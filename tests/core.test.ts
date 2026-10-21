import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, chmod, stat, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as TOML from 'smol-toml';
import { createContext, createPlan, inspect, applyPlan, hashPath, adapters } from '../src/index.js';
import { readDocument, patchDocument } from '../src/documents.js';
import type { Context, Plan } from '../src/types.js';

async function fixture(t: { after: (fn: () => Promise<void>) => void }, scope: Context['scope'] = 'project') {
  const root = await mkdtemp(path.join(tmpdir(), 'mishmash-core-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project'), home = path.join(root, 'home');
  await mkdir(project); await mkdir(home);
  return { root, project, home, context: createContext({ project, home, scope }) };
}
async function json(file: string, value: unknown) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(value, null, 2) + '\n'); }
async function skill(root: string, id = 'review', text = '') {
  const directory = path.join(root, id); await mkdir(path.join(directory, 'scripts'), { recursive: true });
  await writeFile(path.join(directory, 'SKILL.md'), `---\nname: ${id}\ndescription: Review changes carefully.\n---\n${text}\n`);
  await writeFile(path.join(directory, 'scripts', 'run.sh'), '#!/bin/sh\nexit 47\n');
  await chmod(path.join(directory, 'scripts', 'run.sh'), 0o755); return directory;
}
function valid(plan: Plan) { assert.deepEqual(plan.diagnostics.filter(item => item.severity === 'error'), [], JSON.stringify(plan.diagnostics, null, 2)); }
async function canonical(context: Context, targets: string[]) {
  await json(path.join(context.canonicalRoot, 'sync.json'), { version: 1, targets });
  await json(path.join(context.canonicalRoot, 'mcp.json'), { version: 1, mcpServers: { docs: { type: 'streamable-http', url: 'https://example.test/mcp' } } });
  await skill(path.join(context.canonicalRoot, 'skills'));
}

test('all six adapters materialize meaningful MCP outputs at project and user scope', async t => {
  for (const scope of ['project', 'user'] as const) {
    const { context } = await fixture(t, scope);
    await canonical(context, [...adapters.keys()]);
    const plan = await createPlan(context, { command: 'sync' }); valid(plan);
    const files = [...new Set([...adapters.values()].map(adapter => adapter.resolve(context).mcpFiles.find(file => file.role !== 'legacy')!.path))];
    assert.equal(files.length, scope === 'project' ? 5 : 6, 'Only project Claude and Copilot share an MCP artifact');
    await applyPlan(plan);
    for (const adapter of adapters.values()) {
      const spec = adapter.resolve(context).mcpFiles.find(file => file.role !== 'legacy')!;
      const document = await readDocument(spec);
      assert.ok(document.map.docs, `${adapter.id} wrote native server`);
      const decoded = adapter.decode(document.map.docs as Record<string, unknown>, context);
      assert.equal(decoded.server?.type, 'streamable-http');
      assert.equal(decoded.server.url, 'https://example.test/mcp');
    }
    const repeated = await createPlan(context, { command: 'sync' }); valid(repeated); assert.deepEqual(repeated.operations, []);
  }
});

