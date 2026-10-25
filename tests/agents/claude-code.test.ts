import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, stat, symlink, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'jsonc-parser';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeCodeAdapter as adapter } from '../../src/agents/claude-code.js';
import { geminiCliAdapter } from '../../src/agents/gemini-cli.js';
import { fingerprintValue, snapshotPath, snapshotsEqual } from '../../src/fs/snapshot.js';
import type { McpResource } from '../../src/model.js';
import { createSandbox, putFile, putSkill, type Sandbox } from '../helpers/sandbox.js';

let sandbox: Sandbox;
beforeEach(async () => { sandbox = await createSandbox(); });
afterEach(async () => { await sandbox.cleanup(); });
async function mcp(name: string, adapterToRead = adapter): Promise<McpResource> {
  const found = (await adapterToRead.discover(sandbox.context)).resources.find(resource => resource.kind === 'mcp' && resource.name === name);
  if (!found || found.kind !== 'mcp') throw new Error('Expected filesystem MCP fixture was not discovered');
  return found;
}
const decoded = (bytes: Uint8Array): Record<string, any> => parse(Buffer.from(bytes).toString('utf8'));

describe('Claude Code native adapter', () => {
  it('reports empty checked locations without inventing detection or creating files', async () => {
    const before = await snapshotPath(sandbox.root);
    const result = await adapter.discover(sandbox.context);
    expect(result.detected).toBe(false);
    expect(result.resources.length).toBe(0);
    expect(result.checkedLocations.length).toBe(7);
    expect(result.checkedLocations.every(location => !location.exists)).toBe(true);
    expect(await adapter.prepareMcpEdit(sandbox.context, 'private-project', [])).toEqual({ files: [], targets: [], findings: [] });
    expect(snapshotsEqual(before, await snapshotPath(sandbox.root))).toBe(true);
  });

  it('discovers native metadata and distinct project, user and native local provenance', async () => {
    const { projectRoot, homeDir } = sandbox.context;
    const root = await realpath(projectRoot);
    await putSkill(join(projectRoot, '.claude', 'skills'), 'project-skill', 'Project guidance');
    await putSkill(join(homeDir, '.claude', 'skills'), 'user-skill', 'Personal guidance');
    await putSkill(join(projectRoot, '.agents', 'skills'), 'not-a-claude-alias');
    await putFile(join(projectRoot, '.mcp.json'), JSON.stringify({ mcpServers: { shared: { command: 'not-invoked', args: ['--safe'] } } }));
    await putFile(join(homeDir, '.claude.json'), JSON.stringify({ mcpServers: { global: { type: 'http', url: 'https://example.invalid/mcp' } },
      projects: { [root]: { mcpServers: { local: { type: 'sse', url: 'https://example.invalid/events' } } },
        '/another/project': { mcpServers: { irrelevant: { command: 'never' } } } } }));
    const before = await snapshotPath(sandbox.root);
    const result = await adapter.discover(sandbox.context);
    expect(result.detected).toBe(true);
    expect(result.findings.length).toBe(0);
    expect(result.resources.map(resource => resource.name).sort()).toEqual(['global', 'local', 'project-skill', 'shared', 'user-skill']);
    const skill = result.resources.find(resource => resource.name === 'project-skill')!;
    expect(skill.description).toBe('Project guidance');
    expect(skill.source.agentId).toBe('claude-code');
    expect(skill.source.path).toBe(join(projectRoot, '.claude', 'skills'));
    expect(skill.source.scope).toBe('project');
    expect(skill.source.visibility).toBe('shared');
    const local = await mcp('local');
    const global = await mcp('global');
    expect(local.source.scope).toBe('project');
    expect(local.source.visibility).toBe('private');
    expect(local.source.path).toBe(join(homeDir, '.claude.json'));
    expect(local.locator).toBe(JSON.stringify(['projects', root, 'mcpServers', 'local']));
    expect(global.source.scope).toBe('user');
    expect(global.source.visibility).toBe('private');
    expect(local.source.id === global.source.id).toBe(false);
    expect(result.checkedLocations.filter(location => location.exists).length).toBe(7);
    expect(snapshotsEqual(before, await snapshotPath(sandbox.root))).toBe(true);
  });

  it('uses physical skill provenance and changes identity when its configured alias retargets', async () => {
    const first = join(sandbox.root, 'first-skills');
    const second = join(sandbox.root, 'second-skills');
    await putSkill(first, 'same-name', 'First authority');
    await putSkill(second, 'same-name', 'Second authority');
    const alias = join(sandbox.context.projectRoot, '.claude', 'skills');
    await mkdir(join(sandbox.context.projectRoot, '.claude'));
    await symlink(first, alias);
    const initial = (await adapter.discover(sandbox.context)).resources[0]!;
    expect(initial.source.path).toBe(first);
    expect(initial.path).toBe(join(first, 'same-name'));
    await unlink(alias);
    await symlink(second, alias);
    const changed = (await adapter.discover(sandbox.context)).resources[0]!;
    expect(changed.source.path).toBe(second);
    expect(changed.source.id === initial.source.id).toBe(false);
    expect(changed.id === initial.id).toBe(false);
  });

  it.each(['project', 'user'] as const)('resolves the advertised %s skill placement', placement => {
    const result = adapter.skillDestination(sandbox.context, placement);
    expect(result.findings.length).toBe(0);
    expect(result.location).toEqual({ path: join(placement === 'project' ? sandbox.context.projectRoot : sandbox.context.homeDir, '.claude', 'skills'),
      scope: placement, visibility: placement === 'project' ? 'shared' : 'private' });
    expect(adapter.skillDestination(sandbox.context, 'private-project').location).toBeUndefined();
  });

  it('prepares a selected native subset preserving unchecked settings, comments and native fields', async () => {
    const path = join(sandbox.context.projectRoot, '.mcp.json');
    const token = randomUUID();
    const native = { type: 'http', url: `https://example.invalid/${token}`, headers: { Authorization: token },
      headersHelper: '/never-execute', timeout: 12345, alwaysLoad: true, oauth: { clientId: 'native-only' }, futureExecutionField: { enabled: true } };
    await putFile(path, `// root comment\n{\n  "theme": "dark", // retain setting\n  "mcpServers": {\n    "picked": ${JSON.stringify(native)},\n    // retain unchecked comment\n    "unchecked": { "command": "leave-me" }\n  }\n}\n`, 0o640);
    const selected = await mcp('picked');
    const sourcePath = join(sandbox.context.homeDir, '.claude.json');
    await putFile(sourcePath, '{}\n');
    const before = await snapshotPath(sandbox.root);
    const prepared = await adapter.prepareMcpEdit(sandbox.context, 'user', [selected]);
    expect(prepared.findings.length).toBe(0);
    expect(prepared.files.length).toBe(1);
    const output = decoded(prepared.files[0]!.bytes);
    expect(fingerprintValue(output.mcpServers.picked) === fingerprintValue(native)).toBe(true);
    expect(output.mcpServers.unchecked).toBeUndefined();
    expect(prepared.targets[0]!.afterFingerprint === fingerprintValue(native)).toBe(true);
    expect(prepared.targets[0]!.beforeFingerprint).toBeUndefined();
    const unchanged = await adapter.prepareMcpEdit(sandbox.context, 'project', [selected]);
    expect(unchanged.files.length).toBe(0);
    expect(unchanged.targets.length).toBe(1);
    expect(unchanged.targets[0]!.beforeFingerprint === fingerprintValue(native)).toBe(true);
    expect((await readFile(path, 'utf8')).includes('// retain unchecked comment')).toBe(true);
    expect(snapshotsEqual(before, await snapshotPath(sandbox.root))).toBe(true);
  });

  it.each(['project', 'private-project', 'user'] as const)('encodes selected edits at the native %s MCP path', async placement => {
    const { projectRoot, homeDir } = sandbox.context;
    const root = await realpath(projectRoot);
    const source = join(projectRoot, '.mcp.json');
    await putFile(source, JSON.stringify({ mcpServers: { picked: { command: '/never-run', args: ['--new'], env: { NAME: 'literal' } } } }), 0o640);
    const selected = await mcp('picked');
    const path = placement === 'project' ? source : join(homeDir, '.claude.json');
    const old = { command: 'old-value', unknown: true };
    await putFile(path, `// preserve header\n${JSON.stringify({ preferences: { keep: true }, mcpServers: { picked: old, unchecked: { command: 'untouched' } },
      projects: { [root]: { approved: true, mcpServers: { picked: old, other: { command: 'private-untouched' } } }, '/elsewhere': { note: 'keep' } } }, null, 2)}\n`, 0o640);
    const before = await snapshotPath(sandbox.root);
    const result = await adapter.prepareMcpEdit(sandbox.context, placement, [selected]);
    expect(result.findings.length).toBe(0);
    expect(result.files.length).toBe(1);
    const file = result.files[0]!;
    expect(file.path).toBe(path);
    expect(file.mode).toBe(0o640);
    expect(Buffer.from(file.bytes).toString().startsWith('// preserve header')).toBe(true);
    const output = decoded(file.bytes);
    const nativePath = placement === 'private-project' ? ['projects', root, 'mcpServers', 'picked'] : ['mcpServers', 'picked'];
    const server = placement === 'private-project' ? output.projects[root].mcpServers.picked : output.mcpServers.picked;
    expect(fingerprintValue(server) === fingerprintValue(selected.definition.native)).toBe(true);
    expect(output.preferences.keep).toBe(true);
    expect(output.mcpServers.unchecked.command).toBe('untouched');
    expect(output.projects['/elsewhere'].note).toBe('keep');
    expect(output.projects[root].approved).toBe(true);
    expect(result.targets[0]!.slotId).toBe(fingerprintValue([file.expected.resolvedPath, 'mcp', JSON.stringify(nativePath)]));
    expect(result.targets[0]!.beforeFingerprint).toBe(fingerprintValue(old));
    expect(result.targets[0]!.afterFingerprint).toBe(fingerprintValue(selected.definition.native));
    expect(snapshotsEqual(before, await snapshotPath(sandbox.root))).toBe(true);
  });

  it('distinguishes user and private same-name slots and resolves project aliases physically', async () => {
    const { projectRoot, homeDir } = sandbox.context;
    const root = await realpath(projectRoot);
    await putFile(join(homeDir, '.claude.json'), JSON.stringify({ mcpServers: { same: { command: 'user' } }, projects: { [root]: { mcpServers: { same: { command: 'private' } } } } }));
    const all = (await adapter.discover(sandbox.context)).resources.filter((resource): resource is McpResource => resource.kind === 'mcp');
    const user = all.find(resource => resource.source.scope === 'user')!;
    const local = all.find(resource => resource.source.scope === 'project')!;
    const alias = join(sandbox.root, 'project-alias');
    await symlink(projectRoot, alias);
    const context = { ...sandbox.context, projectRoot: alias };
    const userEdit = await adapter.prepareMcpEdit(context, 'user', [user]);
    const localEdit = await adapter.prepareMcpEdit(context, 'private-project', [local]);
    expect(userEdit.files.length).toBe(0);
    expect(localEdit.files.length).toBe(0);
    expect(userEdit.targets[0]!.slotId === localEdit.targets[0]!.slotId).toBe(false);
    expect(localEdit.targets[0]!.slotId).toBe(fingerprintValue([join(homeDir, '.claude.json'), 'mcp', JSON.stringify(['projects', root, 'mcpServers', 'same'])]));
  });

  it.each(['project', 'user'] as const)('blocks private-project publication to %s', async placement => {
    const root = await realpath(sandbox.context.projectRoot);
    await putFile(join(sandbox.context.homeDir, '.claude.json'), JSON.stringify({ projects: { [root]: { mcpServers: { personal: { command: 'private' } } } } }));
    const result = await adapter.prepareMcpEdit(sandbox.context, placement, [await mcp('personal')]);
    expect(result.files.length).toBe(0);
    expect(result.findings.some(finding => finding.code === 'PRIVATE_RESOURCE_SCOPE')).toBe(true);
  });

  it.each(['workspace', 'claude-in-chrome', 'computer-use', 'Claude Preview', 'Claude Browser'])('rejects reserved MCP name %s during discovery and before any target intent', async name => {
    const token = randomUUID();
    const native = { command: 'never-run', env: { TOKEN: token } };
    await putFile(join(sandbox.context.projectRoot, '.gemini', 'settings.json'), JSON.stringify({ mcpServers: { [name]: native } }));
    const selected = await mcp(name, geminiCliAdapter);
    await putFile(join(sandbox.context.projectRoot, '.mcp.json'), JSON.stringify({ mcpServers: { [name]: native, untouched: { command: 'keep' } } }));
    const before = await snapshotPath(sandbox.root);
    const discovery = await adapter.discover(sandbox.context);
    expect(discovery.resources.some(resource => resource.kind === 'mcp' && resource.name === name)).toBe(false);
    expect(discovery.findings.some(finding => finding.code === 'RESERVED_MCP_NAME' && finding.severity === 'error')).toBe(true);
    expect(JSON.stringify(discovery.findings).includes(token)).toBe(false);
    for (const placement of ['project', 'private-project', 'user'] as const) {
      const result = await adapter.prepareMcpEdit(sandbox.context, placement, [selected]);
      expect(result.files.length).toBe(0);
      expect(result.targets.length).toBe(0);
      expect(result.findings.some(finding => finding.code === 'RESERVED_MCP_NAME' && finding.severity === 'error')).toBe(true);
      expect(JSON.stringify(result.findings).includes(token)).toBe(false);
    }
    expect(snapshotsEqual(before, await snapshotPath(sandbox.root))).toBe(true);
  });

  it.each([
    '{"mcpServers": {"bad": {"command": "',
    JSON.stringify({ mcpServers: [] }),
    JSON.stringify({ mcpServers: { bad: { command: 'x', args: [7] } } }),
    JSON.stringify({ mcpServers: { bad: { type: 'http', url: 4 } } }),
    JSON.stringify({ mcpServers: { bad: { type: 'ws', url: 'wss://example.invalid' } } }),
  ])('returns safe findings for malformed native configurations %#', async prefix => {
    const token = randomUUID();
    const path = join(sandbox.context.projectRoot, '.mcp.json');
    await putFile(path, prefix.endsWith('"') ? prefix + token : `// ${token}\n${prefix}`);
    const before = await snapshotPath(sandbox.root);
    const result = await adapter.discover(sandbox.context);
    expect(result.detected).toBe(true);
    expect(result.resources.length).toBe(0);
    expect(result.findings.length > 0).toBe(true);
    expect(JSON.stringify(result.findings).includes(token)).toBe(false);
    expect(snapshotsEqual(before, await snapshotPath(sandbox.root))).toBe(true);
  });

  it('blocks malformed destination containers and unsafe config symlinks', async () => {
    const path = join(sandbox.context.projectRoot, '.mcp.json');
    await putFile(path, '{"mcpServers":{"selected":{"command":"valid"}}}');
    const selected = await mcp('selected');
    const destination = join(sandbox.context.homeDir, '.claude.json');
    await putFile(destination, '{"projects":[]}');
    const bad = await adapter.prepareMcpEdit(sandbox.context, 'private-project', [selected]);
    expect(bad.files.length).toBe(0);
    expect(bad.findings.length > 0).toBe(true);
    const aliasHome = join(sandbox.root, 'alias-home');
    await mkdir(aliasHome);
    await symlink(destination, join(aliasHome, '.claude.json'));
    const result = await adapter.prepareMcpEdit({ ...sandbox.context, homeDir: aliasHome }, 'user', [selected]);
    expect(result.files.length).toBe(0);
    expect(result.findings.some(finding => finding.code === 'UNSAFE_CONFIG_PATH')).toBe(true);
  });

  it('converts only explicit SSE/stdio Gemini fields and blocks fixed HTTP, cwd, native fields, expansion and auto transport', async () => {
    const path = join(sandbox.context.projectRoot, '.gemini', 'settings.json');
    await putFile(path, JSON.stringify({ mcpServers: {
      http: { httpUrl: 'https://example.invalid/mcp', headers: { Accept: 'application/json' } },
      sse: { url: 'https://example.invalid/events', type: 'sse' },
      stdio: { command: 'not-run', args: ['literal'], env: { CONFIG: 'literal' } },
      cwd: { command: 'not-run', cwd: '/native-working-directory' },
      trust: { command: 'not-run', trust: true },
      timeout: { command: 'not-run', timeout: 5000 },
      tools: { command: 'not-run', excludeTools: ['dangerous'] },
      expansion: { command: 'not-run', env: { TOKEN: '$UNRESOLVED' } },
      auto: { url: 'https://example.invalid/auto' },
    } }));
    for (const name of ['sse', 'stdio']) {
      const selected = await mcp(name, geminiCliAdapter);
      const result = await adapter.prepareMcpEdit(sandbox.context, 'project', [selected]);
      expect(result.findings.length).toBe(0);
      const native = decoded(result.files[0]!.bytes).mcpServers[name];
      expect(native.type).toBe(name);
      expect(result.targets[0]!.afterFingerprint).toBe(fingerprintValue(native));
    }
    for (const name of ['http', 'cwd', 'trust', 'timeout', 'tools', 'expansion', 'auto']) {
      const result = await adapter.prepareMcpEdit(sandbox.context, 'project', [await mcp(name, geminiCliAdapter)]);
      expect(result.files.length).toBe(0);
      expect(result.findings.some(finding => finding.code === 'UNSUPPORTED_MCP_CONVERSION')).toBe(true);
    }
  });

  it('keeps discovery/preparation read-only without running executable fixtures', async () => {
    const sentinel = join(sandbox.root, 'executed');
    const launcher = join(sandbox.root, 'must-not-run');
    await putFile(launcher, `#!/bin/sh\ntouch '${sentinel}'\n`, 0o755);
    const skill = await putSkill(join(sandbox.context.projectRoot, '.claude', 'skills'), 'execution-guard');
    await putFile(join(skill, 'script.sh'), `#!/bin/sh\ntouch '${sentinel}'\n`, 0o755);
    const path = join(sandbox.context.projectRoot, '.mcp.json');
    await putFile(path, JSON.stringify({ mcpServers: { selected: { command: launcher } } }));
    const before = await snapshotPath(sandbox.root);
    const mtime = (await stat(path)).mtimeMs;
    const result = await adapter.prepareMcpEdit(sandbox.context, 'user', [await mcp('selected')]);
    expect(result.files.length).toBe(1);
    expect(result.files[0]!.mode).toBe(0o600);
    expect((await stat(path)).mtimeMs).toBe(mtime);
    expect((await snapshotPath(sentinel)).kind).toBe('missing');
    expect(snapshotsEqual(before, await snapshotPath(sandbox.root))).toBe(true);
  });
});
