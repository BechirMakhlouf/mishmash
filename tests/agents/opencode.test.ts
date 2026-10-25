import { randomUUID } from 'node:crypto';
import { lstat, readFile, stat, symlink, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { opencodeAdapter } from '../../src/agents/opencode.js';
import { piAdapter } from '../../src/agents/pi.js';
import type { McpResource } from '../../src/model.js';
import { fingerprintValue, snapshotMatches, snapshotPath } from '../../src/fs/snapshot.js';
import { isRecord, readJsonDocument } from '../../src/resources/jsonc.js';
import { createSandbox, putFile, putSkill, type Sandbox } from '../helpers/sandbox.js';

let sandbox: Sandbox;
beforeEach(async () => { sandbox = await createSandbox(); });
afterEach(async () => { await sandbox.cleanup(); });
const mcp = (resources: readonly { kind: string }[]) => resources.filter((resource): resource is McpResource => resource.kind === 'mcp');
function projectConfig(): string { return join(sandbox.context.projectRoot, 'opencode.json'); }
function userConfig(): string { return join(sandbox.context.configHome, 'opencode', 'opencode.json'); }
function registration(value: unknown, key: string, current = false): unknown {
  if (!isRecord(value) || !isRecord(value.mcp)) throw new Error('Expected a valid native MCP document.');
  const entries = current ? value.mcp.servers : value.mcp;
  if (!isRecord(entries)) throw new Error('Expected a native MCP registration map.');
  return entries[key];
}
async function piSources(entries: Record<string, unknown>): Promise<McpResource[]> {
  await putFile(join(sandbox.context.projectRoot, '.pi', 'mcp.json'), JSON.stringify({ mcpServers: entries }));
  return mcp((await piAdapter.discover(sandbox.context)).resources);
}

describe('OpenCode native adapter', () => {
  it('reports checked standard config/skill paths without creating state or claiming an absent agent is detected', async () => {
    const before = await snapshotPath(sandbox.root);
    const result = await opencodeAdapter.discover(sandbox.context);
    expect(result.detected).toBe(false);
    expect(result.resources).toHaveLength(0);
    for (const path of [projectConfig(), `${projectConfig()}c`, userConfig(), `${userConfig()}c`, join(sandbox.context.projectRoot, '.opencode', 'opencode.json'), join(sandbox.context.projectRoot, '.opencode', 'skills'), join(sandbox.context.configHome, 'opencode', 'skills'), join(sandbox.context.projectRoot, '.claude', 'skills'), join(sandbox.context.homeDir, '.claude', 'skills'), join(sandbox.context.projectRoot, '.agents', 'skills'), join(sandbox.context.homeDir, '.agents', 'skills')]) {
      expect(result.checkedLocations.some(location => location.path === path && !location.exists)).toBe(true);
    }
    expect(await snapshotMatches(before)).toBe(true);
  });

  it('preserves compatible shared and Claude provenance without inferring OpenCode installation', async () => {
    for (const root of [join(sandbox.context.projectRoot, '.agents', 'skills'), join(sandbox.context.homeDir, '.agents', 'skills'), join(sandbox.context.projectRoot, '.claude', 'skills'), join(sandbox.context.homeDir, '.claude', 'skills')]) await putSkill(root, 'same');
    const result = await opencodeAdapter.discover(sandbox.context);
    expect(result.detected).toBe(false);
    expect(result.resources).toHaveLength(4);
    expect(new Set(result.resources.map(resource => resource.id)).size).toBe(4);
    expect(result.resources.every(resource => resource.source.agents?.includes('opencode'))).toBe(true);
    expect(result.resources.filter(resource => resource.source.agentId === 'claude-code')).toHaveLength(2);
    expect(result.resources.filter(resource => resource.source.agentId === 'shared')).toHaveLength(2);
    expect(result.resources.filter(resource => resource.source.scope === 'user').every(resource => resource.source.visibility === 'private')).toBe(true);
  });

  it('discovers native recursive, singular-compatible and configured skill roots in explicit context', async () => {
    const nativeRoot = join(sandbox.context.projectRoot, '.opencode', 'skills');
    const nested = await putSkill(join(nativeRoot, 'group'), 'native', 'Review native configuration');
    await putFile(join(nested, 'assets', 'reference'), 'complete directory');
    await putFile(join(nested, 'scripts', 'never.sh'), '#!/bin/sh\nexit 91\n', 0o755);
    await putSkill(join(sandbox.context.configHome, 'opencode', 'skills'), 'user-native');
    await putSkill(join(sandbox.context.projectRoot, '.opencode', 'skill'), 'legacy-directory');
    await putSkill(join(sandbox.context.projectRoot, 'extra'), 'configured');
    await putFile(projectConfig(), JSON.stringify({ skills: { paths: ['extra'], urls: ['https://example.test/skills'] } }));
    const before = await snapshotPath(sandbox.root);
    const result = await opencodeAdapter.discover(sandbox.context);
    expect(result.detected).toBe(true);
    expect(result.resources.map(resource => resource.name).sort()).toEqual(['configured', 'legacy-directory', 'native', 'user-native']);
    const native = result.resources.find(resource => resource.name === 'native')!;
    expect(native.path).toBe(nested);
    expect(native.source.path).toBe(nativeRoot);
    expect(native.description).toBe('Review native configuration');
    expect(native.snapshot.entries.some(entry => entry.relativePath === 'scripts/never.sh' && entry.mode === 0o755)).toBe(true);
    expect(result.findings.some(finding => finding.code === 'UNSUPPORTED_SKILL_SOURCE')).toBe(true);
    expect(await snapshotMatches(before)).toBe(true);
  });

  it('returns exact project/user destinations using non-default XDG roots and refuses private-project placement', async () => {
    const before = await snapshotPath(sandbox.root);
    expect(opencodeAdapter.skillDestination(sandbox.context, 'project').location).toEqual({ path: join(sandbox.context.projectRoot, '.opencode', 'skills'), scope: 'project', visibility: 'shared' });
    expect(opencodeAdapter.skillDestination(sandbox.context, 'user').location).toEqual({ path: join(sandbox.context.configHome, 'opencode', 'skills'), scope: 'user', visibility: 'private' });
    expect(opencodeAdapter.skillDestination(sandbox.context, 'private-project').location).toBeUndefined();
    expect((await opencodeAdapter.prepareMcpEdit(sandbox.context, 'private-project', [])).findings.some(finding => finding.code === 'UNSUPPORTED_PLACEMENT')).toBe(true);
    expect(opencodeAdapter.capabilities.transports).toEqual(['stdio', 'http']);
    expect(await snapshotMatches(before)).toBe(true);
  });

  it('discovers JSONC, current nested and documented legacy MCP schemas with distinct same-name sources and scopes', async () => {
    await putFile(`${projectConfig()}c`, '{ // project settings\n "model": "vendor/model", "mcp": {"same": {"type":"local", "command":["never","project"]},},}\n');
    await putFile(userConfig(), JSON.stringify({ mcp: { servers: { same: { type: 'local', command: ['never', 'user'], disabled: true, protocol: 'auto' }, remote: { type: 'remote', url: 'https://example.test/mcp', oauth: { client_id: 'client' } } } } }));
    await putFile(join(sandbox.context.projectRoot, '.opencode', 'opencode.json'), JSON.stringify({ mcp: { folder: { type: 'remote', url: 'https://example.test/mcp' } } }));
    const result = await opencodeAdapter.discover(sandbox.context);
    const servers = mcp(result.resources);
    expect(result.findings).toHaveLength(0);
    expect(servers).toHaveLength(4);
    const same = servers.filter(resource => resource.name === 'same');
    expect(same).toHaveLength(2);
    expect(new Set(same.map(resource => resource.id)).size).toBe(2);
    expect(same.find(resource => resource.source.scope === 'project')?.locator).toBe(JSON.stringify(['mcp', 'same']));
    const user = same.find(resource => resource.source.scope === 'user')!;
    expect(user.locator).toBe(JSON.stringify(['mcp', 'servers', 'same']));
    expect(user.definition.native.disabled).toBe(true);
    expect(user.definition.unsupportedFields.includes('protocol')).toBe(true);
    expect(user.source.visibility).toBe('private');
    expect(servers.find(resource => resource.name === 'remote')?.definition.transport).toBe('http');
  });

  it('converts selected literal stdio/HTTP definitions in a single comment-preserving edit and leaves unchecked native settings untouched', async () => {
    const sources = await piSources({ local: { command: 'never-launch', args: ['--stdio'], env: { MODE: 'read' }, cwd: './tools' }, remote: { url: 'https://example.test/mcp', headers: { Accept: 'application/json' } } });
    const beforeLocal = { type: 'local', command: ['old'] };
    const unchecked = { type: 'remote', url: 'https://example.test/unchecked', enabled: false, oauth: false };
    const path = `${projectConfig()}c`;
    await putFile(path, `// Preserve this comment\n${JSON.stringify({ model: 'vendor/model', permission: { skill: { '*': 'ask' } }, mcp: { local: beforeLocal, unchecked } }, null, 2)}\n`, 0o640);
    const before = await snapshotPath(sandbox.root);
    const result = await opencodeAdapter.prepareMcpEdit(sandbox.context, 'project', sources);
    expect(result.findings).toHaveLength(0);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.path).toBe(path);
    expect(result.files[0]?.mode).toBe(0o640);
    expect(result.targets).toHaveLength(2);
    expect(await snapshotMatches(before)).toBe(true);
    const local = result.targets.find(target => target.key === 'local')!;
    expect(local.beforeFingerprint).toBe(fingerprintValue(beforeLocal));
    expect(local.slotId).toBe(fingerprintValue([path, 'mcp', JSON.stringify(['mcp', 'local'])]));
    const encoded = Buffer.from(result.files[0]!.bytes).toString();
    expect(encoded.includes('// Preserve this comment')).toBe(true);
    await putFile(path, result.files[0]!.bytes);
    const parsed = (await readJsonDocument(path)).value;
    expect(fingerprintValue(registration(parsed, 'unchecked'))).toBe(fingerprintValue(unchecked));
    expect(parsed.model).toBe('vendor/model');
    expect(parsed.permission).toEqual({ skill: { '*': 'ask' } });
    const localEntry = registration(parsed, 'local');
    expect(fingerprintValue(localEntry)).toBe(fingerprintValue({ type: 'local', command: ['never-launch', '--stdio'], environment: { MODE: 'read' }, cwd: './tools' }));
    expect(local.afterFingerprint).toBe(fingerprintValue(localEntry));
    const unchanged = await snapshotPath(sandbox.root);
    const mtime = (await stat(path)).mtimeMs;
    const repeat = await opencodeAdapter.prepareMcpEdit(sandbox.context, 'project', sources);
    expect(repeat.files).toHaveLength(0);
    expect(repeat.targets).toHaveLength(2);
    expect(repeat.targets.every(target => target.beforeFingerprint === target.afterFingerprint)).toBe(true);
    expect((await stat(path)).mtimeMs).toBe(mtime);
    expect(await snapshotMatches(unchanged)).toBe(true);
  });

  it('uses current native slots when present and preserves complete same-native objects without migrating schemas', async () => {
    const native = { type: 'remote', url: 'https://example.test/mcp', headers: { Accept: 'application/json' }, disabled: true, codemode: false, protocol: 'auto', timeout: { startup: 8000, execution: 9000 }, oauth: { client_id: 'client', scope: 'tools:read' }, futureOption: { preserve: true } };
    await putFile(projectConfig(), JSON.stringify({ mcp: { servers: { selected: native } } }));
    const selected = mcp((await opencodeAdapter.discover(sandbox.context)).resources)[0]!;
    const result = await opencodeAdapter.prepareMcpEdit(sandbox.context, 'user', [selected]);
    expect(result.findings).toHaveLength(0);
    expect(result.files[0]?.path).toBe(userConfig());
    expect(result.files[0]?.mode).toBe(0o600);
    expect(result.targets[0]?.slotId).toBe(fingerprintValue([userConfig(), 'mcp', JSON.stringify(['mcp', 'servers', 'selected'])]));
    const decoded: unknown = JSON.parse(Buffer.from(result.files[0]!.bytes).toString());
    expect(fingerprintValue(registration(decoded, 'selected', true))).toBe(fingerprintValue(native));
    await putFile(userConfig(), JSON.stringify({ mcp: { selected: { type: 'remote', url: 'https://example.test/old' } } }));
    const incompatible = await opencodeAdapter.prepareMcpEdit(sandbox.context, 'user', [selected]);
    expect(incompatible.files).toHaveLength(0);
    expect(incompatible.findings.some(finding => finding.code === 'UNSUPPORTED_MCP_TRANSLATION')).toBe(true);
  });

  it('targets existing current-schema files for literal conversions without altering global timeouts or unchecked servers', async () => {
    const sources = await piSources({ selected: { command: 'never', args: ['stdio'] } });
    const unchecked = { type: 'local', command: ['untouched'], disabled: true };
    await putFile(userConfig(), JSON.stringify({ mcp: { timeout: { startup: 20000 }, servers: { unchecked } }, username: 'person' }));
    const prepared = await opencodeAdapter.prepareMcpEdit(sandbox.context, 'user', sources);
    expect(prepared.findings).toHaveLength(0);
    expect(prepared.targets[0]?.slotId).toBe(fingerprintValue([userConfig(), 'mcp', JSON.stringify(['mcp', 'servers', 'selected'])]));
    await putFile(userConfig(), prepared.files[0]!.bytes);
    const parsed = (await readJsonDocument(userConfig())).value;
    expect(fingerprintValue(registration(parsed, 'unchecked', true))).toBe(fingerprintValue(unchecked));
    expect(isRecord(parsed.mcp) && fingerprintValue(parsed.mcp.timeout) === fingerprintValue({ startup: 20000 })).toBe(true);
    expect(parsed.username).toBe('person');
    expect(mcp((await opencodeAdapter.discover(sandbox.context)).resources).some(resource => resource.name === 'selected' && resource.locator === JSON.stringify(['mcp', 'servers', 'selected']))).toBe(true);
  });

  it('prefers existing higher-precedence project directory config and retains lower-precedence files', async () => {
    const sources = await piSources({ selected: { command: 'never' } });
    await putFile(projectConfig(), '{"model":"vendor/lower"}\n');
    const high = join(sandbox.context.projectRoot, '.opencode', 'opencode.jsonc');
    await putFile(high, '// Higher native configuration\n{"mcp":{}}\n');
    const lowerBytes = await readFile(projectConfig(), 'utf8');
    const result = await opencodeAdapter.prepareMcpEdit(sandbox.context, 'project', sources);
    expect(result.files[0]?.path).toBe(high);
    expect(await readFile(projectConfig(), 'utf8')).toBe(lowerBytes);
  });

  it('never runs commands, interpolates credential files, performs OAuth or evaluates config while discovering/preparing', async () => {
    const marker = join(sandbox.root, 'executed');
    const executable = join(sandbox.root, 'never-run.sh');
    await putFile(executable, `#!/bin/sh\ntouch '${marker}'\n`, 0o755);
    const secret = randomUUID();
    const secretsFile = join(sandbox.root, 'credential-data');
    await putFile(secretsFile, secret);
    const local = { type: 'local', command: [executable, secret], environment: { TOKEN: `{file:${secretsFile}}` } };
    const remote = { type: 'remote', url: 'https://example.test/mcp', headers: { Authorization: `{file:${secretsFile}}` }, oauth: { clientId: 'native', clientSecret: secret } };
    await putFile(projectConfig(), JSON.stringify({ mcp: { local, remote } }));
    const before = await snapshotPath(sandbox.root);
    const discovery = await opencodeAdapter.discover(sandbox.context);
    const sources = mcp(discovery.resources);
    expect(sources).toHaveLength(2);
    const result = await opencodeAdapter.prepareMcpEdit(sandbox.context, 'user', sources);
    expect(result.files).toHaveLength(1);
    const output: unknown = JSON.parse(Buffer.from(result.files[0]!.bytes).toString());
    expect(fingerprintValue(registration(output, 'local'))).toBe(fingerprintValue(local));
    expect(fingerprintValue(registration(output, 'remote'))).toBe(fingerprintValue(remote));
    const lossy = await piAdapter.prepareMcpEdit(sandbox.context, 'user', sources);
    expect(lossy.files).toHaveLength(0);
    expect(lossy.findings.some(finding => finding.code === 'UNSUPPORTED_MCP_TRANSLATION')).toBe(true);
    expect(JSON.stringify([...discovery.findings, ...result.findings, ...lossy.findings]).includes(secret)).toBe(false);
    expect(await snapshotMatches(before)).toBe(true);
    await expect(lstat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    '{"mcp":',
    '{"mcp":[]}',
    '{"mcp":{"servers":false}}',
    '{"mcp":{"bad":{"type":"local","command":[]}}}',
    '{"mcp":{"bad":{"type":"local","command":[3]}}}',
    '{"mcp":{"bad":{"type":"remote","url":"invalid"}}}',
    '{"mcp":{"bad":{"type":"local","command":["never"],"environment":{"TOKEN":3}}}}',
  ])('reports malformed source configuration without exposing native values or modifying files', async text => {
    const secret = randomUUID();
    await putFile(projectConfig(), text.replace('bad', secret));
    const before = await snapshotPath(sandbox.root);
    const result = await opencodeAdapter.discover(sandbox.context);
    expect(result.findings.some(finding => finding.severity === 'error')).toBe(true);
    expect(JSON.stringify(result.findings).includes(secret)).toBe(false);
    expect(await snapshotMatches(before)).toBe(true);
  });

  it('blocks unsafe destination configs, mixed-schema collisions, private publication and native approval state', async () => {
    const sources = await piSources({ selected: { command: 'never' } });
    for (const text of ['{"mcp": []}', '{"mcp": {"servers": false}}', '{"mcp":']) {
      await putFile(userConfig(), text);
      const before = await snapshotPath(sandbox.root);
      const result = await opencodeAdapter.prepareMcpEdit(sandbox.context, 'user', sources);
      expect(result.files).toHaveLength(0);
      expect(result.findings.some(finding => finding.severity === 'error')).toBe(true);
      expect(await snapshotMatches(before)).toBe(true);
    }
    await putFile(userConfig(), JSON.stringify({ mcp: { selected: { type: 'local', command: ['legacy'] }, servers: { selected: { type: 'local', command: ['current'] } } } }));
    const mixed = await opencodeAdapter.prepareMcpEdit(sandbox.context, 'user', sources);
    expect(mixed.files).toHaveLength(0);
    expect(mixed.findings.some(finding => finding.code === 'MCP_SCHEMA_COLLISION')).toBe(true);
    const privateResource = { ...sources[0]!, source: { ...sources[0]!.source, visibility: 'private' as const } };
    expect((await opencodeAdapter.prepareMcpEdit(sandbox.context, 'project', [privateResource])).findings.some(finding => finding.code === 'PRIVATE_SCOPE_VIOLATION')).toBe(true);
    await putFile(projectConfig(), JSON.stringify({ mcp: { unsafe: { type: 'local', command: ['never'], trusted: true } } }));
    const unsafe = mcp((await opencodeAdapter.discover(sandbox.context)).resources).find(resource => resource.name === 'unsafe')!;
    await putFile(userConfig(), '{}');
    expect((await opencodeAdapter.prepareMcpEdit(sandbox.context, 'user', [unsafe])).findings.some(finding => finding.code === 'UNSUPPORTED_MCP_AUTHORIZATION')).toBe(true);
  });

  it('canonicalizes linked skill roots and native config parents, changing source identity after a link is retargeted', async () => {
    const one = join(sandbox.root, 'one');
    const two = join(sandbox.root, 'two');
    await putSkill(join(one, 'skills'), 'same');
    await putSkill(join(two, 'skills'), 'same');
    await putFile(join(one, 'opencode.json'), '{"mcp":{"selected":{"type":"local","command":["never"]}}}');
    await putFile(join(two, 'opencode.json'), '{}');
    const alias = join(sandbox.context.projectRoot, '.opencode');
    await symlink(one, alias);
    const first = await opencodeAdapter.discover(sandbox.context);
    const skill = first.resources.find(resource => resource.kind === 'skill')!;
    expect(skill.source.path).toBe(join(one, 'skills'));
    const selected = mcp(first.resources)[0]!;
    expect(selected.source.path).toBe(join(one, 'opencode.json'));
    const prepared = await opencodeAdapter.prepareMcpEdit(sandbox.context, 'project', [selected]);
    expect(prepared.targets[0]?.slotId).toBe(fingerprintValue([join(one, 'opencode.json'), 'mcp', JSON.stringify(['mcp', 'selected'])]));
    expect(prepared.files).toHaveLength(0);
    expect(prepared.targets[0]?.path).toBe(join(alias, 'opencode.json'));
    expect(prepared.targets[0]?.beforeFingerprint).toBe(prepared.targets[0]?.afterFingerprint);
    await unlink(alias);
    await symlink(two, alias);
    const second = (await opencodeAdapter.discover(sandbox.context)).resources.find(resource => resource.kind === 'skill')!;
    expect(skill.id === second.id).toBe(false);
  });

  it('reports malformed skill metadata and escaping links safely while retaining safe linked skill assets', async () => {
    const root = join(sandbox.context.projectRoot, '.opencode', 'skills');
    const safe = await putSkill(root, 'safe');
    await putFile(join(safe, 'reference'), 'inside');
    await symlink('reference', join(safe, 'reference-link'));
    const unsafe = await putSkill(root, 'unsafe');
    await putFile(join(sandbox.root, 'outside'), 'outside');
    await symlink(join(sandbox.root, 'outside'), join(unsafe, 'reference'));
    const secret = randomUUID();
    await putFile(join(root, 'bad', 'SKILL.md'), `---\nname: [${secret}\n---\n`);
    const result = await opencodeAdapter.discover(sandbox.context);
    expect(result.resources.filter(resource => resource.kind === 'skill').map(resource => resource.name)).toEqual(['safe']);
    expect(result.findings.some(finding => finding.code === 'UNSAFE_SKILL_LINK')).toBe(true);
    expect(result.findings.some(finding => finding.code === 'INVALID_SKILL_METADATA')).toBe(true);
    expect(JSON.stringify(result.findings).includes(secret)).toBe(false);
  });
  it.each(['header', 'oauth', 'argument', 'environment', 'nested'])('blocks relocation of relative native file references in %s without reading or exposing credentials', async field => {
    const tokenName = `token-${randomUUID()}`;
    const reference = `{file:./${tokenName}}`;
    const sourceSecret = randomUUID();
    const destinationSecret = randomUUID();
    await putFile(join(sandbox.context.projectRoot, tokenName), sourceSecret);
    await putFile(join(sandbox.context.configHome, 'opencode', tokenName), destinationSecret);
    let native: Record<string, unknown>;
    if (field === 'argument') native = { type: 'local', command: ['never', reference] };
    else if (field === 'environment') native = { type: 'local', command: ['never'], environment: { TOKEN: reference } };
    else if (field === 'oauth') native = { type: 'remote', url: 'https://example.test/mcp', oauth: { client_secret: reference } };
    else if (field === 'nested') native = { type: 'remote', url: 'https://example.test/mcp', futureOption: { items: [{ value: reference }] } };
    else native = { type: 'remote', url: 'https://example.test/mcp', headers: { Authorization: reference } };
    await putFile(projectConfig(), JSON.stringify({ mcp: field === 'oauth' ? { servers: { selected: native } } : { selected: native } }));
    const selected = mcp((await opencodeAdapter.discover(sandbox.context)).resources)[0]!;
    const before = await snapshotPath(sandbox.root);
    const result = await opencodeAdapter.prepareMcpEdit(sandbox.context, 'user', [selected]);
    expect(result.files).toHaveLength(0);
    expect(result.targets).toHaveLength(0);
    expect(result.findings.some(finding => finding.code === 'UNSUPPORTED_MCP_RELOCATION')).toBe(true);
    const diagnostics = JSON.stringify(result.findings);
    expect([reference, tokenName, sourceSecret, destinationSecret].some(value => diagnostics.includes(value))).toBe(false);
    expect(await snapshotMatches(before)).toBe(true);
  });

  it('preserves relative file references for unchanged lexical and physical config parents, including no-op preparation', async () => {
    const native = { type: 'remote', url: 'https://example.test/mcp', headers: { Authorization: '{file:./not-read}' } };
    await putFile(projectConfig(), JSON.stringify({ mcp: { selected: native } }));
    const selected = mcp((await opencodeAdapter.discover(sandbox.context)).resources)[0]!;
    const same = await opencodeAdapter.prepareMcpEdit(sandbox.context, 'project', [selected]);
    expect(same.findings).toHaveLength(0);
    expect(same.files).toHaveLength(0);
    expect(same.targets).toHaveLength(1);
    const sibling = `${projectConfig()}c`;
    await putFile(sibling, '{}\n');
    const before = await snapshotPath(sandbox.root);
    const result = await opencodeAdapter.prepareMcpEdit(sandbox.context, 'project', [selected]);
    expect(result.findings).toHaveLength(0);
    expect(result.files[0]?.path).toBe(sibling);
    const encoded: unknown = JSON.parse(Buffer.from(result.files[0]!.bytes).toString());
    expect(fingerprintValue(registration(encoded, 'selected'))).toBe(fingerprintValue(native));
    expect(await snapshotMatches(before)).toBe(true);
    await expect(lstat(join(sandbox.context.projectRoot, 'not-read'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('blocks relative reference reuse when a linked config parent changes physical identity', async () => {
    const first = join(sandbox.root, 'first-config');
    const second = join(sandbox.root, 'second-config');
    const native = { type: 'local', command: ['never'], environment: { TOKEN: '{file:../not-read}' } };
    await putFile(join(first, 'opencode.json'), JSON.stringify({ mcp: { selected: native } }));
    await putFile(join(second, 'opencode.json'), '{}');
    const alias = join(sandbox.context.projectRoot, '.opencode');
    await symlink(first, alias);
    const selected = mcp((await opencodeAdapter.discover(sandbox.context)).resources)[0]!;
    await unlink(alias);
    await symlink(second, alias);
    const before = await snapshotPath(sandbox.root);
    const result = await opencodeAdapter.prepareMcpEdit(sandbox.context, 'project', [selected]);
    expect(result.files).toHaveLength(0);
    expect(result.targets).toHaveLength(0);
    expect(result.findings.some(finding => finding.code === 'UNSUPPORTED_MCP_RELOCATION')).toBe(true);
    expect(await snapshotMatches(before)).toBe(true);
  });

  it('blocks selected native paths that overlap exactly or through a legacy servers registration in either selection order', async () => {
    const legacyRoot = join(sandbox.root, 'legacy-source');
    const currentRoot = join(sandbox.root, 'current-source');
    await putFile(join(legacyRoot, 'opencode.json'), JSON.stringify({ mcp: { servers: { type: 'local', command: ['never-legacy'] } } }));
    await putFile(join(currentRoot, 'opencode.json'), JSON.stringify({ mcp: { servers: { foo: { type: 'local', command: ['never-current'] } } } }));
    const legacy = mcp((await opencodeAdapter.discover({ ...sandbox.context, projectRoot: legacyRoot })).resources)[0]!;
    const current = mcp((await opencodeAdapter.discover({ ...sandbox.context, projectRoot: currentRoot })).resources)[0]!;
    for (const selected of [[legacy, current], [current, legacy], [current, current]]) {
      const before = await snapshotPath(sandbox.root);
      const result = await opencodeAdapter.prepareMcpEdit(sandbox.context, 'project', selected);
      expect(result.files).toHaveLength(0);
      expect(result.targets).toHaveLength(0);
      expect(result.findings.some(finding => finding.code === 'MCP_SCHEMA_COLLISION')).toBe(true);
      expect(await snapshotMatches(before)).toBe(true);
    }
  });

  it('prepares disjoint flat and nested selected paths together without treating string prefixes as ancestry', async () => {
    const legacyRoot = join(sandbox.root, 'legacy-source');
    const currentRoot = join(sandbox.root, 'current-source');
    const legacyNative = { type: 'local', command: ['never-legacy'] };
    const currentNative = { type: 'local', command: ['never-current'] };
    await putFile(join(legacyRoot, 'opencode.json'), JSON.stringify({ mcp: { 'servers-extra': legacyNative } }));
    await putFile(join(currentRoot, 'opencode.json'), JSON.stringify({ mcp: { servers: { foo: currentNative } } }));
    const legacy = mcp((await opencodeAdapter.discover({ ...sandbox.context, projectRoot: legacyRoot })).resources)[0]!;
    const current = mcp((await opencodeAdapter.discover({ ...sandbox.context, projectRoot: currentRoot })).resources)[0]!;
    const before = await snapshotPath(sandbox.root);
    const result = await opencodeAdapter.prepareMcpEdit(sandbox.context, 'project', [legacy, current]);
    expect(result.findings).toHaveLength(0);
    expect(result.files).toHaveLength(1);
    expect(result.targets).toHaveLength(2);
    const encoded: unknown = JSON.parse(Buffer.from(result.files[0]!.bytes).toString());
    expect(fingerprintValue(registration(encoded, 'servers-extra'))).toBe(fingerprintValue(legacyNative));
    expect(fingerprintValue(registration(encoded, 'foo', true))).toBe(fingerprintValue(currentNative));
    expect(await snapshotMatches(before)).toBe(true);
  });
});
