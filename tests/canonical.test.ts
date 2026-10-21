import assert from 'node:assert/strict';
import { access, chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { discoverSkills, readCanonical, secretDiagnostics, validateServer } from '../src/canonical.js';
import type { Context, Diagnostic, Server, SkillRoot } from '../src/types.js';

async function fixture(t: TestContext): Promise<Context> {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'mishmash-canonical-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const project = path.join(temporary, 'project');
  const home = path.join(temporary, 'home');
  await mkdir(project);
  await mkdir(home);
  return { scope: 'project', project, home, canonicalRoot: path.join(project, '.agents'), stateRoot: path.join(home, 'state'), platform: process.platform, env: {}, opencodeVersion: 2, skillMode: 'auto' };
}
async function json(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value));
}
async function makeSkill(root: string, name = 'review', frontmatter = `name: ${name}\ndescription: Review changes.`, body = 'Inspect references and scripts without executing them.'): Promise<string> {
  const directory = path.join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'SKILL.md'), `---\n${frontmatter}\n---\n\n${body}\n`);
  return directory;
}
const errors = (diagnostics: Diagnostic[]): Diagnostic[] => diagnostics.filter(item => item.severity === 'error');
const rootFor = (context: Context): SkillRoot => ({ path: path.join(context.canonicalRoot, 'skills'), kind: 'canonical' });

for (const server of [
  { type: 'stdio', command: 'node' },
  { type: 'stdio', command: '/opt/Program Files/node', args: ['a b', '!not-executed', '${LITERAL}', '$(not-executed)'], env: { MODE: 'production', PORT: '8080', RENAMED: { env: 'ORIGINAL' }, API_TOKEN: { env: 'ACTUAL_TOKEN' } }, cwd: { base: 'source', path: 'tools/runtime' } },
  { type: 'stdio', command: 'C:\\Program Files\\Runtime\\node.exe', cwd: { base: 'home', path: '.' } },
  { type: 'streamable-http', url: 'https://example.com/mcp?version=2', headers: { Authorization: { env: 'MCP_AUTH' }, Accept: 'application/json', 'X-Project': 'demo' } },
  { type: 'sse', url: 'http://localhost:8080/sse' },
] satisfies Server[]) {
  test(`validates and preserves ${server.type} canonical values: ${JSON.stringify(server)}`, () => {
    const result = validateServer(server);
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(result.server, server);
  });
}

for (const value of [
  null, [], 'server', {}, { type: 'http', url: 'https://example.com' },
  { type: 'stdio' }, { type: 'stdio', command: '' }, { type: 'stdio', command: 'node --eval dangerous' },
  { type: 'stdio', command: ' node' }, { type: 'stdio', command: 'node\nmalicious' },
  { type: 'stdio', command: 'node', url: 'https://example.com' },
  { type: 'stdio', command: 'node', args: ['ok', 1] }, { type: 'stdio', command: 'node', args: 'a b' },
  { type: 'stdio', command: 'node', env: { FOO: 42 } },
  { type: 'stdio', command: 'node', env: { 'BAD-NAME': 'literal' } },
  { type: 'stdio', command: 'node', env: { FOO: { env: 'BAD-NAME' } } },
  { type: 'stdio', command: 'node', env: { FOO: { env: 'GOOD', extra: true } } },
  { type: 'stdio', command: 'node', env: { FOO: { env: '' } } },
  { type: 'stdio', command: 'node', env: [] },
  { type: 'stdio', command: 'node', cwd: '.' },
  { type: 'stdio', command: 'node', cwd: { base: 'unknown', path: '.' } },
  { type: 'stdio', command: 'node', cwd: { base: 'project', path: '' } },
  { type: 'stdio', command: 'node', cwd: { base: 'project', path: '../private' } },
  { type: 'stdio', command: 'node', cwd: { base: 'source', path: 'safe/../../private' } },
  { type: 'stdio', command: 'node', cwd: { base: 'source', path: 'safe\\..\\private' } },
  { type: 'stdio', command: 'node', cwd: { base: 'home', path: '/absolute' } },
  { type: 'stdio', command: 'node', cwd: { base: 'home', path: 'C:\\absolute' } },
  { type: 'stdio', command: 'node', cwd: { base: 'home', path: 'C:relative-drive' } },
  { type: 'stdio', command: 'node', cwd: { base: 'home', path: '.', extra: true } },
  { type: 'streamable-http', url: 'not a URL' }, { type: 'streamable-http', url: 'file:///secret' },
  { type: 'streamable-http', url: 'https://example.com', command: 'node' },
  { type: 'streamable-http', url: 'https://example.com', headers: { Bad: 'line\r\ninjected: value' } },
  { type: 'streamable-http', url: 'https://example.com', headers: { 'Invalid Header': 'literal' } },
  { type: 'streamable-http', url: 'https://example.com', headers: { 'X-Ref': { env: 'A B' } } },
  { type: 'sse', url: 'https://example.com', headers: null },
  { type: 'stdio', command: 'node', startup_timeout_sec: 20 },
]) {
  test(`rejects malformed canonical server variant ${JSON.stringify(value)}`, () => {
    const result = validateServer(value);
    assert.equal(result.server, undefined);
    assert.ok(errors(result.diagnostics).length);
    assert.ok(result.diagnostics.some(item => item.code === 'mcp-invalid-server'));
  });
}

