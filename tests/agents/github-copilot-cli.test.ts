import { readFile, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { codexAdapter } from '../../src/agents/codex.js';
import { githubCopilotCliAdapter } from '../../src/agents/github-copilot-cli.js';
import { fingerprintValue, snapshotPath, snapshotsEqual } from '../../src/fs/snapshot.js';
import { readJsonDocument } from '../../src/resources/jsonc.js';
import type { McpResource } from '../../src/model.js';
import { createSandbox, putFile, putSkill, type Sandbox } from '../helpers/sandbox.js';

const sandboxes: Sandbox[] = [];
async function sandbox(): Promise<Sandbox> { const result = await createSandbox(); sandboxes.push(result); return result; }
afterEach(async () => { await Promise.all(sandboxes.splice(0).map(value => value.cleanup())); });
async function copilotSource(box: Sandbox, native: Record<string, unknown> = { type: 'stdio', command: '/must/not/execute', args: ['--read-only'], tools: ['read'], timeout: 1500 }): Promise<McpResource> {
  await putFile(join(box.context.homeDir, '.copilot', 'mcp-config.json'), JSON.stringify({ mcpServers: { selected: native } }));
  const discovered = await githubCopilotCliAdapter.discover(box.context);
  const resource = discovered.resources.find(resource => resource.kind === 'mcp' && resource.name === 'selected');
  if (!resource || resource.kind !== 'mcp') throw new Error('Expected a real discovered MCP server');
  return resource;
}

describe('GitHub Copilot CLI native adapter', () => {
  it('discovers every documented skills root and all config sources with exact provenance read-only', async () => {
    const box = await sandbox();
    const roots = [join(box.context.projectRoot, '.github', 'skills'), join(box.context.projectRoot, '.claude', 'skills'), join(box.context.projectRoot, '.agents', 'skills'), join(box.context.homeDir, '.copilot', 'skills'), join(box.context.homeDir, '.agents', 'skills')];
    for (const [index, root] of roots.entries()) await putSkill(root, `guide-${index}`, `Description ${index}`);
    const actual = await putSkill(join(box.root, 'shared-assets'), 'linked-guide', 'Linked metadata');
    await symlink(actual, join(roots[0]!, 'linked-guide'));
    await putFile(join(actual, 'helper.sh'), '#!/bin/sh\nexit 92\n', 0o755);
    const projectPath = join(box.context.projectRoot, '.mcp.json');
    const sharedPath = join(box.context.projectRoot, '.github', 'mcp.json');
    const userPath = join(box.context.homeDir, '.copilot', 'mcp-config.json');
    await putFile(projectPath, JSON.stringify({ local: { command: '/must/not/execute', env: { TOKEN: 'fixture-value' } } }));
    await putFile(sharedPath, JSON.stringify({ mcpServers: { local: { type: 'local', command: '/must/not/execute', tools: ['read'], timeout: 2000 } } }));
    await putFile(userPath, JSON.stringify({ mcpServers: { remote: { type: 'sse', url: 'https://example.invalid/sse', headers: { Accept: 'text/event-stream' } } } }));
    const before = await snapshotPath(box.root);
    const discovered = await githubCopilotCliAdapter.discover(box.context);
    expect(discovered.detected).toBe(true);
    expect(discovered.findings).toEqual([]);
    expect(discovered.checkedLocations.filter(location => location.kind === 'skills').map(location => location.path)).toEqual(roots);
    expect(discovered.resources.filter(resource => resource.kind === 'skill')).toHaveLength(6);
    const linked = discovered.resources.find(resource => resource.kind === 'skill' && resource.name === 'linked-guide');
    expect(linked?.path).toBe(actual);
    expect(linked?.description).toBe('Linked metadata');
    expect(linked?.source).toMatchObject({ agentId: 'github-copilot-cli', path: roots[0], scope: 'project', visibility: 'shared' });
    const locals = discovered.resources.filter(resource => resource.kind === 'mcp' && resource.name === 'local');
    expect(locals).toHaveLength(2);
    expect(new Set(locals.map(resource => resource.id)).size).toBe(2);
    expect(locals.map(resource => resource.source.path)).toEqual([projectPath, sharedPath]);
    expect(locals.map(resource => resource.locator)).toEqual([JSON.stringify(['local']), JSON.stringify(['mcpServers', 'local'])]);
    const remote = discovered.resources.find(resource => resource.kind === 'mcp' && resource.name === 'remote');
    expect(remote?.source).toMatchObject({ path: userPath, scope: 'user', visibility: 'private' });
    if (!remote || remote.kind !== 'mcp') throw new Error('Expected remote registration');
    expect(remote.definition.transport).toBe('sse');
    expect(snapshotsEqual(before, await snapshotPath(box.root))).toBe(true);
  });

  it('does not mistake compatibility roots for native agent presence or read VS Code schema', async () => {
    const box = await sandbox();
    await putSkill(join(box.context.projectRoot, '.agents', 'skills'), 'shared-guide');
    await putSkill(join(box.context.projectRoot, '.claude', 'skills'), 'claude-guide');
    await putFile(join(box.context.projectRoot, '.vscode', 'mcp.json'), '{"servers":{"editor":{"command":"never"}}}');
    const discovered = await githubCopilotCliAdapter.discover(box.context);
    expect(discovered.resources).toHaveLength(2);
    expect(discovered.detected).toBe(false);
    expect(discovered.checkedLocations.filter(location => location.kind === 'mcp').every(location => !location.exists)).toBe(true);
    const empty = await sandbox();
    const result = await githubCopilotCliAdapter.discover(empty.context);
    expect(result.detected).toBe(false);
    expect(result.checkedLocations).toHaveLength(9);
    expect(result.checkedLocations.every(location => !location.exists)).toBe(true);
  });

  it('resolves every advertised placement and refuses private-project publication', async () => {
    const box = await sandbox();
    const source = await copilotSource(box);
    expect(githubCopilotCliAdapter.capabilities).toEqual({ skills: ['project', 'user'], mcp: ['project', 'user'], links: true, transports: ['stdio', 'http', 'sse'] });
    expect(githubCopilotCliAdapter.skillDestination(box.context, 'project').location).toMatchObject({ path: join(box.context.projectRoot, '.github', 'skills'), scope: 'project', visibility: 'shared' });
    expect(githubCopilotCliAdapter.skillDestination(box.context, 'user').location).toMatchObject({ path: join(box.context.homeDir, '.copilot', 'skills'), scope: 'user', visibility: 'private' });
    for (const placement of githubCopilotCliAdapter.capabilities.mcp) {
      const result = await githubCopilotCliAdapter.prepareMcpEdit(box.context, placement, [source]);
      expect(result.findings).toEqual([]);
      expect(result.targets[0]?.path).toBe(placement === 'user' ? join(box.context.homeDir, '.copilot', 'mcp-config.json') : join(box.context.projectRoot, '.github', 'mcp.json'));
    }
    expect(githubCopilotCliAdapter.skillDestination(box.context, 'private-project').findings.some(finding => finding.code === 'UNSUPPORTED_PLACEMENT')).toBe(true);
    expect((await githubCopilotCliAdapter.prepareMcpEdit(box.context, 'private-project', [source])).findings.some(finding => finding.code === 'UNSUPPORTED_PLACEMENT')).toBe(true);
    const privateSource = { ...source, source: { ...source.source, scope: 'project' as const, visibility: 'private' as const } };
    expect((await githubCopilotCliAdapter.prepareMcpEdit(box.context, 'user', [privateSource])).findings.some(finding => finding.code === 'PRIVATE_RESOURCE_PUBLICATION')).toBe(true);
  });

  it.each(['wrapped', 'bare'] as const)('targets the selected entry in %s native project documents', async format => {
    const box = await sandbox();
    const source = await copilotSource(box);
    const path = join(box.context.projectRoot, '.github', 'mcp.json');
    const text = format === 'wrapped'
      ? '{\n  // retain application settings\n  "theme": "native",\n  "mcpServers": {\n    "selected": {"type":"local", "command":"old", "env":{"OLD":"yes"}},\n    // unchecked comment\n    "unchecked": {"type":"http","url":"https://example.invalid/mcp","tools":["read"]}\n  }\n}\n'
      : '{\n  "selected": {"type":"local", "command":"old", "env":{"OLD":"yes"}},\n  // unchecked comment\n  "unchecked": {"type":"http","url":"https://example.invalid/mcp","tools":["read"]}\n}\n';
    await putFile(path, text, 0o640);
    const before = await snapshotPath(box.root);
    const result = await githubCopilotCliAdapter.prepareMcpEdit(box.context, 'project', [source]);
    expect(result.findings).toEqual([]);
    expect(result.files).toHaveLength(1);
    const file = result.files[0]!;
    const edited = Buffer.from(file.bytes).toString();
    expect(edited.includes('// unchecked comment\n    "unchecked": {"type":"http","url":"https://example.invalid/mcp","tools":["read"]}') || edited.includes('// unchecked comment\n  "unchecked": {"type":"http","url":"https://example.invalid/mcp","tools":["read"]}')).toBe(true);
    if (format === 'wrapped') expect(edited.includes('// retain application settings\n  "theme": "native",')).toBe(true);
    expect(snapshotsEqual(before, await snapshotPath(box.root))).toBe(true);
    // Materialize the returned intent in a separate file to inspect real JSONC semantics.
    const inspection = join(box.root, 'inspection.json');
    await putFile(inspection, file.bytes);
    const parsed = (await readJsonDocument(inspection)).value;
    const map = (format === 'wrapped' ? parsed.mcpServers : parsed) as Record<string, unknown>;
    expect(fingerprintValue(map.selected)).toBe(fingerprintValue(source.definition.native));
    expect(fingerprintValue(map.unchecked)).toBe(fingerprintValue({ type: 'http', url: 'https://example.invalid/mcp', tools: ['read'] }));
    expect(file.mode).toBe(0o640);
    const nativePath = format === 'wrapped' ? ['mcpServers', 'selected'] : ['selected'];
    expect(result.targets[0]).toMatchObject({ resourceId: source.id, path, key: 'selected',
      slotId: fingerprintValue([file.expected.resolvedPath, 'mcp', JSON.stringify(nativePath)]),
      beforeFingerprint: fingerprintValue({ type: 'local', command: 'old', env: { OLD: 'yes' } }),
      afterFingerprint: fingerprintValue(source.definition.native) });
    expect(await readFile(path, 'utf8')).toBe(text);
    expect(file.expected.digest).toBe((await snapshotPath(path)).digest);
  });

  it('returns unchanged ownership evidence without touching bytes or mtime', async () => {
    const box = await sandbox();
    const source = await copilotSource(box, { type: 'local', command: 'unchanged', tools: ['read'], timeout: 1000 });
    const path = join(box.context.projectRoot, '.github', 'mcp.json');
    const text = '{ /* native comment */ "mcpServers": { "selected": { "timeout":1000,"tools":["read"],"command":"unchanged","type":"local" }, "unchecked": {"command":"keep"} } }';
    await putFile(path, text);
    const before = await stat(path);
    const tree = await snapshotPath(box.root);
    const result = await githubCopilotCliAdapter.prepareMcpEdit(box.context, 'project', [source]);
    expect(result.findings).toEqual([]);
    expect(result.files).toEqual([]);
    expect(result.targets).toHaveLength(1);
    expect(result.targets[0]?.beforeFingerprint).toBe(result.targets[0]?.afterFingerprint);
    expect(await readFile(path, 'utf8')).toBe(text);
    expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
    expect(snapshotsEqual(tree, await snapshotPath(box.root))).toBe(true);
  });

  it('coalesces multiple selected additions in a single owner-only config intent', async () => {
    const box = await sandbox();
    await copilotSource(box);
    const path = join(box.context.homeDir, '.copilot', 'mcp-config.json');
    await putFile(path, JSON.stringify({ mcpServers: { one: { type: 'http', url: 'https://one.invalid/mcp' }, two: { type: 'sse', url: 'https://two.invalid/sse' } } }));
    const resources = (await githubCopilotCliAdapter.discover(box.context)).resources.filter((resource): resource is McpResource => resource.kind === 'mcp');
    const result = await githubCopilotCliAdapter.prepareMcpEdit(box.context, 'project', resources);
    expect(result.findings).toEqual([]);
    expect(result.files).toHaveLength(1);
    expect(result.targets).toHaveLength(2);
    expect(result.files[0]?.mode).toBe(0o600);
    const value = JSON.parse(Buffer.from(result.files[0]!.bytes).toString()) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(value.mcpServers)).toEqual(['one', 'two']);
    expect(result.targets.every(target => target.beforeFingerprint === undefined)).toBe(true);
  });

  it.each(['{"mcpServers": ["TOKEN"]}', '{"mcpServers":{"bad":{"type":"http","url":3,"headers":{"Authorization":"TOKEN"}}}}', '{"mcpServers":{"bad":{"command":"TOKEN"}'])('reports malformed credential-bearing configs without leaking content', async fixture => {
    const box = await sandbox();
    const source = await copilotSource(box);
    const marker = ['synthetic', 'credential', 'marker'].join('-');
    const text = fixture.replaceAll('TOKEN', marker);
    const path = join(box.context.projectRoot, '.github', 'mcp.json');
    await putFile(path, text);
    const before = await snapshotPath(box.root);
    const discovered = await githubCopilotCliAdapter.discover(box.context);
    expect(discovered.findings.some(finding => finding.severity === 'error')).toBe(true);
    expect(JSON.stringify(discovered.findings).includes(marker)).toBe(false);
    const result = await githubCopilotCliAdapter.prepareMcpEdit(box.context, 'project', [source]);
    expect(result.files).toEqual([]);
    expect(result.findings.some(finding => finding.severity === 'error')).toBe(true);
    expect(JSON.stringify(result.findings).includes(marker)).toBe(false);
    expect(snapshotsEqual(before, await snapshotPath(box.root))).toBe(true);
  });

  it('converts supported Codex semantics but blocks auth helpers, cwd, tools and interpolation changes', async () => {
    const box = await sandbox();
    await putFile(join(box.context.homeDir, '.codex', 'config.toml'), '[mcp_servers.portable]\ncommand = "portable"\nargs = ["--read-only"]\nenv = { MODE = "read" }\n[mcp_servers.remote]\nurl = "https://example.invalid/mcp"\nhttp_headers = { Accept = "application/json" }\n[mcp_servers.cwd]\ncommand = "portable"\ncwd = "/specific/location"\n[mcp_servers.auth]\nurl = "https://example.invalid/mcp"\nhttp_headers_helper = ["never-run-helper"]\n[mcp_servers.tools]\ncommand = "portable"\nenabled_tools = ["read"]\n[mcp_servers.literal]\ncommand = "portable"\nargs = ["${LITERAL}"]\n');
    const resources = (await codexAdapter.discover(box.context)).resources.filter((resource): resource is McpResource => resource.kind === 'mcp');
    expect(resources).toHaveLength(6);
    for (const resource of resources) {
      const result = await githubCopilotCliAdapter.prepareMcpEdit(box.context, 'project', [resource]);
      if (resource.name === 'portable' || resource.name === 'remote') {
        expect(result.findings).toEqual([]);
        expect(result.files).toHaveLength(1);
        const parsed = JSON.parse(Buffer.from(result.files[0]!.bytes).toString()) as { mcpServers: Record<string, { type: string; headers?: object }> };
        expect(parsed.mcpServers[resource.name]?.type).toBe(resource.definition.transport);
        if (resource.name === 'remote') expect(parsed.mcpServers.remote?.headers).toEqual({ Accept: 'application/json' });
      } else {
        expect(result.files).toEqual([]);
        expect(result.findings.some(finding => finding.code === 'UNSUPPORTED_MCP_CONVERSION')).toBe(true);
      }
    }
  });

  it('blocks unsafe config paths and duplicate selected slots', async () => {
    const box = await sandbox();
    const source = await copilotSource(box);
    const path = join(box.context.projectRoot, '.github', 'mcp.json');
    await putFile(join(box.context.projectRoot, '.github', 'real.json'), '{}');
    await symlink('real.json', path);
    const before = await snapshotPath(box.root);
    expect((await githubCopilotCliAdapter.prepareMcpEdit(box.context, 'project', [source])).files).toEqual([]);
    expect((await githubCopilotCliAdapter.discover(box.context)).findings.some(finding => finding.severity === 'error')).toBe(true);
    expect((await githubCopilotCliAdapter.prepareMcpEdit(box.context, 'user', [source, source])).findings.some(finding => finding.code === 'DUPLICATE_MCP_TARGET')).toBe(true);
    expect(snapshotsEqual(before, await snapshotPath(box.root))).toBe(true);
  });
});
