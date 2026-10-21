import { constants, type Stats as Stat } from 'node:fs';
import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import type { ApplyResult, Operation, Plan, State } from './types.js';

type Guard = { path: string; dev: number; ino: number; resolved: string };
type Entry = { path: string; before: string | null; after: string | null; backup: string | null; work: string };
type Journal = { version: 1; statePath: string; status: 'pending' | 'committed' | 'rolled-back'; entries: Entry[] };
const HASH = /^[a-f0-9]{64}$/;
const KINDS = new Set(['write', 'copy', 'link', 'remove']);
const LINK_ERRORS = new Set(['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EINVAL']);
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';
const inside = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};
const emptyState = (): State => ({ version: 1, managed: {} });

async function statOrNull(file: string): Promise<Stat | null> {
  try { return await fs.lstat(file); } catch (error) { if (missing(error)) return null; throw error; }
}
function same(a: Stat, b: Stat): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
function changed(file: string): Error { return new Error(`Filesystem input changed: ${file}`); }

/** Hash entries without following symbolic links; include every byte, name, type and permission. */
export async function hashPath(file: string): Promise<string | null> { return hashTree(file); }
async function hashTree(file: string, ignore?: (file: string) => Promise<boolean>): Promise<string | null> {
  if (ignore && await ignore(path.resolve(file))) return null;
  const initial = await statOrNull(file);
  if (!initial) return null;
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  async function visit(current: string, relative: string, stat: Stat): Promise<void> {
    const type = stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'unsupported';
    if (type === 'unsupported') throw new Error(`Unsupported filesystem entry: ${current}`);
    hash.update(JSON.stringify([relative, type, stat.mode & 0o7777, type === 'file' ? stat.size : null]) + '\n');
    if (stat.isSymbolicLink()) {
      hash.update(JSON.stringify(await fs.readlink(current)) + '\n');
    } else if (stat.isDirectory()) {
      for (const name of (await fs.readdir(current)).sort()) {
        const child = path.join(current, name);
        if (ignore && await ignore(path.resolve(child))) continue;
        await visit(child, relative ? `${relative}/${name}` : name, await fs.lstat(child));
      }
    } else {
      const handle = await fs.open(current, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        if (!same(stat, await handle.stat())) throw changed(current);
        let offset = 0;
        for (;;) {
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
          if (bytesRead === 0) break;
          hash.update(buffer.subarray(0, bytesRead));
          offset += bytesRead;
        }
        if (offset !== stat.size || !same(stat, await handle.stat())) throw changed(current);
      } finally { await handle.close(); }
    }
    if (!same(stat, await fs.lstat(current))) throw changed(current);
  }
  await visit(file, '', initial);
  return hash.digest('hex');
}

