import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { pi } from '../src/adapters/pi.js';
import { opencode } from '../src/adapters/opencode.js';
import { geminiCli } from '../src/adapters/gemini-cli.js';
import type { Context, Scope } from '../src/types.js';

async function fixture(t: TestContext, scope: Scope = 'project') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mishmash-adapters-b-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const project = path.join(root, 'workspace', 'nested');
  await mkdir(home, { recursive: true });
  await mkdir(project, { recursive: true });
  const context: Context = { scope, home, project, platform: process.platform, env: {}, canonicalRoot: path.join(scope === 'user' ? home : project, '.agents'), stateRoot: path.join(root, 'state'), opencodeVersion: 2, skillMode: 'auto' };
  return { root, home, project, context };
}
async function put(file: string, content: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, typeof content === 'string' ? content : JSON.stringify(content));
}

for (const adapter of [pi, opencode, geminiCli]) {
  test(`${adapter.id} resolves isolated project/user paths and refuses private scope without hoisting`, async t => {
    const { context, project, home } = await fixture(t);
    const projectLayout = adapter.resolve(context);
    assert.equal(projectLayout.directSkills, true);
    assert.ok(projectLayout.skillRoots.some(root => root.path === path.join(project, '.agents', 'skills')));
    assert.ok(projectLayout.mcpFiles[0]!.path.startsWith(project + path.sep));
    assert.ok(!projectLayout.mcpFiles.some(file => file.path.startsWith(home + path.sep)));
    const user = adapter.resolve({ ...context, scope: 'user', canonicalRoot: path.join(home, '.agents') });
    assert.equal(user.directSkills, true);
    assert.ok(user.mcpFiles[0]!.path.startsWith(home + path.sep));
    const privateContext = { ...context, scope: 'project-private' as const };
    const privateLayout = adapter.resolve(privateContext);
    assert.deepEqual(privateLayout.skillRoots, []);
    assert.deepEqual(privateLayout.mcpFiles, []);
    assert.equal(privateLayout.skillDestination, undefined);
    assert.ok(privateLayout.diagnostics.some(item => item.code === 'unsupported-private-scope' && item.severity === 'error'));
    assert.equal(adapter.decode({ command: 'node' }, privateContext).server, undefined);
    assert.equal(adapter.encode({ type: 'stdio', command: 'node' }, undefined, privateContext).entry, undefined);
  });
}

test('pi scans shared ancestors to a Git worktree file, not ancestor native .pi or user aliases', async t => {
  const { context, root, project } = await fixture(t);
  const boundary = path.dirname(project);
  await put(path.join(boundary, '.git'), 'gitdir: /not-executed');
  await put(path.join(project, '.pi', 'settings.json'), { skills: ['../team-skills', '!**/excluded', 'npm:never-install', '../../../home/private-skills'], packages: ['npm:never-install'] });
  const layout = pi.resolve(context);
  assert.deepEqual(layout.skillRoots.map(root => root.path), [path.join(project, 'team-skills'), path.join(project, '.pi', 'skills'), path.join(project, '.agents', 'skills'), path.join(boundary, '.agents', 'skills')]);
  assert.ok(layout.skillRoots.every(root => root.recursive));
  assert.ok(!layout.skillRoots.some(item => item.path === path.join(boundary, '.pi', 'skills')));
  assert.ok(!layout.skillRoots.some(item => item.path === path.join(root, '.agents', 'skills')));
  assert.equal(layout.mcpFiles[0]!.exposureOverlay, true);
  assert.deepEqual(layout.inputs, [path.join(project, '.pi', 'settings.json'), path.join(project, '.git'), path.join(boundary, '.git')]);
  assert.ok(layout.diagnostics.some(item => item.code === 'configured-skill-outside-scope'));
  assert.ok(layout.diagnostics.some(item => item.code === 'unsupported-configured-skill-source'));
  assert.ok(layout.diagnostics.some(item => item.code === 'package-resources-native'));
  assert.ok(layout.diagnostics.some(item => item.code === 'builtin-mcp-required'));
});

test('pi relocates final agent directory independently from shared HOME skills', async t => {
  const { context, root, home } = await fixture(t, 'user');
  const agent = path.join(root, 'pi-native');
  const sharedHome = path.join(root, 'pi-home');
  await put(path.join(agent, 'settings.json'), { skills: ['../team-skills'] });
  const layout = pi.resolve({ ...context, env: { PI_CODING_AGENT_DIR: agent, HOME: sharedHome } });
  assert.equal(layout.mcpFiles[0]!.path, path.join(agent, 'mcp.json'));
  assert.equal(layout.directSkills, false);
  assert.deepEqual(layout.skillRoots.map(root => root.path), [path.join(root, 'team-skills'), path.join(agent, 'skills'), path.join(sharedHome, '.agents', 'skills')]);
  const tilde = pi.resolve({ ...context, env: { PI_CODING_AGENT_DIR: '~/pi-native' } });
  assert.equal(tilde.mcpFiles[0]!.path, path.join(home, 'pi-native', 'mcp.json'));
  const invalid = pi.resolve({ ...context, env: { PI_CODING_AGENT_DIR: 'relative-agent' } });
  assert.ok(invalid.diagnostics.some(item => item.code === 'relative-config-root' && item.severity === 'error'));
});