test('literal credentials and state are rejected recursively without exposing their contents', () => {
  const secret = 'DO-NOT-PRINT-private-value-91351';
  const values: unknown[] = [
    { env: { API_KEY: secret } }, { env: { GITHUB_TOKEN: secret } }, { env: { AWS_SECRET_ACCESS_KEY: secret } },
    { headers: { Authorization: secret } }, { headers: { 'Proxy-Authorization': secret } }, { headers: { Cookie: secret } },
    { native: { clientSecret: secret } }, { oauth: { accessToken: secret, refreshToken: secret } },
    { url: `https://user:${secret}@example.com/mcp` }, { url: `https://example.com/mcp?access_token=${secret}` },
    { url: `https://example.com/mcp?api%5Fkey=${secret}` }, { url: `https://example.com/mcp#token=${secret}` },
    { args: ['--api-key', secret] }, { args: [`--password=${secret}`] },
    { nested: [{ authorization: secret }] }, { trust: { approved: true } }, { allowAllTools: true }, { oauthState: secret },
    { password: { env: 'INVALID-NAME' } },
  ];
  for (const value of values) {
    const diagnostics = secretDiagnostics(value, 'fixture');
    assert.ok(errors(diagnostics).length, JSON.stringify(value));
    assert.equal(JSON.stringify(diagnostics).includes(secret), false);
    assert.equal(diagnostics.every(item => item.resource === 'fixture'), true);
  }
  const invalid = validateServer({ type: 'stdio', command: 'node', env: { API_KEY: secret } });
  assert.equal(invalid.server, undefined);
  assert.equal(JSON.stringify(invalid.diagnostics).includes(secret), false);
});

test('opaque credential arguments are rejected without relying on recognizable token contents', () => {
  const secret = 'opaque-value-91351';
  for (const args of [
    ['--token', secret], ['--secret', secret], ['--private-key', secret], ['--refresh-token', secret],
    [`--token=${secret}`], [`--secret=${secret}`], [`--private-key=${secret}`],
  ]) {
    const result = validateServer({ type: 'stdio', command: 'node', args });
    assert.equal(result.server, undefined);
    assert.ok(result.diagnostics.some(item => item.code === 'secret-literal'));
    assert.equal(JSON.stringify(result.diagnostics).includes(secret), false);
  }
});

test('nested or malformed server-map labels cannot hide credential and trust fields', () => {
  const secret = 'opaque-value-91351';
  for (const value of [
    { oauth: { servers: { clientSecret: secret } } },
    { native: { mcpServers: { password: { value: secret } } } },
    { servers: { accessToken: secret } },
    { nested: { servers: { trust: { approved: true } } } },
  ]) {
    const findings = secretDiagnostics(value);
    assert.ok(errors(findings).length);
    assert.equal(JSON.stringify(findings).includes(secret), false);
  }
});

test('ordinary values, environment references, native registration and map IDs are not credentials', () => {
  assert.deepEqual(secretDiagnostics({ env: { MODE: 'production', TOKENIZER_PARALLELISM: 'false', API_KEY: { env: 'KEY_SOURCE' } }, headers: { Authorization: { env: 'AUTH_SOURCE' } }, oauth: { clientId: 'public-client', scopes: ['read'] }, mcpServers: { token: { command: 'node' }, trust: { command: 'node' } } }), []);
  const cyclic: Record<string, unknown> = { mode: 'safe' };
  cyclic.self = cyclic;
  assert.deepEqual(secretDiagnostics(cyclic), []);
});

test('absent canonical root stays absent with empty versioned defaults and race inputs', async t => {
  const context = await fixture(t);
  const first = await readCanonical(context);
  const second = await readCanonical(context);
  assert.deepEqual(first, second);
  assert.deepEqual(first.sync, { version: 1, targets: [] });
  assert.deepEqual(first.mcp, { version: 1, mcpServers: {} });
  assert.deepEqual(first.overrides, {});
  assert.deepEqual(first.skills, []);
  assert.deepEqual(first.diagnostics, []);
  for (const suffix of ['', 'sync.json', 'mcp.json', 'skills', 'overrides']) assert.ok(first.inputs.includes(path.join(context.canonicalRoot, suffix)));
  await assert.rejects(access(context.canonicalRoot));
  await assert.rejects(access(context.stateRoot));
});

