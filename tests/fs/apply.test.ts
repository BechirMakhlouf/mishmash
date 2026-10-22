import { chmodSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { chmod, lstat, mkdir, readFile, readdir, readlink, rename, stat, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Context, Operation, PathSnapshot, Plan } from '../../src/model.js';
import { applyPlan } from '../../src/fs/apply.js';
import { inspectRecovery } from '../../src/fs/recover.js';
import { hashBytes, snapshotPath, snapshotsEqual } from '../../src/fs/snapshot.js';
import { decodeJournal, encodeOwnershipState, getStatePaths } from '../../src/state.js';
import { createSandbox, putFile, type Sandbox } from '../helpers/sandbox.js';

const sandboxes: Sandbox[] = [];
afterEach(async () => { await Promise.all(sandboxes.splice(0).map(sandbox => sandbox.cleanup())); });
async function sandbox(): Promise<Sandbox> { const result = await createSandbox(); sandboxes.push(result); return result; }
function plan(context: Context, operations: Operation[], preconditions: PathSnapshot[] = []): Plan {
  return { version: 1, id: 'reviewed-test', context, request: { resourceIds: ['selected'], authority: { version: 1, sources: [], resourceAuthorities: {} }, destinations: [], configuration: 'private-project' }, operations, preconditions, findings: [], summary: { authorities: [], resources: [], destinations: [], additions: operations.length, updates: 0, removals: 0, unchanged: 1 } };
}
async function write(path: string, bytes: string | Uint8Array, purpose: 'resource' | 'state' = 'resource', mode = 0o644): Promise<Operation> {
  return { kind: 'write', path, expected: await snapshotPath(path), content: { kind: 'bytes', bytes: typeof bytes === 'string' ? Buffer.from(bytes) : bytes }, mode, resourceIds: ['selected'], purpose, description: 'Replace selected file' };
}
async function directory(path: string, mode = 0o755, purpose: 'resource' | 'state' = 'resource'): Promise<Operation> {
  return { kind: 'mkdir', path, expected: await snapshotPath(path), mode, resourceIds: ['selected'], purpose, description: 'Create selected directory' };
}
async function copy(source: string, target: string, mode = 0o644): Promise<Operation> {
  return { kind: 'write', path: target, expected: await snapshotPath(target), content: { kind: 'source', path: source, snapshot: await snapshotPath(source) }, mode, resourceIds: ['selected'], purpose: 'resource', description: 'Copy complete asset' };
}
async function link(path: string, target: string): Promise<Operation> {
  return { kind: 'symlink', path, expected: await snapshotPath(path), target, resourceIds: ['selected'], purpose: 'resource', description: 'Link selected authority' };
}
async function bytesEqual(path: string, bytes: string | Uint8Array): Promise<boolean> { return (await readFile(path)).equals(Buffer.from(bytes)); }

// Every intent is concrete and reviewed here; these tests do not rely on a planner implementation.
describe('applyPlan', () => {
  it('declines, honors an already-aborted signal, and rejects blocking evidence without any writes', async () => {
    const { root, context } = await sandbox();
    const target = join(context.projectRoot, 'output');
    const reviewed = plan(context, [await write(target, 'selected')]);
    const before = await snapshotPath(root);
    expect((await applyPlan(reviewed, { confirmed: false })).status).toBe('declined');
    const controller = new AbortController(); controller.abort();
    expect((await applyPlan(reviewed, { confirmed: true, signal: controller.signal })).status).toBe('cancelled');
    for (const code of ['UNMANAGED_COLLISION', 'OWNED_OUTPUT_DRIFT']) {
      reviewed.findings = [{ severity: 'error', code, message: 'Review ownership evidence.', path: target }];
      const result = await applyPlan(reviewed, { confirmed: true });
      expect(result.status).toBe('blocked');
      expect(result.findings.some(item => item.code === code)).toBe(true);
    }
    expect(snapshotsEqual(before, await snapshotPath(root))).toBe(true);
  });

  it.each(['target-bytes', 'target-mode', 'source-bytes', 'source-tree', 'source-mode', 'parent-link'] as const)('rejects stale %s before output or state writes', async mutation => {
    const { context } = await sandbox();
    const source = join(context.projectRoot, 'source');
    const targetParent = join(context.projectRoot, 'destination');
    const target = join(targetParent, 'asset');
    await putFile(join(source, 'asset'), 'reviewed source', 0o640);
    await putFile(target, 'reviewed target', 0o640);
    const reviewed = plan(context, [await copy(join(source, 'asset'), target, 0o640)], [await snapshotPath(source)]);
    if (mutation === 'target-bytes') await putFile(target, 'external target');
    if (mutation === 'target-mode') await chmod(target, 0o600);
    if (mutation === 'source-bytes') await putFile(join(source, 'asset'), 'external source');
    if (mutation === 'source-tree') await putFile(join(source, 'new-entry'), 'external addition');
    if (mutation === 'source-mode') await chmod(join(source, 'asset'), 0o600);
    if (mutation === 'parent-link') {
      await rename(targetParent, `${targetParent}-saved`);
      await symlink(`${targetParent}-saved`, targetParent);
    }
    const before = await snapshotPath(context.projectRoot);
    const result = await applyPlan(reviewed, { confirmed: true });
    expect(result.status).toBe('blocked');
    expect(snapshotsEqual(before, await snapshotPath(context.projectRoot))).toBe(true);
    expect((await readdir(context.stateHome)).length).toBe(0);
  });

  it('copies complete binary, nested, executable and link assets, removes only the selected subtree, and commits state last', async () => {
    const { context } = await sandbox();
    const source = join(context.projectRoot, 'authority');
    const output = join(context.projectRoot, 'destination');
    const binary = Uint8Array.from([0, 255, 1, 128, 13, 10]);
    await putFile(join(source, 'assets', 'binary'), binary, 0o640);
    await putFile(join(source, 'run'), '#!/bin/sh\nexit 0\n', 0o751);
    await putFile(join(source, '.hidden'), 'hidden asset', 0o600);
    await mkdir(join(source, 'empty'), { mode: 0o750 });
    await symlink('../run', join(source, 'assets', 'internal'));
    await putFile(join(output, 'unchecked'), 'leave this alone');
    await putFile(join(output, 'obsolete', 'old'), 'old selected asset', 0o751);
    await putFile(join(output, 'mode-only'), 'same bytes', 0o644);
    const paths = await getStatePaths(context);
    const obsolete = join(output, 'obsolete');
    const operations: Operation[] = [
      await directory(dirname(paths.ownershipPath), 0o700, 'state'),
      await write(paths.ownershipPath, encodeOwnershipState({ version: 1, receipts: [] }), 'state', 0o600),
      await directory(join(output, 'assets')),
      await copy(join(source, 'assets', 'binary'), join(output, 'assets', 'binary'), 0o640),
      await copy(join(source, 'run'), join(output, 'run'), 0o751),
      await copy(join(source, '.hidden'), join(output, '.hidden'), 0o600),
      await directory(join(output, 'empty'), 0o750),
      await link(join(output, 'assets', 'internal'), '../run'),
      await link(join(context.projectRoot, 'linked-authority'), source),
      { kind: 'remove', path: obsolete, expected: await snapshotPath(obsolete), purpose: 'resource', resourceIds: ['selected'], description: 'Remove obsolete selected subtree' },
      { kind: 'chmod', path: join(output, 'mode-only'), expected: await snapshotPath(join(output, 'mode-only')), mode: 0o751, purpose: 'resource', resourceIds: ['selected'], description: 'Preserve executable mode' },
    ];
    const replacements: string[] = [];
    const result = await applyPlan(plan(context, operations, [await snapshotPath(source), await snapshotPath(output)]), { confirmed: true, onCheckpoint: (phase, path) => { if (phase === 'replaced') replacements.push(path!); } });
    expect(result.status).toBe('applied');
    expect(replacements.at(-1)).toBe(paths.ownershipPath);
    expect(await bytesEqual(join(output, 'assets', 'binary'), binary)).toBe(true);
    expect(await bytesEqual(join(output, '.hidden'), 'hidden asset')).toBe(true);
    expect((await stat(join(output, 'run'))).mode & 0o777).toBe(0o751);
    expect((await stat(join(output, 'mode-only'))).mode & 0o777).toBe(0o751);
    expect((await stat(join(output, 'empty'))).mode & 0o777).toBe(0o750);
    expect(await readlink(join(output, 'assets', 'internal'))).toBe('../run');
    expect(await readlink(join(context.projectRoot, 'linked-authority'))).toBe(source);
    expect(await bytesEqual(join(output, 'unchecked'), 'leave this alone')).toBe(true);
    expect((await snapshotPath(obsolete)).kind).toBe('missing');
    const journal = decodeJournal(JSON.parse(await readFile(join(result.transactionPath!, 'journal.json'), 'utf8')) as unknown);
    expect(journal.status).toBe('committed');
    const removed = journal.entries.find(entry => entry.path === obsolete)!;
    expect(await bytesEqual(join(removed.backupPath!, hashBytes('old')), 'old selected asset')).toBe(true);
    for (const entry of journal.entries) {
      if (!entry.backupPath) continue;
      expect((await stat(entry.backupPath)).mode & 0o777).toBe(0o700);
      for (const file of await readdir(entry.backupPath)) expect((await stat(join(entry.backupPath, file))).mode & 0o777).toBe(0o600);
    }
    expect((await stat(join(result.transactionPath!, 'journal.json'))).mode & 0o777).toBe(0o600);
    expect((await stat(result.transactionPath!)).mode & 0o777).toBe(0o700);
    expect((await inspectRecovery(context)).transactions.length).toBe(0);
  });

  it.each(['cancel', 'failure'] as const)('restores the original bytes and modes after a real first replacement followed by %s', async action => {
    const { context } = await sandbox();
    const first = join(context.projectRoot, 'first');
    const second = join(context.projectRoot, 'second');
    await putFile(first, 'original first', 0o751);
    await putFile(second, 'original second', 0o640);
    const controller = new AbortController();
    let observedRealReplacement = false;
    const result = await applyPlan(plan(context, [await write(first, 'replacement first'), await write(second, 'replacement second')]), {
      confirmed: true, signal: controller.signal, onCheckpoint: phase => {
        if (phase !== 'replaced') return;
        observedRealReplacement = readFileSync(first).equals(Buffer.from('replacement first'));
        if (action === 'cancel') controller.abort(); else throw new Error('deliberate checkpoint failure');
      },
    });
    expect(observedRealReplacement).toBe(true);
    expect(result.status).toBe('recovered');
    expect(await bytesEqual(first, 'original first')).toBe(true);
    expect(await bytesEqual(second, 'original second')).toBe(true);
    expect((await stat(first)).mode & 0o777).toBe(0o751);
    expect((await inspectRecovery(context)).transactions.length).toBe(0);
    expect((await readdir(context.projectRoot)).some(name => name.startsWith('.mishmash-'))).toBe(false);
  });

  it('rechecks a target changed during preparation without overwriting the new external edit', async () => {
    const { context } = await sandbox();
    const target = join(context.projectRoot, 'target');
    await putFile(target, 'reviewed');
    const result = await applyPlan(plan(context, [await write(target, 'approved')]), { confirmed: true, onCheckpoint: phase => { if (phase === 'prepared') writeFileSync(target, 'external edit'); } });
    expect(result.status).toBe('blocked');
    expect(await bytesEqual(target, 'external edit')).toBe(true);
    expect((await inspectRecovery(context)).transactions.length).toBe(0);
  });

  it('rechecks the complete source tree between replacements and rolls back only its own changes', async () => {
    const { context } = await sandbox();
    const source = join(context.projectRoot, 'source');
    await putFile(join(source, 'one'), 'new one');
    await putFile(join(source, 'two'), 'new two');
    const first = join(context.projectRoot, 'first');
    const second = join(context.projectRoot, 'second');
    await putFile(first, 'original');
    const reviewed = plan(context, [await copy(join(source, 'one'), first), await copy(join(source, 'two'), second)], [await snapshotPath(source)]);
    const result = await applyPlan(reviewed, { confirmed: true, onCheckpoint: (phase, path) => { if (phase === 'replaced' && path === first) writeFileSync(join(source, 'unexpected'), 'external source addition'); } });
    expect(result.status).toBe('recovered');
    expect(await bytesEqual(first, 'original')).toBe(true);
    expect((await snapshotPath(second)).kind).toBe('missing');
    expect(await bytesEqual(join(source, 'unexpected'), 'external source addition')).toBe(true);
  });

  it('detects an external parent-link swap after its approved mkdir and never writes through it', async () => {
    const { context } = await sandbox();
    const output = join(context.projectRoot, 'created');
    const external = join(context.homeDir, 'external');
    await mkdir(external);
    const reviewed = plan(context, [await directory(output), await write(join(output, 'new-file'), 'approved')]);
    const result = await applyPlan(reviewed, { confirmed: true, onCheckpoint: (phase, path) => {
      if (phase === 'replaced' && path === output) { renameSync(output, `${output}-saved`); symlinkSync(external, output); }
    } });
    expect(result.status).toBe('recovery-required');
    expect((await lstat(output)).isSymbolicLink()).toBe(true);
    expect((await readdir(external)).length).toBe(0);
    expect((await inspectRecovery(context)).transactions.length).toBe(1);
  });

  it('replaces an approved final symlink without writing through it or changing the linked file', async () => {
    const { context } = await sandbox();
    const external = join(context.homeDir, 'external');
    const target = join(context.projectRoot, 'target');
    await putFile(external, 'outside original', 0o600);
    await symlink(external, target);
    const result = await applyPlan(plan(context, [await write(target, 'approved replacement')]), { confirmed: true });
    expect(result.status).toBe('applied');
    expect((await lstat(target)).isFile()).toBe(true);
    expect(await bytesEqual(target, 'approved replacement')).toBe(true);
    expect(await bytesEqual(external, 'outside original')).toBe(true);
  });

  it('rejects linked source payloads and escaping internal source links', async () => {
    const { context } = await sandbox();
    const source = join(context.projectRoot, 'source');
    const outside = join(context.homeDir, 'outside');
    const target = join(context.projectRoot, 'target');
    await putFile(outside, 'outside source');
    await mkdir(source);
    await symlink(outside, join(source, 'linked'));
    expect((await applyPlan(plan(context, [await copy(join(source, 'linked'), target)]), { confirmed: true })).status).toBe('blocked');
    await putFile(join(source, 'regular'), 'source');
    expect((await applyPlan(plan(context, [await copy(join(source, 'regular'), target)], [await snapshotPath(source)]), { confirmed: true })).status).toBe('blocked');
    expect((await snapshotPath(target)).kind).toBe('missing');
    expect((await readdir(context.stateHome)).length).toBe(0);
  });

  it('does not rewrite equal bytes or create metadata for an equal-byte operation or an unchanged rerun', async () => {
    const { root, context } = await sandbox();
    const target = join(context.projectRoot, 'output');
    await putFile(target, 'same bytes', 0o640);
    const before = await snapshotPath(root);
    const originalTime = (await stat(target, { bigint: true })).mtimeNs;
    expect((await applyPlan(plan(context, [await write(target, 'same bytes', 'resource', 0o640)]), { confirmed: true })).status).toBe('unchanged');
    expect(snapshotsEqual(before, await snapshotPath(root))).toBe(true);
    expect((await stat(target, { bigint: true })).mtimeNs).toBe(originalTime);
    const statePaths = await getStatePaths(context);
    const stateBytes = encodeOwnershipState({ version: 1, receipts: [] });
    const applied = await applyPlan(plan(context, [await write(target, 'new bytes'), await write(statePaths.ownershipPath, stateBytes, 'state', 0o600)]), { confirmed: true });
    expect(applied.status).toBe('applied');
    const paths = await getStatePaths(context);
    const transactions = await readdir(paths.transactionRoot);
    const after = await snapshotPath(root);
    const outputStat = await stat(target, { bigint: true });
    const journalStat = await stat(join(applied.transactionPath!, 'journal.json'), { bigint: true });
    const stateStat = await stat(paths.ownershipPath, { bigint: true });
    expect((await applyPlan(plan(context, []), { confirmed: true })).status).toBe('unchanged');
    expect(snapshotsEqual(after, await snapshotPath(root))).toBe(true);
    expect((await stat(target, { bigint: true })).mtimeNs).toBe(outputStat.mtimeNs);
    expect((await stat(join(applied.transactionPath!, 'journal.json'), { bigint: true })).mtimeNs).toBe(journalStat.mtimeNs);
    expect((await stat(paths.ownershipPath, { bigint: true })).mtimeNs).toBe(stateStat.mtimeNs);
    expect(await bytesEqual(paths.ownershipPath, stateBytes)).toBe(true);
    expect(await readdir(paths.transactionRoot)).toEqual(transactions);
  });

  it('rechecks chmod preconditions after preparation and preserves an external mode edit', async () => {
    const { context } = await sandbox();
    const target = join(context.projectRoot, 'mode');
    await putFile(target, 'unchanged bytes', 0o644);
    const operation: Operation = { kind: 'chmod', path: target, expected: await snapshotPath(target), mode: 0o751, resourceIds: ['selected'], purpose: 'resource', description: 'Set executable mode' };
    const result = await applyPlan(plan(context, [operation]), { confirmed: true, onCheckpoint: phase => { if (phase === 'prepared') chmodSync(target, 0o600); } });
    expect(result.status).toBe('blocked');
    expect((await stat(target)).mode & 0o777).toBe(0o600);
  });

  it('restores children-first removals even though recovery must recreate their parent directory inode', async () => {
    const { context } = await sandbox();
    const parent = join(context.projectRoot, 'selected');
    const child = join(parent, 'child');
    await putFile(child, 'original asset', 0o751);
    const operations: Operation[] = [
      { kind: 'remove', path: child, expected: await snapshotPath(child), purpose: 'resource', resourceIds: ['selected'], description: 'Remove obsolete asset' },
      { kind: 'remove', path: parent, expected: await snapshotPath(parent), purpose: 'resource', resourceIds: ['selected'], description: 'Remove obsolete directory' },
    ];
    const result = await applyPlan(plan(context, operations), { confirmed: true, onCheckpoint: (phase, path) => { if (phase === 'replaced' && path === parent) throw new Error('fail after parent removal'); } });
    expect(result.status).toBe('recovered');
    expect(await bytesEqual(child, 'original asset')).toBe(true);
    expect((await stat(child)).mode & 0o777).toBe(0o751);
    expect((await inspectRecovery(context)).transactions.length).toBe(0);
  });

  it('removes its own newly created nested output during cancellation without leaving staging directories', async () => {
    const { context } = await sandbox();
    const parent = join(context.projectRoot, 'new-tree');
    const nested = join(parent, 'nested');
    const target = join(nested, 'asset');
    const controller = new AbortController();
    const result = await applyPlan(plan(context, [await directory(parent), await directory(nested), await write(target, 'asset')]), { confirmed: true, signal: controller.signal, onCheckpoint: (phase, path) => { if (phase === 'replaced' && path === target) controller.abort(); } });
    expect(result.status).toBe('recovered');
    expect((await snapshotPath(parent)).kind).toBe('missing');
    expect((await readdir(context.projectRoot)).length).toBe(0);
  });

  it('rolls back both resources and the last state write when failure occurs after metadata replacement', async () => {
    const { context } = await sandbox();
    const target = join(context.projectRoot, 'resource');
    await putFile(target, 'original resource', 0o640);
    const paths = await getStatePaths(context);
    const reviewed = plan(context, [await write(paths.ownershipPath, encodeOwnershipState({ version: 1, receipts: [] }), 'state', 0o600), await write(target, 'approved resource')]);
    const result = await applyPlan(reviewed, { confirmed: true, onCheckpoint: (phase, path) => { if (phase === 'replaced' && path === paths.ownershipPath) throw new Error('fail after state replacement'); } });
    expect(result.status).toBe('recovered');
    expect(await bytesEqual(target, 'original resource')).toBe(true);
    expect((await snapshotPath(paths.ownershipPath)).kind).toBe('missing');
    expect((await inspectRecovery(context)).transactions.length).toBe(0);
  });

  it('creates an approved absent XDG state root and missing ancestors privately only after confirmation', async () => {
    const { root, context: existingContext } = await sandbox();
    const context = { ...existingContext, stateHome: join(root, 'absent', 'nested', 'state') };
    const target = join(context.projectRoot, 'output');
    const paths = await getStatePaths(context);
    const reviewed = plan(context, [await write(target, 'approved'), await write(paths.ownershipPath, encodeOwnershipState({ version: 1, receipts: [] }), 'state', 0o600)]);
    const before = await snapshotPath(root);
    expect((await applyPlan(reviewed, { confirmed: false })).status).toBe('declined');
    expect(snapshotsEqual(before, await snapshotPath(root))).toBe(true);
    expect((await applyPlan(reviewed, { confirmed: true })).status).toBe('applied');
    expect(await bytesEqual(target, 'approved')).toBe(true);
    for (const directory of [join(root, 'absent'), join(root, 'absent', 'nested'), context.stateHome, dirname(paths.lockPath)]) expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(paths.ownershipPath)).mode & 0o777).toBe(0o600);
  });

  it.each(['symlink', 'file'] as const)('rejects an unsafe %s ancestor of an absent XDG state root without writes', async kind => {
    const { root, context: existingContext } = await sandbox();
    const ancestor = join(root, 'unsafe-state');
    if (kind === 'symlink') await symlink(existingContext.homeDir, ancestor);
    else await putFile(ancestor, 'not a directory');
    const context = { ...existingContext, stateHome: join(ancestor, 'state') };
    const target = join(context.projectRoot, 'output');
    const reviewed = plan(context, [await write(target, 'must not write')]);
    const before = await snapshotPath(root);
    expect((await applyPlan(reviewed, { confirmed: true })).status).toBe('blocked');
    expect(snapshotsEqual(before, await snapshotPath(root))).toBe(true);
  });
});
