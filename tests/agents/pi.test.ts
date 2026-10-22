import { randomUUID } from 'node:crypto';
import { lstat, readFile, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { piAdapter } from '../../src/agents/pi.js';
import { opencodeAdapter } from '../../src/agents/opencode.js';
import type { McpResource } from '../../src/model.js';
import { fingerprintValue, snapshotMatches, snapshotPath } from '../../src/fs/snapshot.js';
import { isRecord, readJsonDocument } from '../../src/resources/jsonc.js';
import { createSandbox, putFile, putSkill, type Sandbox } from '../helpers/sandbox.js';

let sandbox: Sandbox;
beforeEach(async () => { sandbox = await createSandbox(); });
afterEach(async () => { await sandbox.cleanup(); });
const mcp = (resources: readonly { kind: string }[]) => resources.filter((resource): resource is McpResource => resource.kind === 'mcp');
function projectConfig(): string { return join(sandbox.context.projectRoot, '.pi', 'mcp.json'); }
function userConfig(): string { return join(sandbox.context.homeDir, '.pi', 'agent', 'mcp.json'); }
function registration(value: unknown, key: string): unknown {
  if (!isRecord(value) || !isRecord(value.mcpServers)) throw new Error('Expected a valid native MCP document.');
  return value.mcpServers[key];
}
async function openCodeSources(entries: Record<string, unknown>): Promise<McpResource[]> {
  await putFile(join(sandbox.context.projectRoot, 'opencode.json'), JSON.stringify({ mcp: entries }));
  return mcp((await opencodeAdapter.discover(sandbox.context)).resources);
}

describe('Pi native adapter', () => {
  it('reports absent documented roots without detecting an installation or changing the filesystem', async () => {
    const before = await snapshotPath(sandbox.root);
    const result = await piAdapter.discover(sandbox.context);
    expect(result.detected).toBe(false);
    expect(result.resources).toHaveLength(0);
    for (const path of [projectConfig(), userConfig(), join(sandbox.context.projectRoot, '.pi', 'skills'), join(sandbox.context.homeDir, '.pi', 'agent', 'skills'), join(sandbox.context.projectRoot, '.agents', 'skills'), join(sandbox.context.homeDir, '.agents', 'skills')]) {
      expect(result.checkedLocations.some(location => location.path === path && !location.exists)).toBe(true);
    }
    expect(await snapshotMatches(before)).toBe(true);
    expect((await piAdapter.prepareMcpEdit(sandbox.context, 'project', [])).files).toHaveLength(0);
    expect(await snapshotMatches(before)).toBe(true);
  });

  it('discovers shared skills without treating shared directories as native Pi presence', async () => {
    await putSkill(join(sandbox.context.projectRoot, '.agents', 'skills'), 'shared');
    await putSkill(join(sandbox.context.homeDir, '.agents', 'skills'), 'shared');
    const result = await piAdapter.discover(sandbox.context);
    expect(result.detected).toBe(false);
    expect(result.resources).toHaveLength(2);
    expect(result.resources.every(resource => resource.source.agentId === 'shared' && resource.source.agents?.includes('pi'))).toBe(true);
    expect(new Set(result.resources.map(resource => resource.id)).size).toBe(2);
    expect(result.resources.map(resource => resource.source.scope).sort()).toEqual(['project', 'user']);
  });

  it('retains same-name provenance, descriptions, recursive directories, configured roots and whole-tree evidence', async () => {
    const native = join(sandbox.context.projectRoot, '.pi', 'skills');
    const nested = await putSkill(join(native, 'group'), 'same', 'Project-specific release guidance');
    await putFile(join(nested, 'scripts', 'check.sh'), '#!/bin/sh\nexit 99\n', 0o755);
    await putFile(join(nested, 'assets', 'binary'), new Uint8Array([0, 255, 1]));
    await putSkill(join(sandbox.context.homeDir, '.pi', 'agent', 'skills'), 'same', 'Personal release guidance');
    await putSkill(join(sandbox.context.projectRoot, '.agents', 'skills'), 'same', 'Shared release guidance');
    await putSkill(join(sandbox.context.projectRoot, '.pi', 'extra-skills'), 'configured');
    await putSkill(join(sandbox.context.homeDir, '.pi', 'agent', 'extra-skills'), 'configured-user');
    await putFile(join(sandbox.context.projectRoot, '.pi', 'settings.json'), JSON.stringify({ skills: ['extra-skills'] }));
    await putFile(join(sandbox.context.homeDir, '.pi', 'agent', 'settings.json'), JSON.stringify({ skills: ['extra-skills'] }));
    const before = await snapshotPath(sandbox.root);
    const result = await piAdapter.discover(sandbox.context);
    expect(result.detected).toBe(true);
    const same = result.resources.filter(resource => resource.name === 'same');
    expect(same).toHaveLength(3);
    expect(new Set(same.map(resource => resource.id)).size).toBe(3);
    const project = same.find(resource => resource.path === nested)!;
    expect(project.description).toBe('Project-specific release guidance');
    expect(project.source.path).toBe(native);
    expect(project.locator).toBe(join('group', 'same'));
    expect(project.source.scope).toBe('project');
    expect(project.source.visibility).toBe('shared');
    expect(project.snapshot.entries.some(entry => entry.relativePath === 'scripts/check.sh' && entry.mode === 0o755)).toBe(true);
    expect(result.resources.some(resource => resource.name === 'configured')).toBe(true);
    expect(result.resources.some(resource => resource.name === 'configured-user' && resource.source.scope === 'user' && resource.source.visibility === 'private')).toBe(true);
    expect(await snapshotMatches(before)).toBe(true);
  });

  it('resolves advertised placements without creating directories and rejects private-project placement', async () => {
    const before = await snapshotPath(sandbox.root);
    expect(piAdapter.skillDestination(sandbox.context, 'project').location).toEqual({ path: join(sandbox.context.projectRoot, '.pi', 'skills'), scope: 'project', visibility: 'shared' });
    expect(piAdapter.skillDestination(sandbox.context, 'user').location).toEqual({ path: join(sandbox.context.homeDir, '.pi', 'agent', 'skills'), scope: 'user', visibility: 'private' });
    expect(piAdapter.skillDestination(sandbox.context, 'private-project').location).toBeUndefined();
    const unsupported = await piAdapter.prepareMcpEdit(sandbox.context, 'private-project', []);
    expect(unsupported.findings.some(finding => finding.code === 'UNSUPPORTED_PLACEMENT')).toBe(true);
    expect(piAdapter.capabilities.transports).toEqual(['stdio', 'http']);
    expect(await snapshotMatches(before)).toBe(true);
  });

  it('discovers built-in MCP configuration independently by user/project scope, not flattened overrides', async () => {
    await putFile(userConfig(), JSON.stringify({ mcpServers: { same: { command: 'never-launch', args: ['user'], enabled: false }, remote: { type: 'streamable-http', url: 'https://example.test/mcp', headers: { Authorization: 'opaque' } } } }));
    await putFile(projectConfig(), JSON.stringify({ mcpServers: { same: { command: 'never-launch', args: ['project'] }, remote: { enabled: false } } }));
    const result = await piAdapter.discover(sandbox.context);
    const servers = mcp(result.resources);
    expect(servers).toHaveLength(3);
    const same = servers.filter(resource => resource.name === 'same');
    expect(same).toHaveLength(2);
    expect(new Set(same.map(resource => resource.id)).size).toBe(2);
    expect(same.every(resource => resource.source.agentId === 'pi' && resource.locator === JSON.stringify(['mcpServers', 'same']))).toBe(true);
    expect(same.find(resource => resource.source.scope === 'user')?.definition.native.enabled).toBe(false);
    expect(servers.find(resource => resource.name === 'remote')?.definition.transport).toBe('http');
    expect(result.findings.some(finding => finding.code === 'INHERITED_MCP_OVERRIDE')).toBe(true);
  });

  it('prepares one targeted conversion for selected stdio and HTTP entries, retaining unchecked settings and exact slot fingerprints', async () => {
    const inputs = await openCodeSources({ local: { type: 'local', command: ['never-launch', '--index'], environment: { MODE: 'read' }, cwd: './tools' }, remote: { type: 'remote', url: 'https://example.test/mcp', headers: { Accept: 'application/json' } } });
    const oldLocal = { command: 'old-command', args: ['keep-until-apply'] };
    const unchecked = { command: 'unselected', env: { KEEP: 'yes' } };
    const original = `${JSON.stringify({ autoEnableCodemode: false, custom: { retain: 7 }, mcpServers: { local: oldLocal, unchecked } }, null, 2)}\n`;
    await putFile(projectConfig(), original, 0o640);
    const before = await snapshotPath(sandbox.root);
    const result = await piAdapter.prepareMcpEdit(sandbox.context, 'project', inputs);
    expect(result.findings).toHaveLength(0);
    expect(result.files).toHaveLength(1);
    expect(result.targets).toHaveLength(2);
    expect(result.files[0]?.mode).toBe(0o640);
    expect(await snapshotMatches(before)).toBe(true);
    const local = result.targets.find(target => target.key === 'local')!;
    expect(local.beforeFingerprint).toBe(fingerprintValue(oldLocal));
    expect(local.slotId).toBe(fingerprintValue([projectConfig(), 'mcp', JSON.stringify(['mcpServers', 'local'])]));
    await putFile(projectConfig(), result.files[0]!.bytes);
    const parsed = (await readJsonDocument(projectConfig())).value;
    expect(fingerprintValue(registration(parsed, 'unchecked'))).toBe(fingerprintValue(unchecked));
    expect(parsed.autoEnableCodemode).toBe(false);
    expect(parsed.custom).toEqual({ retain: 7 });
    const generated = mcp((await piAdapter.discover(sandbox.context)).resources);
    expect(generated.find(resource => resource.name === 'local')?.definition.command).toBe('never-launch');
    expect(generated.find(resource => resource.name === 'local')?.definition.cwd).toBe('./tools');
    expect(generated.find(resource => resource.name === 'remote')?.definition.transport).toBe('http');
    expect(local.afterFingerprint).toBe(fingerprintValue(registration(parsed, 'local')));
    const unchangedTime = (await stat(projectConfig())).mtimeMs;
    const unchanged = await piAdapter.prepareMcpEdit(sandbox.context, 'project', inputs);
    expect(unchanged.files).toHaveLength(0);
    expect(unchanged.targets).toHaveLength(2);
    expect(unchanged.targets.every(target => target.beforeFingerprint === target.afterFingerprint)).toBe(true);
    expect((await stat(projectConfig())).mtimeMs).toBe(unchangedTime);
  });

  it('preserves complete same-native entries and never evaluates commands, auth helpers, substitutions or skill scripts', async () => {
    const marker = join(sandbox.root, 'executed');
    const executable = join(sandbox.root, 'never-run.sh');
    await putFile(executable, `#!/bin/sh\ntouch '${marker}'\n`, 0o755);
    const secret = randomUUID();
    const native = { command: executable, args: ['--secret', secret], env: { TOKEN: `!${executable}` }, exposure: 'hidden', toolExposure: { '*': 'hidden' }, timeout: 27, futureOption: { mode: 'native' } };
    await putFile(projectConfig(), JSON.stringify({ mcpServers: { selected: native } }));
    const skill = await putSkill(join(sandbox.context.projectRoot, '.pi', 'skills'), 'safe');
    await putFile(join(skill, 'scripts', 'run.sh'), `#!/bin/sh\ntouch '${marker}'\n`, 0o755);
    const before = await snapshotPath(sandbox.root);
    const found = mcp((await piAdapter.discover(sandbox.context)).resources)[0]!;
    expect(found.definition.unsupportedFields.includes('env')).toBe(true);
    const prepared = await piAdapter.prepareMcpEdit(sandbox.context, 'user', [found]);
    expect(prepared.findings).toHaveLength(0);
    expect(prepared.files[0]?.path).toBe(userConfig());
    expect(prepared.files[0]?.mode).toBe(0o600);
    const emitted: unknown = JSON.parse(Buffer.from(prepared.files[0]!.bytes).toString());
    expect(fingerprintValue(registration(emitted, 'selected'))).toBe(fingerprintValue(native));
    const blocked = await opencodeAdapter.prepareMcpEdit(sandbox.context, 'user', [found]);
    expect(blocked.files).toHaveLength(0);
    expect(blocked.findings.some(finding => finding.code === 'UNSUPPORTED_MCP_TRANSLATION')).toBe(true);
    expect(JSON.stringify([...prepared.findings, ...blocked.findings]).includes(secret)).toBe(false);
    expect(await snapshotMatches(before)).toBe(true);
    await expect(lstat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    '{"mcpServers":',
    '{"mcpServers": []}',
    '{"mcpServers": {"bad": {"command": "never", "args": "invalid"}}}',
    '{"mcpServers": {"bad": {"url": "invalid"}}}',
    '{"mcpServers": {"bad": {"type": "sse", "url": "https://example.test/sse"}}}',
    '{"mcpServers": {"bad": {"command": "never", "env": {"TOKEN": 3}}}}',
    '{ // Native Pi uses strict JSON\n "mcpServers": {} }',
  ])('reports malformed native configuration safely without writing', async text => {
    const secret = randomUUID();
    const input = text.replace('bad', secret);
    await putFile(projectConfig(), input);
    const before = await snapshotPath(sandbox.root);
    const discovery = await piAdapter.discover(sandbox.context);
    expect(discovery.findings.some(finding => finding.severity === 'error')).toBe(true);
    expect(JSON.stringify(discovery.findings).includes(secret)).toBe(false);
    expect(await snapshotMatches(before)).toBe(true);
  });

  it('refuses malformed destination containers and strict-JSON syntax without returning partial edits', async () => {
    const sources = await openCodeSources({ valid: { type: 'local', command: ['never'] } });
    for (const text of ['{"mcpServers":[]}', '{"mcpServers":{},}', '{"mcpServers":']) {
      await putFile(userConfig(), text);
      const before = await snapshotPath(sandbox.root);
      const result = await piAdapter.prepareMcpEdit(sandbox.context, 'user', sources);
      expect(result.findings.some(finding => finding.severity === 'error')).toBe(true);
      expect(result.files).toHaveLength(0);
      expect(result.targets).toHaveLength(0);
      expect(await snapshotMatches(before)).toBe(true);
    }
  });

  it('blocks private-project publication, native authorization-state propagation and lossy cross-agent translation', async () => {
    await putFile(projectConfig(), JSON.stringify({ mcpServers: { selected: { command: 'never', approved: true } } }));
    const source = mcp((await piAdapter.discover(sandbox.context)).resources)[0]!;
    const authorization = await piAdapter.prepareMcpEdit(sandbox.context, 'user', [source]);
    expect(authorization.findings.some(finding => finding.code === 'UNSUPPORTED_MCP_AUTHORIZATION')).toBe(true);
    const privateSource = { ...source, source: { ...source.source, visibility: 'private' as const } };
    expect((await piAdapter.prepareMcpEdit(sandbox.context, 'project', [privateSource])).findings.some(finding => finding.code === 'PRIVATE_SCOPE_VIOLATION')).toBe(true);
    const foreign = await openCodeSources({ selected: { type: 'local', command: ['never'], timeout: 1500 } });
    const lossy = await piAdapter.prepareMcpEdit(sandbox.context, 'user', foreign);
    expect(lossy.files).toHaveLength(0);
    expect(lossy.findings.some(finding => finding.code === 'UNSUPPORTED_MCP_TRANSLATION')).toBe(true);
  });

  it('rejects Pi namespace aliases across selected entries and unchecked registrations', async () => {
    const sources = await openCodeSources({ 'same-name': { type: 'local', command: ['one'] }, same_name: { type: 'local', command: ['two'] } });
    const batch = await piAdapter.prepareMcpEdit(sandbox.context, 'user', sources);
    expect(batch.files).toHaveLength(0);
    expect(batch.findings.some(finding => finding.code === 'MCP_NAMESPACE_COLLISION')).toBe(true);
    await putFile(userConfig(), JSON.stringify({ mcpServers: { same_name: { command: 'unchecked' } } }));
    const result = await piAdapter.prepareMcpEdit(sandbox.context, 'user', [sources.find(source => source.name === 'same-name')!]);
    expect(result.files).toHaveLength(0);
    expect(result.findings.some(finding => finding.code === 'MCP_NAMESPACE_COLLISION')).toBe(true);
  });

  it('uses physical configuration paths in slot IDs when a native parent is linked', async () => {
    const physical = join(sandbox.root, 'pi-physical');
    await putFile(join(physical, 'mcp.json'), JSON.stringify({ mcpServers: {} }));
    await symlink(physical, join(sandbox.context.projectRoot, '.pi'));
    const sources = await openCodeSources({ selected: { type: 'local', command: ['never'] } });
    const result = await piAdapter.prepareMcpEdit(sandbox.context, 'project', sources);
    expect(result.targets[0]?.path).toBe(join(physical, 'mcp.json'));
    expect(result.targets[0]?.slotId).toBe(fingerprintValue([join(physical, 'mcp.json'), 'mcp', JSON.stringify(['mcpServers', 'selected'])]));
  });

  it('reports unsafe asset links and malformed metadata without leaking their bodies', async () => {
    const root = join(sandbox.context.projectRoot, '.pi', 'skills');
    const unsafe = await putSkill(root, 'unsafe');
    await putFile(join(sandbox.root, 'outside'), 'sensitive data');
    await symlink(join(sandbox.root, 'outside'), join(unsafe, 'asset'));
    const secret = randomUUID();
    await putFile(join(root, 'malformed', 'SKILL.md'), `---\nname: [${secret}\n---\n`);
    const before = await snapshotPath(sandbox.root);
    const result = await piAdapter.discover(sandbox.context);
    expect(result.resources).toHaveLength(0);
    expect(result.findings.some(finding => finding.code === 'UNSAFE_SKILL_LINK')).toBe(true);
    expect(result.findings.some(finding => finding.code === 'INVALID_SKILL_METADATA')).toBe(true);
    expect(JSON.stringify(result.findings).includes(secret)).toBe(false);
    expect(await snapshotMatches(before)).toBe(true);
    expect((await readFile(join(root, 'malformed', 'SKILL.md'), 'utf8')).includes(secret)).toBe(true);
  });
});
