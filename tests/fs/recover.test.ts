import { writeFileSync } from 'node:fs';
import { chmod, mkdir, open, readFile, readdir, readlink, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Context, Plan, TransactionJournal } from '../../src/model.js';
import { applyPlan } from '../../src/fs/apply.js';
import { inspectRecovery, recoverTransaction } from '../../src/fs/recover.js';
import { hashBytes, snapshotPath, snapshotsEqual } from '../../src/fs/snapshot.js';
import { acquireLock, syncDirectory } from '../../src/fs/transaction.js';
import { encodeJournal, getStatePaths } from '../../src/state.js';
import { createSandbox, putFile, type Sandbox } from '../helpers/sandbox.js';

const sandboxes: Sandbox[] = [];
afterEach(async () => { await Promise.all(sandboxes.splice(0).map(sandbox => sandbox.cleanup())); });
async function sandbox(): Promise<Sandbox> { const result = await createSandbox(); sandboxes.push(result); return result; }
function plan(context: Context): Plan {
  return { version: 1, id: 'reviewed-test', context, request: { resourceIds: [], authority: { version: 1, sources: [], resourceAuthorities: {} }, destinations: [], configuration: 'private-project' }, operations: [], preconditions: [], findings: [], summary: { authorities: [], resources: [], destinations: [], additions: 0, updates: 0, removals: 0, unchanged: 1 } };
}
async function privateDirectory(path: string): Promise<void> { await mkdir(path, { recursive: true, mode: 0o700 }); await chmod(path, 0o700); }
async function persist(path: string, journal: TransactionJournal): Promise<void> { await writeFile(join(path, 'journal.json'), encodeJournal(journal), { mode: 0o600 }); }
async function interruptedWrite(context: Context): Promise<{ path: string; journal: TransactionJournal; target: string; backup: string }> {
  const paths = await getStatePaths(context);
  await privateDirectory(join(context.stateHome, 'mishmash'));
  await privateDirectory(paths.transactionRoot);
  const path = join(paths.transactionRoot, 'crash-write');
  const backup = join(path, 'backups', '0');
  await privateDirectory(path);
  await privateDirectory(join(path, 'backups'));
  await privateDirectory(backup);
  const target = join(context.projectRoot, 'target');
  await putFile(target, 'original private data', 0o751);
  const before = await snapshotPath(target);
  await putFile(join(backup, hashBytes('')), 'original private data', 0o600);
  await putFile(target, 'approved new data');
  await chmod(target, 0o644);
  const after = await snapshotPath(target);
  const journal: TransactionJournal = { version: 1, id: 'crash-write', context, status: 'applying', entries: [{ path: target, backupPath: backup, before, after, operation: 'write', state: 'intent' }] };
  await persist(path, journal);
  return { path, journal, target, backup };
}
async function bytesEqual(path: string, bytes: string | Uint8Array): Promise<boolean> { return (await readFile(path)).equals(Buffer.from(bytes)); }

