import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import type { PathLike } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { test, type TestContext } from 'node:test';
import { applyPlan, hashPath, readState } from '../src/safety.js';
import type { Operation, Plan, State } from '../src/types.js';

async function fixture(t: TestContext): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mishmash-safety-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function put(file: string, content: string, mode = 0o600): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, { mode });
  await fs.chmod(file, mode);
}
async function planFor(root: string, operations: Operation[], extraInputs: string[] = []): Promise<Plan> {
  const statePath = path.join(root, 'private-state', 'state.json');
  const inputs = new Set([statePath, ...extraInputs]);
  for (const operation of operations) {
    inputs.add(operation.path);
    if (operation.kind === 'copy' || operation.kind === 'link') inputs.add(operation.source);
  }
  const state: State = { version: 1, managed: {} };
  for (const operation of operations) if (operation.kind !== 'remove') state.managed[operation.path] = { path: operation.path, hash: '', kind: operation.kind };
  return { version: 1, command: 'sync', scope: 'project', targets: ['test'], diagnostics: [], operations, statePath, state, preconditions: await Promise.all([...inputs].map(async file => ({ path: file, hash: await hashPath(file) }))) };
}

 test('successful apply persists authenticated output hashes, private state and recoverable originals', async t => {
  const root = await fixture(t);
  const output = path.join(root, 'project', 'native.json');
  await put(output, '{"unmanaged":true}\n', 0o640);
  const originalHash = await hashPath(output);
  const plan = await planFor(root, [{ kind: 'write', path: output, content: '{"unmanaged":true,"mcpServers":{}}\n', reason: 'native projection' }]);
  plan.state.managed[output]!.keys = { mcpServers: ['owned'] };
  const result = await applyPlan(plan);
  assert.equal(result.applied, true);
  assert.equal(result.changes, 1);
  assert.ok(result.backupDirectory);
  assert.equal(await hashPath(path.join(result.backupDirectory, 'backup-0')), originalHash);
  assert.equal(await fs.readFile(output, 'utf8'), '{"unmanaged":true,"mcpServers":{}}\n');
  const state = await readState(plan.statePath);
  assert.equal(state.managed[output]!.hash, await hashPath(output));
  assert.deepEqual(state.managed[output]!.keys, { mcpServers: ['owned'] });
  assert.equal(plan.state.managed[output]!.hash, '', 'applying must not mutate the caller plan');
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(output)).mode & 0o777, 0o640);
    assert.equal((await fs.stat(plan.statePath)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.dirname(plan.statePath))).mode & 0o777, 0o700);
    assert.equal((await fs.stat(result.backupDirectory)).mode & 0o777, 0o700);
  }
  await assert.rejects(applyPlan(plan), /Stale plan precondition/);
});

test('applying one output preserves ownership baselines for edited or missing untouched outputs', async t => {
  const root = await fixture(t);
  const output = path.join(root, 'project', 'native.json');
  const edited = path.join(root, 'unselected', 'edited');
  const removed = path.join(root, 'unselected', 'removed');
  await put(edited, 'owned original');
  await put(removed, 'owned original');
  const baseline = (await hashPath(edited))!;
  const removedBaseline = (await hashPath(removed))!;
  await put(edited, 'unrelated user edit');
  await fs.unlink(removed);
  const plan = await planFor(root, [{ kind: 'write', path: output, content: 'selected output', reason: 'reconcile selected target' }]);
  plan.state.managed[edited] = { path: edited, hash: baseline, kind: 'copy' };
  plan.state.managed[removed] = { path: removed, hash: removedBaseline, kind: 'copy' };
  await applyPlan(plan);
  const state = await readState(plan.statePath);
  assert.equal(state.managed[output]!.hash, await hashPath(output));
  assert.deepEqual(state.managed[edited], plan.state.managed[edited]);
  assert.deepEqual(state.managed[removed], plan.state.managed[removed]);
  assert.notEqual(state.managed[edited]!.hash, await hashPath(edited));
  assert.equal(await fs.readFile(edited, 'utf8'), 'unrelated user edit');
});

