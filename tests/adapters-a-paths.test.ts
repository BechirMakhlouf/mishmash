import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { claudeCode } from '../src/adapters/claude-code.js';
import { codex } from '../src/adapters/codex.js';
import { githubCopilotCli } from '../src/adapters/github-copilot-cli.js';
import { discoverSkills } from '../src/canonical.js';
import type { Adapter, Context, JsonObject, Scope } from '../src/types.js';

async function fixture(t: TestContext, scope: Scope = 'project'): Promise<Context> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'mishmash-adapters-a-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  const home = path.join(root, 'home');
  await mkdir(project, { recursive: true });
  await mkdir(home, { recursive: true });
  return { scope, project, home, platform: process.platform, env: {}, canonicalRoot: path.join(scope === 'user' ? home : project, '.agents'), stateRoot: path.join(root, 'state'), opencodeVersion: 2, skillMode: 'auto', codexHome: home };
}
async function put(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}
const hasError = (value: ReturnType<Adapter['resolve']>) => value.diagnostics.some(item => item.severity === 'error');

for (const scope of ['project', 'user'] as const) {
  test(`native ${scope} paths retain independent skill and MCP scopes`, async t => {
    const context = await fixture(t, scope);
    const claude = claudeCode.resolve(context);
    const codexLayout = codex.resolve(context);
    const copilot = githubCopilotCli.resolve(context);
    assert.equal(hasError(claude), false);
    assert.equal(hasError(codexLayout), false);
    assert.equal(hasError(copilot), false);
    assert.equal(claude.directSkills, false);
    assert.equal(codexLayout.directSkills, true);
    assert.equal(copilot.directSkills, true);
    assert.equal(claude.skillDestination, path.join(scope === 'project' ? context.project : context.home, '.claude', 'skills'));
    assert.equal(claude.mcpFiles[0]?.path, path.join(scope === 'project' ? context.project : context.home, scope === 'project' ? '.mcp.json' : '.claude.json'));
    assert.equal(codexLayout.mcpFiles[0]?.path, path.join(scope === 'project' ? context.project : context.home, '.codex', 'config.toml'));
    assert.equal(copilot.mcpFiles[0]?.path, scope === 'project' ? path.join(context.project, '.mcp.json') : path.join(context.home, '.copilot', 'mcp-config.json'));
    assert.deepEqual(codexLayout.mcpFiles[0]?.mapPath, ['mcp_servers']);
    assert.deepEqual(copilot.mcpFiles[0]?.mapPath, ['mcpServers']);
    assert.ok(codexLayout.skillRoots.some(root => root.path === path.join(scope === 'project' ? context.project : context.home, '.codex', 'skills')));
    if (scope === 'project') {
      assert.deepEqual(copilot.skillRoots.map(root => root.path), ['.github', '.agents', '.claude'].map(name => path.join(context.project, name, 'skills')));
      assert.equal(copilot.mcpFiles[1]?.path, path.join(context.project, '.github', 'mcp.json'));
    }
  });
}

test('Claude local/private selects only the chosen project map, not global or other project servers', async t => {
  const context = await fixture(t, 'project-private');
  context.canonicalRoot = path.join(context.home, '.agents', 'projects', 'private-fixture');
  const stateFile = path.join(context.home, '.claude.json');
  await writeFile(stateFile, JSON.stringify({
    mcpServers: { global: { type: 'http', url: 'https://global.example/mcp' } },
    projects: {
      [context.project]: { trustAccepted: true, mcpServers: { private: { type: 'http', url: 'https://private.example/mcp' } } },
      [path.join(context.project, 'other')]: { mcpServers: { unrelated: { command: 'unrelated' } } },
    },
    preferences: { sentinel: 'keep' },
  }));
  const layout = claudeCode.resolve(context);
  assert.equal(hasError(layout), false);
  assert.deepEqual(layout.skillRoots, []);
  assert.equal(layout.skillDestination, undefined);
  assert.equal(layout.mcpFiles.length, 1);
  assert.equal(layout.mcpFiles[0]?.private, true);
  assert.deepEqual(layout.mcpFiles[0]?.mapPath, ['projects', path.resolve(context.project), 'mcpServers']);
  let selected: unknown = JSON.parse(await readFile(stateFile, 'utf8'));
  for (const key of layout.mcpFiles[0]!.mapPath) selected = (selected as JsonObject)[key];
  assert.deepEqual(Object.keys(selected as JsonObject), ['private']);
  assert.deepEqual(claudeCode.decode((selected as JsonObject).private as JsonObject, context).server, { type: 'streamable-http', url: 'https://private.example/mcp' });
  for (const adapter of [codex, githubCopilotCli]) {
    const unsupported = adapter.resolve(context);
    assert.deepEqual(unsupported.skillRoots, []);
    assert.deepEqual(unsupported.mcpFiles, []);
    assert.equal(unsupported.skillDestination, undefined);
    assert.ok(hasError(unsupported));
    assert.equal(adapter.encode({ type: 'streamable-http', url: 'https://private.example/mcp' }, undefined, context).entry, undefined);
  }
});