test('OpenCode discovers native plural/singular/Claude sources, configured paths and major-specific ancestor boundaries', async t => {
  const { context, project, root } = await fixture(t);
  const boundary = path.dirname(project);
  await put(path.join(boundary, '.git'), 'gitdir: /never-read');
  await put(path.join(project, 'opencode.jsonc'), '// retained\n{"skills":{"paths":["./team-skills","https://example.com/skills"],"urls":["https://example.com/catalog"]},"mcp":{}}');
  const v1 = opencode.resolve({ ...context, opencodeVersion: 1 });
  assert.equal(v1.mcpFiles[0]!.path, path.join(project, 'opencode.jsonc'));
  assert.deepEqual(v1.mcpFiles[0]!.mapPath, ['mcp']);
  for (const relative of ['team-skills', '.opencode/skills', '.opencode/skill', '.claude/skills', '.agents/skills']) assert.ok(v1.skillRoots.some(item => item.path === path.resolve(project, relative)));
  assert.ok(!v1.skillRoots.some(item => item.path === path.join(root, '.agents', 'skills')));
  assert.ok(v1.diagnostics.some(item => item.code === 'remote-skills-not-adopted'));
  await put(path.join(project, 'opencode.jsonc'), '{"skills":["./v2-skills"],"mcp":{"servers":{}}}');
  const v2 = opencode.resolve(context);
  assert.deepEqual(v2.mcpFiles[0]!.mapPath, ['mcp', 'servers']);
  assert.ok(v2.skillRoots.some(item => item.path === path.join(root, '.agents', 'skills')));
  assert.ok(v2.skillRoots.some(item => item.path === path.join(project, 'v2-skills')));
  assert.ok(v2.inputs!.includes(path.join(project, 'opencode.json'))); // absent preferred candidate participates in preconditions
});

test('OpenCode versioned config-dir relocation retains legacy/additional import sources and native writer preference', async t => {
  const { context, root, home } = await fixture(t, 'user');
  const xdg = path.join(root, 'xdg');
  const custom = path.join(root, 'extra');
  const normal = path.join(xdg, 'opencode');
  await put(path.join(normal, 'opencode.jsonc'), { skills: { paths: ['./session-dependent', path.join(home, 'shared-skills')] }, mcp: { old: { type: 'local', command: ['node'] } } });
  await put(path.join(normal, 'config.json'), { mcp: { legacy: { type: 'remote', url: 'https://example.com/mcp' } } });
  await put(path.join(custom, 'opencode.json'), { mcp: { servers: { current: { type: 'remote', url: 'https://example.com/mcp' } } } });
  const env = { XDG_CONFIG_HOME: xdg, OPENCODE_CONFIG_DIR: custom };
  const v1 = opencode.resolve({ ...context, env, opencodeVersion: 1 });
  assert.equal(v1.mcpFiles[0]!.path, path.join(normal, 'opencode.jsonc'));
  assert.ok(v1.mcpFiles.some(file => file.path === path.join(normal, 'config.json') && file.role === 'legacy'));
  assert.ok(v1.mcpFiles.some(file => file.path === path.join(custom, 'opencode.json') && file.mapPath.join('.') === 'mcp.servers'));
  assert.ok(v1.skillRoots.some(item => item.path === path.join(normal, 'skill')));
  assert.ok(v1.skillRoots.some(item => item.path === path.join(custom, 'skills')));
  assert.ok(v1.skillRoots.some(item => item.path === path.join(home, 'shared-skills')));
  assert.ok(v1.diagnostics.some(item => item.code === 'session-relative-skill-source'));
  const v2 = opencode.resolve({ ...context, env });
  assert.equal(v2.mcpFiles[0]!.path, path.join(custom, 'opencode.json'));
  assert.ok(!v2.mcpFiles.some(file => file.path === path.join(normal, 'opencode.jsonc')));
  assert.equal(v2.directSkills, true);
  const disabled = opencode.resolve({ ...context, opencodeVersion: 1, env: { ...env, OPENCODE_DISABLE_EXTERNAL_SKILLS: 'true' } });
  assert.equal(disabled.directSkills, false);
  assert.ok(!disabled.skillRoots.some(item => item.path.includes(`${path.sep}.agents${path.sep}`)));
  assert.ok(!disabled.skillRoots.some(item => item.path.includes(`${path.sep}.claude${path.sep}`)));
});

