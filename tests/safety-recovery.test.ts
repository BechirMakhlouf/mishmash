import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { applyPlan, hashPath, readState, recover } from '../src/safety.js';
import type { Plan } from '../src/types.js';

async function fixture(t: TestContext): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mishmash-recovery-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function put(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, { mode: 0o600 });
  await fs.chmod(file, 0o600);
}
async function createPlan(root: string, remove = false): Promise<Plan> {
  const output = path.join(root, 'project', 'native.json');
  const statePath = path.join(root, 'state', 'state.json');
  await put(output, 'original output\n');
  await put(statePath, JSON.stringify({ version: 1, managed: {} }) + '\n');
  return {
    version: 1, command: 'sync', scope: 'project', targets: [], diagnostics: [], statePath,
    operations: remove ? [{ kind: 'remove', path: output, reason: 'remove superseded' }] : [{ kind: 'write', path: output, content: 'installed output\n', reason: 'projection' }],
    state: { version: 1, managed: remove ? {} : { [output]: { path: output, hash: '', kind: 'write' } } },
    preconditions: [{ path: output, hash: await hashPath(output) }, { path: statePath, hash: await hashPath(statePath) }],
  };
}

// Exit in a real process immediately after rename, bypassing finally/rollback.
// This deliberately exercises persisted journals and dead-process lock recovery,
// rather than presenting recover() with only a hand-written happy-path manifest.
async function crashDuringApply(root: string, plan: Plan, at: 'output' | 'state' | 'remove'): Promise<void> {
  const planFile = path.join(root, 'plan.json');
  await put(planFile, JSON.stringify(plan));
  const script = `
    import fs from 'node:fs/promises';
    import path from 'node:path';
    import { applyPlan } from ${JSON.stringify(new URL('../src/safety.js', import.meta.url).href)};
    const plan = JSON.parse(await fs.readFile(${JSON.stringify(planFile)}, 'utf8'));
    const rename = fs.rename.bind(fs);
    fs.rename = async (from, to) => {
      await rename(from, to);
      const at = ${JSON.stringify(at)};
      if ((at === 'output' && String(to) === plan.operations[0].path) ||
          (at === 'state' && String(to) === plan.statePath) ||
          (at === 'remove' && String(from) === plan.operations[0].path && path.basename(String(to)) === 'original')) process.exit(73);
    };
    await applyPlan(plan);
    process.exit(74);
  `;
  const result = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stderr }));
  });
  assert.equal(result.code, 73, result.stderr || 'child did not reach the intended crash point');
}

for (const at of ['output', 'state', 'remove'] as const) {
  test(`recover restores original filesystem and state after process death during ${at} rename`, async t => {
    const root = await fixture(t);
    const plan = await createPlan(root, at === 'remove');
    const output = plan.operations[0]!.path;
    const before = await hashPath(output);
    const stateBefore = await hashPath(plan.statePath);
    await crashDuringApply(root, plan, at);
    assert.notEqual(await hashPath(output), before);
    const backups = path.join(path.dirname(plan.statePath), 'backups');
    const names = await fs.readdir(backups);
    assert.equal(names.length, 1);
    const directory = path.join(backups, names[0]!);
    assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'journal.json'), 'utf8')).status, 'pending');
    await recover(plan.statePath);
    assert.equal(await hashPath(output), before);
    assert.equal(await hashPath(plan.statePath), stateBefore);
    assert.deepEqual(await readState(plan.statePath), { version: 1, managed: {} });
    assert.equal(await hashPath(path.join(path.dirname(plan.statePath), '.lock')), null);
    assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'journal.json'), 'utf8')).status, 'rolled-back');
    assert.equal(await hashPath(path.join(directory, 'backup-0')), before);
    await recover(plan.statePath);
    assert.equal(await hashPath(output), before, 'recovery is idempotent');
    assert.deepEqual((await fs.readdir(path.dirname(output))).filter(name => name.startsWith('.mishmash-txn-')), []);
  });
}

test('next apply automatically recovers pending transaction before applying authenticated fresh intent', async t => {
  const root = await fixture(t);
  const plan = await createPlan(root);
  const before = await hashPath(plan.operations[0]!.path);
  await crashDuringApply(root, plan, 'output');
  // Original preconditions describe the state recovery will restore.
  const result = await applyPlan(plan);
  assert.equal(result.applied, true);
  assert.equal(await fs.readFile(plan.operations[0]!.path, 'utf8'), 'installed output\n');
  assert.notEqual(await hashPath(plan.operations[0]!.path), before);
  assert.equal((await readState(plan.statePath)).managed[plan.operations[0]!.path]!.hash, await hashPath(plan.operations[0]!.path));
  const backups = path.join(path.dirname(plan.statePath), 'backups');
  const statuses = await Promise.all((await fs.readdir(backups)).map(async name => JSON.parse(await fs.readFile(path.join(backups, name, 'journal.json'), 'utf8')).status));
  assert.deepEqual(statuses.sort(), ['committed', 'rolled-back']);
});

test('redundant absolute path segments do not poison later transaction recovery', async t => {
  const root = await fixture(t);
  const plan = await createPlan(root);
  const statePath = plan.statePath;
  const output = plan.operations[0]!.path;
  plan.statePath = `${path.dirname(statePath)}/../state/state.json`;
  plan.operations[0]!.path = `${path.dirname(output)}/../project/native.json`;
  const suppliedStatePath = plan.statePath;
  await applyPlan(plan);
  await recover(suppliedStatePath);
  await recover(statePath);
  assert.equal(await fs.readFile(output, 'utf8'), 'installed output\n');
  assert.equal((await readState(statePath)).managed[output]!.hash, await hashPath(output));
  assert.equal(plan.statePath, suppliedStatePath, 'applying must not rewrite the supplied plan');
});