test('an empty ownership hash without a planned output is rejected before creating private state', async t => {
  const root = await fixture(t);
  const plan = await planFor(root, []);
  const untouched = path.join(root, 'untouched');
  plan.state.managed[untouched] = { path: untouched, hash: '', kind: 'copy' };
  await assert.rejects(applyPlan(plan), /Uninitialized ownership entry has no planned output/);
  assert.equal(await hashPath(path.dirname(plan.statePath)), null);
});

test('aliased copy sources require an independently authenticated resolved tree', async t => {
  const root = await fixture(t);
  const source = path.join(root, 'source');
  const alias = path.join(root, 'alias');
  const output = path.join(root, 'project', 'skill');
  await put(path.join(source, 'SKILL.md'), 'reviewed skill');
  try { await fs.symlink('source', alias, 'dir'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('Filesystem does not permit symbolic links'); return; }
    throw error;
  }
  const operation: Operation = { kind: 'copy', path: output, source: alias, reason: 'adopt source alias' };
  await assert.rejects(applyPlan(await planFor(root, [operation])), /Resolved source precondition is required/);
  assert.equal(await hashPath(output), null);
  const stale = await planFor(root, [operation], [source]);
  await put(path.join(source, 'SKILL.md'), 'unreviewed change');
  await assert.rejects(applyPlan(stale), /Stale plan precondition/);
  assert.equal(await hashPath(output), null);
  await applyPlan(await planFor(root, [operation], [source]));
  assert.equal(await hashPath(output), await hashPath(source));
});

for (const failAfter of [0, 1, 2, 3]) {
  test(`injected failure after ${failAfter} writes restores all outputs and original state`, async t => {
    const root = await fixture(t);
    const first = path.join(root, 'project', 'first.json');
    const second = path.join(root, 'project', 'nested', 'second.json');
    const statePath = path.join(root, 'private-state', 'state.json');
    await put(first, 'original\n', 0o640);
    await put(statePath, JSON.stringify({ version: 1, managed: {} }) + '\n');
    const before = await hashPath(first);
    const beforeState = await hashPath(statePath);
    const plan = await planFor(root, [
      { kind: 'write', path: first, content: 'replacement\n', reason: 'replace existing' },
      { kind: 'write', path: second, content: 'new output\n', reason: 'add new' },
    ]);
    await assert.rejects(applyPlan(plan, { failAfter }), /Injected transaction failure/);
    assert.equal(await hashPath(first), before);
    assert.equal(await hashPath(second), null);
    assert.equal(await hashPath(statePath), beforeState);
    assert.equal(await hashPath(path.dirname(second)), null, 'new empty output directories are removed on rollback');
    const backups = path.join(path.dirname(statePath), 'backups');
    const transactions = await fs.readdir(backups);
    assert.equal(transactions.length, 1);
    const journal = JSON.parse(await fs.readFile(path.join(backups, transactions[0]!, 'journal.json'), 'utf8'));
    assert.equal(journal.status, 'rolled-back');
    assert.equal(await hashPath(path.join(backups, transactions[0]!, 'backup-0')), before);
  });
}