describe('explicit transaction recovery', () => {
  it('inspects real intent journals read-only and requires explicit confirmation before recovery writes', async () => {
    const { root, context } = await sandbox();
    const transaction = await interruptedWrite(context);
    const before = await snapshotPath(root);
    const journalTime = (await stat(join(transaction.path, 'journal.json'), { bigint: true })).mtimeNs;
    const inspection = await inspectRecovery(context);
    expect(inspection.findings.length).toBe(0);
    expect(inspection.transactions.length).toBe(1);
    expect((await recoverTransaction(transaction, { confirmed: false })).status).toBe('declined');
    const controller = new AbortController(); controller.abort();
    expect((await recoverTransaction(transaction, { confirmed: true, signal: controller.signal })).status).toBe('cancelled');
    expect(snapshotsEqual(before, await snapshotPath(root))).toBe(true);
    expect((await stat(join(transaction.path, 'journal.json'), { bigint: true })).mtimeNs).toBe(journalTime);
    expect(await bytesEqual(transaction.target, 'approved new data')).toBe(true);
  });

  it('restores the preimage after a crash between mutation and replaced-journal persistence', async () => {
    const { context } = await sandbox();
    const transaction = await interruptedWrite(context);
    const result = await recoverTransaction(transaction, { confirmed: true });
    expect(result.status).toBe('recovered');
    expect(await bytesEqual(transaction.target, 'original private data')).toBe(true);
    expect((await stat(transaction.target)).mode & 0o777).toBe(0o751);
    expect(await bytesEqual(join(transaction.backup, hashBytes('')), 'original private data')).toBe(true);
    expect((await inspectRecovery(context)).transactions.length).toBe(0);
    expect((await snapshotPath((await getStatePaths(context)).lockPath)).kind).toBe('missing');
    expect((await stat(transaction.path)).mode & 0o777).toBe(0o700);
    expect((await stat(join(transaction.path, 'journal.json'))).mode & 0o777).toBe(0o600);
    expect((await stat(join(transaction.backup, hashBytes('')))).mode & 0o777).toBe(0o600);
  });

  it('preserves an external edit during rollback, retains usable backup data, and blocks later apply until recovery succeeds', async () => {
    const { context } = await sandbox();
    const target = join(context.projectRoot, 'target');
    await putFile(target, 'original secret value', 0o640);
    const reviewed = plan(context);
    reviewed.operations = [{ kind: 'write', path: target, expected: await snapshotPath(target), content: { kind: 'bytes', bytes: Buffer.from('approved value') }, mode: 0o644, purpose: 'resource', resourceIds: ['selected'], description: 'Approved selected update' }];
    const result = await applyPlan(reviewed, { confirmed: true, onCheckpoint: phase => { if (phase === 'replaced') { writeFileSync(target, 'external replacement'); throw new Error('stop after real replacement'); } } });
    expect(result.status).toBe('recovery-required');
    expect(await bytesEqual(target, 'external replacement')).toBe(true);
    let inspection = await inspectRecovery(context);
    expect(inspection.transactions.length).toBe(1);
    const entry = inspection.transactions[0]!.journal.entries[0]!;
    expect(await bytesEqual(join(entry.backupPath!, hashBytes('')), 'original secret value')).toBe(true);
    const before = await snapshotPath(context.projectRoot);
    expect((await applyPlan(plan(context), { confirmed: true })).status).toBe('blocked');
    const failed = await recoverTransaction(inspection.transactions[0]!, { confirmed: true });
    expect(failed.status).toBe('recovery-required');
    expect(snapshotsEqual(before, await snapshotPath(context.projectRoot))).toBe(true);
    expect(JSON.stringify(failed.findings).includes('original secret value')).toBe(false);
    // The user resolves the unrelated edit themselves; recovery never force-overwrites it.
    await putFile(target, 'approved value');
    await chmod(target, 0o644);
    inspection = await inspectRecovery(context);
    expect((await recoverTransaction(inspection.transactions[0]!, { confirmed: true })).status).toBe('recovered');
    expect(await bytesEqual(target, 'original secret value')).toBe(true);
    expect((await applyPlan(plan(context), { confirmed: true })).status).toBe('unchanged');
  });

  it('retains the current file and journal when a backup is unreadable or corrupted', async () => {
    const { context } = await sandbox();
    const transaction = await interruptedWrite(context);
    await putFile(join(transaction.backup, hashBytes('')), 'corrupted backup');
    const result = await recoverTransaction(transaction, { confirmed: true });
    expect(result.status).toBe('recovery-required');
    expect(await bytesEqual(transaction.target, 'approved new data')).toBe(true);
    expect((await snapshotPath(join(transaction.path, 'journal.json'))).kind).toBe('file');
    expect((await inspectRecovery(context)).transactions.length).toBe(1);
    expect((await applyPlan(plan(context), { confirmed: true })).status).toBe('blocked');
  });

  it('restores a removed complete tree with binary assets, private backups, internal links and executable modes', async () => {
    const { context } = await sandbox();
    const paths = await getStatePaths(context);
    await privateDirectory(join(context.stateHome, 'mishmash'));
    await privateDirectory(paths.transactionRoot);
    const path = join(paths.transactionRoot, 'crash-remove');
    const backupPath = join(path, 'backups', '0');
    await privateDirectory(path); await privateDirectory(join(path, 'backups')); await privateDirectory(backupPath);
    const target = join(context.projectRoot, 'selected-tree');
    const binary = Uint8Array.from([0, 255, 128, 42]);
    await putFile(join(target, 'nested', 'binary'), binary, 0o640);
    await putFile(join(target, 'run'), 'executable asset', 0o751);
    await mkdir(join(target, 'empty'), { mode: 0o750 });
    await symlink('../run', join(target, 'nested', 'internal'));
    const before = await snapshotPath(target);
    for (const entry of before.entries) if (entry.kind === 'file') await putFile(join(backupPath, hashBytes(entry.relativePath)), await readFile(join(target, entry.relativePath)), 0o600);
    const stage = join(context.projectRoot, '.mishmash-crash-remove-0');
    await privateDirectory(stage);
    await rename(target, join(stage, 'removed'));
    const journal: TransactionJournal = { version: 1, id: 'crash-remove', context, status: 'applying', entries: [{ path: target, backupPath, before, after: await snapshotPath(target), operation: 'remove', state: 'intent' }] };
    await persist(path, journal);
    expect((await recoverTransaction({ path, journal }, { confirmed: true })).status).toBe('recovered');
    expect(snapshotsEqual(before, await snapshotPath(target))).toBe(true);
    expect(await bytesEqual(join(target, 'nested', 'binary'), binary)).toBe(true);
    expect((await stat(join(target, 'run'))).mode & 0o777).toBe(0o751);
    expect(await readlink(join(target, 'nested', 'internal'))).toBe('../run');
    expect((await snapshotPath(stage)).kind).toBe('missing');
  });

  it('does not discard the original renamed tree if backup verification fails', async () => {
    const { context } = await sandbox();
    const transaction = await interruptedWrite(context);
    // A remove intent can retain its original, same-device preimage as well as its private backup.
    const stage = join(context.projectRoot, '.mishmash-crash-write-0');
    await privateDirectory(stage);
    await putFile(join(stage, 'removed'), 'original private data', 0o751);
    await putFile(join(transaction.backup, hashBytes('')), 'corrupted backup');
    expect((await recoverTransaction(transaction, { confirmed: true })).status).toBe('recovery-required');
    expect(await bytesEqual(join(stage, 'removed'), 'original private data')).toBe(true);
    expect(await bytesEqual(transaction.target, 'approved new data')).toBe(true);
  });

  it('settles an already-restored intent idempotently without rewriting its original bytes or mtime', async () => {
    const { context } = await sandbox();
    const transaction = await interruptedWrite(context);
    await putFile(transaction.target, 'original private data');
    await chmod(transaction.target, 0o751);
    const before = (await stat(transaction.target, { bigint: true })).mtimeNs;
    expect((await recoverTransaction(transaction, { confirmed: true })).status).toBe('recovered');
    expect((await stat(transaction.target, { bigint: true })).mtimeNs).toBe(before);
  });

  it('rejects a stale recovery review rather than trusting a supplied in-memory journal', async () => {
    const { context } = await sandbox();
    const transaction = await interruptedWrite(context);
    await persist(transaction.path, { ...transaction.journal, status: 'recovery-required' });
    const result = await recoverTransaction(transaction, { confirmed: true });
    expect(result.status).toBe('recovery-required');
    expect(await bytesEqual(transaction.target, 'approved new data')).toBe(true);
    expect((await snapshotPath((await getStatePaths(context)).lockPath)).kind).toBe('missing');
  });

  it('exposes a dead-owner orphan lock as an empty journal and settles it only after explicit recovery approval', async () => {
    const { root, context } = await sandbox();
    const paths = await getStatePaths(context);
    await privateDirectory(join(context.stateHome, 'mishmash'));
    const journal: TransactionJournal = { version: 1, id: 'orphan-lock', context, status: 'prepared', entries: [] };
    await putFile(paths.lockPath, JSON.stringify({ pid: 2147483647, token: 'orphan-token', journal }), 0o600);
    const before = await snapshotPath(root);
    const inspection = await inspectRecovery(context);
    expect(inspection.findings.length).toBe(0);
    expect(inspection.transactions.length).toBe(1);
    expect(inspection.transactions[0]!.path).toBe(join(paths.transactionRoot, journal.id));
    expect((await applyPlan(plan(context), { confirmed: true })).status).toBe('blocked');
    expect((await recoverTransaction(inspection.transactions[0]!, { confirmed: false })).status).toBe('declined');
    expect(snapshotsEqual(before, await snapshotPath(root))).toBe(true);
    expect((await recoverTransaction(inspection.transactions[0]!, { confirmed: true })).status).toBe('recovered');
    expect((await snapshotPath(paths.lockPath)).kind).toBe('missing');
    expect((await inspectRecovery(context)).transactions.length).toBe(0);
  });

  it('blocks corrupt lock and unsafe journal evidence without exposing bodies or modifying recovery data', async () => {
    const { root, context } = await sandbox();
    const transaction = await interruptedWrite(context);
    const paths = await getStatePaths(context);
    await putFile(paths.lockPath, 'not-json credential-marker', 0o600);
    const before = await snapshotPath(root);
    const inspection = await inspectRecovery(context);
    expect(inspection.findings.length).toBeGreaterThan(0);
    expect(JSON.stringify(inspection.findings).includes('credential-marker')).toBe(false);
    expect((await recoverTransaction(transaction, { confirmed: true })).status).toBe('blocked');
    expect((await applyPlan(plan(context), { confirmed: true })).status).toBe('blocked');
    expect(snapshotsEqual(before, await snapshotPath(root))).toBe(true);
    const bad = { ...transaction.journal, entries: transaction.journal.entries.map(entry => ({ ...entry, backupPath: context.homeDir })) };
    expect((await recoverTransaction({ path: transaction.path, journal: bad }, { confirmed: true })).status).toBe('recovery-required');
    expect((await readdir(context.homeDir)).length).toBe(0);
  });

  it('serializes concurrent dead-owner claims and excludes concurrent recovery and apply writers', async () => {
    const { context } = await sandbox();
    const transaction = await interruptedWrite(context);
    const paths = await getStatePaths(context);
    const intent: TransactionJournal = { version: 1, id: transaction.journal.id, context, status: 'prepared', entries: [] };
    await putFile(paths.lockPath, JSON.stringify({ pid: 2147483647, token: 'dead-owner', journal: intent }), 0o600);
    const claims = await Promise.allSettled(Array.from({ length: 12 }, () => acquireLock(paths.lockPath, true, intent)));
    const winners = claims.filter((claim): claim is PromiseFulfilledResult<() => Promise<void>> => claim.status === 'fulfilled');
    expect(winners.length).toBe(1);
    const winningLock = await snapshotPath(paths.lockPath);
    const output = join(context.projectRoot, 'new-output');
    const reviewed = plan(context);
    reviewed.operations = [{ kind: 'write', path: output, expected: await snapshotPath(output), mode: 0o644, content: { kind: 'bytes', bytes: Buffer.from('must not write') }, resourceIds: [], purpose: 'resource', description: 'Concurrent apply' }];
    const attempts = await Promise.all([recoverTransaction(transaction, { confirmed: true }), recoverTransaction(transaction, { confirmed: true }), applyPlan(reviewed, { confirmed: true })]);
    expect(attempts.every(result => result.status !== 'recovered' && result.status !== 'applied')).toBe(true);
    expect(await bytesEqual(transaction.target, 'approved new data')).toBe(true);
    expect((await snapshotPath(output)).kind).toBe('missing');
    expect(snapshotsEqual(winningLock, await snapshotPath(paths.lockPath))).toBe(true);
    await winners[0]!.value();
    const recoveries = await Promise.all([recoverTransaction(transaction, { confirmed: true }), recoverTransaction(transaction, { confirmed: true }), applyPlan(reviewed, { confirmed: true })]);
    expect(recoveries.filter(result => result.status === 'recovered').length).toBe(1);
    expect(recoveries.filter(result => result.status === 'applied').length).toBe(0);
    expect(await bytesEqual(transaction.target, 'original private data')).toBe(true);
  });

  it.each(['intent', 'restored'] as const)('cleans stages before retrying parent rollback after a crash with a child marked %s', async childState => {
    const { context } = await sandbox();
    const paths = await getStatePaths(context);
    await privateDirectory(join(context.stateHome, 'mishmash'));
    await privateDirectory(paths.transactionRoot);
    const path = join(paths.transactionRoot, 'crash-stages');
    await privateDirectory(path);
    const parent = join(context.projectRoot, 'created');
    const parentBefore = await snapshotPath(parent);
    await mkdir(parent);
    const parentAfter = await snapshotPath(parent);
    const child = join(parent, 'child');
    const childBefore = await snapshotPath(child);
    await putFile(child, 'approved child');
    const childAfter = await snapshotPath(child);
    await rm(child);
    await privateDirectory(join(parent, '.mishmash-crash-stages-1'));
    await putFile(join(parent, '.mishmash-crash-stages-1', 'payload'), 'staged child', 0o600);
    await privateDirectory(join(parent, '.mishmash-crash-stages-1-recovery'));
    const journal: TransactionJournal = { version: 1, id: 'crash-stages', context, status: 'recovering', entries: [
      { path: parent, before: parentBefore, after: parentAfter, operation: 'mkdir', state: 'replaced' },
      { path: child, before: childBefore, after: childAfter, operation: 'write', state: childState },
    ] };
    await persist(path, journal);
    expect((await recoverTransaction({ path, journal }, { confirmed: true })).status).toBe('recovered');
    expect((await snapshotPath(parent)).kind).toBe('missing');
    expect((await readdir(context.projectRoot)).length).toBe(0);
    expect((await inspectRecovery(context)).transactions.length).toBe(0);
  });

  it.each(['committed', 'recovered'] as const)('ignores %s history from a deleted project while retaining its backups', async status => {
    const { root, context } = await sandbox();
    const transaction = await interruptedWrite(context);
    await persist(transaction.path, { ...transaction.journal, status });
    await rm(context.projectRoot, { recursive: true });
    const nextContext = { ...context, projectRoot: join(root, 'next-project') };
    await mkdir(nextContext.projectRoot);
    const inspection = await inspectRecovery(nextContext);
    expect(inspection.transactions.length).toBe(0);
    expect(inspection.findings.length).toBe(0);
    const target = join(nextContext.projectRoot, 'output');
    const reviewed = plan(nextContext);
    reviewed.operations = [{ kind: 'write', path: target, expected: await snapshotPath(target), mode: 0o644, content: { kind: 'bytes', bytes: Buffer.from('next project') }, resourceIds: [], purpose: 'resource', description: 'New project output' }];
    expect((await applyPlan(reviewed, { confirmed: true })).status).toBe('applied');
    expect(await bytesEqual(target, 'next project')).toBe(true);
    expect(await bytesEqual(join(transaction.backup, hashBytes('')), 'original private data')).toBe(true);
  });

  it.each(['file', 'directory'] as const)('settles a real %s chmod rollback before marking recovery complete', async kind => {
    const { context } = await sandbox();
    const target = join(context.projectRoot, 'mode-target');
    if (kind === 'file') await putFile(target, 'unchanged data', 0o640);
    else { await mkdir(target, { mode: 0o750 }); await putFile(join(target, 'asset'), 'unchanged asset'); }
    const before = await snapshotPath(target);
    const reviewed = plan(context);
    reviewed.operations = [{ kind: 'chmod', path: target, expected: before, mode: 0o700, resourceIds: [], purpose: 'resource', description: 'Change approved mode' }];
    let observed = false;
    const result = await applyPlan(reviewed, { confirmed: true, onCheckpoint: (phase, path) => { if (phase === 'replaced' && path === target) { observed = true; throw new Error('rollback real chmod'); } } });
    expect(observed).toBe(true);
    expect(result.status).toBe('recovered');
    expect(snapshotsEqual(before, await snapshotPath(target))).toBe(true);
    expect((await inspectRecovery(context)).transactions.length).toBe(0);
    const settled = JSON.parse(await readFile(join(result.transactionPath!, 'journal.json'), 'utf8')) as TransactionJournal;
    expect(settled.status).toBe('recovered');
    expect(settled.entries[0]!.state).toBe('restored');
  });

  it('surfaces a stranded exclusive guard with actionable manual recovery guidance without deleting it', async () => {
    const { root, context } = await sandbox();
    const transaction = await interruptedWrite(context);
    const paths = await getStatePaths(context);
    const guard = `${paths.lockPath}.guard`;
    await putFile(guard, 'corrupt-owner-data', 0o600);
    const before = await snapshotPath(root);
    const inspection = await inspectRecovery(context);
    const issue = inspection.findings.find(item => item.code === 'LOCK_GUARD_PENDING');
    expect(issue?.path).toBe(guard);
    expect(issue?.remediation?.includes('manually')).toBe(true);
    expect((await recoverTransaction(transaction, { confirmed: true })).status).toBe('blocked');
    expect((await applyPlan(plan(context), { confirmed: true })).status).toBe('blocked');
    expect(snapshotsEqual(before, await snapshotPath(root))).toBe(true);
  });

  it('refuses to unlink a replacement lock even when its bytes duplicate the original owner record', async () => {
    const { context } = await sandbox();
    const transaction = await interruptedWrite(context);
    const paths = await getStatePaths(context);
    const intent: TransactionJournal = { version: 1, id: transaction.journal.id, context, status: 'prepared', entries: [] };
    const release = await acquireLock(paths.lockPath, false, intent);
    const bytes = await readFile(paths.lockPath);
    const replacement = join(context.stateHome, 'mishmash', 'replacement-lock');
    await putFile(replacement, bytes, 0o600);
    await rename(replacement, paths.lockPath);
    const external = await stat(paths.lockPath, { bigint: true });
    await expect(release()).rejects.toThrow('LOCK_CHANGED');
    expect((await stat(paths.lockPath, { bigint: true })).ino).toBe(external.ino);
    expect((await readFile(paths.lockPath)).equals(bytes)).toBe(true);
    expect((await snapshotPath(`${paths.lockPath}.guard`)).kind).toBe('missing');
  });

  it('releases its live lease while a contender holds the durable guard without deleting that guard or a later lease', async () => {
    const { context } = await sandbox();
    const transaction = await interruptedWrite(context);
    const paths = await getStatePaths(context);
    const intent: TransactionJournal = { version: 1, id: transaction.journal.id, context, status: 'prepared', entries: [] };
    const release = await acquireLock(paths.lockPath, false, intent);
    const owned = await snapshotPath(paths.lockPath);
    // Pause the real interleaving after the contender's exclusive durable claim, before
    // its lock inspection. The current owner is still live and must be able to finish.
    const guard = `${paths.lockPath}.guard`;
    const contenderGuard = await open(guard, 'wx', 0o600);
    try {
      await contenderGuard.writeFile(JSON.stringify({ pid: process.pid, token: 'held-contender-guard' }));
      await contenderGuard.sync();
      await syncDirectory(join(context.stateHome, 'mishmash'));
      const guardBefore = await snapshotPath(guard);
      const guardIdentity = await stat(guard, { bigint: true });
      await expect(acquireLock(paths.lockPath, true, intent)).rejects.toThrow('LOCK_GUARD_PENDING');
      expect(snapshotsEqual(owned, await snapshotPath(paths.lockPath))).toBe(true);
      await release();
      expect((await snapshotPath(paths.lockPath)).kind).toBe('missing');
      expect(snapshotsEqual(guardBefore, await snapshotPath(guard))).toBe(true);
      expect((await stat(guard, { bigint: true })).ino).toBe(guardIdentity.ino);
      expect((await inspectRecovery(context)).findings.some(issue => issue.code === 'LOCK_GUARD_PENDING' && issue.path === guard)).toBe(true);
    } finally { await contenderGuard.close(); }
    // Only the test's contender removes its own guard; ordinary release never does.
    await unlink(guard);
    await syncDirectory(join(context.stateHome, 'mishmash'));
    const releaseNext = await acquireLock(paths.lockPath, false, intent);
    const next = await snapshotPath(paths.lockPath);
    await expect(release()).rejects.toThrow('LOCK_CHANGED');
    expect(snapshotsEqual(next, await snapshotPath(paths.lockPath))).toBe(true);
    await releaseNext();
    expect((await snapshotPath(paths.lockPath)).kind).toBe('missing');
  });
});