test('recovery refuses edited outputs and retains both user content and transaction evidence', async t => {
  const root = await fixture(t);
  const plan = await createPlan(root);
  await crashDuringApply(root, plan, 'output');
  const output = plan.operations[0]!.path;
  await put(output, 'user edit after crash\n');
  const backups = path.join(path.dirname(plan.statePath), 'backups');
  const directory = path.join(backups, (await fs.readdir(backups))[0]!);
  const backupHash = await hashPath(path.join(directory, 'backup-0'));
  await assert.rejects(recover(plan.statePath), /Recovery conflicts with edited output/);
  assert.equal(await fs.readFile(output, 'utf8'), 'user edit after crash\n');
  assert.equal(await hashPath(path.join(directory, 'backup-0')), backupHash);
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'journal.json'), 'utf8')).status, 'pending');
  assert.equal(await hashPath(path.join(path.dirname(plan.statePath), '.lock')), null);
});

test('changed backups block recovery instead of installing corrupt originals', async t => {
  const root = await fixture(t);
  const plan = await createPlan(root);
  await crashDuringApply(root, plan, 'output');
  const backups = path.join(path.dirname(plan.statePath), 'backups');
  const directory = path.join(backups, (await fs.readdir(backups))[0]!);
  await put(path.join(directory, 'backup-0'), 'corrupted backup');
  await assert.rejects(recover(plan.statePath), /Recovery backup missing or changed/);
  assert.equal(await fs.readFile(plan.operations[0]!.path, 'utf8'), 'installed output\n');
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'journal.json'), 'utf8')).status, 'pending');
});

test('recovery never deletes unexpected staging contents or unknown backup directories', async t => {
  const root = await fixture(t);
  const plan = await createPlan(root);
  const result = await applyPlan(plan);
  const journalPath = path.join(result.backupDirectory!, 'journal.json');
  const journal = JSON.parse(await fs.readFile(journalPath, 'utf8'));
  const work = journal.entries[0].work as string;
  await put(path.join(work, 'unrelated.txt'), 'unrelated content');
  const unknown = path.join(path.dirname(result.backupDirectory!), 'user-directory', 'sentinel');
  await put(unknown, 'preserve unknown backups');
  await assert.rejects(recover(plan.statePath), /Unrecognized transaction staging data/);
  assert.equal(await fs.readFile(path.join(work, 'unrelated.txt'), 'utf8'), 'unrelated content');
  assert.equal(await fs.readFile(unknown, 'utf8'), 'preserve unknown backups');
});

for (const kind of ['remove', 'create'] as const) {
  test(`recovery retains unexpected staging data without an authenticated ${kind === 'remove' ? 'new' : 'restore'} hash`, async t => {
    const root = await fixture(t);
    const plan = await createPlan(root, kind === 'remove');
    if (kind === 'create') {
      await fs.unlink(plan.operations[0]!.path);
      plan.preconditions.find(input => input.path === plan.operations[0]!.path)!.hash = null;
    }
    const result = await applyPlan(plan);
    const journalPath = path.join(result.backupDirectory!, 'journal.json');
    const journal = JSON.parse(await fs.readFile(journalPath, 'utf8'));
    const entry = journal.entries[0];
    const unexpected = path.join(entry.work, kind === 'remove' ? 'new' : 'restore');
    await put(unexpected, 'unrelated content');
    await assert.rejects(recover(plan.statePath), /Transaction staging data changed/);
    assert.equal(await fs.readFile(unexpected, 'utf8'), 'unrelated content');
    assert.equal(await hashPath(plan.operations[0]!.path), entry.after);
  });
}

test('active lock excludes concurrent apply and invalid journal cannot trigger arbitrary recovery', async t => {
  const root = await fixture(t);
  const plan = await createPlan(root);
  const lockPath = path.join(path.dirname(plan.statePath), '.lock');
  await put(lockPath, JSON.stringify({ version: 1, pid: process.pid, token: randomUUID() }));
  await assert.rejects(applyPlan(plan), /Another mishmash transaction is active/);
  assert.equal(await fs.readFile(plan.operations[0]!.path, 'utf8'), 'original output\n');
  await fs.unlink(lockPath);
  const directory = path.join(path.dirname(plan.statePath), 'backups', `txn-${randomUUID()}`);
  const sentinel = path.join(root, 'sentinel');
  await put(sentinel, 'do not touch');
  await put(path.join(directory, 'journal.json'), JSON.stringify({ version: 1, statePath: plan.statePath, status: 'pending', entries: [{ path: sentinel, before: null, after: await hashPath(sentinel), backup: null, work: root }] }));
  await assert.rejects(recover(plan.statePath), /Invalid recovery journal entry/);
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'do not touch');
});

test('recover absent state remains read-only and readState never performs implicit recovery', async t => {
  const root = await fixture(t);
  const absent = path.join(root, 'absent', 'state.json');
  await recover(absent);
  assert.equal(await hashPath(path.dirname(absent)), null);
  const plan = await createPlan(root);
  await crashDuringApply(root, plan, 'output');
  const outputHash = await hashPath(plan.operations[0]!.path);
  assert.deepEqual(await readState(plan.statePath), { version: 1, managed: {} });
  assert.equal(await hashPath(plan.operations[0]!.path), outputHash);
  const backups = path.join(path.dirname(plan.statePath), 'backups');
  const journal = path.join(backups, (await fs.readdir(backups))[0]!, 'journal.json');
  assert.equal(JSON.parse(await fs.readFile(journal, 'utf8')).status, 'pending');
});
