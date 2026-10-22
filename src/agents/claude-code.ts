import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context, Finding, McpDefinition, McpResource, Placement, SourceRef } from '../model.js';
import type { AdapterDiscovery, NativeAdapter, PreparedMcpEdit, PreparedMcpTarget } from './contract.js';
import { errorCode, filesystemFinding, fingerprintValue } from '../fs/snapshot.js';
import { editJsonDocument, isRecord, readJsonDocument } from '../resources/jsonc.js';
import { discoverSkills, resourceId, sourceRef } from '../resources/skills.js';

const id = 'claude-code';
const reservedMcpNames = new Set(['workspace', 'claude-in-chrome', 'computer-use', 'Claude Preview', 'Claude Browser']);
const own = (value: Record<string, unknown>, key: string): boolean => Object.hasOwn(value, key);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
const stringMap = (value: unknown): value is Record<string, string> => isRecord(value) && Object.values(value).every(item => typeof item === 'string');
function problem(path: string, code: string): Finding { return filesystemFinding(path, code); }
function reservedNameFinding(path: string): Finding {
  return { severity: 'error', code: 'RESERVED_MCP_NAME', path, message: 'Claude Code skips this reserved MCP server name.',
    remediation: 'Rename the source registration before synchronizing.' };
}

function definition(value: unknown): McpDefinition | undefined {
  if (!isRecord(value)) return;
  const type = value.type === undefined ? 'stdio' : value.type;
  const transport = type === 'streamable-http' ? 'http' : type;
  if (transport !== 'stdio' && transport !== 'http' && transport !== 'sse') return;
  if (transport === 'stdio' ? typeof value.command !== 'string' || !value.command.trim() : typeof value.url !== 'string' || !value.url.trim()) return;
  if (own(value, 'args') && !strings(value.args) || own(value, 'env') && !stringMap(value.env)
    || own(value, 'headers') && !stringMap(value.headers) || own(value, 'command') && typeof value.command !== 'string'
    || own(value, 'url') && typeof value.url !== 'string') return;
  const supported = transport === 'stdio' ? ['type', 'command', 'args', 'env'] : ['type', 'url', 'headers'];
  const unsupportedFields = Object.keys(value).filter(key => !supported.includes(key));
  if (transport === 'http') unsupportedFields.push('transport-auto-detection');
  if (/\$\{/.test(JSON.stringify(value))) unsupportedFields.push('environment-expansion');
  return {
    transport, nativeAgent: id, native: value,
    unsupportedFields,
    ...(transport === 'stdio' ? {
      command: value.command as string,
      ...(strings(value.args) ? { args: value.args } : {}),
      ...(stringMap(value.env) ? { env: value.env } : {}),
    } : {
      url: value.url as string,
      ...(stringMap(value.headers) ? { headers: value.headers } : {}),
    }),
  };
}

function serverMap(root: Record<string, unknown>, path: readonly string[], file: string, findings: Finding[]): Record<string, unknown> | undefined {
  let current: Record<string, unknown> = root;
  for (const key of path) {
    if (!own(current, key)) return {};
    const next = current[key];
    if (!isRecord(next)) { findings.push(problem(file, 'INVALID_MCP_CONTAINER')); return; }
    current = next;
  }
  return current;
}
async function exists(path: string, findings: Finding[]): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if (errorCode(error) !== 'ENOENT') findings.push(problem(path, 'UNREADABLE_SOURCE')); return false; }
}
function mcpSource(context: Context, placement: Placement): SourceRef {
  return sourceRef(id, placement === 'project' ? join(context.projectRoot, '.mcp.json') : join(context.homeDir, '.claude.json'),
    placement === 'user' ? 'user' : 'project', placement === 'project' ? 'shared' : 'private',
    placement === 'private-project' ? 'Claude Code local MCP' : `Claude Code ${placement} MCP`);
}
async function nativePath(context: Context, placement: Placement): Promise<string[]> {
  return placement === 'private-project' ? ['projects', await realpath(context.projectRoot), 'mcpServers'] : ['mcpServers'];
}
function converted(resource: McpResource): Record<string, unknown> | undefined {
  const value = resource.definition;
  if (value.nativeAgent === id) return definition(value.native) ? value.native : undefined;
  if (value.unsupportedFields.length || value.cwd !== undefined || value.transport === 'http') return;
  // Gemini also expands bare $VAR and Windows %VAR%; Claude does not. Never resolve them here.
  if (value.nativeAgent === 'gemini-cli' && /\$(?!\{)[A-Za-z_]|%[A-Za-z_][A-Za-z_0-9]*%/.test(JSON.stringify(value.native))) return;
  if (/\$\{/.test(JSON.stringify(value.native))) return;
  const result: Record<string, unknown> = { type: value.transport };
  if (value.transport === 'stdio') {
    if (value.url !== undefined || value.headers !== undefined) return;
    result.command = value.command;
    if (value.args !== undefined) result.args = value.args;
    if (value.env !== undefined) result.env = value.env;
  } else {
    if (value.command !== undefined || value.args !== undefined || value.env !== undefined) return;
    result.url = value.url;
    if (value.headers !== undefined) result.headers = value.headers;
  }
  return definition(result) ? result : undefined;
}

export const claudeCodeAdapter: NativeAdapter = {
  id, label: 'Claude Code',
  capabilities: { skills: ['project', 'user'], mcp: ['project', 'private-project', 'user'], links: true, transports: ['stdio', 'http', 'sse'] },
  skillDestination(context, placement) {
    if (placement === 'private-project') return { findings: [problem(context.projectRoot, 'UNSUPPORTED_PRIVATE_SKILLS')] };
    return { location: { path: join(placement === 'user' ? context.homeDir : context.projectRoot, '.claude', 'skills'),
      scope: placement === 'user' ? 'user' : 'project', visibility: placement === 'user' ? 'private' : 'shared' }, findings: [] };
  },
  async discover(context): Promise<AdapterDiscovery> {
    const resources: AdapterDiscovery['resources'][number][] = [];
    const sources: SourceRef[] = [];
    const checkedLocations: AdapterDiscovery['checkedLocations'][number][] = [];
    const findings: Finding[] = [];
    let detected = false;
    for (const scope of ['project', 'user'] as const) {
      const root = scope === 'project' ? context.projectRoot : context.homeDir;
      const evidence = join(root, '.claude');
      const present = await exists(evidence, findings);
      checkedLocations.push({ agentId: id, path: evidence, kind: 'evidence', scope, exists: present });
      detected ||= present;
      const path = join(evidence, 'skills');
      const found = await exists(path, findings);
      checkedLocations.push({ agentId: id, path, kind: 'skills', scope, exists: found });
      if (found) {
        try {
          const source = sourceRef(id, await realpath(path), scope, scope === 'project' ? 'shared' : 'private', `Claude Code ${scope} skills`);
          sources.push(source);
          const result = await discoverSkills(source);
          resources.push(...result.resources);
          findings.push(...result.findings);
        } catch { findings.push(problem(path, 'UNREADABLE_SOURCE')); }
      }
    }
    for (const placement of ['project', 'user', 'private-project'] as const) {
      const source = mcpSource(context, placement);
      const present = await exists(source.path, findings);
      checkedLocations.push({ agentId: id, path: source.path, kind: 'mcp', scope: source.scope, exists: present });
      detected ||= present;
      if (!present) continue;
      try {
        const document = await readJsonDocument(source.path);
        findings.push(...document.findings);
        if (document.findings.length) continue;
        const path = await nativePath(context, placement);
        const servers = serverMap(document.value, path, source.path, findings);
        if (!servers) continue;
        const actualSource = sourceRef(id, document.snapshot.resolvedPath, source.scope, source.visibility, source.label);
        sources.push(actualSource);
        for (const [name, native] of Object.entries(servers)) {
          if (reservedMcpNames.has(name)) { findings.push(reservedNameFinding(source.path)); continue; }
          const parsed = definition(native);
          if (!parsed || !/^[A-Za-z0-9_-]+$/.test(name)) { findings.push(problem(source.path, 'INVALID_MCP_DEFINITION')); continue; }
          const locator = JSON.stringify([...path, name]);
          resources.push({ kind: 'mcp', id: resourceId(actualSource, locator), name, source: actualSource, path: actualSource.path,
            locator, snapshot: document.snapshot, definition: parsed });
        }
      } catch { findings.push(problem(source.path, 'UNREADABLE_SOURCE')); }
    }
    return { resources, sources, checkedLocations, detected, findings };
  },
  async prepareMcpEdit(context, placement, resources): Promise<PreparedMcpEdit> {
    if (!resources.length) return { files: [], targets: [], findings: [] };
    const source = mcpSource(context, placement);
    try {
      const document = await readJsonDocument(source.path);
      const findings = [...document.findings];
      const path = await nativePath(context, placement);
      const servers = serverMap(document.value, path, source.path, findings);
      if (!servers || findings.length) return { files: [], targets: [], findings };
      const changes: { path: string[]; value: unknown }[] = [];
      const targets: PreparedMcpTarget[] = [];
      const keys = new Set<string>();
      for (const resource of resources) {
        if (reservedMcpNames.has(resource.name)) { findings.push(reservedNameFinding(source.path)); continue; }
        if (resource.source.visibility === 'private' && (placement === 'project' || resource.source.scope === 'project' && placement === 'user')) {
          findings.push(problem(source.path, 'PRIVATE_RESOURCE_SCOPE')); continue;
        }
        if (!/^[A-Za-z0-9_-]+$/.test(resource.name) || keys.has(resource.name)) {
          findings.push(problem(source.path, 'INVALID_MCP_KEY')); continue;
        }
        keys.add(resource.name);
        const native = converted(resource);
        if (!native) { findings.push(problem(source.path, 'UNSUPPORTED_MCP_CONVERSION')); continue; }
        const before = own(servers, resource.name) ? fingerprintValue(servers[resource.name]) : undefined;
        const after = fingerprintValue(native);
        const key = JSON.stringify([...path, resource.name]);
        targets.push({ resourceId: resource.id, key: resource.name,
          slotId: fingerprintValue([document.snapshot.resolvedPath, 'mcp', key]), path: source.path,
          ...(before === undefined ? {} : { beforeFingerprint: before }), afterFingerprint: after });
        if (before !== after) changes.push({ path: [...path, resource.name], value: native });
      }
      if (findings.length) return { files: [], targets: [], findings };
      return { files: changes.length ? [{ path: source.path, bytes: editJsonDocument(document.text, changes),
        mode: document.snapshot.kind === 'missing' ? 0o600 : document.snapshot.mode, expected: document.snapshot }] : [], targets, findings };
    } catch { return { files: [], targets: [], findings: [problem(source.path, 'UNREADABLE_SOURCE')] }; }
  },
};