// System aliases such as macOS /tmp -> /private/tmp are safe only in root-owned,
// non-writable parents. User-controlled ancestor links are never accepted.
async function guardAncestors(file: string): Promise<Guard[]> {
  const absolute = path.resolve(file);
  const parent = path.dirname(absolute);
  const root = path.parse(parent).root;
  const parts = path.relative(root, parent).split(path.sep).filter(Boolean);
  const result: Guard[] = [];
  let current = root;
  for (const part of ['', ...parts]) {
    if (part) current = path.join(current, part);
    const stat = await statOrNull(current);
    if (!stat) break;
    if (stat.isSymbolicLink()) {
      const parentStat = await fs.stat(path.dirname(current));
      if (process.platform === 'win32' || stat.uid !== 0 || parentStat.uid !== 0 || (parentStat.mode & 0o022) !== 0) {
        throw new Error(`Refusing symbolic-link output ancestor: ${current}`);
      }
    } else if (!stat.isDirectory()) throw new Error(`Output ancestor is not a directory: ${current}`);
    result.push({ path: current, dev: stat.dev, ino: stat.ino, resolved: await fs.realpath(current) });
  }
  return result;
}
function guardedOutputPath(file: string, guards: Guard[]): string {
  const ancestor = guards[guards.length - 1]!;
  return path.resolve(ancestor.resolved, path.relative(ancestor.path, path.resolve(file)));
}
async function checkGuards(guards: Guard[]): Promise<void> {
  for (const guard of guards) {
    const stat = await fs.lstat(guard.path);
    if (stat.dev !== guard.dev || stat.ino !== guard.ino || await fs.realpath(guard.path) !== guard.resolved) throw changed(guard.path);
  }
}
async function createParents(file: string, created: string[]): Promise<void> {
  const parent = path.dirname(file);
  const stat = await statOrNull(parent);
  if (stat) {
    if (stat.isSymbolicLink()) { await guardAncestors(file); return; }
    if (!stat.isDirectory()) throw new Error(`Output ancestor is not a directory: ${parent}`);
    return;
  }
  await createParents(parent, created);
  await guardAncestors(file);
  try { await fs.mkdir(parent, { mode: 0o700 }); created.push(parent); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  await guardAncestors(file);
}
async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try { handle = await fs.open(directory, constants.O_RDONLY); }
  catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return;
    throw error;
  }
  try {
    try { await handle.sync(); } catch (error) {
      if (!['EINVAL', 'ENOTSUP', 'EBADF', 'EISDIR', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  } finally { await handle.close(); }
}
async function writeFileDurable(file: string, content: string, mode: number): Promise<void> {
  const handle = await fs.open(file, 'wx', mode);
  try { await handle.writeFile(content); await handle.chmod(mode); await handle.sync(); }
  finally { await handle.close(); }
}
async function atomicJson(file: string, value: unknown): Promise<void> {
  const guards = await guardAncestors(file);
  const temporary = path.join(path.dirname(file), `.mishmash-json-${randomUUID()}`);
  try {
    await writeFileDurable(temporary, JSON.stringify(value, null, 2) + '\n', 0o600);
    await checkGuards(guards);
    const existing = await statOrNull(file);
    if (existing?.isSymbolicLink() || existing?.isDirectory()) throw new Error(`Unsafe private state file: ${file}`);
    await fs.rename(temporary, file);
    await syncDirectory(path.dirname(file));
  } finally { await fs.rm(temporary, { force: true }); }
}

async function validateCopyTree(source: string): Promise<string> {
  const root = await fs.realpath(source);
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() && !rootStat.isFile()) throw new Error(`Unsupported copy source: ${source}`);
  const visited = new Set<string>();
  const active = new Set<string>();
  async function visit(current: string): Promise<void> {
    const info = await fs.lstat(current);
    if (info.isSymbolicLink()) {
      const target = await fs.readlink(current);
      let depth = path.relative(root, path.dirname(current)).split(path.sep).filter(Boolean).length;
      let escapes = false;
      for (const part of target.split(path.sep)) {
        if (part === '..') { if (depth === 0) { escapes = true; break; } depth--; }
        else if (part && part !== '.') depth++;
      }
      if (path.isAbsolute(target) || path.win32.isAbsolute(target) || escapes || !inside(root, path.resolve(path.dirname(current), target))) {
        throw new Error(`Copy source link escapes its tree or is absolute: ${current}`);
      }
    }
    const resolved = await fs.realpath(current);
    if (!inside(root, resolved)) throw new Error(`Copy source link escapes its tree: ${current}`);
    const stat = await fs.stat(current);
    if (stat.isFile()) return;
    if (!stat.isDirectory()) throw new Error(`Unsupported copy source entry: ${current}`);
    if (active.has(resolved)) throw new Error(`Cyclic copy source: ${current}`);
    if (visited.has(resolved)) return;
    active.add(resolved);
    for (const name of await fs.readdir(resolved)) await visit(path.join(resolved, name));
    active.delete(resolved);
    visited.add(resolved);
  }
  await visit(root);
  return root;
}

// Preserve link representations exactly, including when backing up native entries.
async function copyTree(source: string, destination: string): Promise<void> {
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink()) {
    const target = await fs.readlink(source);
    const targetStat = await fs.stat(source).catch(() => null);
    await fs.symlink(target, destination, targetStat?.isDirectory() ? 'dir' : 'file');
  } else if (stat.isDirectory()) {
    await fs.mkdir(destination, { mode: 0o700 });
    for (const name of (await fs.readdir(source)).sort()) await copyTree(path.join(source, name), path.join(destination, name));
    await fs.chmod(destination, stat.mode & 0o7777);
    await syncDirectory(destination);
  } else if (stat.isFile()) {
    const input = await fs.open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const output = await fs.open(destination, 'wx', 0o600);
    try {
      if (!same(stat, await input.stat())) throw changed(source);
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let offset = 0;
      for (;;) {
        const { bytesRead } = await input.read(buffer, 0, buffer.length, offset);
        if (!bytesRead) break;
        let written = 0;
        while (written < bytesRead) {
          const result = await output.write(buffer, written, bytesRead - written, offset + written);
          if (!result.bytesWritten) throw new Error(`Unable to copy file: ${source}`);
          written += result.bytesWritten;
        }
        offset += bytesRead;
      }
      if (offset !== stat.size || !same(stat, await input.stat())) throw changed(source);
      await output.chmod(stat.mode & 0o7777);
      await output.sync();
    } finally { await input.close(); await output.close(); }
  } else throw new Error(`Unsupported filesystem entry: ${source}`);
  if (!same(stat, await fs.lstat(source))) throw changed(source);
}