test('reads versioned canonical documents, preserves native-only options and literal/reference distinctions', async t => {
  const context = await fixture(t);
  await json(path.join(context.canonicalRoot, 'sync.json'), { version: 1, targets: ['future-adapter', 'codex'] });
  const servers = {
    local: { type: 'stdio', command: 'node', args: ['a b'], env: { MODE: 'literal', RENAMED: { env: 'ACTUAL_NAME' } }, cwd: { base: 'project', path: '.' } },
    remote: { type: 'streamable-http', url: 'https://example.com/mcp', headers: { Authorization: { env: 'MY_AUTH' } } },
  };
  await json(path.join(context.canonicalRoot, 'mcp.json'), { version: 1, mcpServers: servers });
  const overrides = { version: 1, mcpServers: { local: { startup_timeout_sec: 30, enabled: true }, remote: { oauth: { clientId: 'public-client' }, tools: ['search'] } } };
  await json(path.join(context.canonicalRoot, 'overrides', 'future-adapter', 'mcp.json'), overrides);
  const skill = await makeSkill(rootFor(context).path);
  const data = await readCanonical(context);
  assert.deepEqual(data.sync.targets, ['future-adapter', 'codex']);
  assert.deepEqual(data.mcp.mcpServers, servers);
  assert.deepEqual(data.overrides['future-adapter'], overrides);
  assert.equal(data.skills[0]?.path, skill);
  assert.deepEqual(data.diagnostics, []);
  assert.deepEqual(data.inputs, [...new Set(data.inputs)].sort());
  assert.ok(data.inputs.includes(path.join(context.canonicalRoot, 'overrides', 'future-adapter')));
  assert.ok(data.inputs.includes(path.join(skill, 'SKILL.md')));
});

for (const content of ['{', '// comment\n{}', '{"version":1,"targets":[],}', '{"version":1,"version":1,"targets":[]}', '{"version":1,"targets":[],"nested":{"a":1,"a":2}}', '', 'undefined']) {
  test(`rejects non-strict JSON without echoing its content ${JSON.stringify(content)}`, async t => {
    const context = await fixture(t);
    await mkdir(context.canonicalRoot);
    await writeFile(path.join(context.canonicalRoot, 'sync.json'), content);
    const data = await readCanonical(context);
    assert.ok(data.diagnostics.some(item => item.code === 'canonical-invalid-json'));
    assert.deepEqual(data.sync.targets, []);
    assert.equal((await readFile(path.join(context.canonicalRoot, 'sync.json'), 'utf8')), content);
  });
}

for (const sync of [null, [], {}, { version: 2, targets: [] }, { version: 1, targets: 'codex' }, { version: 1, targets: [1] }, { version: 1, targets: [''] }, { version: 1, targets: [' codex'] }, { version: 1, targets: ['codex', 'codex'] }, { version: 1, targets: [], unknown: true }]) {
  test(`rejects invalid target selection ${JSON.stringify(sync)}`, async t => {
    const context = await fixture(t);
    await json(path.join(context.canonicalRoot, 'sync.json'), sync);
    const data = await readCanonical(context);
    assert.ok(errors(data.diagnostics).length);
    assert.deepEqual(data.sync.targets, []);
  });
}

for (const document of [null, [], {}, { version: 2, mcpServers: {} }, { version: 1, mcpServers: [] }, { version: 1, mcpServers: {}, extra: true }, { version: 1, mcpServers: { bad: { type: 'stdio', command: 'node', nativeOption: true } } }]) {
  test(`rejects invalid MCP envelope or unknown canonical options ${JSON.stringify(document)}`, async t => {
    const context = await fixture(t);
    await json(path.join(context.canonicalRoot, 'mcp.json'), document);
    const data = await readCanonical(context);
    assert.ok(errors(data.diagnostics).length);
    assert.deepEqual(data.mcp.mcpServers, {});
  });
}

test('invalid overrides and credential overrides are not accepted or leaked', async t => {
  const context = await fixture(t);
  const secret = 'keep-this-override-private-91351';
  for (const [id, document] of Object.entries({
    badversion: { version: 2, mcpServers: {} },
    badmap: { version: 1, mcpServers: [] },
    badentry: { version: 1, mcpServers: { server: 'not-object' } },
    unknown: { version: 1, mcpServers: {}, extra: true },
    secret: { version: 1, mcpServers: { server: { clientSecret: secret } } },
    state: { version: 1, mcpServers: { server: { trust: true } } },
  })) await json(path.join(context.canonicalRoot, 'overrides', id, 'mcp.json'), document);
  const data = await readCanonical(context);
  assert.deepEqual(data.overrides, {});
  assert.ok(errors(data.diagnostics).length >= 6);
  assert.equal(JSON.stringify(data.diagnostics).includes(secret), false);
  assert.equal(JSON.stringify(data.mcp).includes(secret), false);
});

