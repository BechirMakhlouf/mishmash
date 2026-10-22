import { writeFileSync } from 'node:fs';
import { chmod, mkdir, readFile, readdir, readlink, rename, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Context, Plan, TransactionJournal } from '../../src/model.js';
import { applyPlan } from '../../src/fs/apply.js';
import { inspectRecovery, recoverTransaction } from '../../src/fs/recover.js';
import { hashBytes, snapshotPath, snapshotsEqual } from '../../src/fs/snapshot.js';
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
});