/** Copy a complete skill tree, preserving modes and contained symbolic links. */
export async function safeCopy(source: string, destination: string): Promise<void> {
  const root = await validateCopyTree(source);
  const guards = await guardAncestors(destination);
  if (inside(root, guardedOutputPath(destination, guards))) throw new Error('Copy destination is inside its source');
  const before = await hashPath(root);
  if (await statOrNull(destination)) throw new Error(`Copy destination already exists: ${destination}`);
  const created: string[] = [];
  await createParents(destination, created);
  const work = await fs.mkdtemp(path.join(path.dirname(destination), '.mishmash-copy-'));
  await fs.chmod(work, 0o700);
  try {
    const staged = path.join(work, 'new');
    await copyTree(root, staged);
    if (await hashPath(root) !== before) throw changed(root);
    await checkGuards(guards);
    await guardAncestors(destination);
    if (await statOrNull(destination)) throw new Error(`Copy destination appeared: ${destination}`);
    await fs.rename(staged, destination);
    await syncDirectory(path.dirname(destination));
  } finally { await fs.rm(work, { recursive: true, force: true }); }
}

function validateState(value: unknown, allowUnhashed = false): State {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid mishmash state');
  const state = value as State;
  if (state.version !== 1 || !state.managed || typeof state.managed !== 'object' || Array.isArray(state.managed)) throw new Error('Invalid mishmash state');
  if (Object.keys(state).some(key => key !== 'version' && key !== 'managed')) throw new Error('Invalid mishmash state fields');
  for (const entry of Object.values(state.managed)) {
    if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string' || !path.isAbsolute(entry.path) || typeof entry.hash !== 'string' || !(HASH.test(entry.hash) || allowUnhashed && entry.hash === '') || !KINDS.has(entry.kind)) throw new Error('Invalid managed state entry');
    if (Object.keys(entry).some(key => !['path', 'hash', 'kind', 'keys'].includes(key))) throw new Error('Invalid managed state fields');
    if (entry.keys !== undefined && (!entry.keys || typeof entry.keys !== 'object' || Array.isArray(entry.keys) || Object.values(entry.keys).some(keys => !Array.isArray(keys) || keys.some(key => typeof key !== 'string')))) throw new Error('Invalid managed state keys');
  }
  return state;
}
export async function readState(statePath: string): Promise<State> {
  await guardAncestors(statePath);
  const stat = await statOrNull(statePath);
  if (!stat) return emptyState();
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Unsafe state file: ${statePath}`);
  const handle = await fs.open(statePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!same(stat, await handle.stat())) throw changed(statePath);
    const result = validateState(JSON.parse(await handle.readFile('utf8')));
    if (!same(stat, await handle.stat())) throw changed(statePath);
    return result;
  } finally { await handle.close(); }
}

async function privateDirectory(directory: string): Promise<void> {
  await guardAncestors(path.join(directory, 'entry'));
  const stat = await statOrNull(directory);
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error(`Unsafe private state directory: ${directory}`);
  const created: string[] = [];
  await createParents(path.join(directory, 'entry'), created);
  await fs.chmod(directory, 0o700);
}
async function withLock<T>(statePath: string, action: () => Promise<T>): Promise<T> {
  await privateDirectory(path.dirname(statePath));
  const lockPath = path.join(path.dirname(statePath), '.lock');
  const token = randomUUID();
  const content = JSON.stringify({ version: 1, pid: process.pid, token });
  for (;;) {
    try { await writeFileDurable(lockPath, content, 0o600); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const stat = await fs.lstat(lockPath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Unsafe transaction lock: ${lockPath}`);
      let owner: { version?: number; pid?: number; token?: string };
      try { owner = JSON.parse(await fs.readFile(lockPath, 'utf8')) as typeof owner; }
      catch { throw new Error(`Invalid transaction lock; preserve for manual recovery: ${lockPath}`); }
      if (owner.version !== 1 || !Number.isSafeInteger(owner.pid) || (owner.pid ?? 0) <= 0 || typeof owner.token !== 'string') throw new Error(`Invalid transaction lock: ${lockPath}`);
      try { process.kill(owner.pid!, 0); throw new Error('Another mishmash transaction is active'); }
      catch (probe) { if ((probe as NodeJS.ErrnoException).code !== 'ESRCH') throw probe; }
      if (!same(stat, await fs.lstat(lockPath))) throw changed(lockPath);
      await fs.unlink(lockPath);
    }
  }
  try { return await action(); }
  finally {
    const stat = await statOrNull(lockPath);
    if (stat?.isFile() && !stat.isSymbolicLink() && await fs.readFile(lockPath, 'utf8') === content) await fs.unlink(lockPath);
  }
}