test('Claude relocated profile skills require an explicit independent mixed state filename', async t => {
  const context = await fixture(t, 'user');
  const config = path.join(context.home, 'custom-claude');
  context.env = { CLAUDE_CONFIG_DIR: config };
  const unresolved = claudeCode.resolve(context);
  assert.equal(unresolved.skillDestination, path.join(config, 'skills'));
  assert.deepEqual(unresolved.mcpFiles, []);
  assert.ok(unresolved.diagnostics.some(item => item.code === 'unknown-claude-state-file'));
  context.claudeStateFile = path.join(context.home, 'independent-state.json');
  const resolved = claudeCode.resolve(context);
  assert.equal(hasError(resolved), false);
  assert.equal(resolved.mcpFiles[0]?.path, context.claudeStateFile);
  assert.deepEqual(resolved.mcpFiles[0]?.mapPath, ['mcpServers']);
  context.scope = 'project-private';
  assert.deepEqual(claudeCode.resolve(context).mcpFiles[0]?.mapPath, ['projects', context.project, 'mcpServers']);
  context.claudeStateFile = 'state.json';
  assert.ok(hasError(claudeCode.resolve(context)));
});

test('project Claude and Copilot paths ignore user-only relocation and secret storage variables', async t => {
  const context = await fixture(t);
  context.env = { CLAUDE_CONFIG_DIR: 'not-absolute', COPILOT_HOME: 'not-absolute', GH_CONFIG_DIR: path.join(context.home, 'gh'), COPILOT_CACHE_HOME: path.join(context.home, 'cache') };
  for (const adapter of [claudeCode, githubCopilotCli]) {
    const layout = adapter.resolve(context);
    assert.equal(hasError(layout), false);
    assert.equal(layout.mcpFiles[0]?.path, path.join(context.project, '.mcp.json'));
    assert.ok(layout.skillRoots.every(root => root.path.startsWith(context.project + path.sep)));
  }
});

test('repository ancestors retain source paths and native nearest-first precedence', async t => {
  const context = await fixture(t);
  const repository = context.project;
  await mkdir(path.join(repository, '.git'));
  context.project = path.join(repository, 'packages', 'app');
  context.canonicalRoot = path.join(context.project, '.agents');
  await mkdir(context.project, { recursive: true });
  const directories = [context.project, path.dirname(context.project), repository];
  const claude = claudeCode.resolve(context);
  assert.deepEqual(claude.skillRoots.map(root => root.path), directories.map(root => path.join(root, '.claude', 'skills')));
  const codexLayout = codex.resolve(context);
  assert.deepEqual(codexLayout.mcpFiles.map(file => file.path), directories.map(root => path.join(root, '.codex', 'config.toml')));
  assert.deepEqual(codexLayout.mcpFiles.map(file => file.role), ['primary', 'legacy', 'legacy']);
  assert.equal(codexLayout.skillRoots.length, 6);
  assert.ok(codexLayout.skillRoots.every(root => root.recursive));
  const copilot = githubCopilotCli.resolve(context);
  assert.deepEqual(copilot.mcpFiles.map(file => file.path), directories.flatMap(root => [path.join(root, '.mcp.json'), path.join(root, '.github', 'mcp.json')]));
  assert.deepEqual(copilot.skillRoots.slice(3).map(root => root.path), directories.slice(1).map(root => path.join(root, '.github', 'skills')));
  assert.ok(copilot.diagnostics.some(item => item.code === 'copilot-skill-ancestor-boundary'));
  for (const layout of [claude, codexLayout, copilot]) {
    assert.ok(layout.inputs?.includes(path.join(repository, '.git')));
    assert.ok(layout.inputs?.includes(path.join(context.project, '.git')));
    assert.ok(!layout.inputs?.includes(path.join(path.dirname(repository), '.git')));
  }
});

test('a worktree .git file bounds discovery without following the main checkout', async t => {
  const context = await fixture(t);
  await writeFile(path.join(context.project, '.git'), 'gitdir: /never/read/main/.git/worktrees/fixture\n');
  const child = path.join(context.project, 'nested');
  await mkdir(child);
  const layout = codex.resolve({ ...context, project: child, canonicalRoot: path.join(child, '.agents') });
  assert.deepEqual(layout.mcpFiles.map(file => file.path), [path.join(child, '.codex', 'config.toml'), path.join(context.project, '.codex', 'config.toml')]);
  assert.ok(!JSON.stringify(layout).includes('/never/read/main'));
});

