import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rm, symlink, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { ApplyOptions, Context, Finding, JournalEntry, Operation, PathIdentity, PathSnapshot, TransactionJournal, TreeEntry } from '../model.js';
import { decodeJournal, encodeJournal, getStatePaths } from '../state.js';
import { errorCode, fingerprintValue, hashBytes, isWithin, snapshotMatches, snapshotPath, snapshotsEqual } from './snapshot.js';

export const journalName = 'journal.json';
export const finding = (code: string, path?: string): Finding => ({ severity: 'error', code, path, message: 'The reviewed filesystem change could not be completed safely.', remediation: code === 'LOCK_GUARD_PENDING' ? 'Check the guard owner PID and verify all mishmash writers have stopped. Preserve lock and transaction data; remove only this guard manually once no writer can still own it, then inspect recovery again. If ownership cannot be established, leave it in place.' : 'Review the affected location and any pending recovery before trying again.' });
export class TransactionError extends Error {
  constructor(readonly code: string, readonly path?: string) { super(code); }
}
export function checkCancellation(options: ApplyOptions): void {
  if (options.signal?.aborted) throw new TransactionError('CANCELLED');
}
export async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function identity(path: string): Promise<PathIdentity> {
  const stat = await lstat(path, { bigint: true });
  return { path, kind: stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'symlink' : stat.isFile() ? 'file' : 'other', dev: String(stat.dev), ino: String(stat.ino), ...(stat.isSymbolicLink() ? { linkTarget: await readlink(path) } : {}) };
}
export interface Effects { snapshots: PathSnapshot[]; parents: Map<string, PathIdentity> }
export const newEffects = (): Effects => ({ snapshots: [], parents: new Map() });
export async function privateDirectory(path: string, effects?: Effects): Promise<void> {
  try {
    const stat = await lstat(path);
    if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700) throw new TransactionError('UNSAFE_PRIVATE_DIRECTORY', path);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
    await mkdir(path, { mode: 0o700 });
    await chmod(path, 0o700);
    await syncDirectory(dirname(path));
    if (effects) await recordEffect(effects, await snapshotPath(path));
  }
}
async function ensureStateAncestors(path: string, effects: Effects): Promise<void> {
  const absolute = resolve(path);
  const parent = dirname(absolute);
  if (parent !== absolute) await ensureStateAncestors(parent, effects);
  try {
    if (!(await lstat(absolute)).isDirectory()) throw new TransactionError('UNSAFE_STATE_PATH', absolute);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
    try { await mkdir(absolute, { mode: 0o700 }); }
    catch (creationError) { if (errorCode(creationError) !== 'EEXIST') throw creationError; }
    const stat = await lstat(absolute);
    if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700) throw new TransactionError('UNSAFE_STATE_PATH', absolute);
    await syncDirectory(absolute);
    await syncDirectory(parent);
    await recordEffect(effects, await snapshotPath(absolute));
  }
}
export async function initializeStorage(context: Context, effects: Effects): Promise<{ transactionRoot: string; lockPath: string }> {
  const paths = await getStatePaths(context);
  await ensureStateAncestors(context.stateHome, effects);
  await privateDirectory(dirname(paths.lockPath), effects);
  return paths;
}
async function guardLock<T>(lockPath: string, action: () => Promise<T>): Promise<T> {
  const guard = `${lockPath}.guard`;
  let handle;
  try { handle = await open(guard, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch { throw new TransactionError('LOCK_GUARD_PENDING', guard); }
  try {
    await handle.chmod(0o600);
    await handle.writeFile(JSON.stringify({ pid: process.pid, token: randomUUID() }));
    await handle.sync();
    await syncDirectory(dirname(guard));
    const owned = await identity(guard);
    try { return await action(); }
    finally {
      if (fingerprintValue(owned) !== fingerprintValue(await identity(guard))) throw new TransactionError('LOCK_GUARD_CHANGED', guard);
      await unlink(guard);
      await syncDirectory(dirname(guard));
    }
  } finally { await handle.close(); }
}
export async function acquireLock(lockPath: string, reclaim = false, journal?: TransactionJournal): Promise<() => Promise<void>> {
  const owned = await guardLock(lockPath, async () => {
    try {
      const existing = await snapshotPath(lockPath);
      if (existing.kind !== 'missing') {
        if (!reclaim) throw new TransactionError('APPLY_LOCKED', lockPath);
        if (existing.kind !== 'file' || existing.mode !== 0o600) throw new TransactionError('UNSAFE_LOCK', lockPath);
        const owner: unknown = JSON.parse(await readFile(lockPath, 'utf8'));
        if (typeof owner !== 'object' || owner === null || !('pid' in owner) || !Number.isSafeInteger(owner.pid) || Number(owner.pid) <= 0 || !('token' in owner) || typeof owner.token !== 'string' || owner.token.length === 0) throw new TransactionError('UNSAFE_LOCK', lockPath);
        try { process.kill(Number(owner.pid), 0); throw new TransactionError('APPLY_LOCKED', lockPath); }
        catch (error) { if (errorCode(error) !== 'ESRCH') throw error; }
        if (!await snapshotMatches(existing)) throw new TransactionError('APPLY_LOCKED', lockPath);
        await unlink(lockPath);
        await syncDirectory(dirname(lockPath));
      }
      const handle = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        await handle.chmod(0o600);
        await handle.writeFile(JSON.stringify({ pid: process.pid, token: randomUUID(), journal }));
        await handle.sync();
        await syncDirectory(dirname(lockPath));
      } finally { await handle.close(); }
      return { snapshot: await snapshotPath(lockPath), identity: await identity(lockPath) };
    } catch (error) { if (error instanceof TransactionError) throw error; throw new TransactionError('UNSAFE_LOCK', lockPath); }
  });
  return async () => {
    // A guarded contender cannot replace a live owner's lock: acquisition rejects it,
    // and reclamation checks that its PID is dead. Release therefore must not compete
    // for that contender's short-lived guard or strand its own still-live lease.
    if (!await snapshotMatches(owned.snapshot) || fingerprintValue(owned.identity) !== fingerprintValue(await identity(lockPath))) throw new TransactionError('LOCK_CHANGED', lockPath);
    await unlink(lockPath);
    await syncDirectory(dirname(lockPath));
  };
}
export async function persistJournal(path: string, journal: TransactionJournal, effects?: Effects): Promise<void> {
  const next = join(path, '.journal-next');
  const handle = await open(next, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try { await handle.chmod(0o600); await handle.writeFile(encodeJournal(journal)); await handle.sync(); } finally { await handle.close(); }
  await rename(next, join(path, journalName));
  await syncDirectory(path);
  if (effects) await recordEffect(effects, await snapshotPath(join(path, journalName)));
}
function relativeEntry(path: string): boolean { return path === '' || (!isAbsolute(path) && path.split('/').every(part => part !== '' && part !== '.' && part !== '..')); }
function validSnapshot(value: PathSnapshot): boolean {
  return typeof value === 'object' && value !== null && typeof value.path === 'string' && isAbsolute(value.path)
    && typeof value.digest === 'string' && typeof value.resolvedPath === 'string' && Number.isInteger(value.mode)
    && ['missing', 'file', 'directory', 'symlink', 'other'].includes(value.kind)
    && Array.isArray(value.parents) && value.parents.every(parent => typeof parent.path === 'string' && typeof parent.dev === 'string' && typeof parent.ino === 'string')
    && Array.isArray(value.entries) && value.entries.every(entry => typeof entry.relativePath === 'string' && relativeEntry(entry.relativePath) && ['file', 'directory', 'symlink'].includes(entry.kind) && typeof entry.digest === 'string' && Number.isInteger(entry.mode) && (entry.kind !== 'symlink' || typeof entry.linkTarget === 'string'));
}
export function validateJournal(path: string, journal: TransactionJournal, transactionRoot: string): void {
  if (!/^[a-zA-Z0-9-]+$/.test(journal.id) || resolve(path) !== join(resolve(transactionRoot), journal.id)) throw new TransactionError('UNSAFE_RECOVERY_PATH', path);
  journal.entries.forEach((entry, index) => {
    if (!validSnapshot(entry.before) || entry.before.path !== entry.path || (entry.after && (!validSnapshot(entry.after) || entry.after.path !== entry.path))
      || (entry.backupPath !== undefined && entry.backupPath !== join(path, 'backups', String(index)))
      || (entry.before.kind !== 'missing' && !entry.backupPath)) throw new TransactionError('INVALID_RECOVERY_JOURNAL', path);
  });
}
export async function readJournal(path: string, transactionRoot: string): Promise<TransactionJournal> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700) throw new TransactionError('UNSAFE_RECOVERY_PATH', path);
  const file = join(path, journalName);
  const before = await snapshotPath(file);
  if (before.kind === 'missing') throw new TransactionError('MISSING_RECOVERY_JOURNAL', file);
  if (before.kind !== 'file' || before.mode !== 0o600) throw new TransactionError('INVALID_RECOVERY_JOURNAL', file);
  const journal = decodeJournal(JSON.parse(await readFile(file, 'utf8')) as unknown);
  validateJournal(path, journal, transactionRoot);
  if (!await snapshotMatches(before)) throw new TransactionError('RECOVERY_CHANGED', file);
  return journal;
}
export async function scanRecovery(context: Context): Promise<{ transactions: { path: string; journal: TransactionJournal }[]; findings: Finding[] }> {
  const { transactionRoot, lockPath } = await getStatePaths(context);
  const transactions: { path: string; journal: TransactionJournal }[] = [];
  const findings: Finding[] = [];
  const incomplete = new Set<string>();
  try {
    const root = await lstat(transactionRoot);
    if (!root.isDirectory() || (root.mode & 0o777) !== 0o700) throw new TransactionError('UNSAFE_RECOVERY_PATH', transactionRoot);
    for (const name of (await readdir(transactionRoot)).sort()) {
      const path = join(transactionRoot, name);
      try {
        const journal = await readJournal(path, transactionRoot);
        if (resolve(journal.context.stateHome, 'mishmash', 'transactions') !== resolve(transactionRoot)) throw new TransactionError('INVALID_RECOVERY_CONTEXT', path);
        if (journal.status !== 'committed' && journal.status !== 'recovered') transactions.push({ path, journal });
      } catch (error) {
        if (error instanceof TransactionError && error.code === 'MISSING_RECOVERY_JOURNAL') incomplete.add(path);
        else findings.push(finding('INVALID_RECOVERY_JOURNAL', path));
      }
    }
  } catch (error) { if (errorCode(error) !== 'ENOENT') findings.push(finding('UNSAFE_RECOVERY_PATH', transactionRoot)); }
  try {
    const lock = await snapshotPath(lockPath);
    if (lock.kind !== 'missing') {
      if (lock.kind !== 'file' || lock.mode !== 0o600) throw new TransactionError('UNSAFE_LOCK', lockPath);
      const owner: unknown = JSON.parse(await readFile(lockPath, 'utf8'));
      if (typeof owner !== 'object' || owner === null || !('pid' in owner) || !Number.isSafeInteger(owner.pid) || Number(owner.pid) <= 0 || !('token' in owner) || typeof owner.token !== 'string' || owner.token.length === 0 || !('journal' in owner)) throw new TransactionError('UNSAFE_LOCK', lockPath);
      let dead = false;
      try { process.kill(Number(owner.pid), 0); } catch (error) { if (errorCode(error) === 'ESRCH') dead = true; else throw error; }
      if (dead) {
        const intent = decodeJournal(owner.journal);
        const path = join(transactionRoot, intent.id);
        validateJournal(path, intent, transactionRoot);
        if (intent.entries.length !== 0 || intent.status !== 'prepared') throw new TransactionError('UNSAFE_LOCK', lockPath);
        if (!transactions.some(transaction => transaction.path === path)) {
          let journal = intent;
          try { journal = await readJournal(path, transactionRoot); }
          catch (error) { if (errorCode(error) !== 'ENOENT' && !(error instanceof TransactionError && error.code === 'MISSING_RECOVERY_JOURNAL')) throw error; }
          incomplete.delete(path);
          transactions.push({ path, journal });
        }
      }
      if (!await snapshotMatches(lock)) throw new TransactionError('LOCK_CHANGED', lockPath);
    }
  } catch { findings.push(finding('UNSAFE_LOCK', lockPath)); }
  const guard = `${lockPath}.guard`;
  try { await lstat(guard); findings.push(finding('LOCK_GUARD_PENDING', guard)); }
  catch (error) { if (errorCode(error) !== 'ENOENT') findings.push(finding('LOCK_GUARD_PENDING', guard)); }
  for (const path of incomplete) findings.push(finding('INVALID_RECOVERY_JOURNAL', path));
  return { transactions, findings };
}
function rebuild(entries: TreeEntry[]): TreeEntry[] {
  for (const entry of [...entries].sort((a, b) => b.relativePath.split('/').length - a.relativePath.split('/').length || b.relativePath.length - a.relativePath.length)) {
    if (entry.kind !== 'directory') continue;
    const prefix = entry.relativePath ? `${entry.relativePath}/` : '';
    const children = entries.filter(child => child.relativePath !== entry.relativePath && child.relativePath.startsWith(prefix) && !child.relativePath.slice(prefix.length).includes('/')).sort((a, b) => a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0);
    entry.digest = fingerprintValue(children.map(child => [child.relativePath, child.kind, child.mode, child.digest]));
  }
  return entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}