function validateJournal(value: unknown, statePath: string, directory: string): Journal {
  const journal = value as Journal;
  if (!journal || journal.version !== 1 || journal.statePath !== statePath || !['pending', 'committed', 'rolled-back'].includes(journal.status) || !Array.isArray(journal.entries)) throw new Error(`Invalid recovery journal: ${directory}`);
  const seen = new Set<string>();
  for (const entry of journal.entries) {
    if (!entry || typeof entry.path !== 'string' || !path.isAbsolute(entry.path) || seen.has(entry.path) || typeof entry.work !== 'string' || path.dirname(entry.work) !== path.dirname(entry.path) || !path.basename(entry.work).startsWith('.mishmash-txn-') || ![entry.before, entry.after].every(hash => hash === null || typeof hash === 'string' && HASH.test(hash)) || entry.backup !== null && (typeof entry.backup !== 'string' || path.dirname(entry.backup) !== directory || !/^backup-\d+$/.test(path.basename(entry.backup)))) throw new Error(`Invalid recovery journal entry: ${directory}`);
    seen.add(entry.path);
  }
  return journal;
}
async function removeWork(entry: Entry): Promise<void> {
  await guardAncestors(path.join(entry.work, 'entry'));
  const stat = await statOrNull(entry.work);
  if (!stat) return;
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe transaction staging directory: ${entry.work}`);
  const contents = await fs.readdir(entry.work);
  if (contents.some(name => !['new', 'original', 'restore'].includes(name))) throw new Error(`Unrecognized transaction staging data: ${entry.work}`);
  for (const name of contents) {
    const hash = await hashPath(path.join(entry.work, name));
    const expected = name === 'restore' ? entry.before : name === 'new' ? entry.after : null;
    if (name === 'original' ? hash !== entry.before && hash !== entry.after : expected === null || hash !== expected) throw new Error(`Transaction staging data changed; retained: ${entry.work}`);
  }
  await fs.rm(entry.work, { recursive: true });
}
async function rollback(journal: Journal, journalPath: string): Promise<void> {
  // Validate every output before restoring any, so a drift conflict cannot cause
  // a second partial rollback. Keep all evidence on conflict.
  for (const entry of journal.entries) {
    await guardAncestors(entry.path);
    const current = await hashPath(entry.path);
    if (current !== entry.before && current !== entry.after && !(current === null && entry.before !== null)) throw new Error(`Recovery conflicts with edited output; backups retained: ${entry.path}`);
    if (entry.before !== null && (!entry.backup || await hashPath(entry.backup) !== entry.before)) throw new Error(`Recovery backup missing or changed: ${entry.path}`);
  }
  for (const entry of [...journal.entries].reverse()) {
    const current = await hashPath(entry.path);
    if (current === entry.before) continue;
    await guardAncestors(entry.path);
    if (entry.before === null) {
      // Only delete the exact result this transaction installed.
      if (current !== entry.after) throw new Error(`Recovery output changed: ${entry.path}`);
      await fs.rm(entry.path, { recursive: true, force: true });
    } else {
      const created: string[] = [];
      await createParents(entry.path, created);
      const workStat = await statOrNull(entry.work);
      if (!workStat) await fs.mkdir(entry.work, { mode: 0o700 });
      else if (!workStat.isDirectory() || workStat.isSymbolicLink()) throw new Error(`Unsafe recovery staging: ${entry.work}`);
      const staged = path.join(entry.work, 'restore');
      if (await statOrNull(staged)) {
        if (await hashPath(staged) !== entry.before) throw new Error(`Recovery staging changed: ${staged}`);
      } else await copyTree(entry.backup!, staged);
      const latest = await hashPath(entry.path);
      if (latest !== current) throw changed(entry.path);
      if (latest !== null) {
        const original = path.join(entry.work, 'original');
        if (await statOrNull(original)) {
          if (await hashPath(original) !== entry.before) throw new Error(`Recovery original changed: ${original}`);
          await fs.rm(original, { recursive: true });
        }
        await fs.rename(entry.path, original);
      }
      await fs.rename(staged, entry.path);
    }
    await syncDirectory(path.dirname(entry.path));
  }
  journal.status = 'rolled-back';
  await atomicJson(journalPath, journal);
  for (const entry of journal.entries) await removeWork(entry);
}
async function recoverUnlocked(statePath: string): Promise<void> {
  const backups = path.join(path.dirname(statePath), 'backups');
  const stat = await statOrNull(backups);
  if (!stat) return;
  await guardAncestors(path.join(backups, 'entry'));
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe backup directory: ${backups}`);
  for (const name of (await fs.readdir(backups)).sort()) {
    if (!/^txn-[a-f0-9-]+$/.test(name)) continue;
    const directory = path.join(backups, name);
    const journalPath = path.join(directory, 'journal.json');
    await guardAncestors(journalPath);
    const journalStat = await statOrNull(journalPath);
    if (!journalStat) continue; // A crash while preparing backups made no native changes.
    if (!journalStat.isFile() || journalStat.isSymbolicLink()) throw new Error(`Unsafe recovery journal: ${journalPath}`);
    const journal = validateJournal(JSON.parse(await fs.readFile(journalPath, 'utf8')), statePath, directory);
    if (journal.status === 'pending') await rollback(journal, journalPath);
    else for (const entry of journal.entries) await removeWork(entry);
  }
}
export async function recover(statePath: string): Promise<void> {
  const absolute = path.resolve(statePath);
  if (!await statOrNull(path.dirname(absolute))) return;
  await withLock(absolute, () => recoverUnlocked(absolute));
}