test('Gemini relocated home moves both skill families and settings, with no ancestor settings scan', async t => {
  const { context, root, project } = await fixture(t, 'user');
  const geminiHome = path.join(root, 'gemini-home');
  const user = geminiCli.resolve({ ...context, env: { GEMINI_CLI_HOME: geminiHome } });
  assert.equal(user.directSkills, false);
  assert.deepEqual(user.skillRoots.map(item => item.path), [path.join(geminiHome, '.gemini', 'skills'), path.join(geminiHome, '.agents', 'skills')]);
  assert.equal(user.mcpFiles[0]!.path, path.join(geminiHome, '.gemini', 'settings.json'));
  assert.ok(user.skillRoots.every(item => item.recursive === false));
  await put(path.join(project, '.gemini', 'settings.json'), '// preserve\n{"skills":{"enabled":false},"mcp":{"excluded":["private"]}}');
  const local = geminiCli.resolve({ ...context, scope: 'project', canonicalRoot: path.join(project, '.agents'), env: { GEMINI_CLI_HOME: geminiHome } });
  assert.equal(local.directSkills, false);
  assert.equal(local.mcpFiles.length, 1);
  assert.equal(local.mcpFiles[0]!.path, path.join(project, '.gemini', 'settings.json'));
  assert.deepEqual(local.inputs, [path.join(project, '.gemini', 'settings.json')]);
  assert.ok(local.diagnostics.some(item => item.code === 'skills-disabled'));
  assert.ok(local.diagnostics.some(item => item.code === 'native-global-mcp-controls'));
});

test('native JSON dialect errors are visible and resolvers never create or rewrite files', async t => {
  const { context, project, home } = await fixture(t);
  await put(path.join(project, '.pi', 'settings.json'), '{"skills":[],}');
  await put(path.join(project, '.gemini', 'settings.json'), '// valid comments, invalid trailing comma\n{"mcpServers":{},}');
  await put(path.join(project, 'opencode.jsonc'), '// comments and trailing commas are native here\n{"skills":[],}');
  const piBefore = await readFile(path.join(project, '.pi', 'settings.json'), 'utf8');
  assert.ok(pi.resolve(context).diagnostics.some(item => item.code === 'invalid-native-config'));
  assert.ok(geminiCli.resolve(context).diagnostics.some(item => item.code === 'invalid-native-config'));
  assert.ok(!opencode.resolve(context).diagnostics.some(item => item.code === 'invalid-native-config'));
  assert.equal(await readFile(path.join(project, '.pi', 'settings.json'), 'utf8'), piBefore);
  assert.deepEqual(await readdir(home), []);
});

test('native Windows resolvers use injected Windows paths, XDG instead of APPDATA, and distinct pi HOME', () => {
  const context: Context = { scope: 'user', project: 'C:\\work\\repo', home: 'C:\\Users\\Alice', canonicalRoot: 'C:\\Users\\Alice\\.agents', stateRoot: 'C:\\state', env: { APPDATA: 'C:\\wrong', HOME: 'D:\\UnixHome' }, platform: 'win32', opencodeVersion: 2, skillMode: 'copy' };
  const piLayout = pi.resolve({ ...context, env: { ...context.env, PI_CODING_AGENT_DIR: 'E:\\PiAgent' } });
  assert.equal(piLayout.mcpFiles[0]!.path, 'E:\\PiAgent\\mcp.json');
  assert.ok(piLayout.skillRoots.some(item => item.path === 'D:\\UnixHome\\.agents\\skills'));
  assert.equal(piLayout.directSkills, false);
  assert.equal(opencode.resolve(context).mcpFiles[0]!.path, 'C:\\Users\\Alice\\.config\\opencode\\opencode.json');
  assert.equal(opencode.resolve({ ...context, env: { XDG_CONFIG_HOME: 'D:\\XDG' } }).mcpFiles[0]!.path, 'D:\\XDG\\opencode\\opencode.json');
  assert.equal(geminiCli.resolve({ ...context, env: { GEMINI_CLI_HOME: 'D:\\Gemini' } }).mcpFiles[0]!.path, 'D:\\Gemini\\.gemini\\settings.json');
});

test('OpenCode V1 inventories an empty V2 envelope without inventing a server named servers', async t => {
  const { context, project } = await fixture(t);
  await put(path.join(project, 'opencode.json'), { mcp: { servers: {} } });
  const layout = opencode.resolve({ ...context, opencodeVersion: 1 });
  const file = path.join(project, 'opencode.json');
  assert.deepEqual(layout.mcpFiles.filter(spec => spec.path === file).map(spec => ({ mapPath: spec.mapPath, ignoreKeys: spec.ignoreKeys })), [
    { mapPath: ['mcp'], ignoreKeys: ['servers'] }, { mapPath: ['mcp', 'servers'], ignoreKeys: undefined },
  ]);
  assert.deepEqual(layout.diagnostics.filter(item => item.severity === 'error'), []);
});