test('rejects unknown overrides root entries and file/directory mismatches without throwing', async t => {
  const context = await fixture(t);
  await mkdir(path.join(context.canonicalRoot, 'overrides'), { recursive: true });
  await writeFile(path.join(context.canonicalRoot, 'overrides', 'not-a-directory'), '{}');
  await mkdir(path.join(context.canonicalRoot, 'overrides', 'INVALID'));
  await mkdir(path.join(context.canonicalRoot, 'mcp.json'));
  const data = await readCanonical(context);
  assert.ok(errors(data.diagnostics).length >= 3);
  assert.deepEqual(data.overrides, {});
});

test('user scope cannot claim a project-relative working directory', async t => {
  const context = await fixture(t);
  context.scope = 'user';
  context.canonicalRoot = path.join(context.home, '.agents');
  await json(path.join(context.canonicalRoot, 'mcp.json'), { version: 1, mcpServers: { server: { type: 'stdio', command: 'node', cwd: { base: 'project', path: '.' } } } });
  const data = await readCanonical(context);
  assert.ok(errors(data.diagnostics).length);
  assert.deepEqual(data.mcp.mcpServers, {});
});

test('special JSON map identities do not mutate object prototypes', async t => {
  const context = await fixture(t);
  await mkdir(context.canonicalRoot);
  await writeFile(path.join(context.canonicalRoot, 'mcp.json'), '{"version":1,"mcpServers":{"__proto__":{"type":"stdio","command":"node"},"constructor":{"type":"stdio","command":"node"}}}');
  const data = await readCanonical(context);
  assert.deepEqual(errors(data.diagnostics), []);
  assert.equal(Object.hasOwn(data.mcp.mcpServers, '__proto__'), true);
  assert.equal(Object.getPrototypeOf(data.mcp.mcpServers), Object.prototype);
});

test('canonical documents may not follow external symlinks', async t => {
  const context = await fixture(t);
  await mkdir(context.canonicalRoot);
  const external = path.join(context.home, 'private.json');
  await json(external, { version: 1, mcpServers: { secret: { type: 'stdio', command: 'node', env: { API_KEY: 'external-secret-91351' } } } });
  await symlink(external, path.join(context.canonicalRoot, 'mcp.json'), 'file');
  const data = await readCanonical(context);
  assert.deepEqual(data.mcp.mcpServers, {});
  assert.ok(data.diagnostics.some(item => item.code === 'canonical-invalid-config'));
  assert.equal(JSON.stringify(data.diagnostics).includes('external-secret-91351'), false);
  assert.equal((await lstat(path.join(context.canonicalRoot, 'mcp.json'))).isSymbolicLink(), true);
});

test('whole skill assets, executable modes, hidden files and internal links are preserved and hashed without execution', async t => {
  const context = await fixture(t);
  const root = rootFor(context);
  const skill = await makeSkill(root.path, 'review', 'name: review\ndescription: Review changes.\nlicense: MIT\ncompatibility: Requires a local checkout.\nmetadata:\n  owner: engineering');
  await mkdir(path.join(skill, 'scripts'));
  await mkdir(path.join(skill, 'references'));
  await mkdir(path.join(skill, 'assets'));
  const marker = path.join(context.project, 'EXECUTED');
  const script = path.join(skill, 'scripts', 'run.sh');
  await writeFile(script, `#!/bin/sh\ntouch '${marker}'\n`);
  await chmod(script, 0o755);
  await writeFile(path.join(skill, 'references', 'guide.txt'), 'complete guide');
  await writeFile(path.join(skill, 'assets', 'image.bin'), Buffer.from([0, 1, 255, 128]));
  await writeFile(path.join(skill, '.hidden-metadata'), 'hidden asset');
  await symlink('../references/guide.txt', path.join(skill, 'assets', 'guide-link'), 'file');
  const mode = (await stat(script)).mode;
  const first = await discoverSkills([root], context);
  const second = await discoverSkills([root], context);
  assert.deepEqual(first, second);
  assert.deepEqual(first.diagnostics, []);
  assert.equal(first.skills.length, 1);
  assert.equal(first.skills[0]?.nativeOnly, false);
  assert.equal((await stat(script)).mode, mode);
  assert.equal(await readlink(path.join(skill, 'assets', 'guide-link')), '../references/guide.txt');
  assert.deepEqual(await readFile(path.join(skill, 'assets', 'image.bin')), Buffer.from([0, 1, 255, 128]));
  await assert.rejects(access(marker));
  await writeFile(path.join(skill, 'references', 'guide.txt'), 'changed guide');
  const changed = await discoverSkills([root], context);
  assert.notEqual(first.skills[0]?.hash, changed.skills[0]?.hash);
  await writeFile(path.join(skill, '.hidden-metadata'), 'changed hidden asset');
  const hiddenChanged = await discoverSkills([root], context);
  assert.notEqual(changed.skills[0]?.hash, hiddenChanged.skills[0]?.hash);
  await chmod(script, 0o644);
  const modeChanged = await discoverSkills([root], context);
  if ((await stat(script)).mode !== mode) assert.notEqual(hiddenChanged.skills[0]?.hash, modeChanged.skills[0]?.hash);
  await assert.rejects(access(marker));
});

