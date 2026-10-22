import { randomUUID } from 'node:crypto';
import { readFile, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'jsonc-parser';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { geminiCliAdapter as adapter } from '../../src/agents/gemini-cli.js';
import { claudeCodeAdapter } from '../../src/agents/claude-code.js';
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

describe('Gemini CLI native adapter', () => {
  it('lists checked locations but does not invent native presence from empty or shared-only discovery', async () => {
    const before = await snapshotPath(sandbox.root);
    const empty = await adapter.discover(sandbox.context);
    expect(empty.detected).toBe(false);
    expect(empty.checkedLocations.length).toBe(8);
    expect(empty.checkedLocations.every(location => !location.exists)).toBe(true);
    expect(empty.resources.length).toBe(0);
    expect(await adapter.prepareMcpEdit(sandbox.context, 'private-project', [])).toEqual({ files: [], targets: [], findings: [] });
    expect(snapshotsEqual(before, await snapshotPath(sandbox.root))).toBe(true);
    await putSkill(join(sandbox.context.projectRoot, '.agents', 'skills'), 'shared-only');
    const shared = await adapter.discover(sandbox.context);
    expect(shared.detected).toBe(false);
    expect(shared.resources.length).toBe(1);
    expect(shared.resources[0]!.source.agentId).toBe('shared');
    expect(shared.resources[0]!.source.agents).toEqual(['gemini-cli']);
  });

  it('discovers project/user native and documented shared aliases with metadata and provenance', async () => {
    const { projectRoot, homeDir } = sandbox.context;
    for (const [root, scope] of [[projectRoot, 'project'], [homeDir, 'user']] as const) {
      for (const directory of ['.gemini', '.agents']) await putSkill(join(root, directory, 'skills'), `${scope}-${directory.slice(1)}`, `${scope} skill guidance`);
      await putFile(join(root, '.gemini', 'settings.json'), JSON.stringify({ theme: 'dark', mcpServers: { [scope]: { command: 'not-run', args: ['safe'], env: { STATIC: 'literal' }, cwd: './server' } } }));
    }
    const before = await snapshotPath(sandbox.root);
    const result = await adapter.discover(sandbox.context);
    expect(result.detected).toBe(true);
    expect(result.findings.length).toBe(0);
    expect(result.resources.length).toBe(6);
    expect(result.checkedLocations.every(location => location.exists)).toBe(true);
    for (const resource of result.resources) {
      const scope = resource.name.startsWith('user') ? 'user' : 'project';
      expect(resource.source.scope).toBe(scope);
      expect(resource.source.visibility).toBe(scope === 'user' ? 'private' : 'shared');
      expect(resource.source.path.startsWith(scope === 'user' ? homeDir : projectRoot)).toBe(true);
      if (resource.kind === 'skill') expect(resource.description).toBe(`${scope} skill guidance`);
      else {
        expect(resource.source.agentId).toBe('gemini-cli');
        expect(resource.definition.transport).toBe('stdio');
        expect(resource.definition.cwd).toBe('./server');
        expect(resource.locator).toBe(JSON.stringify(['mcpServers', resource.name]));
      }
    }
    expect(snapshotsEqual(before, await snapshotPath(sandbox.root))).toBe(true);
  });

  it('retains independently authored duplicate-name native and shared skills rather than choosing precedence', async () => {
    for (const directory of ['.gemini', '.agents']) await putSkill(join(sandbox.context.projectRoot, directory, 'skills'), 'duplicate', directory);
    const result = await adapter.discover(sandbox.context);
    expect(result.resources.length).toBe(2);
    expect(new Set(result.resources.map(resource => resource.id)).size).toBe(2);
    expect(new Set(result.resources.map(resource => resource.description)).size).toBe(2);
  });

  it.each(['project', 'user'] as const)('resolves every advertised %s skill destination', placement => {
    const result = adapter.skillDestination(sandbox.context, placement);
    expect(result.location).toEqual({ path: join(placement === 'user' ? sandbox.context.homeDir : sandbox.context.projectRoot, '.gemini', 'skills'),
      scope: placement, visibility: placement === 'user' ? 'private' : 'shared' });
    expect(result.findings.length).toBe(0);
    expect(adapter.skillDestination(sandbox.context, 'private-project').location).toBeUndefined();
  });

  it.each(['project', 'user'] as const)('prepares targeted %s MCP edits, preserving native fields and unrelated comments/settings', async placement => {
    const { projectRoot, homeDir } = sandbox.context;
    const path = join(placement === 'user' ? homeDir : projectRoot, '.gemini', 'settings.json');
    const token = randomUUID();
    const native = { command: '/never-run', args: ['--selected', token], env: { TOKEN: '${UNRESOLVED}' }, cwd: './private-cwd',
      timeout: 654321, trust: false, includeTools: ['read'], excludeTools: ['write'], oauth: { enabled: true, clientId: token },
      authProviderType: 'google_credentials', description: 'Selected native description', futureExecution: { enabled: true } };
    const source = join(projectRoot, '.gemini', 'settings.json');
    await putFile(source, JSON.stringify({ mcpServers: { chosen: native, notSelected: { command: 'do-not-copy' } } }), 0o640);
    const selected = await mcp('chosen');
    const previous = { command: 'old' };
    await putFile(path, `// preserve top-level\n{\n  "ui": { "theme": "unchanged" },\n  "mcp": { "excluded": ["unchecked"] },\n  "mcpServers": {\n    "chosen": ${JSON.stringify(previous)},\n    // preserve unchecked comment\n    "unchecked": { "command": "not-selected", "trust": true }\n  }\n}\n`, 0o640);
    const before = await snapshotPath(sandbox.root);
    const result = await adapter.prepareMcpEdit(sandbox.context, placement, [selected]);
    expect(result.findings.length).toBe(0);
    expect(result.files.length).toBe(1);
    const file = result.files[0]!;
    expect(file.path).toBe(path);
    expect(file.mode).toBe(0o640);
    const text = Buffer.from(file.bytes).toString('utf8');
    expect(text.includes('// preserve top-level')).toBe(true);
    expect(text.includes('// preserve unchecked comment')).toBe(true);
    const output = decoded(file.bytes);
    expect(fingerprintValue(output.mcpServers.chosen) === fingerprintValue(native)).toBe(true);
    expect(output.mcpServers.unchecked.command).toBe('not-selected');
    expect(output.mcpServers.unchecked.trust).toBe(true);
    expect(output.mcpServers.notSelected).toBeUndefined();
    expect(output.ui.theme).toBe('unchanged');
    expect(output.mcp.excluded).toEqual(['unchecked']);
    expect(result.targets.length).toBe(1);
    expect(result.targets[0]!.key).toBe('chosen');
    expect(result.targets[0]!.slotId).toBe(fingerprintValue([file.expected.resolvedPath, 'mcp', JSON.stringify(['mcpServers', 'chosen'])]));
    expect(result.targets[0]!.beforeFingerprint).toBe(fingerprintValue(previous));
    expect(result.targets[0]!.afterFingerprint === fingerprintValue(native)).toBe(true);
    expect(snapshotsEqual(before, await snapshotPath(sandbox.root))).toBe(true);
  });

  it('uses physical config identity through a linked parent and handles literal dotted server keys', async () => {
    await putFile(join(sandbox.context.projectRoot, '.gemini', 'settings.json'), JSON.stringify({ mcpServers: { 'literal.key/one': { command: 'never' } } }));
    const selected = await mcp('literal.key/one');
    const physical = join(sandbox.root, 'physical-gemini');
    await putFile(join(physical, 'settings.json'), '{"mcpServers":{"linked":{"command":"never"}}}');
    await symlink(physical, join(sandbox.context.homeDir, '.gemini'));
    const linked = await mcp('linked');
    expect(linked.source.path).toBe(join(physical, 'settings.json'));
    expect(linked.path).toBe(join(physical, 'settings.json'));
    const before = await snapshotPath(sandbox.root);
    const result = await adapter.prepareMcpEdit(sandbox.context, 'user', [selected]);
    const file = result.files[0]!;
    expect(file.expected.resolvedPath).toBe(join(physical, 'settings.json'));
    expect(result.targets[0]!.slotId).toBe(fingerprintValue([join(physical, 'settings.json'), 'mcp', JSON.stringify(['mcpServers', selected.name])]));
    expect(decoded(file.bytes).mcpServers['literal.key/one'].command).toBe('never');
    expect(snapshotsEqual(before, await snapshotPath(sandbox.root))).toBe(true);
  });

  it('returns targets without file edits for identical native definitions, even without a final newline', async () => {
    const path = join(sandbox.context.projectRoot, '.gemini', 'settings.json');
    const native = { url: 'https://example.invalid/events' };
    await putFile(path, JSON.stringify({ mcpServers: { same: native } }));
    const selected = await mcp('same');
    expect(selected.definition.unsupportedFields).toContain('transport-auto-detection');
    const before = await snapshotPath(sandbox.root);
    const mtime = (await stat(path)).mtimeMs;
    const result = await adapter.prepareMcpEdit(sandbox.context, 'project', [selected]);
    expect(result.files.length).toBe(0);
    expect(result.targets.length).toBe(1);
    expect(result.targets[0]!.beforeFingerprint).toBe(fingerprintValue(native));
    expect(result.targets[0]!.afterFingerprint).toBe(fingerprintValue(native));
    expect((await stat(path)).mtimeMs).toBe(mtime);
    expect((await readFile(path, 'utf8')).endsWith('\n')).toBe(false);
    expect(snapshotsEqual(before, await snapshotPath(sandbox.root))).toBe(true);
  });

  it('converts compatible Claude stdio and explicit SSE entries without granting trust', async () => {
    const values = { stdio: { command: 'never', args: ['one'], env: { VALUE: 'literal' } },
      sse: { type: 'sse', url: 'https://example.invalid/events' } };
    await putFile(join(sandbox.context.projectRoot, '.mcp.json'), JSON.stringify({ mcpServers: values }));
    const resources = await Promise.all(Object.keys(values).map(name => mcp(name, claudeCodeAdapter)));
    const before = await snapshotPath(sandbox.root);
    const result = await adapter.prepareMcpEdit(sandbox.context, 'project', resources);
    expect(result.findings.length).toBe(0);
    expect(result.files.length).toBe(1);
    expect(result.files[0]!.mode).toBe(0o600);
    const output = decoded(result.files[0]!.bytes).mcpServers;
    expect(output.stdio.command).toBe('never');
    expect(output.stdio.args).toEqual(['one']);
    expect(output.sse.url).toBe('https://example.invalid/events');
    expect(output.sse.type).toBe('sse');
    expect(Object.values(output).every(value => typeof value === 'object' && value !== null && !Object.hasOwn(value, 'trust'))).toBe(true);
    expect(result.targets.length).toBe(2);
    expect(result.targets.every(target => target.beforeFingerprint === undefined)).toBe(true);
    expect(snapshotsEqual(before, await snapshotPath(sandbox.root))).toBe(true);
  });

  it.each(['headersHelper', 'timeout', 'alwaysLoad', 'oauth', 'futureExecution'])('blocks lossy Claude %s conversion but preserves it natively', async field => {
    const token = randomUUID();
    await putFile(join(sandbox.context.projectRoot, '.mcp.json'), JSON.stringify({ mcpServers: { selected: { type: 'sse', url: 'https://example.invalid/mcp', [field]: token } } }));
    const selected = await mcp('selected', claudeCodeAdapter);
    const result = await adapter.prepareMcpEdit(sandbox.context, 'project', [selected]);
    expect(result.files.length).toBe(0);
    expect(result.findings.some(finding => finding.code === 'UNSUPPORTED_MCP_CONVERSION')).toBe(true);
    expect(JSON.stringify(result.findings).includes(token)).toBe(false);
    const native = await claudeCodeAdapter.prepareMcpEdit(sandbox.context, 'user', [selected]);
    expect(native.findings.length).toBe(0);
    expect(fingerprintValue(decoded(native.files[0]!.bytes).mcpServers.selected) === fingerprintValue(selected.definition.native)).toBe(true);
  });

  it.each(['$UNRESOLVED', '%UNRESOLVED%'])('blocks converting Claude literal expansion syntax %s into Gemini interpolation', async expression => {
    await putFile(join(sandbox.context.projectRoot, '.mcp.json'), JSON.stringify({ mcpServers: { selected: { command: 'never', args: [expression] } } }));
    const selected = await mcp('selected', claudeCodeAdapter);
    const result = await adapter.prepareMcpEdit(sandbox.context, 'project', [selected]);
    expect(result.files.length).toBe(0);
    expect(result.findings.some(finding => finding.code === 'UNSUPPORTED_MCP_CONVERSION')).toBe(true);
  });

  it.each(['command', 'args', 'env', 'url', 'headers'])('blocks every Claude braced variable in %s without resolving or exposing it', async field => {
    const token = randomUUID();
    const names = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK', 'HTTPS_PROXY', 'NPM_TOKEN', 'ORDINARY_VARIABLE'];
    for (const name of names) {
      for (const fallback of ['', `:-${token}`]) {
        const expression = '${' + name + fallback + '}';
        const native: Record<string, unknown> = field === 'url' || field === 'headers'
          ? { type: 'sse', url: 'https://example.invalid/mcp', headers: { Marker: token } }
          : { command: 'never', env: { MARKER: token } };
        if (field === 'args') native.args = [expression];
        else if (field === 'env') native.env = { VALUE: expression, MARKER: token };
        else if (field === 'url') native.url = `https://example.invalid/${expression}/${token}`;
        else if (field === 'headers') native.headers = { Authorization: `Bearer ${expression}`, Marker: token };
        else native.command = expression;
        await putFile(join(sandbox.context.projectRoot, '.mcp.json'), JSON.stringify({ mcpServers: { selected: native } }));
        const selected = await mcp('selected', claudeCodeAdapter);
        const before = await snapshotPath(sandbox.root);
        for (const placement of ['project', 'user'] as const) {
          const result = await adapter.prepareMcpEdit(sandbox.context, placement, [selected]);
          expect(result.files.length).toBe(0);
          expect(result.targets.length).toBe(0);
          expect(result.findings.some(finding => finding.code === 'UNSUPPORTED_MCP_CONVERSION' && finding.severity === 'error')).toBe(true);
          const diagnostics = JSON.stringify(result.findings);
          expect(diagnostics.includes(token) || diagnostics.includes(expression) || diagnostics.includes(name)).toBe(false);
        }
        const nativeCopy = await claudeCodeAdapter.prepareMcpEdit(sandbox.context, 'user', [selected]);
        expect(nativeCopy.findings.length).toBe(0);
        expect(nativeCopy.files.length).toBe(1);
        expect(fingerprintValue(decoded(nativeCopy.files[0]!.bytes).mcpServers.selected) === fingerprintValue(native)).toBe(true);
        expect(snapshotsEqual(before, await snapshotPath(sandbox.root))).toBe(true);
      }
    }
  });

  it.each(['http', 'streamable-http'])('blocks Claude %s fallback conversion while preserving the native registration', async type => {
    const token = randomUUID();
    const native = { type, url: `https://example.invalid/${token}`, headers: { Authorization: token } };
    await putFile(join(sandbox.context.projectRoot, '.mcp.json'), JSON.stringify({ mcpServers: { selected: native } }));
    const selected = await mcp('selected', claudeCodeAdapter);
    expect(selected.definition.unsupportedFields.includes('transport-auto-detection')).toBe(true);
    const before = await snapshotPath(sandbox.root);
    for (const placement of ['project', 'user'] as const) {
      const result = await adapter.prepareMcpEdit(sandbox.context, placement, [selected]);
      expect(result.files.length).toBe(0);
      expect(result.targets.length).toBe(0);
      expect(result.findings.some(finding => finding.code === 'UNSUPPORTED_MCP_CONVERSION' && finding.severity === 'error')).toBe(true);
      expect(JSON.stringify(result.findings).includes(token)).toBe(false);
    }
    const unchanged = await claudeCodeAdapter.prepareMcpEdit(sandbox.context, 'project', [selected]);
    expect(unchanged.files.length).toBe(0);
    expect(unchanged.targets.length).toBe(1);
    const nativeCopy = await claudeCodeAdapter.prepareMcpEdit(sandbox.context, 'user', [selected]);
    expect(nativeCopy.findings.length).toBe(0);
    expect(nativeCopy.files.length).toBe(1);
    expect(fingerprintValue(decoded(nativeCopy.files[0]!.bytes).mcpServers.selected) === fingerprintValue(native)).toBe(true);
    expect(snapshotsEqual(before, await snapshotPath(sandbox.root))).toBe(true);
  });

  it('distinguishes explicit current native transport forms and blocks ambiguous/excess source fields on conversion', async () => {
    await putFile(join(sandbox.context.projectRoot, '.gemini', 'settings.json'), JSON.stringify({ mcpServers: {
      typedHttp: { type: 'http', url: 'https://example.invalid/mcp' },
      typedSse: { type: 'sse', url: 'https://example.invalid/events' },
      legacyHttp: { httpUrl: 'https://example.invalid/legacy' },
      auto: { url: 'https://example.invalid/auto' },
      conflicting: { httpUrl: 'https://example.invalid/http', url: 'https://example.invalid/sse' },
      extras: { command: 'not-run', unknownExecutionFlag: true },
    } }));
    for (const [name, transport] of [['typedSse', 'sse']] as const) {
      const selected = await mcp(name);
      expect(selected.definition.transport).toBe(transport);
      const result = await claudeCodeAdapter.prepareMcpEdit(sandbox.context, 'project', [selected]);
      expect(result.findings.length).toBe(0);
      expect(decoded(result.files[0]!.bytes).mcpServers[name].type).toBe(transport);
    }
    for (const name of ['typedHttp', 'legacyHttp', 'auto', 'conflicting', 'extras']) {
      const selected = await mcp(name);
      expect((await adapter.prepareMcpEdit(sandbox.context, 'user', [selected])).files.length).toBe(1);
      const cross = await claudeCodeAdapter.prepareMcpEdit(sandbox.context, 'project', [selected]);
      expect(cross.files.length).toBe(0);
      expect(cross.findings.some(finding => finding.code === 'UNSUPPORTED_MCP_CONVERSION')).toBe(true);
    }
  });

  it('blocks unsupported private destinations, private-user publication and same-name selected collisions', async () => {
    await putFile(join(sandbox.context.homeDir, '.gemini', 'settings.json'), '{"mcpServers":{"personal":{"command":"never"}}}');
    const selected = await mcp('personal');
    const privateResult = await adapter.prepareMcpEdit(sandbox.context, 'private-project', [selected]);
    expect(privateResult.findings.some(finding => finding.code === 'UNSUPPORTED_PRIVATE_MCP')).toBe(true);
    const publicResult = await adapter.prepareMcpEdit(sandbox.context, 'project', [selected]);
    expect(publicResult.findings.some(finding => finding.code === 'PRIVATE_RESOURCE_SCOPE')).toBe(true);
    const collision = await adapter.prepareMcpEdit(sandbox.context, 'user', [selected, selected]);
    expect(collision.files.length).toBe(0);
    expect(collision.findings.some(finding => finding.code === 'INVALID_MCP_KEY')).toBe(true);
  });

  it('does not copy native confirmation-bypass trust, but leaves identical trusted targets untouched', async () => {
    const path = join(sandbox.context.projectRoot, '.gemini', 'settings.json');
    const native = { command: 'never-run', trust: true };
    await putFile(path, JSON.stringify({ mcpServers: { selected: native } }));
    const selected = await mcp('selected');
    const before = await snapshotPath(sandbox.root);
    const addition = await adapter.prepareMcpEdit(sandbox.context, 'user', [selected]);
    expect(addition.files.length).toBe(0);
    expect(addition.findings.some(finding => finding.code === 'MCP_TRUST_ESCALATION')).toBe(true);
    const unchanged = await adapter.prepareMcpEdit(sandbox.context, 'project', [selected]);
    expect(unchanged.files.length).toBe(0);
    expect(unchanged.targets.length).toBe(1);
    expect(unchanged.findings.length).toBe(0);
    expect(snapshotsEqual(before, await snapshotPath(sandbox.root))).toBe(true);
  });

  it.each([
    '{"mcpServers": {"bad": {"command": "',
    JSON.stringify({ mcpServers: [] }),
    JSON.stringify({ mcpServers: { bad: { command: 'x', env: { TOKEN: 1 } } } }),
    JSON.stringify({ mcpServers: { bad: { command: 'x', args: [false] } } }),
    JSON.stringify({ mcpServers: { bad: { command: 'x', trust: 'not-a-boolean' } } }),
    JSON.stringify({ mcpServers: { bad: { type: 'unknown', url: 'https://example.invalid' } } }),
    JSON.stringify({ mcpServers: { bad: { httpUrl: 42 } } }),
    JSON.stringify({ mcpServers: { bad: { tcp: 'localhost:1234' } } }),
  ])('returns safe findings for malformed secret-bearing configs %#', async prefix => {
    const token = randomUUID();
    const path = join(sandbox.context.projectRoot, '.gemini', 'settings.json');
    await putFile(path, prefix.endsWith('"') ? prefix + token : `// ${token}\n${prefix}`);
    const before = await snapshotPath(sandbox.root);
    const result = await adapter.discover(sandbox.context);
    expect(result.detected).toBe(true);
    expect(result.resources.length).toBe(0);
    expect(result.findings.length > 0).toBe(true);
    expect(JSON.stringify(result.findings).includes(token)).toBe(false);
    expect(snapshotsEqual(before, await snapshotPath(sandbox.root))).toBe(true);
  });

  it('blocks malformed targets safely and never runs a command or skill script', async () => {
    const token = randomUUID();
    const sentinel = join(sandbox.root, 'executed');
    const launcher = join(sandbox.root, 'not-a-launcher');
    await putFile(launcher, `#!/bin/sh\ntouch '${sentinel}'\n`, 0o755);
    const skill = await putSkill(join(sandbox.context.projectRoot, '.gemini', 'skills'), 'script-guard');
    await putFile(join(skill, 'script.sh'), `#!/bin/sh\ntouch '${sentinel}'\n`, 0o755);
    await putFile(join(sandbox.context.projectRoot, '.gemini', 'settings.json'), JSON.stringify({ mcpServers: { selected: { command: launcher } } }));
    const selected = await mcp('selected');
    await putFile(join(sandbox.context.homeDir, '.gemini', 'settings.json'), `{"secret":"${token}","mcpServers":[]}`);
    const before = await snapshotPath(sandbox.root);
    const result = await adapter.prepareMcpEdit(sandbox.context, 'user', [selected]);
    expect(result.files.length).toBe(0);
    expect(result.findings.length > 0).toBe(true);
    expect(JSON.stringify(result.findings).includes(token)).toBe(false);
    expect((await snapshotPath(sentinel)).kind).toBe('missing');
    expect(snapshotsEqual(before, await snapshotPath(sandbox.root))).toBe(true);
  });
});
