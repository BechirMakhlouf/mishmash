import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context, Finding, McpDefinition, McpResource, Placement, SourceRef } from '../model.js';
import { errorCode, filesystemFinding, fingerprintValue } from '../fs/snapshot.js';
import { editJsonDocument, isRecord, readJsonDocument, type JsonDocument } from '../resources/jsonc.js';
import { discoverSkills, resourceId, sourceRef } from '../resources/skills.js';
import type { AdapterDiscovery, NativeAdapter, PreparedMcpEdit } from './contract.js';

const id = 'github-copilot-cli';
const label = 'GitHub Copilot CLI';
const commonFields = new Set(['type', 'command', 'args', 'env', 'url', 'headers']);
function problem(path: string, code: string): Finding { return filesystemFinding(path, code); }
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every(item => typeof item === 'string'); }
function stringMap(value: unknown): value is Record<string, string> { return isRecord(value) && Object.values(value).every(item => typeof item === 'string'); }
function hasSubstitution(value: unknown): boolean {
  if (typeof value === 'string') return /\$(?:[A-Za-z_][A-Za-z0-9_]*|\{)/.test(value);
  if (Array.isArray(value)) return value.some(hasSubstitution);
  return isRecord(value) && Object.values(value).some(hasSubstitution);
}
function definition(value: unknown): McpDefinition | undefined {
  if (!isRecord(value)) return undefined;
  const type = value.type ?? 'local';
  if (type !== 'local' && type !== 'stdio' && type !== 'http' && type !== 'streamable-http' && type !== 'sse') return undefined;
  const stdio = type === 'local' || type === 'stdio';
  if (stdio ? typeof value.command !== 'string' || !value.command.trim() : typeof value.url !== 'string' || !value.url.trim()) return undefined;
  if (value.args !== undefined && !strings(value.args) || value.env !== undefined && !stringMap(value.env)
    || value.headers !== undefined && !stringMap(value.headers) || value.tools !== undefined && !strings(value.tools)) return undefined;
  if (stdio && (value.url !== undefined || value.headers !== undefined)
    || !stdio && ['command', 'args', 'env'].some(key => value[key] !== undefined)) return undefined;
  const unsupportedFields = Object.keys(value).filter(key => !commonFields.has(key) && !(key === 'tools' && strings(value.tools) && value.tools.length === 1 && value.tools[0] === '*'));
  if (hasSubstitution(Object.fromEntries(Object.entries(value).filter(([key]) => commonFields.has(key) && key !== 'type')))) unsupportedFields.push('variable-substitution');
  return {
    transport: type === 'local' ? 'stdio' : type === 'streamable-http' ? 'http' : type, nativeAgent: id, native: value,
    ...(stdio ? { command: value.command as string } : { url: value.url as string }),
    ...(value.args === undefined ? {} : { args: value.args as string[] }),
    ...(value.env === undefined ? {} : { env: value.env as Record<string, string> }),
    ...(value.headers === undefined ? {} : { headers: value.headers as Record<string, string> }),
    unsupportedFields,
  };
}
async function exists(path: string, findings: Finding[]): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if (errorCode(error) !== 'ENOENT') findings.push(problem(path, 'UNREADABLE_SOURCE')); return false; }
}
function skillLocations(context: Context): SourceRef[] {
  return [
    ...['.github', '.claude', '.agents'].map((directory): SourceRef => ({ ...sourceRef(directory === '.claude' ? 'claude-code' : directory === '.agents' ? 'shared' : id, join(context.projectRoot, directory, 'skills'), 'project', 'shared', `${label} project skills (${directory})`), agents: directory === '.claude' ? ['claude-code', id] : [id] })),
    ...['.copilot', '.agents'].map((directory): SourceRef => ({ ...sourceRef(directory === '.agents' ? 'shared' : id, join(context.homeDir, directory, 'skills'), 'user', 'private', `${label} user skills (${directory})`), agents: [id] })),
  ];
}
function configLocations(context: Context): SourceRef[] {
  return [sourceRef(id, join(context.projectRoot, '.mcp.json'), 'project', 'shared', `${label} checkout MCP`),
    sourceRef(id, join(context.projectRoot, '.github', 'mcp.json'), 'project', 'shared', `${label} shared project MCP`),
    sourceRef(id, join(context.homeDir, '.copilot', 'mcp-config.json'), 'user', 'private', `${label} user MCP`)];
}
function unsupportedPlacement(): Finding {
  return { severity: 'error', code: 'UNSUPPORTED_PLACEMENT', message: 'GitHub Copilot CLI has no guaranteed private-project resource location.', remediation: 'Choose a supported scope without publishing private project resources.' };
}
// The bare project map is a current native format, not a legacy mishmash schema.
function serverMap(document: JsonDocument, scope: 'project' | 'user'): { servers: Record<string, unknown>; prefix: string[] } | undefined {
  if (Object.hasOwn(document.value, 'mcpServers')) return isRecord(document.value.mcpServers) ? { servers: document.value.mcpServers, prefix: ['mcpServers'] } : undefined;
  if (scope === 'project' && Object.keys(document.value).length) return { servers: document.value, prefix: [] };
  return { servers: {}, prefix: ['mcpServers'] };
}
async function discover(context: Context): Promise<AdapterDiscovery> {
  const resources: AdapterDiscovery['resources'][number][] = [];
  const sources: SourceRef[] = [];
  const findings: Finding[] = [];
  const checkedLocations: AdapterDiscovery['checkedLocations'][number][] = [];
  for (const configured of skillLocations(context)) {
    const present = await exists(configured.path, findings);
    checkedLocations.push({ agentId: id, path: configured.path, kind: 'skills', scope: configured.scope, exists: present });
    if (!present) continue;
    try {
      const source = { ...sourceRef(configured.agentId, await realpath(configured.path), configured.scope, configured.visibility, configured.label), agents: configured.agents };
      sources.push(source);
      const result = await discoverSkills(source);
      resources.push(...result.resources); findings.push(...result.findings);
    } catch { findings.push(problem(configured.path, 'UNREADABLE_SOURCE')); }
  }
  for (const configured of configLocations(context)) {
    const path = configured.path;
    const present = await exists(path, findings);
    checkedLocations.push({ agentId: id, path, kind: 'mcp', scope: configured.scope, exists: present });
    if (!present) continue;
    try {
      const source = sourceRef(configured.agentId, await realpath(path), configured.scope, configured.visibility, configured.label);
      sources.push(source);
      const document = await readJsonDocument(path);
      findings.push(...document.findings);
      if (document.findings.length) continue;
      const map = serverMap(document, source.scope);
      if (!map) { findings.push(problem(path, 'INVALID_MCP_REGISTRATIONS')); continue; }
      for (const [name, native] of Object.entries(map.servers)) {
        const parsed = definition(native);
        if (!name.trim() || !parsed) { findings.push(problem(path, 'INVALID_MCP_REGISTRATION')); continue; }
        const locator = JSON.stringify([...map.prefix, name]);
        resources.push({ kind: 'mcp', id: resourceId(source, locator), name, source, path: source.path, locator, snapshot: document.snapshot, definition: parsed });
      }
    } catch { findings.push(problem(path, 'UNREADABLE_SOURCE')); }
  }
  const path = join(context.homeDir, '.copilot');
  checkedLocations.push({ agentId: id, path, kind: 'evidence', scope: 'user', exists: await exists(path, findings) });
  return { resources, sources, findings, checkedLocations, detected: checkedLocations.some(location => location.exists
    && (location.path === path || location.path === join(context.projectRoot, '.github', 'skills') || location.path === join(context.projectRoot, '.github', 'mcp.json')
      || location.path === join(context.homeDir, '.copilot', 'skills') || location.path === join(context.homeDir, '.copilot', 'mcp-config.json'))) };
}
function nativeFor(resource: McpResource): Record<string, unknown> | undefined {
  const value = resource.definition;
  if (value.nativeAgent === id) return definition(value.native)?.transport === value.transport ? { ...value.native } : undefined;
  if (value.unsupportedFields.length || value.cwd !== undefined) return undefined;
  if (value.transport === 'stdio' && (value.url !== undefined || value.headers !== undefined)
    || value.transport !== 'stdio' && (value.command !== undefined || value.args !== undefined || value.env !== undefined)) return undefined;
  const native: Record<string, unknown> = value.transport === 'stdio' ? {
    type: 'stdio', command: value.command, ...(value.args === undefined ? {} : { args: value.args }), ...(value.env === undefined ? {} : { env: value.env }),
  } : { type: value.transport, url: value.url, ...(value.headers === undefined ? {} : { headers: value.headers }) };
  // Copilot performs interpolation: literal dollars from another client are not portable.
  if (hasSubstitution(native)) return undefined;
  return definition(native) ? native : undefined;
}
async function prepareMcpEdit(context: Context, placement: Placement, resources: readonly McpResource[]): Promise<PreparedMcpEdit> {
  if (placement === 'private-project') return { files: [], targets: [], findings: [unsupportedPlacement()] };
  if (!resources.length) return { files: [], targets: [], findings: [] };
  // Shared project placement is the documented checked-in configuration. Existing
  // .mcp.json sources retain their provenance; copying them does not grant trust.
  const path = placement === 'user' ? join(context.homeDir, '.copilot', 'mcp-config.json') : join(context.projectRoot, '.github', 'mcp.json');
  try {
    const document = await readJsonDocument(path);
    if (document.findings.length) return { files: [], targets: [], findings: document.findings };
    const map = serverMap(document, placement);
    if (!map) return { files: [], targets: [], findings: [problem(path, 'INVALID_MCP_REGISTRATIONS')] };
    if (Object.entries(map.servers).some(([name, value]) => !name.trim() || !definition(value))) {
      return { files: [], targets: [], findings: [problem(path, 'INVALID_MCP_REGISTRATION')] };
    }
    const findings: Finding[] = [];
    const targets: PreparedMcpEdit['targets'][number][] = [];
    const changes: { path: string[]; value: Record<string, unknown> }[] = [];
    const seen = new Set<string>();
    for (const resource of resources) {
      if (!resource.name.trim() || seen.has(resource.name)) { findings.push(problem(path, 'DUPLICATE_MCP_TARGET')); continue; }
      seen.add(resource.name);
      if (resource.source.scope === 'project' && resource.source.visibility === 'private') { findings.push(problem(path, 'PRIVATE_RESOURCE_PUBLICATION')); continue; }
      const native = nativeFor(resource);
      if (!native) { findings.push({ ...problem(path, 'UNSUPPORTED_MCP_CONVERSION'), resourceId: resource.id }); continue; }
      const nativePath = [...map.prefix, resource.name];
      const before = Object.hasOwn(map.servers, resource.name) ? map.servers[resource.name] : undefined;
      const afterFingerprint = fingerprintValue(native);
      targets.push({ resourceId: resource.id, key: resource.name, path,
        slotId: fingerprintValue([document.snapshot.resolvedPath, 'mcp', JSON.stringify(nativePath)]),
        ...(before === undefined ? {} : { beforeFingerprint: fingerprintValue(before) }), afterFingerprint });
      if (before !== undefined && fingerprintValue(before) === afterFingerprint) continue;
      changes.push({ path: nativePath, value: native });
    }
    if (findings.length) return { files: [], targets, findings };
    return { files: changes.length ? [{ path, bytes: editJsonDocument(document.text, changes), mode: document.snapshot.kind === 'missing' ? 0o600 : document.snapshot.mode, expected: document.snapshot }] : [], targets, findings };
  } catch { return { files: [], targets: [], findings: [problem(path, 'INVALID_NATIVE_CONFIG')] }; }
}

export const githubCopilotCliAdapter: NativeAdapter = {
  id, label, capabilities: { skills: ['project', 'user'], mcp: ['project', 'user'], links: true, transports: ['stdio', 'http', 'sse'] }, discover,
  skillDestination(context, placement) {
    if (placement === 'private-project') return { findings: [unsupportedPlacement()] };
    return { location: { path: placement === 'user' ? join(context.homeDir, '.copilot', 'skills') : join(context.projectRoot, '.github', 'skills'), scope: placement, visibility: placement === 'user' ? 'private' : 'shared' }, findings: [] };
  }, prepareMcpEdit,
};