test('known diagnostics, stale sources, missing preconditions and state drift cause no native writes', async t => {
  const root = await fixture(t);
  const source = path.join(root, 'native', 'skill');
  const destination = path.join(root, 'project', '.agents', 'skills', 'skill');
  await put(path.join(source, 'SKILL.md'), 'original skill');
  const operation: Operation = { kind: 'copy', path: destination, source, reason: 'adopt skill' };
  const invalid = await planFor(root, [operation]);
  invalid.diagnostics.push({ code: 'invalid', severity: 'error', message: 'bad input' });
  await assert.rejects(applyPlan(invalid), /error diagnostics/);
  assert.equal(await hashPath(destination), null);
  assert.equal(await hashPath(path.dirname(invalid.statePath)), null);
  const stale = await planFor(root, [operation]);
  await put(path.join(source, 'asset.txt'), 'concurrent addition');
  await assert.rejects(applyPlan(stale), /Stale plan precondition/);
  assert.equal(await hashPath(destination), null);
  assert.equal(await hashPath(path.dirname(stale.statePath)), null);
  const unguarded = await planFor(root, [operation]);
  unguarded.preconditions = unguarded.preconditions.filter(input => input.path !== destination);
  await assert.rejects(applyPlan(unguarded), /Output precondition is required/);
  const stateDrift = await planFor(root, [operation]);
  await put(stateDrift.statePath, JSON.stringify({ version: 1, managed: {} }));
  await assert.rejects(applyPlan(stateDrift), /Stale plan precondition/);
  assert.equal(await hashPath(destination), null);
});

test('directory-root preconditions survive owned staging but do not hide unrelated drift', async t => {
  const root = await fixture(t);
  const output = path.join(root, 'project', '.agents', 'skills', 'skill');
  const source = path.join(root, 'native', 'skill');
  await put(path.join(source, 'SKILL.md'), 'skill');
  const plan = await planFor(root, [{ kind: 'copy', path: output, source, reason: 'adopt' }], [path.join(root, 'project', '.agents'), path.dirname(output)]);
  await applyPlan(plan);
  assert.equal(await fs.readFile(path.join(output, 'SKILL.md'), 'utf8'), 'skill');
  const second = path.join(path.dirname(output), 'second');
  const driftPlan = await planFor(root, [{ kind: 'copy', path: second, source, reason: 'another' }], [path.dirname(output)]);
  await put(path.join(path.dirname(output), 'unrelated.txt'), 'external edit');
  await assert.rejects(applyPlan(driftPlan), /Stale plan precondition/);
  assert.equal(await hashPath(second), null);
});

test('source edit during durable journal preparation is detected before native mutation', async t => {
  const root = await fixture(t);
  const source = path.join(root, 'source', 'skill');
  const output = path.join(root, 'project', 'skill');
  await put(path.join(source, 'SKILL.md'), 'before');
  const plan = await planFor(root, [{ kind: 'copy', path: output, source, reason: 'copy' }]);
  const rename = fs.rename.bind(fs);
  let edited = false;
  t.mock.method(fs, 'rename', async (from: PathLike, to: PathLike) => {
    await rename(from, to);
    if (!edited && path.basename(String(to)) === 'journal.json') {
      edited = true;
      await put(path.join(source, 'SKILL.md'), 'concurrent edit');
    }
  });
  await assert.rejects(applyPlan(plan), /Stale plan precondition/);
  assert.equal(edited, true);
  assert.equal(await hashPath(output), null);
  assert.equal(await hashPath(plan.statePath), null);
  assert.equal(await fs.readFile(path.join(source, 'SKILL.md'), 'utf8'), 'concurrent edit');
});

test('post-install user edits are retained as recovery conflicts instead of becoming ownership baselines', async t => {
  const root = await fixture(t);
  const output = path.join(root, 'project', 'native.json');
  const plan = await planFor(root, [{ kind: 'write', path: output, content: 'planned output', reason: 'projection' }]);
  const rename = fs.rename.bind(fs);
  t.mock.method(fs, 'rename', async (from: PathLike, to: PathLike) => {
    await rename(from, to);
    if (String(to) === output) await put(output, 'concurrent user edit');
  });
  await assert.rejects(applyPlan(plan), /Transaction failed; recovery required/);
  assert.equal(await fs.readFile(output, 'utf8'), 'concurrent user edit');
  assert.equal(await hashPath(plan.statePath), null);
  const backups = path.join(path.dirname(plan.statePath), 'backups');
  const directory = path.join(backups, (await fs.readdir(backups))[0]!);
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'journal.json'), 'utf8')).status, 'pending');
});