async function preflight(plan: Plan): Promise<Map<string, string | null>> {
  if (plan.version !== 1 || plan.diagnostics.some(diagnostic => diagnostic.severity === 'error')) throw new Error('Cannot apply a plan with error diagnostics');
  validateState(plan.state, true);
  if (!path.isAbsolute(plan.statePath)) throw new Error('State path must be absolute');
  const expected = new Map<string, string | null>();
  for (const input of plan.preconditions) {
    if (!path.isAbsolute(input.path) || input.hash !== null && !HASH.test(input.hash)) throw new Error('Invalid plan precondition');
    const absolute = path.resolve(input.path);
    if (expected.has(absolute) && expected.get(absolute) !== input.hash) throw new Error(`Conflicting preconditions: ${absolute}`);
    expected.set(absolute, input.hash);
  }
  if (!expected.has(path.resolve(plan.statePath))) throw new Error('State precondition is required');
  const physicalOutputs = new Map<string, string>();
  const producers = new Map<string, Operation>();
  const stateDirectory = path.dirname(guardedOutputPath(plan.statePath, await guardAncestors(plan.statePath)));
  for (const operation of plan.operations) {
    if (!KINDS.has(operation.kind) || !path.isAbsolute(operation.path)) throw new Error('Invalid operation');
    const output = path.resolve(operation.path);
    const physicalOutput = guardedOutputPath(output, await guardAncestors(output));
    if (physicalOutputs.has(physicalOutput) || output === path.parse(output).root || inside(stateDirectory, physicalOutput) || inside(physicalOutput, stateDirectory)) throw new Error(`Unsafe or duplicate output path: ${output}`);
    for (const other of physicalOutputs.keys()) if (inside(physicalOutput, other) || inside(other, physicalOutput)) throw new Error(`Overlapping output paths: ${output}`);
    physicalOutputs.set(physicalOutput, output);
    if (!expected.has(output)) throw new Error(`Output precondition is required: ${output}`);
    const stat = await statOrNull(output);
    if (stat?.isSymbolicLink() && operation.kind === 'write') throw new Error(`Refusing symbolic-link output: ${output}`);
    if (operation.kind === 'write' && (typeof operation.content !== 'string' || operation.mode !== undefined && (!Number.isInteger(operation.mode) || operation.mode < 0 || operation.mode > 0o777))) throw new Error(`Invalid write operation: ${output}`);
    if (operation.kind === 'copy' || operation.kind === 'link') {
      const source = path.resolve(operation.source);
      const producer = producers.get(source);
      if (!path.isAbsolute(operation.source) || !expected.has(source) || expected.get(source) === null && (!producer || producer.kind !== 'copy')) throw new Error(`Source precondition is required: ${source}`);
      if (source === output) throw new Error(`Output is its own source: ${output}`);
      if (!producer) {
        const root = await validateCopyTree(source);
        if (!expected.has(root) || expected.get(root) === null) throw new Error(`Resolved source precondition is required: ${root}`);
        if (inside(root, physicalOutput)) throw new Error(`Output is inside its source: ${output}`);
      }
    }
    producers.set(output, operation);
  }
  for (const operation of plan.operations) {
    if (operation.kind === 'copy' || operation.kind === 'link') {
      const source = path.resolve(operation.source);
      const resolvedSource = producers.get(source)?.kind === 'copy' ? guardedOutputPath(source, await guardAncestors(source)) : await fs.realpath(source);
      for (const [physicalOutput, output] of physicalOutputs) {
        // Exact source/output identity is the planned copy-then-native-link cutover.
        if (output !== source && inside(physicalOutput, resolvedSource)) throw new Error(`Source overlaps planned output: ${source}`);
      }
    }
  }
  for (const managed of Object.values(plan.state.managed)) {
    if (managed.hash === '' && !producers.has(path.resolve(managed.path))) throw new Error(`Uninitialized ownership entry has no planned output: ${managed.path}`);
  }
  for (const [file, hash] of expected) if (await hashPath(file) !== hash) throw new Error(`Stale plan precondition: ${file}`);
  await readState(plan.statePath);
  return expected;
}
async function prepareOperation(operation: Operation, staged: string, stagedSource?: string): Promise<void> {
  if (operation.kind === 'write') {
    const previous = await statOrNull(operation.path);
    await writeFileDurable(staged, operation.content, operation.mode ?? (previous?.isFile() ? previous.mode & 0o777 : 0o600));
  } else if (operation.kind === 'copy') {
    const root = await validateCopyTree(stagedSource ?? operation.source);
    await copyTree(root, staged);
  } else if (operation.kind === 'link') {
    const root = await validateCopyTree(stagedSource ?? operation.source);
    const target = path.relative(path.dirname(operation.path), path.resolve(operation.source)) || '.';
    try { await fs.symlink(target, staged, (await fs.stat(root)).isDirectory() ? 'dir' : 'file'); }
    catch (error) {
      if (!operation.fallbackCopy || !LINK_ERRORS.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
      await copyTree(root, staged);
    }
  }
}
async function install(entry: Entry): Promise<void> {
  await guardAncestors(entry.path);
  if (await hashPath(entry.path) !== entry.before) throw changed(entry.path);
  if (entry.before !== null) {
    await fs.rename(entry.path, path.join(entry.work, 'original'));
    if (await hashPath(path.join(entry.work, 'original')) !== entry.before) throw changed(entry.path);
  }
  if (entry.after !== null) await fs.rename(path.join(entry.work, 'new'), entry.path);
  await syncDirectory(entry.work);
  await syncDirectory(path.dirname(entry.path));
}

/** Apply an authenticated plan, retaining private backups and a durable rollback journal. */
export async function applyPlan(plan: Plan, options: { failAfter?: number } = {}): Promise<ApplyResult> {
  if (options.failAfter !== undefined && (!Number.isSafeInteger(options.failAfter) || options.failAfter < 0)) throw new Error('failAfter must be a nonnegative integer');
  if (plan.version !== 1 || plan.diagnostics.some(diagnostic => diagnostic.severity === 'error')) throw new Error('Cannot apply a plan with error diagnostics');
  validateState(plan.state, true);
  if (!path.isAbsolute(plan.statePath)) throw new Error('State path must be absolute');
  const statePath = path.resolve(plan.statePath);
  // Recover an interrupted cutover before checking a newly supplied plan. New
  // state roots still get the full preflight before any metadata is created.
  if (!await statOrNull(path.dirname(statePath))) await preflight(plan);
  return withLock(statePath, async () => {
    await recoverUnlocked(statePath);
    const expected = await preflight(plan);
    const backups = path.join(path.dirname(statePath), 'backups');
    await privateDirectory(backups);
    const directory = path.join(backups, `txn-${randomUUID()}`);
    await fs.mkdir(directory, { mode: 0o700 });
    const journalPath = path.join(directory, 'journal.json');
    const journal: Journal = { version: 1, statePath, status: 'pending', entries: [] };
    const created: string[] = [];
    const prepared: Entry[] = [];
    const stagedSources = new Map<string, string>();
    const ignoredWork = new Set<string>();
    const ignoredParents = new Set<string>();
    const ignoreStaging = async (file: string): Promise<boolean> => {
      if (ignoredWork.has(file)) return true;
      if (!ignoredParents.has(file)) return false;
      const stat = await statOrNull(file);
      if (!stat) return true;
      if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
      for (const name of await fs.readdir(file)) if (!await ignoreStaging(path.join(file, name))) return false;
      return true;
    };
    let journalWritten = false;
    let completed = 0;
    const inject = (): void => { if (options.failAfter !== undefined && completed >= options.failAfter) throw new Error(`Injected transaction failure after ${completed} writes`); };
    try {
      for (const operation of plan.operations) {
        const output = path.resolve(operation.path);
        await createParents(output, created);
        for (const parent of created) ignoredParents.add(path.resolve(parent));
        const work = await fs.mkdtemp(path.join(path.dirname(output), '.mishmash-txn-'));
        await fs.chmod(work, 0o700);
        const entry: Entry = { path: output, before: expected.get(output)!, after: null, backup: null, work };
        prepared.push(entry);
        ignoredWork.add(path.resolve(work));
        if (entry.before !== null) {
          entry.backup = path.join(directory, `backup-${prepared.length - 1}`);
          await copyTree(entry.path, entry.backup);
          if (await hashPath(entry.backup) !== entry.before) throw changed(entry.path);
        }
        const staged = path.join(work, 'new');
        await prepareOperation(operation, staged, operation.kind === 'copy' || operation.kind === 'link' ? stagedSources.get(path.resolve(operation.source)) : undefined);
        if (operation.kind === 'copy' || operation.kind === 'write') stagedSources.set(path.resolve(operation.path), staged);
        entry.after = await hashPath(path.join(work, 'new'));
        await syncDirectory(work);
        journal.entries.push(entry);
      }
      // Staging can take time: authenticate all inputs again before the first native write.
      for (const [file, hash] of expected) if (await hashTree(file, ignoreStaging) !== hash) throw new Error(`Stale plan precondition: ${file}`);
      await atomicJson(journalPath, journal);
      journalWritten = true;
      for (const [file, hash] of expected) if (await hashTree(file, ignoreStaging) !== hash) throw new Error(`Stale plan precondition: ${file}`);
      inject();
      for (const entry of journal.entries) {
        await install(entry);
        completed++;
        inject();
      }
      const state = structuredClone(plan.state);
      const installedHashes = new Map<string, string | null>();
      for (const entry of journal.entries) {
        const hash = await hashPath(entry.path);
        if (hash !== entry.after) throw changed(entry.path);
        installedHashes.set(path.resolve(entry.path), hash);
      }
      for (const [key, managed] of Object.entries(state.managed)) {
        const file = path.resolve(managed.path);
        if (!installedHashes.has(file)) continue;
        const hash = installedHashes.get(file)!;
        if (hash === null) delete state.managed[key];
        else managed.hash = hash;
      }
      const stateWork = await fs.mkdtemp(path.join(path.dirname(statePath), '.mishmash-txn-'));
      await fs.chmod(stateWork, 0o700);
      const stateEntry: Entry = { path: statePath, before: expected.get(statePath)!, after: null, backup: null, work: stateWork };
      prepared.push(stateEntry);
      if (stateEntry.before !== null) {
        stateEntry.backup = path.join(directory, `backup-${prepared.length - 1}`);
        await copyTree(statePath, stateEntry.backup);
        if (await hashPath(stateEntry.backup) !== stateEntry.before) throw changed(statePath);
      }
      await writeFileDurable(path.join(stateWork, 'new'), JSON.stringify(state, null, 2) + '\n', 0o600);
      stateEntry.after = await hashPath(path.join(stateWork, 'new'));
      journal.entries.push(stateEntry);
      await atomicJson(journalPath, journal);
      await install(stateEntry);
      completed++;
      inject();
      journal.status = 'committed';
      await atomicJson(journalPath, journal);
    } catch (error) {
      if (journalWritten && journal.status !== 'committed') {
        try { await rollback(journal, journalPath); }
        catch (recoveryError) { throw new AggregateError([error, recoveryError], `Transaction failed; recovery required, backups retained: ${directory}`); }
      }
      for (const entry of prepared) await removeWork(entry);
      for (const parent of [...created].reverse()) {
        try { await fs.rmdir(parent); } catch (cleanupError) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((cleanupError as NodeJS.ErrnoException).code ?? '')) throw cleanupError; }
      }
      throw error;
    }
    for (const entry of journal.entries) await removeWork(entry);
    return { applied: true, changes: plan.operations.length, backupDirectory: directory };
  });
}
