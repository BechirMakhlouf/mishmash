import { readFile, stat, symlink, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { afterEach, describe, expect, it } from 'vitest';
import { codexAdapter } from '../../src/agents/codex.js';
import { githubCopilotCliAdapter } from '../../src/agents/github-copilot-cli.js';
import { fingerprintValue, snapshotPath, snapshotsEqual } from '../../src/fs/snapshot.js';
import type { McpResource } from '../../src/model.js';
import { createSandbox, putFile, putSkill, type Sandbox } from '../helpers/sandbox.js';

const sandboxes: Sandbox[] = [];
async function sandbox(): Promise<Sandbox> { const result = await createSandbox(); sandboxes.push(result); return result; }
afterEach(async () => { await Promise.all(sandboxes.splice(0).map(value => value.cleanup())); });
function mcp(resources: readonly { kind: string }[]): asserts resources is readonly McpResource[] {
  expect(resources.every(resource => resource.kind === 'mcp')).toBe(true);
}
async function codexSource(box: Sandbox, text = '[mcp_servers.selected]\ncommand = "new-command"\nargs = ["--read-only"]\n'): Promise<McpResource> {
  await putFile(join(box.context.homeDir, '.codex', 'config.toml'), text);
  const discovered = await codexAdapter.discover(box.context);
  const resource = discovered.resources.find(resource => resource.kind === 'mcp');
  if (!resource || resource.kind !== 'mcp') throw new Error('Expected a real discovered server');
  return resource;
}

describe('Codex native adapter', () => {
  it('discovers documented skill roots, complete metadata and MCP provenance without writes', async () => {
    const box = await sandbox();
    const projectSkills = join(box.context.projectRoot, '.agents', 'skills');
    const userSkills = join(box.context.homeDir, '.agents', 'skills');
    const projectSkill = await putSkill(projectSkills, 'project-guide', 'Project development rules');
    await putFile(join(projectSkill, 'assets', 'helper.sh'), '#!/bin/sh\nexit 91\n', 0o755);
    const userSkill = await putSkill(userSkills, 'personal-guide', 'Personal development rules');
    await symlink(userSkill, join(userSkills, 'linked-guide'));
    await putFile(join(box.context.projectRoot, '.codex', 'config.toml'), '[mcp_servers.local]\ncommand = "/must/not/execute"\ncwd = "workspace"\nenv = { TOKEN = "fixture-value" }\n');
    await putFile(join(box.context.homeDir, '.codex', 'config.toml'), '[mcp_servers.remote]\nurl = "https://example.invalid/mcp"\nhttp_headers = { Accept = "application/json" }\nbearer_token_env_var = "MCP_TOKEN"\n');
    const before = await snapshotPath(box.root);
    const discovered = await codexAdapter.discover(box.context);
    expect(discovered.detected).toBe(true);
    expect(discovered.findings).toEqual([]);
    expect(discovered.resources.filter(resource => resource.kind === 'skill').map(resource => resource.name).sort()).toEqual(['personal-guide', 'personal-guide', 'project-guide']);
    const skill = discovered.resources.find(resource => resource.name === 'project-guide');
    expect(skill?.description).toBe('Project development rules');
    expect(skill?.source).toMatchObject({ agentId: 'shared', agents: ['codex'], scope: 'project', visibility: 'shared', path: projectSkills });
    expect(skill?.path).toBe(projectSkill);
    const remote = discovered.resources.find(resource => resource.kind === 'mcp' && resource.name === 'remote');
    expect(remote?.source).toMatchObject({ scope: 'user', visibility: 'private', path: join(box.context.homeDir, '.codex', 'config.toml') });
    if (!remote || remote.kind !== 'mcp') throw new Error('Expected remote server');
    expect(remote.locator).toBe(JSON.stringify(['mcp_servers', 'remote']));
    expect(remote.definition.transport).toBe('http');
    expect(remote.definition.unsupportedFields).toContain('bearer_token_env_var');
    expect(discovered.checkedLocations.filter(location => location.kind === 'skills').map(location => location.path)).toEqual([projectSkills, userSkills]);
    expect(snapshotsEqual(before, await snapshotPath(box.root))).toBe(true);
  });

  it('reports every absent native location and does not detect executables or legacy layouts', async () => {
    const box = await sandbox();
    await putSkill(join(box.context.projectRoot, '.codex', 'skills'), 'not-a-current-skill-root');
    const discovered = await codexAdapter.discover(box.context);
    expect(discovered.resources).toEqual([]);
    expect(discovered.checkedLocations.filter(location => location.kind === 'skills').every(location => !location.exists)).toBe(true);
    expect(discovered.checkedLocations.some(location => location.path === join(box.context.homeDir, '.codex', 'config.toml') && !location.exists)).toBe(true);
    const empty = await sandbox();
    expect((await codexAdapter.discover(empty.context)).detected).toBe(false);
  });

  it('advertises only actual destinations and blocks private publication', async () => {
    const box = await sandbox();
    expect(codexAdapter.capabilities).toEqual({ skills: ['project', 'user'], mcp: ['project', 'user'], links: true, transports: ['stdio', 'http'] });
    for (const placement of codexAdapter.capabilities.skills) {
      const result = codexAdapter.skillDestination(box.context, placement);
      expect(result.location).toMatchObject({ path: join(placement === 'user' ? box.context.homeDir : box.context.projectRoot, '.agents', 'skills'), scope: placement });
    }
    const source = await codexSource(box);
    for (const placement of codexAdapter.capabilities.mcp) {
      const result = await codexAdapter.prepareMcpEdit(box.context, placement, [source]);
      expect(result.findings).toEqual([]);
      expect(result.targets[0]?.path).toBe(join(placement === 'user' ? box.context.homeDir : box.context.projectRoot, '.codex', 'config.toml'));
    }
    expect(codexAdapter.skillDestination(box.context, 'private-project').findings.some(finding => finding.severity === 'error')).toBe(true);
    expect((await codexAdapter.prepareMcpEdit(box.context, 'private-project', [source])).files).toEqual([]);
    const privateSource = { ...source, source: { ...source.source, scope: 'project' as const, visibility: 'private' as const } };
    expect((await codexAdapter.prepareMcpEdit(box.context, 'user', [privateSource])).findings.some(finding => finding.code === 'PRIVATE_RESOURCE_PUBLICATION')).toBe(true);
  });

  it.each([
    ['tables and subtables', '# native header\nmodel = "model-choice" # retain\ncreated = 2026-10-22T07:00:00Z\nmessage = """line one\n[mcp_servers.fake]\nline three"""\n\n[mcp_servers.selected]\ncommand = "old" # selected note\n[mcp_servers.selected.env]\nOLD = "yes"\n\n# unchecked note\n[mcp_servers.unchecked]\ncommand = \'keep exact\'\nargs = [\n  "--untouched", # preserve array comment\n]\n\n[[profiles.dev.history]]\nname = "stay"\n'],
    ['dotted assignments', '# dotted syntax\nmodel = "stay"\nmcp_servers.selected.command = "old"\nmcp_servers.selected.env.OLD = "yes"\nmcp_servers.unchecked.command = \'keep exact\'\n'],
    ['inline selected entry', 'model = "stay"\nmcp_servers = { selected = { command = "old", env = { OLD = "yes" } }, unchecked = { command = \'keep exact\' } } # inline note\n'],
    ['inline dotted selected entry', 'model = "stay"\nmcp_servers = { selected.command = "old", unchecked = { command = \'keep exact\' }, selected.env.OLD = "yes" }\n'],
    ['parent table', 'model = "stay"\n[mcp_servers]\nselected = { command = "old" }\nunchecked.command = \'keep exact\'\n'],
  ])('edits only selected registrations with %s', async (_description, text) => {
    const box = await sandbox();
    const source = await codexSource(box, '[mcp_servers.selected]\ncommand = "new-command"\nargs = ["--read-only"]\nenv = { NEW = "yes" }\nstartup_timeout_sec = 15\nenabled_tools = ["read"]\n');
    const path = join(box.context.projectRoot, '.codex', 'config.toml');
    await putFile(path, text, 0o640);
    const before = await snapshotPath(box.root);
    const result = await codexAdapter.prepareMcpEdit(box.context, 'project', [source]);
    expect(result.findings).toEqual([]);
    expect(result.files).toHaveLength(1);
    const file = result.files[0]!;
    const edited = Buffer.from(file.bytes).toString();
    const parsed = parse(edited);
    const prior = parse(text);
    expect(fingerprintValue(parsed.mcp_servers)).not.toBe(fingerprintValue(prior.mcp_servers));
    const servers = parsed.mcp_servers as Record<string, unknown>;
    const oldServers = prior.mcp_servers as Record<string, unknown>;
    expect(fingerprintValue(servers.selected)).toBe(fingerprintValue(source.definition.native));
    expect(fingerprintValue(servers.unchecked)).toBe(fingerprintValue(oldServers.unchecked));
    expect(edited.includes("'keep exact'")).toBe(true);
    expect(edited.includes('model = "')).toBe(true);
    if (text.includes('# native header')) {
      expect(edited.includes('# native header\nmodel = "model-choice" # retain\ncreated = 2026-10-22T07:00:00Z\nmessage = """line one\n[mcp_servers.fake]\nline three"""')).toBe(true);
      expect(edited.includes('# unchecked note\n[mcp_servers.unchecked]\ncommand = \'keep exact\'\nargs = [\n  "--untouched", # preserve array comment\n]\n\n[[profiles.dev.history]]\nname = "stay"')).toBe(true);
      expect(edited.includes('# selected note')).toBe(true);
    }
    expect(file.mode).toBe(0o640);
    expect(file.expected.path).toBe(path);
    expect(result.targets[0]).toMatchObject({ resourceId: source.id, key: 'selected', path,
      slotId: fingerprintValue([file.expected.resolvedPath, 'mcp', JSON.stringify(['mcp_servers', 'selected'])]),
      beforeFingerprint: fingerprintValue(oldServers.selected), afterFingerprint: fingerprintValue(source.definition.native) });
    expect(snapshotsEqual(before, await snapshotPath(box.root))).toBe(true);
    expect(await readFile(path, 'utf8')).toBe(text);
  });

  it('coalesces additions, quoted keys, and updates without whole-document normalization', async () => {
    const box = await sandbox();
    await codexSource(box, '[mcp_servers."quoted.name"]\ncommand = "one"\n[mcp_servers.second]\nurl = "https://example.invalid/mcp"\n');
    const discovered = (await codexAdapter.discover(box.context)).resources;
    mcp(discovered);
    const path = join(box.context.projectRoot, '.codex', 'config.toml');
    const initial = '# no normalization\nmodel = \'keep\'\nmcp_servers = { untouched = { command = "keep" } }\n';
    await putFile(path, initial);
    const result = await codexAdapter.prepareMcpEdit(box.context, 'project', discovered);
    expect(result.findings).toEqual([]);
    expect(result.files).toHaveLength(1);
    expect(result.targets).toHaveLength(2);
    const text = Buffer.from(result.files[0]!.bytes).toString();
    expect(text.startsWith('# no normalization\nmodel = \'keep\'\n')).toBe(true);
    expect(Object.keys(parse(text).mcp_servers as object).sort()).toEqual(['quoted.name', 'second', 'untouched']);
  });

  it('returns ownership evidence but no file bytes for unchanged selected entries', async () => {
    const box = await sandbox();
    const source = await codexSource(box);
    const path = join(box.context.projectRoot, '.codex', 'config.toml');
    const text = '# hand formatted\n[mcp_servers.selected]\ncommand=\'new-command\'\nargs=["--read-only"] # keep\n[mcp_servers.unchecked]\ncommand="stay"\n';
    await putFile(path, text);
    const before = await stat(path);
    const result = await codexAdapter.prepareMcpEdit(box.context, 'project', [source]);
    expect(result.findings).toEqual([]);
    expect(result.files).toEqual([]);
    expect(result.targets).toHaveLength(1);
    expect(result.targets[0]?.beforeFingerprint).toBe(result.targets[0]?.afterFingerprint);
    expect(await readFile(path, 'utf8')).toBe(text);
    expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
  });

  it.each(['[mcp_servers.bad]\ncommand = "unterminated', '[mcp_servers.bad]\ncommand = 5\n', 'mcp_servers = []\n'])('keeps malformed credential-bearing diagnostics safe', async text => {
    const box = await sandbox();
    const marker = ['synthetic', 'credential', 'marker'].join('-');
    const path = join(box.context.projectRoot, '.codex', 'config.toml');
    await putFile(path, `# ${marker}\n${text}`);
    const source = await codexSource(box);
    const before = await snapshotPath(box.root);
    const discovered = await codexAdapter.discover(box.context);
    expect(discovered.findings.some(finding => finding.severity === 'error')).toBe(true);
    expect(JSON.stringify(discovered.findings).includes(marker)).toBe(false);
    const prepared = await codexAdapter.prepareMcpEdit(box.context, 'project', [source]);
    expect(prepared.files).toEqual([]);
    expect(prepared.findings.some(finding => finding.severity === 'error')).toBe(true);
    expect(JSON.stringify(prepared.findings).includes(marker)).toBe(false);
    expect(snapshotsEqual(before, await snapshotPath(box.root))).toBe(true);
  });

  it('converts supported literal definitions and blocks foreign semantics or legacy SSE', async () => {
    const box = await sandbox();
    await putFile(join(box.context.homeDir, '.copilot', 'mcp-config.json'), JSON.stringify({ mcpServers: {
      portable: { type: 'stdio', command: 'safe-command', args: ['--read-only'], env: { MODE: 'read' }, tools: ['*'] },
      filtered: { type: 'stdio', command: 'safe-command', tools: ['read'] },
      expanded: { type: 'stdio', command: 'safe-command', env: { TOKEN: '${MCP_TOKEN}' } },
      streaming: { type: 'sse', url: 'https://example.invalid/sse' },
      helper: { type: 'http', url: 'https://example.invalid/mcp', headers: { Accept: 'application/json' }, timeout: 10 },
    } }));
    const resources = (await githubCopilotCliAdapter.discover(box.context)).resources;
    mcp(resources);
    for (const resource of resources) {
      const result = await codexAdapter.prepareMcpEdit(box.context, 'project', [resource]);
      if (resource.name === 'portable') {
        expect(result.findings).toEqual([]);
        expect(result.files).toHaveLength(1);
        expect(result.files[0]?.mode).toBe(0o600);
      } else {
        expect(result.files).toEqual([]);
        expect(result.findings.some(finding => finding.code === 'UNSUPPORTED_MCP_CONVERSION')).toBe(true);
      }
    }
  });

  it('shares exact common-root identity and invalidates a retargeted source root', async () => {
    const box = await sandbox();
    const firstRoot = join(box.root, 'first-skills');
    const secondRoot = join(box.root, 'second-skills');
    await putSkill(firstRoot, 'same-name');
    await putSkill(secondRoot, 'same-name');
    await putFile(join(box.context.projectRoot, '.agents', '.keep'), '');
    const alias = join(box.context.projectRoot, '.agents', 'skills');
    await symlink(firstRoot, alias);
    const first = await codexAdapter.discover(box.context);
    const copilot = await githubCopilotCliAdapter.discover(box.context);
    expect(first.detected).toBe(false);
    expect(first.resources[0]?.source.path).toBe(firstRoot);
    expect(first.resources[0]?.source.agentId).toBe('shared');
    expect(first.resources[0]?.id).toBe(copilot.resources[0]?.id);
    expect(first.checkedLocations.some(location => location.path === alias && location.exists)).toBe(true);
    await unlink(alias);
    await symlink(secondRoot, alias);
    const second = await codexAdapter.discover(box.context);
    expect(second.resources[0]?.source.path).toBe(secondRoot);
    expect(second.resources[0]?.id).not.toBe(first.resources[0]?.id);
  });

  it.each(['default_tools_approval_mode = "auto"', '[mcp_servers.selected.tools.write]\napproval_mode = "approve"'])('blocks selected native approval propagation', async policy => {
    const box = await sandbox();
    const source = await codexSource(box, `[mcp_servers.selected]\ncommand = "safe-command"\n${policy}\n`);
    const before = await snapshotPath(box.root);
    const result = await codexAdapter.prepareMcpEdit(box.context, 'project', [source]);
    expect(result.files).toEqual([]);
    expect(result.findings.some(finding => finding.code === 'MCP_APPROVAL_PROPAGATION')).toBe(true);
    expect(snapshotsEqual(before, await snapshotPath(box.root))).toBe(true);
  });

  it('blocks unsafe config symlinks and duplicate selected keys without changing the tree', async () => {
    const box = await sandbox();
    const source = await codexSource(box);
    const path = join(box.context.projectRoot, '.codex', 'config.toml');
    await putFile(join(box.context.projectRoot, '.codex', 'target.toml'), 'model = "keep"\n');
    await symlink('target.toml', path);
    const before = await snapshotPath(box.root);
    expect((await codexAdapter.discover(box.context)).findings.some(finding => finding.severity === 'error')).toBe(true);
    expect((await codexAdapter.prepareMcpEdit(box.context, 'project', [source])).files).toEqual([]);
    expect((await codexAdapter.prepareMcpEdit(box.context, 'user', [source, source])).findings.some(finding => finding.code === 'DUPLICATE_MCP_TARGET')).toBe(true);
    expect(snapshotsEqual(before, await snapshotPath(box.root))).toBe(true);
  });
});