test('discovery is sorted, shallow when configured, recursively finds collections and stops at each skill', async t => {
  const context = await fixture(t);
  const root = path.join(context.project, 'native-skills');
  await makeSkill(root, 'zeta');
  const alpha = await makeSkill(root, 'alpha');
  await makeSkill(alpha, 'not-another-skill');
  await makeSkill(path.join(root, 'collection'), 'deep');
  await makeSkill(path.join(root, '.hidden'), 'hidden');
  await makeSkill(path.join(root, 'node_modules'), 'package');
  const shallow = await discoverSkills([{ path: root, kind: 'native', ignoredDirectories: ['node_modules'] }], context);
  assert.deepEqual(shallow.skills.map(skill => skill.id), ['alpha', 'zeta']);
  const recursive = await discoverSkills([{ path: root, kind: 'native', recursive: true, ignoredDirectories: ['node_modules'] }], context);
  assert.deepEqual(recursive.skills.map(skill => skill.id), ['alpha', 'deep', 'zeta']);
  assert.deepEqual(errors(recursive.diagnostics), []);
  const configured = await discoverSkills([{ path: alpha, kind: 'configured' }], context);
  assert.deepEqual(configured.skills.map(skill => skill.id), ['alpha']);
});

test('canonical collection cannot itself be a skill or contain incomplete skill directories', async t => {
  const context = await fixture(t);
  const root = rootFor(context);
  await mkdir(path.join(root.path, 'incomplete'), { recursive: true });
  let result = await discoverSkills([root], context);
  assert.ok(errors(result.diagnostics).length);
  assert.deepEqual(result.skills, []);
  await writeFile(path.join(root.path, 'SKILL.md'), '---\nname: skills\ndescription: Invalid location.\n---\n');
  result = await discoverSkills([root], context);
  assert.ok(errors(result.diagnostics).length);
  assert.deepEqual(result.skills, []);
});

for (const frontmatter of [
  'description: Missing name.', 'name: review', 'name: Review\ndescription: Invalid case.',
  'name: wrong-name\ndescription: Mismatch.', 'name: review\ndescription: ""',
  'name: review\ndescription: 42', 'name: review\ndescription: ' + 'a'.repeat(1025),
  'name: review\ndescription: Valid.\nlicense: [MIT]',
  'name: review\ndescription: Valid.\ncompatibility: 5',
  'name: review\ndescription: Valid.\ncompatibility: ' + 'a'.repeat(501),
  'name: review\ndescription: Valid.\nmetadata: [invalid]',
  'name: review\ndescription: Valid.\nmetadata:\n  numeric: 42',
  'name: review\ndescription: Valid.\nallowed-tools: [Read, Bash]',
  'name: review\nname: review\ndescription: Duplicate.',
  'name: review\ndescription: [broken',
  'name: review\ndescription: !unknown-tag Untrusted.',
  'name: review\ndescription: &description Alias.\nlicense: *description',
]) {
  test(`rejects malformed skill metadata ${JSON.stringify(frontmatter.slice(0, 120))}`, async t => {
    const context = await fixture(t);
    const root = rootFor(context);
    await makeSkill(root.path, 'review', frontmatter);
    const result = await discoverSkills([root], context);
    assert.deepEqual(result.skills, []);
    assert.ok(result.diagnostics.some(item => item.code === 'skill-invalid'));
  });
}

for (const name of ['-leading', 'trailing-', 'double--hyphen', 'UPPER', 'has_underscore', 'a'.repeat(65)]) {
  test(`rejects nonportable skill directory/name ${name}`, async t => {
    const context = await fixture(t);
    const root = rootFor(context);
    await makeSkill(root.path, name);
    const result = await discoverSkills([root], context);
    assert.deepEqual(result.skills, []);
    assert.ok(errors(result.diagnostics).length);
  });
}

test('64-character skill names and maximum description length are accepted', async t => {
  const context = await fixture(t);
  const root = rootFor(context);
  const name = 'a'.repeat(64);
  await makeSkill(root.path, name, `name: ${name}\ndescription: ${'b'.repeat(1024)}`);
  const result = await discoverSkills([root], context);
  assert.equal(result.skills[0]?.id, name);
  assert.deepEqual(result.diagnostics, []);
});

test('missing/non-object frontmatter and unterminated YAML fail without changing the source', async t => {
  const context = await fixture(t);
  const root = rootFor(context);
  const directory = await makeSkill(root.path);
  for (const text of ['# Missing frontmatter', '---\nname: review\ndescription: Missing closing delimiter.', '---\n- review\n- description\n---\n']) {
    await writeFile(path.join(directory, 'SKILL.md'), text);
    const result = await discoverSkills([root], context);
    assert.deepEqual(result.skills, []);
    assert.ok(errors(result.diagnostics).length);
    assert.equal(await readFile(path.join(directory, 'SKILL.md'), 'utf8'), text);
  }
});