test('Codex honors configured root markers and empty-marker CWD boundary', async t => {
  const context = await fixture(t);
  const repository = context.project;
  await writeFile(path.join(repository, 'workspace.marker'), '');
  context.project = path.join(repository, 'nested');
  await mkdir(context.project);
  const config = path.join(context.home, '.codex', 'config.toml');
  await put(config, 'project_root_markers = ["workspace.marker"]\n');
  const custom = codex.resolve(context);
  assert.equal(custom.mcpFiles.length, 2);
  assert.ok(custom.inputs?.includes(config));
  assert.ok(custom.inputs?.includes(path.join(repository, 'workspace.marker')));
  await writeFile(config, 'project_root_markers = []\n');
  assert.equal(codex.resolve(context).mcpFiles.length, 1);
  await writeFile(config, 'project_root_markers = "not-an-array"\n');
  assert.ok(hasError(codex.resolve(context)));
});

test('Codex config relocation does not relocate shared user skill discovery', async t => {
  const context = await fixture(t, 'user');
  const configHome = path.join(context.home, 'config-codex');
  await mkdir(configHome);
  context.env = { CODEX_HOME: configHome };
  const layout = codex.resolve(context);
  assert.equal(hasError(layout), false);
  assert.equal(layout.directSkills, true);
  assert.deepEqual(layout.skillRoots.map(root => root.path), [path.join(context.home, '.agents', 'skills'), path.join(configHome, 'skills')]);
  assert.equal(layout.mcpFiles[0]?.path, path.join(configHome, 'config.toml'));
  context.env.CODEX_HOME = path.join(context.home, 'missing-profile');
  assert.ok(codex.resolve(context).diagnostics.some(item => item.code === 'invalid-codex-home'));
});

test('Codex Unix HOME disagreement bridges from a verified native shared reader instead of moving canonical content', async t => {
  const context = await fixture(t, 'user');
  if (context.platform === 'win32') context.codexHome = path.join(context.home, 'known-folder-profile');
  else context.env.HOME = path.join(context.home, 'native-account-home');
  const nativeHome = context.platform === 'win32' ? context.codexHome! : context.env.HOME!;
  const layout = codex.resolve(context);
  assert.equal(layout.directSkills, false);
  assert.equal(layout.skillDestination, path.join(nativeHome, '.agents', 'skills'));
  assert.ok(layout.diagnostics.some(item => item.code === 'codex-shared-home-mismatch'));
  assert.equal(context.canonicalRoot, path.join(context.home, '.agents'));
});

test('Copilot relocated home excludes default shared root and imports explicit environment and settings roots', async t => {
  const context = await fixture(t, 'user');
  const config = path.join(context.home, 'work-copilot');
  const registered = path.join(context.home, 'registered');
  const fromEnv = path.join(context.home, 'env-skills');
  context.env = { COPILOT_HOME: config, COPILOT_SKILLS_DIRS: ` ${fromEnv},${registered},${fromEnv} `, GH_CONFIG_DIR: path.join(context.home, 'unrelated-gh') };
  await put(path.join(config, 'settings.json'), `// authored discovery settings\n${JSON.stringify({ skillDirectories: [registered], disabledSkills: ['disabled-skill'] })}`);
  const layout = githubCopilotCli.resolve(context);
  assert.equal(hasError(layout), false);
  assert.equal(layout.directSkills, false);
  assert.equal(layout.skillDestination, path.join(config, 'skills'));
  assert.deepEqual(layout.skillRoots.map(root => root.path), [path.join(config, 'skills'), fromEnv, registered]);
  assert.ok(!layout.skillRoots.some(root => root.path === path.join(context.home, '.agents', 'skills')));
  assert.equal(layout.mcpFiles[0]?.path, path.join(config, 'mcp-config.json'));
  assert.ok(layout.inputs?.includes(path.join(config, 'settings.json')));
  assert.ok(layout.diagnostics.some(item => item.code === 'native-skill-disablement'));
});