export function adjustedSnapshot(original: PathSnapshot, effects: Effects): PathSnapshot {
  let result: PathSnapshot = { ...original, entries: original.entries.map(entry => ({ ...entry })) };
  for (const effect of effects.snapshots) {
    if (effect.path === result.path) { result = { ...effect, entries: effect.entries.map(entry => ({ ...entry })) }; continue; }
    if (result.kind !== 'directory' || !isWithin(result.path, effect.path)) continue;
    const rel = relative(result.path, effect.path).split('\\').join('/');
    const entries = result.entries.filter(entry => entry.relativePath !== rel && !entry.relativePath.startsWith(`${rel}/`));
    if (effect.kind !== 'missing') entries.push(...effect.entries.map(entry => ({ ...entry, relativePath: entry.relativePath ? `${rel}/${entry.relativePath}` : rel })));
    rebuild(entries);
    const root = entries.find(entry => entry.relativePath === '')!;
    result = { ...result, entries, digest: fingerprintValue([root.kind, root.mode, root.digest]) };
  }
  const parents = new Map(result.parents.map(parent => [parent.path, parent]));
  for (const [path, parent] of effects.parents) if (path !== result.path && isWithin(path, result.path)) parents.set(path, parent);
  return { ...result, parents: [...parents.values()].sort((a, b) => a.path.length - b.path.length) };
}
export async function recordEffect(effects: Effects, after: PathSnapshot): Promise<void> {
  effects.snapshots = effects.snapshots.filter(snapshot => snapshot.path !== after.path);
  effects.snapshots.push(after);
  if (after.kind === 'directory' && !effects.parents.has(after.path)) effects.parents.set(after.path, await identity(after.path));
  if (after.kind !== 'directory') for (const path of effects.parents.keys()) if (isWithin(after.path, path)) effects.parents.delete(path);
}
export async function checkExpected(before: PathSnapshot, effects: Effects): Promise<PathSnapshot> {
  const expected = adjustedSnapshot(before, effects);
  const actual = await snapshotPath(before.path);
  if (!snapshotsEqual(expected, actual)) throw new TransactionError('STALE_PLAN', before.path);
  return actual;
}
export function sameContent(a: PathSnapshot, b: PathSnapshot): boolean { return a.kind === b.kind && a.digest === b.digest; }
async function copyRegular(source: string, target: string, mode: number): Promise<void> {
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await input.stat()).isFile()) throw new TransactionError('UNSAFE_SOURCE', source);
    const output = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      const buffer = Buffer.allocUnsafe(64 * 1024);
      for (;;) {
        const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        let position = 0;
        while (position < bytesRead) position += (await output.write(buffer, position, bytesRead - position, null)).bytesWritten;
      }
      await output.chmod(mode);
      await output.sync();
    } finally { await output.close(); }
  } finally { await input.close(); }
}
export async function backupEntry(path: string, before: PathSnapshot, backupPath: string): Promise<void> {
  await privateDirectory(backupPath);
  for (const entry of before.entries) {
    if (entry.kind === 'other') throw new TransactionError('UNSUPPORTED_FILE_TYPE', path);
    if (entry.kind === 'file') {
      const backup = join(backupPath, hashBytes(entry.relativePath));
      await copyRegular(entry.relativePath ? join(path, entry.relativePath) : path, backup, 0o600);
      if ((await snapshotPath(backup)).entries[0]?.digest !== entry.digest) throw new TransactionError('STALE_PLAN', path);
    }
  }
  await syncDirectory(backupPath);
  if (!await snapshotMatches(before)) throw new TransactionError('STALE_PLAN', path);
}
export function stagePath(transactionPath: string, index: number, target: string): string { return join(dirname(target), `.mishmash-${transactionPath.slice(transactionPath.lastIndexOf('/') + 1)}-${index}`); }
export async function createStage(transactionPath: string, index: number, target: string): Promise<string> {
  const path = stagePath(transactionPath, index, target);
  await mkdir(path, { mode: 0o700 });
  await chmod(path, 0o700);
  await syncDirectory(dirname(path));
  return path;
}
async function resolvePhysical(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if (errorCode(error) !== 'ENOENT' && errorCode(error) !== 'ENOTDIR') throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await resolvePhysical(parent), relative(parent, path));
  }
}
export async function prepareOperation(operation: Operation, before: PathSnapshot, stage: string): Promise<PathSnapshot> {
  const payload = join(stage, 'payload');
  const parent = await realpath(dirname(operation.path));
  const physicalPath = join(parent, relative(dirname(operation.path), operation.path));
  if (operation.kind === 'write') {
    if (before.kind === 'directory' || before.kind === 'other') throw new TransactionError('UNSAFE_TARGET', operation.path);
    if (operation.content.kind === 'source') {
      if (operation.content.snapshot.kind !== 'file' || operation.content.path !== operation.content.snapshot.path || !await snapshotMatches(operation.content.snapshot)) throw new TransactionError('STALE_SOURCE', operation.content.path);
      await copyRegular(operation.content.path, payload, operation.mode);
      const staged = await snapshotPath(payload);
      if (staged.entries[0]?.digest !== operation.content.snapshot.entries[0]?.digest || !await snapshotMatches(operation.content.snapshot)) throw new TransactionError('STALE_SOURCE', operation.content.path);
    } else {
      const handle = await open(payload, 'wx', 0o600);
      try { await handle.writeFile(operation.content.bytes); await handle.chmod(operation.mode); await handle.sync(); } finally { await handle.close(); }
    }
  } else if (operation.kind === 'symlink') {
    if (before.kind === 'directory' || before.kind === 'other') throw new TransactionError('UNSAFE_TARGET', operation.path);
    await symlink(operation.target, payload);
  } else if (operation.kind === 'mkdir') {
    if (before.kind !== 'missing') throw new TransactionError('UNSAFE_TARGET', operation.path);
    await mkdir(payload, { mode: operation.mode });
    await chmod(payload, operation.mode);
    await syncDirectory(payload);
  } else if (operation.kind === 'chmod') {
    if (before.kind !== 'file' && before.kind !== 'directory') throw new TransactionError('UNSAFE_TARGET', operation.path);
    const entries = before.entries.map(entry => ({ ...entry, ...(entry.relativePath === '' ? { mode: operation.mode } : {}) }));
    const root = entries.find(entry => entry.relativePath === '')!;
    return { ...before, mode: operation.mode, entries, digest: fingerprintValue([root.kind, root.mode, root.digest]) };
  } else return { ...before, kind: 'missing', digest: 'missing', mode: 0, entries: [], linkTarget: undefined, resolvedPath: physicalPath };
  await syncDirectory(stage);
  const after = await snapshotPath(payload);
  // Preserve the target text until the filesystem expands any intermediate links;
  // lexical normalization would incorrectly collapse a link component followed by '..'.
  const resolvedPath = operation.kind === 'symlink' ? await resolvePhysical(isAbsolute(operation.target) ? operation.target : `${parent}/${operation.target}`) : physicalPath;
  return { ...after, path: operation.path, parents: before.parents, resolvedPath };
}
export async function mutate(operation: Operation, stage: string): Promise<void> {
  if (operation.kind === 'chmod') await chmod(operation.path, operation.mode);
  else if (operation.kind === 'remove') await rename(operation.path, join(stage, 'removed'));
  else await rename(join(stage, 'payload'), operation.path);
  if (operation.kind === 'chmod') {
    const handle = await open(operation.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await handle.sync(); } finally { await handle.close(); }
  }
  await syncDirectory(dirname(operation.path));
}
async function restorePayload(entry: JournalEntry, stage: string): Promise<void> {
  await privateDirectory(dirname(entry.backupPath!));
  await privateDirectory(entry.backupPath!);
  const payload = join(stage, 'payload');
  const entries = [...entry.before.entries].sort((a, b) => a.relativePath.length - b.relativePath.length);
  for (const item of entries) {
    const path = item.relativePath ? join(payload, item.relativePath) : payload;
    if (item.kind === 'directory') { await mkdir(path, { mode: 0o700 }); }
    else if (item.kind === 'file') await copyRegular(join(entry.backupPath!, hashBytes(item.relativePath)), path, item.mode);
    else if (item.kind === 'symlink') await symlink(item.linkTarget!, path);
    else throw new TransactionError('UNSUPPORTED_FILE_TYPE', entry.path);
  }
  for (const item of entries.reverse()) if (item.kind === 'directory') { await chmod(item.relativePath ? join(payload, item.relativePath) : payload, item.mode); await syncDirectory(item.relativePath ? join(payload, item.relativePath) : payload); }
  const restored = await snapshotPath(payload);
  if (!sameContent(restored, entry.before)) throw new TransactionError('BACKUP_CHANGED', entry.backupPath);
  await syncDirectory(stage);
}
export async function rollback(path: string, journal: TransactionJournal): Promise<{ journal: TransactionJournal; findings: Finding[] }> {
  let current: TransactionJournal = { ...journal, status: 'recovering', entries: journal.entries.map(entry => ({ ...entry })) };
  await persistJournal(path, current);
  const findings: Finding[] = [];
  // Reverse order restores children before their containing directory and state before resources.
  for (let index = current.entries.length - 1; index >= 0; index--) {
    const entry = current.entries[index]!;
    if (entry.state === 'restored' || entry.state === 'prepared') {
      await removeStage(path, index, entry);
      await removeStage(path, index, entry, true);
      continue;
    }
    try {
      const actual = await snapshotPath(entry.path);
      const unchanged = snapshotsEqual(entry.before, actual);
      if (!unchanged && (!entry.after || !snapshotsEqual(entry.after, actual))) throw new TransactionError('RECOVERY_CONFLICT', entry.path);
      if (!unchanged) {
        const stage = `${stagePath(path, index, entry.path)}-recovery`;
        // An interrupted stage belongs only to this journal, never to an arbitrary user path.
        const stageSnapshot = await snapshotPath(stage);
        if (stageSnapshot.kind !== 'missing' && (stageSnapshot.kind !== 'directory' || stageSnapshot.mode !== 0o700)) throw new TransactionError('UNSAFE_STAGE', stage);
        if (stageSnapshot.kind !== 'missing') await rm(stage, { recursive: true });
        await mkdir(stage, { mode: 0o700 });
        await chmod(stage, 0o700);
        if (entry.before.kind === 'missing') {
          if (actual.kind === 'directory' && actual.entries.length !== 1) throw new TransactionError('RECOVERY_CONFLICT', entry.path);
          await rename(entry.path, join(stage, 'discarded'));
        } else if (entry.operation === 'chmod') {
          await chmod(entry.path, entry.before.mode);
        } else {
          await restorePayload(entry, stage);
          if (!await snapshotMatches(actual)) throw new TransactionError('RECOVERY_CONFLICT', entry.path);
          await rename(join(stage, 'payload'), entry.path);
        }
        await syncDirectory(dirname(entry.path));
      }
      if (entry.operation === 'chmod') {
        const handle = await open(entry.path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try { await handle.sync(); } finally { await handle.close(); }
      }
      const entries = [...current.entries];
      if (entry.before.kind === 'directory') {
        const restoredParents = newEffects();
        for (const item of entry.before.entries) if (item.kind === 'directory') {
          const directory = item.relativePath ? join(entry.path, item.relativePath) : entry.path;
          restoredParents.parents.set(directory, await identity(directory));
        }
        // Restoring a removed directory necessarily gives it a new inode. Persist only these
        // verified, engine-restored identities alongside settlement, so a restart is consistent.
        for (let earlier = 0; earlier < index; earlier++) {
          const prior = entries[earlier]!;
          entries[earlier] = { ...prior, before: adjustedSnapshot(prior.before, restoredParents), ...(prior.after ? { after: adjustedSnapshot(prior.after, restoredParents) } : {}) };
        }
      }
      await removeStage(path, index, entry);
      await removeStage(path, index, entry, true);
      entries[index] = { ...entry, state: 'restored' };
      current = { ...current, entries };
      await persistJournal(path, current);
    } catch { findings.push(finding('RECOVERY_CONFLICT', entry.path)); break; }
  }
  current = { ...current, status: findings.length ? 'recovery-required' : 'recovered' };
  await persistJournal(path, current);
  return { journal: current, findings };
}
async function removeStage(path: string, index: number, entry: JournalEntry, recovery = false): Promise<void> {
  const stage = `${stagePath(path, index, entry.path)}${recovery ? '-recovery' : ''}`;
  const actual = await snapshotPath(stage);
  if (actual.kind === 'missing') return;
  if (actual.kind !== 'directory' || actual.mode !== 0o700 || fingerprintValue(actual.parents) !== fingerprintValue(entry.before.parents)) throw new TransactionError('UNSAFE_STAGE', stage);
  await rm(stage, { recursive: true });
  await syncDirectory(dirname(stage));
}
export async function cleanupStages(path: string, journal: TransactionJournal): Promise<void> {
  for (let index = journal.entries.length - 1; index >= 0; index--) {
    await removeStage(path, index, journal.entries[index]!);
    await removeStage(path, index, journal.entries[index]!, true);
  }
}
export function operationChanges(operation: Operation, expected = operation.expected): boolean {
  if (operation.kind === 'mkdir') return expected.kind !== 'directory' || expected.mode !== operation.mode;
  if (operation.kind === 'remove') return expected.kind !== 'missing';
  if (operation.kind === 'chmod') return expected.kind === 'missing' || expected.mode !== operation.mode;
  if (operation.kind === 'symlink') return expected.kind !== 'symlink' || expected.linkTarget !== operation.target;
  const digest = operation.content.kind === 'bytes' ? hashBytes(operation.content.bytes) : operation.content.snapshot.entries.find(entry => entry.relativePath === '')?.digest;
  return expected.kind !== 'file' || expected.mode !== operation.mode || expected.entries.find(entry => entry.relativePath === '')?.digest !== digest;
}
export async function validateReview(operations: readonly Operation[], preconditions: readonly PathSnapshot[], effects = newEffects()): Promise<void> {
  for (const snapshot of [...preconditions, ...operations.map(operation => operation.expected)]) await checkExpected(snapshot, effects);
  for (const operation of operations) {
    if (operation.path !== operation.expected.path || !isAbsolute(operation.path) || operation.expected.kind === 'other') throw new TransactionError('INVALID_PLAN', operation.path);
    if (operation.kind === 'write' && operation.content.kind === 'source' && operation.content.snapshot.kind !== 'file') throw new TransactionError('UNSAFE_SOURCE', operation.content.path);
    if (operation.kind === 'write' && operation.content.kind === 'source' && !await snapshotMatches(operation.content.snapshot)) throw new TransactionError('STALE_SOURCE', operation.content.path);
  }
  for (const source of preconditions) {
    if (source.kind !== 'directory' || !operations.some(operation => operation.kind === 'write' && operation.content.kind === 'source' && isWithin(source.path, operation.content.path))) continue;
    for (const entry of source.entries) {
      if (entry.kind === 'other') throw new TransactionError('UNSAFE_SOURCE_TREE', source.path);
      if (entry.kind !== 'symlink') continue;
      const resolved = await resolvePhysical(join(source.path, entry.relativePath));
      if (isAbsolute(entry.linkTarget!) || !isWithin(source.resolvedPath, resolved)) throw new TransactionError('UNSAFE_SOURCE_TREE', source.path);
    }
  }
}