test('unknown frontmatter, experimental tool grants, native metadata and substitutions stay intact and native-only', async t => {
  const context = await fixture(t);
  const root = rootFor(context);
  const cases = [
    ['claude', 'disable-model-invocation: true\ncontext: fork', 'Ordinary body.'],
    ['unknown', 'future-extension:\n  preserve: true', 'Ordinary body.'],
    ['tools', 'allowed-tools: Read Grep', 'Ordinary body.'],
    ['opencode', 'metadata:\n  opencode/autoinvoke: "false"', 'Ordinary body.'],
    ['substitution', '', 'Use $ARGUMENTS and !`dangerous-command` without executing during discovery.'],
    ['sidecar', '', 'Ordinary body.'],
  ];
  for (const [name, extra, body] of cases) {
    const directory = await makeSkill(root.path, name!, `name: ${name}\ndescription: Native behavior.\n${extra}`, body);
    if (name === 'sidecar') {
      await mkdir(path.join(directory, 'agents'));
      await writeFile(path.join(directory, 'agents', 'openai.yaml'), 'policy:\n  allow_implicit_invocation: false\n');
    }
  }
  const before = await Promise.all(cases.map(([name]) => readFile(path.join(root.path, name!, 'SKILL.md'), 'utf8')));
  const result = await discoverSkills([root], context);
  assert.equal(result.skills.length, cases.length);
  assert.ok(result.skills.every(skill => skill.nativeOnly));
  assert.equal(result.diagnostics.filter(item => item.code === 'skill-native-only').length, cases.length);
  assert.deepEqual(errors(result.diagnostics), []);
  const after = await Promise.all(cases.map(([name]) => readFile(path.join(root.path, name!, 'SKILL.md'), 'utf8')));
  assert.deepEqual(after, before);
});

test('credential frontmatter does not become merely a native-only warning', async t => {
  const context = await fixture(t);
  const root = rootFor(context);
  await makeSkill(root.path, 'review', 'name: review\ndescription: Review.\nclientSecret: PRIVATE-FRONTMATTER-91351');
  const result = await discoverSkills([root], context);
  assert.deepEqual(result.skills, []);
  assert.ok(result.diagnostics.some(item => item.code === 'secret-literal'));
  assert.equal(JSON.stringify(result.diagnostics).includes('PRIVATE-FRONTMATTER-91351'), false);
});

test('same real directory is deduplicated, but distinct same-name directories conflict even with identical bytes', async t => {
  const context = await fixture(t);
  const firstRoot = path.join(context.project, 'first');
  const secondRoot = path.join(context.project, 'second');
  const aliasRoot = path.join(context.project, 'alias');
  const first = await makeSkill(firstRoot);
  await makeSkill(secondRoot);
  await mkdir(aliasRoot);
  await symlink(first, path.join(aliasRoot, 'review'), process.platform === 'win32' ? 'junction' : 'dir');
  const roots: SkillRoot[] = [{ path: firstRoot, kind: 'native' }, { path: aliasRoot, kind: 'legacy' }, { path: secondRoot, kind: 'native' }];
  const result = await discoverSkills(roots, context);
  assert.equal(result.skills.length, 2);
  assert.equal(result.skills[0]?.hash, result.skills[1]?.hash);
  assert.ok(result.diagnostics.some(item => item.code === 'skill-duplicate-identity' && item.severity === 'info'));
  assert.ok(result.diagnostics.some(item => item.code === 'skill-duplicate-name' && item.severity === 'error'));
  assert.deepEqual(await discoverSkills(roots, context), result);
});