test('Copilot malformed settings or excluded canonical roots never trigger a discovery bypass', async t => {
  const context = await fixture(t, 'user');
  const settings = path.join(context.home, '.copilot', 'settings.json');
  await put(settings, JSON.stringify({ ignoredSkillsLocations: [context.canonicalRoot], skillDirectories: [path.join(context.home, 'extra')] }));
  const ignored = githubCopilotCli.resolve(context);
  assert.equal(ignored.directSkills, false);
  assert.ok(ignored.diagnostics.some(item => item.code === 'canonical-skills-disabled' && item.severity === 'error'));
  assert.ok(!ignored.skillRoots.some(root => root.path === path.join(context.canonicalRoot, 'skills')));
  await writeFile(settings, '{broken');
  assert.ok(hasError(githubCopilotCli.resolve(context)));
  await writeFile(settings, JSON.stringify({ skillDirectories: ['~/not-expanded'] }));
  assert.ok(hasError(githubCopilotCli.resolve(context)));
});

function windows(scope: Scope = 'user'): Context {
  return { scope, platform: 'win32', project: 'D:\\workspace\\project', home: 'C:\\mishmash-fixture\\node-profile', codexHome: 'C:\\mishmash-fixture\\known-profile', env: { HOME: 'Z:\\not-codex-home', USERPROFILE: 'Z:\\not-known-folder', APPDATA: 'Z:\\not-appdata' }, canonicalRoot: 'C:\\mishmash-fixture\\node-profile\\.agents', stateRoot: 'C:\\mishmash-fixture\\state', opencodeVersion: 2, skillMode: 'auto' };
}

test('injected Windows resolution uses native separators and Codex known-folder identity, never AppData guesses', () => {
  const context = windows();
  assert.equal(claudeCode.resolve(context).mcpFiles[0]?.path, 'C:\\mishmash-fixture\\node-profile\\.claude.json');
  const codexLayout = codex.resolve(context);
  assert.equal(codexLayout.mcpFiles[0]?.path, 'C:\\mishmash-fixture\\known-profile\\.codex\\config.toml');
  assert.equal(codexLayout.skillRoots[0]?.path, 'C:\\mishmash-fixture\\known-profile\\.agents\\skills');
  assert.equal(codexLayout.directSkills, false);
  assert.equal(githubCopilotCli.resolve(context).mcpFiles[0]?.path, 'C:\\mishmash-fixture\\node-profile\\.copilot\\mcp-config.json');
  assert.ok(!JSON.stringify([claudeCode.resolve(context), codexLayout, githubCopilotCli.resolve(context)]).includes('not-appdata'));
  assert.ok(codex.resolve({ ...context, codexHome: undefined }).diagnostics.some(item => item.code === 'unknown-codex-home'));
});

test('Windows profile overrides are final native roots, and private map keys are normalized without separator substitutions', () => {
  const context = windows();
  context.env = { CLAUDE_CONFIG_DIR: 'E:\\claude-work', CODEX_HOME: 'E:\\codex-work', COPILOT_HOME: 'E:\\copilot-work' };
  context.claudeStateFile = 'E:\\independent\\state.json';
  const claude = claudeCode.resolve(context);
  assert.equal(claude.skillDestination, 'E:\\claude-work\\skills');
  assert.equal(claude.mcpFiles[0]?.path, context.claudeStateFile);
  assert.equal(codex.resolve(context).mcpFiles[0]?.path, 'E:\\codex-work\\config.toml');
  assert.equal(githubCopilotCli.resolve(context).skillDestination, 'E:\\copilot-work\\skills');
  const privateContext = { ...context, scope: 'project-private' as const, project: 'D:\\workspace\\project\\nested\\..' };
  assert.deepEqual(claudeCode.resolve(privateContext).mcpFiles[0]?.mapPath, ['projects', 'D:\\workspace\\project', 'mcpServers']);
  const projectContext = { ...context, scope: 'project' as const, canonicalRoot: 'D:\\workspace\\project\\.agents' };
  assert.equal(githubCopilotCli.resolve(projectContext).mcpFiles[0]?.path, 'D:\\workspace\\project\\.mcp.json');
  assert.equal(claudeCode.resolve(projectContext).mcpFiles[0]?.path, 'D:\\workspace\\project\\.mcp.json');
});

for (const scope of ['project', 'user'] as const) {
  test(`Claude ${scope} adoption excludes account-managed reserved skill directories`, async t => {
    const context = await fixture(t, scope);
    const base = path.join(scope === 'project' ? context.project : context.home, '.claude', 'skills');
    for (const name of ['review', 'synced', 'anthropic-skills']) {
      await put(path.join(base, name, 'SKILL.md'), `---\nname: ${name}\ndescription: Fixture skill\n---\nReview instructions.\n`);
    }
    const found = await discoverSkills(claudeCode.resolve(context).skillRoots, context);
    assert.deepEqual(found.diagnostics.filter(item => item.severity === 'error'), []);
    assert.deepEqual(found.skills.map(skill => skill.id), ['review']);
  });
}
