import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { test, type TestContext } from 'node:test';
import { applyPlan, hashPath, readState, safeCopy } from '../src/safety.js';
import type { Operation, Plan } from '../src/types.js';

async function fixture(t: TestContext): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mishmash-tree-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function put(file: string, content: string, mode = 0o600): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, { mode });
  await fs.chmod(file, mode);
}
async function link(t: TestContext, target: string, output: string, type: 'file' | 'dir' = 'dir'): Promise<boolean> {
  try { await fs.symlink(target, output, type); return true; }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      t.skip('Filesystem does not permit symbolic links for this test process');
      return false;
    }
    throw error;
  }
}
async function planFor(root: string, operation: Operation): Promise<Plan> {
  const statePath = path.join(root, 'state', 'state.json');
  const inputs = [statePath, operation.path];
  if (operation.kind === 'copy' || operation.kind === 'link') inputs.push(operation.source);
  return { version: 1, command: 'sync', scope: 'project', targets: [], diagnostics: [], operations: [operation], statePath, state: { version: 1, managed: {} }, preconditions: await Promise.all(inputs.map(async file => ({ path: file, hash: await hashPath(file) }))) };
}

test('hashPath includes hidden files, nested bytes, entry names and mode without depending on absolute root', async t => {
  const root = await fixture(t);
  const first = path.join(root, 'a');
  const second = path.join(root, 'b');
  await put(path.join(first, 'SKILL.md'), 'same metadata');
  await put(path.join(first, '.hidden'), 'hidden');
  await put(path.join(first, 'scripts', 'run'), 'script', 0o755);
  await fs.mkdir(path.join(first, 'empty'), { mode: 0o750 });
  assert.equal(await hashPath(path.join(root, 'missing')), null);
  await safeCopy(first, second);
  const original = await hashPath(first);
  assert.equal(await hashPath(second), original);
  await put(path.join(second, '.hidden'), 'different');
  assert.notEqual(await hashPath(second), original);
  await put(path.join(second, '.hidden'), 'hidden');
  assert.equal(await hashPath(second), original);
  await fs.rename(path.join(second, '.hidden'), path.join(second, '.renamed'));
  assert.notEqual(await hashPath(second), original);
  if (process.platform !== 'win32') {
    await fs.rename(path.join(second, '.renamed'), path.join(second, '.hidden'));
    await fs.chmod(path.join(second, 'scripts', 'run'), 0o644);
    assert.notEqual(await hashPath(second), original);
  }
});

test('safeCopy retains complete tree, binary assets, empty directories and Unix executable modes', async t => {
  const root = await fixture(t);
  const source = path.join(root, 'source');
  const destination = path.join(root, 'nested', 'copy');
  await put(path.join(source, 'SKILL.md'), '---\nname: example\ndescription: Example.\n---\n');
  await put(path.join(source, 'scripts', 'run.sh'), '#!/bin/sh\nexit 7\n', 0o751);
  await fs.mkdir(path.join(source, 'assets', 'empty'), { recursive: true });
  await fs.writeFile(path.join(source, 'assets', 'binary'), Buffer.from([0, 255, 128, 10]));
  await fs.chmod(path.join(source, 'assets', 'binary'), 0o640);
  await safeCopy(source, destination);
  assert.equal(await hashPath(source), await hashPath(destination));
  assert.deepEqual(await fs.readFile(path.join(destination, 'assets', 'binary')), Buffer.from([0, 255, 128, 10]));
  assert.deepEqual(await fs.readdir(path.join(destination, 'assets', 'empty')), []);
  if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(destination, 'scripts', 'run.sh'))).mode & 0o777, 0o751);
  await assert.rejects(safeCopy(source, destination), /already exists/);
  await assert.rejects(safeCopy(source, path.join(source, 'recursive')), /inside its source/);
});

test('contained relative links are preserved and root aliases can be copied', async t => {
  const root = await fixture(t);
  const source = path.join(root, 'source');
  await put(path.join(source, 'references', 'guide.md'), 'guide');
  if (!await link(t, path.join('references', 'guide.md'), path.join(source, 'guide.md'), 'file')) return;
  await fs.symlink('references', path.join(source, 'docs'), 'dir');
  const alias = path.join(root, 'alias');
  await fs.symlink('source', alias, 'dir');
  const destination = path.join(root, 'copy');
  await safeCopy(alias, destination);
  assert.equal(await fs.readlink(path.join(destination, 'guide.md')), path.join('references', 'guide.md'));
  assert.equal(await fs.readlink(path.join(destination, 'docs')), 'references');
  assert.equal(await fs.readFile(path.join(destination, 'docs', 'guide.md'), 'utf8'), 'guide');
  assert.equal(await hashPath(source), await hashPath(destination));
  assert.notEqual(await hashPath(alias), await hashPath(source), 'root link ownership is distinct from its target');
});