for (const kind of ['escaping-file', 'escaping-directory', 'absolute-internal', 'broken', 'cycle'] as const) {
  test(`rejects ${kind} symlinks anywhere inside a skill tree`, async t => {
    const context = await fixture(t);
    const root = rootFor(context);
    const skill = await makeSkill(root.path);
    await mkdir(path.join(skill, 'assets'));
    await writeFile(path.join(context.project, 'outside.txt'), 'not-an-asset');
    await mkdir(path.join(context.project, 'outside-directory'));
    if (kind === 'escaping-file') await symlink(path.relative(path.join(skill, 'assets'), path.join(context.project, 'outside.txt')), path.join(skill, 'assets', 'link'), 'file');
    if (kind === 'escaping-directory') await symlink(path.join(context.project, 'outside-directory'), path.join(skill, 'assets', 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    if (kind === 'absolute-internal') await symlink(path.join(skill, 'SKILL.md'), path.join(skill, 'assets', 'link'), 'file');
    if (kind === 'broken') await symlink('missing', path.join(skill, 'assets', 'link'), 'file');
    if (kind === 'cycle') await symlink('..', path.join(skill, 'assets', 'link'), 'dir');
    const result = await discoverSkills([root], context);
    assert.deepEqual(result.skills, []);
    assert.ok(result.diagnostics.some(item => item.code === 'skill-unsafe-link'));
    assert.equal((await lstat(path.join(skill, 'assets', 'link'))).isSymbolicLink(), true);
  });
}

test('relative internal directory links remain preserved and participate in the complete hash', async t => {
  const context = await fixture(t);
  const root = rootFor(context);
  const skill = await makeSkill(root.path);
  await mkdir(path.join(skill, 'references'));
  await writeFile(path.join(skill, 'references', 'guide'), 'guide');
  await symlink('references', path.join(skill, 'ref-link'), 'dir');
  const result = await discoverSkills([root], context);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.skills.length, 1);
  assert.equal(await readlink(path.join(skill, 'ref-link')), 'references');
});

test('collection cycles and external non-skill collections fail without traversal loops', async t => {
  const context = await fixture(t);
  const root = path.join(context.project, 'native');
  await mkdir(root);
  await symlink('.', path.join(root, 'cycle'), 'dir');
  const outside = path.join(context.project, 'outside');
  await makeSkill(outside);
  await symlink(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = await discoverSkills([{ path: root, kind: 'native', recursive: true }], context);
  assert.deepEqual(result.skills, []);
  assert.equal(result.diagnostics.filter(item => item.code === 'skill-unsafe-link').length, 2);
});

test('native standalone Markdown receives an explicit nonportable format finding instead of a fake skill tree', async t => {
  const context = await fixture(t);
  const root = path.join(context.project, 'native');
  await mkdir(root);
  await writeFile(path.join(root, 'legacy.md'), '---\nname: legacy\ndescription: Native file.\n---\n');
  const result = await discoverSkills([{ path: root, kind: 'legacy', recursive: true }], context);
  assert.deepEqual(result.skills, []);
  assert.ok(result.diagnostics.some(item => item.code === 'skill-native-format' && item.severity === 'warning'));
  assert.ok(result.inputs.includes(path.join(root, 'legacy.md')));
  assert.deepEqual(await readdir(root), ['legacy.md']);
});

test('inherited native ignore files control discovery, not the complete adopted skill payload', async t => {
  const context = await fixture(t);
  const root = path.join(context.project, 'native');
  await makeSkill(root, 'skip-root');
  await makeSkill(root, 'root-kept');
  await makeSkill(path.join(root, 'collection'), 'skip-parent');
  const kept = await makeSkill(path.join(root, 'collection'), 'keep-override');
  await makeSkill(path.join(root, 'collection'), 'skip-local');
  await makeSkill(path.join(root, 'collection'), 'fd-excluded');
  await writeFile(path.join(root, '.gitignore'), 'skip-*/\n**/keep-*/\n');
  await writeFile(path.join(root, 'collection', '.gitignore'), '!keep-override/\n');
  await writeFile(path.join(root, 'collection', '.ignore'), 'skip-local/\n');
  await writeFile(path.join(root, 'collection', '.fdignore'), 'fd-excluded/\n');
  await mkdir(path.join(kept, 'assets'));
  await writeFile(path.join(kept, '.gitignore'), 'assets/\n');
  await writeFile(path.join(kept, 'assets', 'included.txt'), 'ignored for native discovery, retained as skill support');
  const policy: SkillRoot = { path: root, kind: 'native', recursive: true, ignoreFiles: ['.gitignore', '.ignore', '.fdignore'] };
  const result = await discoverSkills([policy], context);
  assert.deepEqual(result.skills.map(skill => skill.id), ['keep-override', 'root-kept']);
  assert.deepEqual(errors(result.diagnostics), []);
  for (const ignoreFile of ['.gitignore', '.ignore', '.fdignore']) {
    assert.ok(result.inputs.includes(path.join(root, ignoreFile)));
    assert.ok(result.inputs.includes(path.join(root, 'collection', ignoreFile)));
  }
  const before = result.skills.find(skill => skill.id === 'keep-override')!.hash;
  await writeFile(path.join(kept, 'assets', 'included.txt'), 'changed ignored skill asset');
  const changed = await discoverSkills([policy], context);
  assert.notEqual(changed.skills.find(skill => skill.id === 'keep-override')!.hash, before);
  const withoutIgnores = await discoverSkills([{ path: root, kind: 'native', recursive: true }], context);
  assert.equal(withoutIgnores.skills.length, 6);
});

test('gitignore directory patterns cannot unignore descendants of an excluded parent', async t => {
  const context = await fixture(t);
  const root = path.join(context.project, 'native');
  await makeSkill(path.join(root, 'excluded'), 'review');
  await writeFile(path.join(root, '.gitignore'), 'excluded/\n!excluded/review/\n');
  const result = await discoverSkills([{ path: root, kind: 'native', recursive: true, ignoreFiles: ['.gitignore'] }], context);
  assert.deepEqual(result.skills, []);
  assert.deepEqual(errors(result.diagnostics), []);
});

test('ignore filename precedence and anchored rules use each containing directory as their base', async t => {
  const context = await fixture(t);
  const root = path.join(context.project, 'native');
  await makeSkill(root, 'review');
  await makeSkill(path.join(root, 'nested'), 'review');
  await writeFile(path.join(root, '.gitignore'), '/review/\n');
  await writeFile(path.join(root, '.ignore'), '!/review/\n');
  await writeFile(path.join(root, '.fdignore'), '/review/\n');
  const result = await discoverSkills([{ path: root, kind: 'native', recursive: true, ignoreFiles: ['.gitignore', '.ignore', '.fdignore'] }], context);
  assert.equal(result.skills.length, 1);
  assert.equal(result.skills[0]?.path, path.join(root, 'nested', 'review'));
  assert.deepEqual(errors(result.diagnostics), []);
});

test('depth, entry and directory-count boundaries report untouched undiscovered resources', async t => {
  const context = await fixture(t);
  const root = path.join(context.project, 'native');
  await makeSkill(root, 'alpha');
  await makeSkill(root, 'zeta');
  await makeSkill(path.join(root, 'collection'), 'deep');
  const depth = await discoverSkills([{ path: root, kind: 'native', recursive: true, maxDepth: 1 }], context);
  assert.deepEqual(depth.skills.map(skill => skill.id), ['alpha', 'zeta']);
  assert.ok(depth.diagnostics.some(item => item.code === 'skill-discovery-limit' && item.severity === 'warning'));
  const entries = await discoverSkills([{ path: root, kind: 'native', recursive: true, maxEntries: 1 }], context);
  assert.deepEqual(entries.skills.map(skill => skill.id), ['alpha']);
  assert.ok(entries.diagnostics.some(item => item.code === 'skill-discovery-limit'));
  const directories = await discoverSkills([{ path: root, kind: 'native', recursive: true, maxDirectories: 2 }], context);
  assert.deepEqual(directories.skills.map(skill => skill.id), ['alpha']);
  assert.ok(directories.diagnostics.some(item => item.code === 'skill-discovery-limit'));
  for (const result of [depth, entries, directories]) assert.deepEqual(errors(result.diagnostics), []);
  assert.equal(await readFile(path.join(root, 'collection', 'deep', 'SKILL.md'), 'utf8'), '---\nname: deep\ndescription: Review changes.\n---\n\nInspect references and scripts without executing them.\n');
});

test('explicit ignored directory policy is not silently imposed on unrelated native roots', async t => {
  const context = await fixture(t);
  const root = path.join(context.project, 'native');
  await makeSkill(path.join(root, 'venv'));
  const ignored = await discoverSkills([{ path: root, kind: 'native', recursive: true, ignoredDirectories: ['venv'] }], context);
  assert.deepEqual(ignored.skills, []);
  const included = await discoverSkills([{ path: root, kind: 'native', recursive: true }], context);
  assert.equal(included.skills.length, 1);
});

test('invalid discovery policies and external ignore symlinks are rejected without reading external content', async t => {
  const context = await fixture(t);
  const root = path.join(context.project, 'native');
  await makeSkill(root);
  const invalid: SkillRoot[] = [
    { path: root, kind: 'native', maxDepth: -1 },
    { path: root, kind: 'native', maxEntries: 1.5 },
    { path: root, kind: 'native', maxDirectories: -1 },
    { path: root, kind: 'native', ignoreFiles: ['../outside'] },
    { path: root, kind: 'native', ignoreFiles: ['..\\outside'] },
  ];
  for (const policy of invalid) {
    const result = await discoverSkills([policy], context);
    assert.deepEqual(result.skills, []);
    assert.ok(errors(result.diagnostics).length);
  }
  await writeFile(path.join(context.home, 'private-ignore'), 'review/\n');
  await symlink(path.join(context.home, 'private-ignore'), path.join(root, '.gitignore'), 'file');
  const result = await discoverSkills([{ path: root, kind: 'native', ignoreFiles: ['.gitignore'] }], context);
  assert.deepEqual(result.skills, []);
  assert.ok(errors(result.diagnostics).length);
});

test('escaping SKILL.md links are blocked before frontmatter interpretation', async t => {
  const context = await fixture(t);
  const root = rootFor(context);
  const directory = path.join(root.path, 'review');
  await mkdir(directory, { recursive: true });
  const external = path.join(context.home, 'PRIVATE.md');
  await writeFile(external, '---\nname: review\ndescription: Private.\nclientSecret: NOT-FOR-DIAGNOSTICS-91351\n---\n');
  await symlink(external, path.join(directory, 'SKILL.md'), 'file');
  const result = await discoverSkills([root], context);
  assert.deepEqual(result.skills, []);
  assert.ok(result.diagnostics.some(item => item.code === 'skill-unsafe-link'));
  assert.equal(result.diagnostics.some(item => item.code === 'secret-literal'), false);
  assert.equal(JSON.stringify(result.diagnostics).includes('NOT-FOR-DIAGNOSTICS-91351'), false);
});