test('Claude import copies complete skill/assets/modes and migrates without executing', async t => {
  const { context, project, root } = await fixture(t);
  const source = await skill(path.join(project, '.claude', 'skills'));
  const marker = path.join(root, 'must-not-exist');
  await json(path.join(project, '.mcp.json'), { sentinel: 'keep', mcpServers: { dangerous: { command: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'bad')`] } } });
  const plan = await createPlan(context, { command: 'import', from: 'claude-code', targets: ['codex'] }); valid(plan);
  assert.equal(await hashPath(path.join(context.canonicalRoot, 'mcp.json')), null);
  await applyPlan(plan);
  const adopted = path.join(context.canonicalRoot, 'skills', 'review');
  assert.equal(await readFile(path.join(adopted, 'scripts', 'run.sh'), 'utf8'), '#!/bin/sh\nexit 47\n');
  if (process.platform !== 'win32') assert.equal((await stat(path.join(adopted, 'scripts', 'run.sh'))).mode & 0o777, 0o755);
  assert.equal(await hashPath(marker), null);
  assert.equal((await lstat(source)).isSymbolicLink() || (await lstat(source)).isDirectory(), true);
  assert.equal(JSON.parse(await readFile(path.join(project, '.mcp.json'), 'utf8')).sentinel, 'keep');
  const repeat = await createPlan(context, { command: 'import', from: 'claude-code', targets: ['codex'] }); valid(repeat); assert.deepEqual(repeat.operations, []);
});

test('direct-discovery skill import removes native duplicate only after canonical adoption', async t => {
  const { context, project } = await fixture(t);
  const source = await skill(path.join(project, '.gemini', 'skills'));
  const plan = await createPlan(context, { command: 'import', from: 'gemini-cli', targets: ['gemini-cli'] }); valid(plan);
  assert.ok(plan.operations.some(operation => operation.kind === 'remove' && operation.path === source));
  await applyPlan(plan);
  assert.equal(await hashPath(source), null);
  assert.ok(await hashPath(path.join(context.canonicalRoot, 'skills', 'review')));
  const repeated = await createPlan(context, { command: 'import', from: 'gemini-cli' }); valid(repeated); assert.deepEqual(repeated.operations, []);
});

test('project operations never write user resources; explicit home ignores hostile native env overrides', async t => {
  const { context, root, home } = await fixture(t);
  await canonical(context, [...adapters.keys()]);
  const before = await hashPath(home);
  const old = process.env.GEMINI_CLI_HOME;
  process.env.GEMINI_CLI_HOME = path.join(root, 'escape');
  try {
    const isolated = createContext({ project: context.project, home });
    assert.equal(isolated.env.GEMINI_CLI_HOME, undefined);
    const plan = await createPlan(isolated, { command: 'sync' }); valid(plan);
    assert.ok(plan.operations.every(operation => !operation.path.startsWith(home + path.sep)));
    await applyPlan(plan);
    assert.equal(await hashPath(path.join(home, '.agents')), null);
    assert.equal(await hashPath(path.join(root, 'escape')), null);
    assert.notEqual(await hashPath(home), before, 'only isolated ownership state may be created');
  } finally { if (old === undefined) delete process.env.GEMINI_CLI_HOME; else process.env.GEMINI_CLI_HOME = old; }
});

test('private Claude import remains outside project and global user maps', async t => {
  const { context, project, home } = await fixture(t, 'project-private');
  const state = path.join(home, '.claude.json');
  const original = { trust: { keep: true }, mcpServers: { global: { command: 'global-server' } }, projects: { [project]: { mcpServers: { private: { type: 'http', url: 'https://private.example.test/mcp' } }, hasTrustDialogAccepted: false }, '/another/project': { mcpServers: { unrelated: { command: 'elsewhere' } } } } };
  await json(state, original);
  const plan = await createPlan(context, { command: 'import', from: 'claude-code', targets: ['claude-code'] }); valid(plan);
  assert.ok(plan.operations.every(operation => !operation.path.startsWith(project + path.sep)));
  await applyPlan(plan);
  assert.ok(await hashPath(path.join(context.canonicalRoot, 'mcp.json')));
  assert.equal(await hashPath(path.join(project, '.agents')), null);
  const persisted = JSON.parse(await readFile(state, 'utf8'));
  assert.deepEqual(persisted.mcpServers, original.mcpServers);
  assert.deepEqual(persisted.projects['/another/project'], original.projects['/another/project']);
  assert.equal(persisted.projects[project].hasTrustDialogAccepted, false);
  const unsupported = await createPlan(context, { command: 'sync', targets: ['gemini-cli'] });
  assert.ok(unsupported.diagnostics.some(item => item.severity === 'error'));
});

test('shared Claude/Copilot project artifact merges compatible fields once and preserves unrelated entries', async t => {
  const { context, project } = await fixture(t);
  await canonical(context, ['claude-code', 'github-copilot-cli']);
  await json(path.join(project, '.mcp.json'), { keep: 'sentinel', mcpServers: { unmanaged: { type: 'stdio', command: 'keep-me', args: [] } } });
  const plan = await createPlan(context, { command: 'sync' }); valid(plan);
  assert.equal(plan.operations.filter(operation => operation.path === path.join(project, '.mcp.json')).length, 1);
  await applyPlan(plan);
  const output = JSON.parse(await readFile(path.join(project, '.mcp.json'), 'utf8'));
  assert.equal(output.keep, 'sentinel'); assert.equal(output.mcpServers.unmanaged.command, 'keep-me');
  assert.equal(output.mcpServers.docs.url, 'https://example.test/mcp'); assert.deepEqual(output.mcpServers.docs.tools, ['*']);
});

test('native MCP overrides survive import and conflicting canonical fields block writes', async t => {
  const { context, project } = await fixture(t);
  await json(path.join(project, '.mcp.json'), { mcpServers: { docs: { type: 'http', url: 'https://example.test/mcp', timeout: 9000 } } });
  const plan = await createPlan(context, { command: 'import', from: 'claude-code' }); valid(plan); await applyPlan(plan);
  const overrideFile = path.join(context.canonicalRoot, 'overrides', 'claude-code', 'mcp.json');
  const override = JSON.parse(await readFile(overrideFile, 'utf8')); assert.equal(override.mcpServers.docs.timeout, 9000);
  override.mcpServers.docs.url = 'https://conflict.example.test'; await json(overrideFile, override);
  const conflict = await createPlan(context, { command: 'sync' }); assert.ok(conflict.diagnostics.some(item => item.severity === 'error'));
  const before = await hashPath(project); await assert.rejects(applyPlan(conflict)); assert.equal(await hashPath(project), before);
});

test('disabled native activation is never silently enabled in a different target', async t => {
  for (const [adapter, relative, data] of [
    ['codex', '.codex/config.toml', '[mcp_servers.off]\ncommand = "server"\nenabled = false\n'],
    ['pi', '.pi/mcp.json', JSON.stringify({ mcpServers: { off: { command: 'server', enabled: false } } })],
    ['opencode', 'opencode.json', JSON.stringify({ mcp: { servers: { off: { type: 'local', command: ['server'], disabled: true } } } })]
  ] as const) {
    const { context, project } = await fixture(t);
    const file = path.join(project, relative); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, data);
    const plan = await createPlan(context, { command: 'import', from: adapter, targets: ['gemini-cli'] });
    assert.ok(plan.diagnostics.some(item => item.code === 'activation-incompatible'), JSON.stringify(plan.diagnostics));
    assert.equal(await hashPath(context.canonicalRoot), null);
  }
});

test('native tool restrictions block cross-target projection but retain source behavior', async t => {
  for (const [adapter, relative, data, policy] of [
    ['github-copilot-cli', '.mcp.json', { mcpServers: { limited: { type: 'http', url: 'https://example.test/mcp', tools: [] } } }, { tools: [] }],
    ['codex', '.codex/config.toml', '[mcp_servers.limited]\nurl = "https://example.test/mcp"\nenabled_tools = ["read"]\n', { enabled_tools: ['read'] }],
    ['gemini-cli', '.gemini/settings.json', { mcpServers: { limited: { type: 'http', url: 'https://example.test/mcp', excludeTools: ['write'] } } }, { excludeTools: ['write'] }],
    ['pi', '.pi/mcp.json', { mcpServers: { limited: { url: 'https://example.test/mcp', exposure: 'hidden' } } }, { exposure: 'hidden' }],
  ] as const) {
    const { context, project } = await fixture(t);
    const file = path.join(project, relative); await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, typeof data === 'string' ? data : JSON.stringify(data));
    const source = await createPlan(context, { command: 'import', from: adapter, targets: [adapter] }); valid(source); await applyPlan(source);
    const before = await hashPath(project);
    const target = await createPlan(context, { command: 'sync', targets: ['claude-code'] });
    assert.ok(target.diagnostics.some(item => item.code === 'tool-policy-incompatible'));
    await assert.rejects(applyPlan(target)); assert.equal(await hashPath(project), before);
    const native = await readDocument(adapters.get(adapter)!.resolve(context).mcpFiles.find(file => file.role !== 'legacy')!);
    for (const [key, value] of Object.entries(policy)) assert.deepEqual((native.map.limited as Record<string, unknown>)[key], value);
    const repeat = await createPlan(context, { command: 'sync', targets: [adapter] }); valid(repeat); assert.deepEqual(repeat.operations, []);
  }
});

test('MCP unmanaged collision, owned drift, and stale preconditions cause no partial writes', async t => {
  const { context, project } = await fixture(t);
  await canonical(context, ['claude-code']);
  await json(path.join(project, '.mcp.json'), { mcpServers: { docs: { type: 'http', url: 'https://other.test/mcp' } } });
  const collision = await createPlan(context, { command: 'sync' }); assert.ok(collision.diagnostics.some(item => item.code === 'unmanaged-collision'));
  await rm(path.join(project, '.mcp.json'));
  const plan = await createPlan(context, { command: 'sync' }); valid(plan);
  await writeFile(path.join(context.canonicalRoot, 'skills', 'review', 'new.txt'), 'concurrent edit');
  const before = await hashPath(project); await assert.rejects(applyPlan(plan)); assert.equal(await hashPath(project), before);
  const clean = await createPlan(context, { command: 'sync' }); valid(clean); await applyPlan(clean);
  await json(path.join(project, '.mcp.json'), { mcpServers: { docs: { type: 'http', url: 'https://edited.test/mcp' } } });
  const drift = await createPlan(context, { command: 'sync' }); assert.ok(drift.diagnostics.some(item => item.code === 'owned-drift'));
});

test('selected generated-file drift is rejected even when no projection needs rewriting', async t => {
  const { context, project } = await fixture(t);
  await canonical(context, ['claude-code']);
  const initial = await createPlan(context, { command: 'sync' }); valid(initial); await applyPlan(initial);
  const file = path.join(project, '.mcp.json');
  await writeFile(file, JSON.stringify(JSON.parse(await readFile(file, 'utf8'))));
  const plan = await createPlan(context, { command: 'sync' });
  assert.deepEqual(plan.operations, []); assert.ok(plan.diagnostics.some(item => item.code === 'owned-drift'));
  const before = await hashPath(project); await assert.rejects(applyPlan(plan)); assert.equal(await hashPath(project), before);
});

test('intentional canonical edits remain authoritative during a later native import', async t => {
  const { context, project } = await fixture(t);
  await json(path.join(project, '.mcp.json'), { mcpServers: { original: { type: 'http', url: 'https://original.test/mcp' } } });
  const initial = await createPlan(context, { command: 'import', from: 'claude-code' }); valid(initial); await applyPlan(initial);
  const file = path.join(context.canonicalRoot, 'mcp.json');
  const edited = JSON.parse(await readFile(file, 'utf8'));
  edited.mcpServers.curated = { type: 'streamable-http', url: 'https://curated.test/mcp' }; await json(file, edited);
  await json(path.join(project, '.gemini/settings.json'), { mcpServers: { incoming: { type: 'http', url: 'https://incoming.test/mcp' } } });
  const next = await createPlan(context, { command: 'import', from: 'gemini-cli', targets: ['codex'] }); valid(next); await applyPlan(next);
  const result = JSON.parse(await readFile(file, 'utf8')).mcpServers;
  assert.equal(result.curated.url, 'https://curated.test/mcp'); assert.equal(result.incoming.url, 'https://incoming.test/mcp'); assert.equal(result.original.url, 'https://original.test/mcp');
});

test('secret-bearing native input blocks adoption without leaking literal values', async t => {
  const { context, project } = await fixture(t);
  const secret = 'private-credential-DO-NOT-PRINT';
  await json(path.join(project, '.mcp.json'), { mcpServers: { api: { type: 'http', url: 'https://example.test/mcp', headers: { Authorization: secret } } } });
  const plan = await createPlan(context, { command: 'import', from: 'claude-code' });
  assert.ok(plan.diagnostics.some(item => item.severity === 'error'));
  assert.ok(!JSON.stringify(plan).includes(secret));
  await assert.rejects(applyPlan(plan)); assert.equal(await hashPath(context.canonicalRoot), null);
});

test('credential references survive native projection and reimport across every adapter', async t => {
  for (const scope of ['project', 'user'] as const) {
    const { context } = await fixture(t, scope);
    const targets = [...adapters.keys()];
    const servers = {
      worker: { type: 'stdio', command: 'node', env: { API_TOKEN: { env: 'API_TOKEN' } } },
      remote: { type: 'streamable-http', url: 'https://example.test/mcp', headers: { Authorization: { env: 'MCP_AUTHORIZATION' } } },
    };
    await json(path.join(context.canonicalRoot, 'sync.json'), { version: 1, targets });
    await json(path.join(context.canonicalRoot, 'mcp.json'), { version: 1, mcpServers: servers });
    const plan = await createPlan(context, { command: 'sync' }); valid(plan); await applyPlan(plan);
    for (const adapter of adapters.values()) {
      const spec = adapter.resolve(context).mcpFiles.find(file => file.role !== 'legacy')!;
      const document = await readDocument(spec);
      const worker = adapter.decode(document.map.worker as Record<string, unknown>, context);
      assert.ok(worker.server?.type === 'stdio');
      assert.deepEqual(worker.server.env, servers.worker.env, `${adapter.id} retains the credential reference`);
      const remote = adapter.decode(document.map.remote as Record<string, unknown>, context);
      assert.ok(remote.server && remote.server.type !== 'stdio');
      assert.deepEqual(remote.server.headers, servers.remote.headers, `${adapter.id} retains the authorization reference`);
    }
    const inventory = await inspect(context); assert.deepEqual(inventory.diagnostics.filter(item => item.severity === 'error'), []);
    const adopted = await createPlan(context, { command: 'import', from: 'all' }); valid(adopted); await applyPlan(adopted);
    assert.deepEqual(JSON.parse(await readFile(path.join(context.canonicalRoot, 'mcp.json'), 'utf8')).mcpServers, servers);
    const repeat = await createPlan(context, { command: 'import', from: 'all' }); valid(repeat); assert.deepEqual(repeat.operations, []);
  }
});

test('native JSONC and TOML targeted patches preserve unrelated fields and comments', async t => {
  const { root } = await fixture(t);
  const jsonFile = path.join(root, 'settings.json');
  await writeFile(jsonFile, '{\n // keep comment\n "theme": "dark",\n "mcpServers": { "other": { "command": "keep" } }\n}\n');
  const document = await readDocument({ path: jsonFile, format: 'jsonc', mapPath: ['mcpServers'] });
  const text = patchDocument(document, new Map([['docs', { type: 'http', url: 'https://example.test' }]]));
  assert.ok(text.includes('// keep comment')); assert.ok(text.includes('"theme": "dark"')); assert.ok(text.includes('"command": "keep"'));
  const tomlFile = path.join(root, 'config.toml');
  await writeFile(tomlFile, '# keep top\nmodel = "sentinel"\n\n[mcp_servers.other]\ncommand = "keep"\n\n[mcp_servers.docs]\ncommand = "old"\n\n[unrelated]\n# keep nested\nvalue = 9\n');
  const toml = await readDocument({ path: tomlFile, format: 'toml', mapPath: ['mcp_servers'] });
  const patched = patchDocument(toml, new Map([['docs', { url: 'https://example.test' }]]));
  const parsed = TOML.parse(patched) as any;
  assert.equal(parsed.model, 'sentinel'); assert.equal(parsed.mcp_servers.other.command, 'keep'); assert.equal(parsed.unrelated.value, 9);
  assert.ok(patched.includes('# keep top')); assert.ok(patched.includes('# keep nested'));
});

test('TOML projections reconcile inline and dotted maps without changing unmanaged content', async t => {
  const { root } = await fixture(t);
  for (const source of [
    '# retain comment\nmodel = "keep"\nmcp_servers = { docs = { command = "old" }, other = { command = "untouched" } }\n',
    '# retain comment\nmodel = "keep"\nmcp_servers.docs.command = "old"\nmcp_servers.other.command = "untouched"\n',
    '# retain comment\nmodel = "keep"\n[mcp_servers]\ndocs = { command = "old" }\nother = { command = "untouched" }\n',
  ]) {
    const file = path.join(root, 'inline.toml'); await writeFile(file, source);
    const document = await readDocument({ path: file, format: 'toml', mapPath: ['mcp_servers'] });
    const patched = patchDocument(document, new Map([['docs', { url: 'https://example.test/mcp' }], ['added', { command: 'new' }]]));
    const parsed = TOML.parse(patched) as any;
    assert.equal(parsed.model, 'keep'); assert.equal(parsed.mcp_servers.other.command, 'untouched');
    assert.equal(parsed.mcp_servers.docs.url, 'https://example.test/mcp'); assert.equal(parsed.mcp_servers.docs.command, undefined); assert.equal(parsed.mcp_servers.added.command, 'new');
    assert.ok(patched.includes('# retain comment'));
    await writeFile(file, patched);
    const removed = patchDocument(await readDocument(document.spec), new Map([['docs', undefined], ['added', undefined]]));
    const afterRemoval = (TOML.parse(removed) as any).mcp_servers;
    assert.equal(afterRemoval.docs, undefined); assert.equal(afterRemoval.added, undefined); assert.equal(afterRemoval.other.command, 'untouched');
    await writeFile(file, removed);
    const empty = patchDocument(await readDocument(document.spec), new Map([['other', undefined]]));
    assert.deepEqual(Object.keys((TOML.parse(empty) as any).mcp_servers), []);
  }
});

test('TOML table-looking text in multiline strings is not treated as a server declaration', async t => {
  const { root } = await fixture(t);
  const file = path.join(root, 'multiline.toml');
  const banner = '[mcp_servers.docs]\ncommand = "this is text, not configuration"';
  await writeFile(file, `banner = '''\n${banner}\n'''\n\n[mcp_servers.docs]\ncommand = "old"\n`);
  const document = await readDocument({ path: file, format: 'toml', mapPath: ['mcp_servers'] });
  const patched = patchDocument(document, new Map([['docs', { command: 'new' }]]));
  assert.equal((TOML.parse(patched) as any).banner, banner + '\n');
  assert.equal((TOML.parse(patched) as any).mcp_servers.docs.command, 'new');
});

test('real CLI commands honor read-only boundaries and explicit apply in temporary homes', async t => {
  const { context, project, home } = await fixture(t);
  await canonical(context, ['claude-code']);
  const cli = path.join(process.cwd(), 'dist', 'cli.js');
  const run = (...args: string[]) => {
    const result = spawnSync(process.execPath, [cli, ...args, '--project', project, '--home', home, '--json'], { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(home, 'must-not-use') } });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`); return JSON.parse(result.stdout);
  };
  const beforeProject = await hashPath(project), beforeHome = await hashPath(home);
  for (const args of [['inspect'], ['plan'], ['sync'], ['import', '--from', 'claude-code']]) {
    const result = run(...args); assert.equal(result.applied, false);
    assert.equal(await hashPath(project), beforeProject); assert.equal(await hashPath(home), beforeHome);
  }
  const applied = run('sync', '--apply'); assert.equal(applied.applied, true); assert.ok(applied.changes.length);
  const afterHome = await hashPath(home), afterProject = await hashPath(project);
  const repeated = run('sync', '--apply'); assert.deepEqual(repeated.changes, []);
  assert.equal(await hashPath(home), afterHome); assert.equal(await hashPath(project), afterProject);
  for (const args of [['plan', '--apply'], ['sync', '--unknown'], ['import'], ['sync', '--scope', 'local']]) {
    const result = spawnSync(process.execPath, [cli, ...args, '--project', project, '--home', home, '--json'], { encoding: 'utf8' });
    assert.notEqual(result.status, 0); assert.equal(JSON.parse(result.stdout).applied, false);
  }
});

test('all-source inspection retains Copilot bare-map resources without reusing Claude envelope parsing', async t => {
  const { context, project } = await fixture(t);
  await json(path.join(project, '.mcp.json'), { bare: { type: 'http', url: 'https://bare.test/mcp', tools: ['*'] } });
  const inventory = await inspect(context, 'all');
  assert.ok(inventory.inventory.mcp.some(item => item.id === 'bare' && item.adapter === 'github-copilot-cli' && item.type === 'streamable-http'));
  const plan = await createPlan(context, { command: 'import', from: 'all' });
  assert.ok(plan.diagnostics.some(item => item.code === 'shared-envelope-conflict'));
  const before = await hashPath(project); await assert.rejects(applyPlan(plan)); assert.equal(await hashPath(project), before);
});

test('canonical skills cannot be projected into account-managed native skill names', async t => {
  const { context, project } = await fixture(t);
  await json(path.join(context.canonicalRoot, 'sync.json'), { version: 1, targets: ['claude-code'] });
  await skill(path.join(context.canonicalRoot, 'skills'), 'synced');
  await skill(path.join(project, '.claude', 'skills', 'synced'), 'account');
  const plan = await createPlan(context, { command: 'sync' });
  assert.ok(plan.diagnostics.some(item => item.code === 'reserved-skill-destination'));
  const before = await hashPath(project); await assert.rejects(applyPlan(plan)); assert.equal(await hashPath(project), before);
});

test('prototype-named server IDs retain own entries through native import and TOML projection', async t => {
  const { context, project } = await fixture(t);
  const source = JSON.parse('{"mcpServers":{"constructor":{"type":"http","url":"https://constructor.test/mcp"},"__proto__":{"type":"http","url":"https://proto.test/mcp"}}}');
  await json(path.join(project, '.mcp.json'), source);
  const plan = await createPlan(context, { command: 'import', from: 'claude-code', targets: ['codex'] }); valid(plan); await applyPlan(plan);
  const canonical = JSON.parse(await readFile(path.join(context.canonicalRoot, 'mcp.json'), 'utf8')).mcpServers;
  assert.equal(Object.hasOwn(canonical, '__proto__'), true); assert.equal(canonical.__proto__.url, 'https://proto.test/mcp');
  assert.equal(canonical.constructor.url, 'https://constructor.test/mcp');
  const native = await readDocument({ path: path.join(project, '.codex/config.toml'), format: 'toml', mapPath: ['mcp_servers'] });
  assert.equal(Object.getOwnPropertyDescriptor(native.map, 'constructor')!.value.url, 'https://constructor.test/mcp');
  assert.equal((native.map.__proto__ as Record<string, unknown>).url, 'https://proto.test/mcp');
  assert.equal(Object.hasOwn(Object, 'url'), false);
  const repeated = await createPlan(context, { command: 'import', from: 'claude-code', targets: ['codex'] }); valid(repeated); assert.deepEqual(repeated.operations, []);
});

test('native JSONC keeps own prototype keys and rejects duplicate server definitions', async t => {
  const { root } = await fixture(t);
  const file = path.join(root, 'settings.jsonc');
  const spec = { path: file, format: 'jsonc' as const, mapPath: ['mcpServers'] };
  await writeFile(file, '{ // preserve this comment\n "__proto__": {"sentinel": 7}, "mcpServers": {"constructor": {"command": "node"}}\n}\n');
  const document = await readDocument(spec);
  assert.equal(Object.hasOwn(document.data, '__proto__'), true); assert.equal((document.data.__proto__ as Record<string, unknown>).sentinel, 7);
  const patched = patchDocument(document, new Map([['__proto__', { command: 'server' }]]));
  await writeFile(file, patched);
  const reread = await readDocument(spec);
  assert.equal((reread.map.__proto__ as Record<string, unknown>).command, 'server'); assert.equal(Object.getOwnPropertyDescriptor(reread.map, 'constructor')!.value.command, 'node');
  assert.ok(patched.includes('// preserve this comment'));
  await writeFile(file, '{"mcpServers":{"duplicate":{"command":"first"},"duplicate":{"command":"second"}}}');
  await assert.rejects(readDocument(spec));
});

test('inline TOML patching preserves unmanaged scalar types and raw values', async t => {
  const { root } = await fixture(t);
  const file = path.join(root, 'config.toml');
  await writeFile(file, 'mcp_servers = { docs = { command = "old" }, other = { day = 1979-05-27, decimal = 1.0, command = "keep" } }\n');
  const spec = { path: file, format: 'toml' as const, mapPath: ['mcp_servers'] };
  const patched = patchDocument(await readDocument(spec), new Map([['docs', { command: 'new' }]]));
  const result = (TOML.parse(patched, { integersAsBigInt: true }) as any).mcp_servers;
  assert.equal(result.other.day.isDate(), true); assert.equal(result.other.day.isLocal(), true);
  assert.equal(typeof result.other.decimal, 'number'); assert.equal(result.other.decimal, 1);
  assert.equal(result.other.command, 'keep'); assert.equal(result.docs.command, 'new');
});