test('hashing an escaping link hashes link identity but never reads external content', async t => {
  const root = await fixture(t);
  const source = path.join(root, 'source');
  const outside = path.join(root, 'outside');
  await put(path.join(source, 'SKILL.md'), 'skill');
  await put(outside, 'sensitive external bytes');
  if (!await link(t, outside, path.join(source, 'escape'), 'file')) return;
  const before = await hashPath(source);
  await put(outside, 'changed external bytes');
  assert.equal(await hashPath(source), before);
  await assert.rejects(safeCopy(source, path.join(root, 'copy')), /escapes its tree/);
  assert.equal(await hashPath(path.join(root, 'copy')), null);
  assert.equal(await fs.readFile(outside, 'utf8'), 'changed external bytes');
});

test('copy rejects absolute and lexically escaping asset links even when they currently resolve inside the source', async t => {
  const root = await fixture(t);
  const source = path.join(root, 'source');
  const destination = path.join(root, 'copy');
  await put(path.join(source, 'data'), 'complete asset');
  const asset = path.join(source, 'alias');
  if (!await link(t, '../source/data', asset, 'file')) return;
  await assert.rejects(safeCopy(source, destination), /escapes its tree/);
  assert.equal(await hashPath(destination), null);
  await fs.unlink(asset);
  await fs.symlink(path.join(source, 'data'), asset, 'file');
  await assert.rejects(safeCopy(source, destination), /absolute/);
  assert.equal(await hashPath(destination), null);
  assert.equal(await fs.readFile(path.join(source, 'data'), 'utf8'), 'complete asset');
});