test('copy-then-native-link cutover supports initially missing canonical source and tracked fallback', async t => {
  const root = await fixture(t);
  const native = path.join(root, 'native', 'skills', 'skill');
  const canonical = path.join(root, 'project', '.agents', 'skills', 'skill');
  await put(path.join(native, 'SKILL.md'), 'complete skill');
  await put(path.join(native, 'scripts', 'run.sh'), '#!/bin/sh\nexit 0\n', 0o755);
  await put(path.join(native, 'references', 'asset.bin'), '\u0000\u0001\u0002');
  const plan = await planFor(root, [
    { kind: 'copy', path: canonical, source: native, reason: 'canonical adoption' },
    { kind: 'link', path: native, source: canonical, fallbackCopy: true, reason: 'native bridge' },
  ], [path.dirname(native), path.dirname(canonical)]);
  t.mock.method(fs, 'symlink', async () => { throw Object.assign(new Error('simulated unprivileged symlink'), { code: 'EPERM' }); });
  const result = await applyPlan(plan);
  assert.equal(result.changes, 2);
  assert.equal((await fs.lstat(native)).isDirectory(), true);
  assert.equal(await hashPath(native), await hashPath(canonical));
  assert.equal(await fs.readFile(path.join(native, 'references', 'asset.bin'), 'utf8'), '\u0000\u0001\u0002');
  if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(native, 'scripts', 'run.sh'))).mode & 0o777, 0o755);
  assert.equal((await readState(plan.statePath)).managed[native]!.hash, await hashPath(native));
});

test('unsupported link errors only fall back when explicitly allowed', async t => {
  const root = await fixture(t);
  const source = path.join(root, 'source');
  const output = path.join(root, 'project', 'skill');
  await put(path.join(source, 'SKILL.md'), 'skill');
  const plan = await planFor(root, [{ kind: 'link', path: output, source, fallbackCopy: false, reason: 'strict link' }]);
  t.mock.method(fs, 'symlink', async () => { throw Object.assign(new Error('no link permission'), { code: 'EPERM' }); });
  await assert.rejects(applyPlan(plan), /no link permission/);
  assert.equal(await hashPath(output), null);
  assert.equal(await hashPath(plan.statePath), null);
});

test('remove has recoverable backup and injected failure restores complete directory', async t => {
  const root = await fixture(t);
  const output = path.join(root, 'project', 'superseded');
  await put(path.join(output, 'SKILL.md'), 'original skill');
  await put(path.join(output, 'assets', 'asset'), 'valuable asset');
  const before = await hashPath(output);
  const failed = await planFor(root, [{ kind: 'remove', path: output, reason: 'successful cutover cleanup' }]);
  await assert.rejects(applyPlan(failed, { failAfter: 1 }), /Injected/);
  assert.equal(await hashPath(output), before);
  const result = await applyPlan(await planFor(root, failed.operations));
  assert.equal(await hashPath(output), null);
  assert.equal(await hashPath(path.join(result.backupDirectory!, 'backup-0')), before);
});

test('overlapping outputs, source recursion and invalid fault injection are rejected', async t => {
  const root = await fixture(t);
  const source = path.join(root, 'source');
  await put(path.join(source, 'SKILL.md'), 'skill');
  const nested = await planFor(root, [{ kind: 'copy', path: path.join(source, 'nested'), source, reason: 'unsafe recursion' }]);
  await assert.rejects(applyPlan(nested), /inside its source/);
  const output = path.join(root, 'output');
  const overlap = await planFor(root, [
    { kind: 'write', path: output, content: 'x', reason: 'one' },
    { kind: 'write', path: path.join(output, 'child'), content: 'y', reason: 'two' },
  ]);
  await assert.rejects(applyPlan(overlap), /Overlapping output/);
  await assert.rejects(applyPlan(await planFor(root, []), { failAfter: -1 }), /nonnegative integer/);
  assert.equal(await hashPath(output), null);
});