test('protected system ancestor aliases cannot conceal recursive copies or duplicate outputs', async t => {
  const base = process.platform === 'darwin' ? '/tmp' : process.platform === 'linux' ? `/var/run/user/${process.getuid!()}` : undefined;
  if (!base) { t.skip('No protected system directory alias available'); return; }
  let aliasRoot: string;
  try { aliasRoot = await fs.mkdtemp(path.join(base, 'mishmash-alias-')); }
  catch (error) {
    if (['ENOENT', 'EACCES', 'EROFS'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('Protected runtime directory is unavailable'); return; }
    throw error;
  }
  t.after(() => fs.rm(aliasRoot, { recursive: true, force: true }));
  const root = await fs.realpath(aliasRoot);
  if (root === aliasRoot) { t.skip('System directory is not an alias'); return; }
  const source = path.join(root, 'source');
  const recursive = path.join(aliasRoot, 'source', 'nested', 'copy');
  await put(path.join(source, 'SKILL.md'), 'complete skill');
  await assert.rejects(safeCopy(source, recursive), /inside its source/);
  await assert.rejects(applyPlan(await planFor(root, { kind: 'copy', path: recursive, source, reason: 'recursive alias' })), /inside its source/);
  assert.equal(await hashPath(path.join(source, 'nested')), null);
  const output = path.join(root, 'output');
  const aliasOutput = path.join(aliasRoot, 'output');
  const plan = await planFor(root, { kind: 'write', path: output, content: 'first', reason: 'first spelling' });
  plan.operations.push({ kind: 'write', path: aliasOutput, content: 'second', reason: 'aliased spelling' });
  plan.preconditions.push({ path: aliasOutput, hash: null });
  await assert.rejects(applyPlan(plan), /Unsafe or duplicate output path/);
  assert.equal(await hashPath(output), null);
});

test('directory ancestor cycles, sibling cycles and broken links cannot be copied', async t => {
  const root = await fixture(t);
  const source = path.join(root, 'source');
  await put(path.join(source, 'SKILL.md'), 'skill');
  if (!await link(t, '.', path.join(source, 'cycle'))) return;
  await assert.rejects(safeCopy(source, path.join(root, 'copy')), /Cyclic copy source/);
  await fs.unlink(path.join(source, 'cycle'));
  await fs.mkdir(path.join(source, 'a'));
  await fs.mkdir(path.join(source, 'b'));
  await fs.symlink(path.join('..', 'b'), path.join(source, 'a', 'next'), 'dir');
  await fs.symlink(path.join('..', 'a'), path.join(source, 'b', 'next'), 'dir');
  await assert.rejects(safeCopy(source, path.join(root, 'copy')), /Cyclic copy source/);
  await fs.unlink(path.join(source, 'a', 'next'));
  await fs.unlink(path.join(source, 'b', 'next'));
  await fs.symlink('does-not-exist', path.join(source, 'broken'), 'file');
  await assert.rejects(safeCopy(source, path.join(root, 'copy')), /ENOENT/);
  assert.equal(await hashPath(path.join(root, 'copy')), null);
});

test('hostile output symlink and ancestor links cannot redirect writes or private state', async t => {
  const root = await fixture(t);
  const output = path.join(root, 'project', 'native.json');
  const outside = path.join(root, 'outside', 'sentinel');
  await put(outside, 'do not overwrite');
  await fs.mkdir(path.dirname(output));
  if (!await link(t, outside, output, 'file')) return;
  await assert.rejects(applyPlan(await planFor(root, { kind: 'write', path: output, content: 'bad', reason: 'hostile output' })), /symbolic-link output/);
  assert.equal(await fs.readFile(outside, 'utf8'), 'do not overwrite');
  await fs.unlink(output);
  const ancestor = path.join(root, 'project', 'redirect');
  await fs.symlink(path.dirname(outside), ancestor, 'dir');
  await assert.rejects(applyPlan(await planFor(root, { kind: 'write', path: path.join(ancestor, 'sentinel'), content: 'bad', reason: 'hostile ancestor' })), /symbolic-link output ancestor/);
  assert.equal(await fs.readFile(outside, 'utf8'), 'do not overwrite');
  const statePath = path.join(root, 'state', 'state.json');
  await fs.symlink(path.dirname(outside), path.dirname(statePath), 'dir');
  await assert.rejects(readState(statePath), /symbolic-link output ancestor/);
  assert.equal(await fs.readFile(outside, 'utf8'), 'do not overwrite');
});

test('authenticated owned link replacement uses relative target without touching original link target', async t => {
  const root = await fixture(t);
  const oldSource = path.join(root, 'old');
  const newSource = path.join(root, 'canonical');
  const output = path.join(root, 'native');
  await put(path.join(oldSource, 'SKILL.md'), 'old');
  await put(path.join(newSource, 'SKILL.md'), 'new');
  if (!await link(t, 'old', output)) return;
  const plan = await planFor(root, { kind: 'link', path: output, source: newSource, fallbackCopy: false, reason: 'owned link update' });
  const result = await applyPlan(plan);
  assert.equal(await fs.readlink(output), path.relative(path.dirname(output), newSource));
  assert.equal(await fs.readFile(path.join(output, 'SKILL.md'), 'utf8'), 'new');
  assert.equal(await fs.readFile(path.join(oldSource, 'SKILL.md'), 'utf8'), 'old');
  assert.equal(await fs.readlink(path.join(result.backupDirectory!, 'backup-0')), 'old');
});

test('authenticated link materialization and removal never modify the previous target', async t => {
  const root = await fixture(t);
  const previous = path.join(root, 'previous');
  const canonical = path.join(root, 'canonical');
  const output = path.join(root, 'native');
  await put(path.join(previous, 'SKILL.md'), 'previous skill');
  await put(path.join(canonical, 'SKILL.md'), 'canonical skill');
  if (!await link(t, 'previous', output)) return;
  const original = await hashPath(previous);
  await applyPlan(await planFor(root, { kind: 'copy', path: output, source: canonical, reason: 'materialize owned link' }));
  assert.equal((await fs.lstat(output)).isDirectory(), true);
  assert.equal(await hashPath(output), await hashPath(canonical));
  assert.equal(await hashPath(previous), original);
  await fs.rm(output, { recursive: true });
  await fs.symlink('previous', output, 'dir');
  await applyPlan(await planFor(root, { kind: 'remove', path: output, reason: 'remove adopted root alias' }));
  assert.equal(await hashPath(output), null);
  assert.equal(await hashPath(previous), original);
});

test('invalid state is never treated as empty or repaired on read-only access', async t => {
  const root = await fixture(t);
  const statePath = path.join(root, 'state', 'state.json');
  assert.deepEqual(await readState(statePath), { version: 1, managed: {} });
  assert.equal(await hashPath(path.dirname(statePath)), null);
  for (const content of ['not json', '{"version":2,"managed":{}}', '{"version":1,"managed":[]}', JSON.stringify({ version: 1, managed: { broken: { path: '/x', hash: '', kind: 'write' } } }), '{"version":1,"managed":{},"credentials":"forbidden"}']) {
    await put(statePath, content);
    const before = await hashPath(statePath);
    await assert.rejects(readState(statePath));
    assert.equal(await hashPath(statePath), before);
  }
});
