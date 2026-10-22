import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context, Finding, McpDefinition, McpResource, Placement, SourceRef } from '../model.js';
import type { AdapterDiscovery, NativeAdapter, PreparedMcpEdit, PreparedMcpTarget } from './contract.js';
import { errorCode, filesystemFinding, fingerprintValue } from '../fs/snapshot.js';
import { editJsonDocument, isRecord, readJsonDocument } from '../resources/jsonc.js';
import { discoverSkills, resourceId, sourceRef } from '../resources/skills.js';

const id = 'gemini-cli';
const own = (value: Record<string, unknown>, key: string): boolean => Object.hasOwn(value, key);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
const stringMap = (value: unknown): value is Record<string, string> => isRecord(value) && Object.values(value).every(item => typeof item === 'string');
function problem(path: string, code: string): Finding { return filesystemFinding(path, code); }

function definition(value: unknown): McpDefinition | undefined {
  if (!isRecord(value)) return;
  if (own(value, 'type') && value.type !== 'http' && value.type !== 'sse') return;
  if (own(value, 'trust') && typeof value.trust !== 'boolean') return;
  if (own(value, 'args') && !strings(value.args) || own(value, 'env') && !stringMap(value.env)
    || own(value, 'headers') && !stringMap(value.headers) || own(value, 'cwd') && typeof value.cwd !== 'string') return;
  for (const key of ['command', 'url', 'httpUrl']) if (own(value, key) && (typeof value[key] !== 'string' || !value[key].trim())) return;
  const transport = typeof value.httpUrl === 'string' ? 'http' : typeof value.url === 'string' ? value.type === 'sse' ? 'sse' : 'http' : 'stdio';
  if (transport === 'stdio' && typeof value.command !== 'string') return;
  const supported = transport === 'stdio' ? ['command', 'args', 'env', 'cwd']
    : typeof value.httpUrl === 'string' ? ['httpUrl', 'headers'] : ['url', 'type', 'headers'];
  const unsupportedFields = Object.keys(value).filter(key => !supported.includes(key));
  // Current upstream auto-detects untyped `url`; the public guide still calls it SSE.
  // The common model cannot represent fallback, so it is native-only, never guessed on conversion.
  if (typeof value.url === 'string' && value.httpUrl === undefined && value.type === undefined) unsupportedFields.push('transport-auto-detection');
  return {
    transport, nativeAgent: id, native: value, unsupportedFields,
    ...(transport === 'stdio' ? {
      command: value.command as string,
      ...(strings(value.args) ? { args: value.args } : {}),
      ...(stringMap(value.env) ? { env: value.env } : {}),
      ...(typeof value.cwd === 'string' ? { cwd: value.cwd } : {}),
    } : {
      url: (value.httpUrl ?? value.url) as string,
      ...(stringMap(value.headers) ? { headers: value.headers } : {}),
    }),
  };
}
function serverMap(value: Record<string, unknown>, path: string, findings: Finding[]): Record<string, unknown> | undefined {
  if (!own(value, 'mcpServers')) return {};
  if (isRecord(value.mcpServers)) return value.mcpServers;
  findings.push(problem(path, 'INVALID_MCP_CONTAINER'));
}
async function exists(path: string, findings: Finding[]): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if (errorCode(error) !== 'ENOENT') findings.push(problem(path, 'UNREADABLE_SOURCE')); return false; }
}
function mcpSource(context: Context, placement: 'project' | 'user'): SourceRef {
  return sourceRef(id, join(placement === 'user' ? context.homeDir : context.projectRoot, '.gemini', 'settings.json'),
    placement, placement === 'user' ? 'private' : 'shared', `Gemini CLI ${placement} MCP`);
}
function converted(resource: McpResource): Record<string, unknown> | undefined {
  const value = resource.definition;
  if (value.nativeAgent === id) return definition(value.native) ? value.native : undefined;
  if (value.unsupportedFields.length) return;
  if (/\$(?!\{)[A-Za-z_]|%[A-Za-z_][A-Za-z_0-9]*%/.test(JSON.stringify(value.native))) return;
  if (value.nativeAgent !== 'claude-code' && /\$\{/.test(JSON.stringify(value.native))) return;
  const result: Record<string, unknown> = {};
  if (value.transport === 'stdio') {
    if (value.url !== undefined || value.headers !== undefined) return;
    result.command = value.command;
    if (value.args !== undefined) result.args = value.args;
    if (value.env !== undefined) result.env = value.env;
    if (value.cwd !== undefined) result.cwd = value.cwd;
  } else {
    if (value.cwd !== undefined || value.command !== undefined || value.args !== undefined || value.env !== undefined) return;
    if (value.transport === 'http') result.httpUrl = value.url;
    else { result.url = value.url; result.type = 'sse'; }
    if (value.headers !== undefined) result.headers = value.headers;
  }
  return definition(result) ? result : undefined;
}

export const geminiCliAdapter: NativeAdapter = {
  id, label: 'Gemini CLI',
  capabilities: { skills: ['project', 'user'], mcp: ['project', 'user'], links: true, transports: ['stdio', 'http', 'sse'] },
  skillDestination(context, placement) {
    if (placement === 'private-project') return { findings: [problem(context.projectRoot, 'UNSUPPORTED_PRIVATE_SKILLS')] };
    return { location: { path: join(placement === 'user' ? context.homeDir : context.projectRoot, '.gemini', 'skills'),
      scope: placement, visibility: placement === 'user' ? 'private' : 'shared' }, findings: [] };
  },
  async discover(context): Promise<AdapterDiscovery> {
    const resources: AdapterDiscovery['resources'][number][] = [];
    const sources: SourceRef[] = [];
    const checkedLocations: AdapterDiscovery['checkedLocations'][number][] = [];
    const findings: Finding[] = [];
    let detected = false;
    for (const scope of ['project', 'user'] as const) {
      const root = scope === 'project' ? context.projectRoot : context.homeDir;
      const evidence = join(root, '.gemini');
      const present = await exists(evidence, findings);
      checkedLocations.push({ agentId: id, path: evidence, kind: 'evidence', scope, exists: present });
      detected ||= present;
      for (const directory of ['.gemini', '.agents']) {
        const path = join(root, directory, 'skills');
        const found = await exists(path, findings);
        checkedLocations.push({ agentId: directory === '.agents' ? 'shared' : id, path, kind: 'skills', scope, exists: found });
        if (!found) continue;
        try {
          const source = sourceRef(directory === '.agents' ? 'shared' : id, await realpath(path), scope, scope === 'project' ? 'shared' : 'private',
            directory === '.agents' ? `Shared ${scope} skills` : `Gemini CLI ${scope} skills`);
          if (directory === '.agents') source.agents = [id];
          sources.push(source);
          const result = await discoverSkills(source);
          resources.push(...result.resources);
          findings.push(...result.findings);
        } catch { findings.push(problem(path, 'UNREADABLE_SOURCE')); }
      }
      const source = mcpSource(context, scope);
      const found = await exists(source.path, findings);
      checkedLocations.push({ agentId: id, path: source.path, kind: 'mcp', scope, exists: found });
      detected ||= found;
      if (!found) continue;
      try {
        const document = await readJsonDocument(source.path);
        findings.push(...document.findings);
        if (document.findings.length) continue;
        const servers = serverMap(document.value, source.path, findings);
        if (!servers) continue;
        const actualSource = sourceRef(id, document.snapshot.resolvedPath, source.scope, source.visibility, source.label);
        sources.push(actualSource);
        for (const [name, native] of Object.entries(servers)) {
          const parsed = definition(native);
          if (!parsed || !name.trim()) { findings.push(problem(source.path, 'INVALID_MCP_DEFINITION')); continue; }
          const locator = JSON.stringify(['mcpServers', name]);
          resources.push({ kind: 'mcp', id: resourceId(actualSource, locator), name, source: actualSource, path: actualSource.path, locator,
            snapshot: document.snapshot, definition: parsed });
        }
      } catch { findings.push(problem(source.path, 'UNREADABLE_SOURCE')); }
    }
    return { resources, sources, checkedLocations, detected, findings };
  },
  async prepareMcpEdit(context, placement, resources): Promise<PreparedMcpEdit> {
    if (!resources.length) return { files: [], targets: [], findings: [] };
    if (placement === 'private-project') return { files: [], targets: [], findings: [problem(context.projectRoot, 'UNSUPPORTED_PRIVATE_MCP')] };
    const source = mcpSource(context, placement);
    try {
      const document = await readJsonDocument(source.path);
      const findings = [...document.findings];
      const servers = serverMap(document.value, source.path, findings);
      if (!servers || findings.length) return { files: [], targets: [], findings };
      const changes: { path: string[]; value: unknown }[] = [];
      const targets: PreparedMcpTarget[] = [];
      const keys = new Set<string>();
      for (const resource of resources) {
        if (resource.source.visibility === 'private' && placement === 'project' || resource.source.visibility === 'private' && resource.source.scope === 'project') {
          findings.push(problem(source.path, 'PRIVATE_RESOURCE_SCOPE')); continue;
        }
        if (!resource.name.trim() || keys.has(resource.name)) { findings.push(problem(source.path, 'INVALID_MCP_KEY')); continue; }
        keys.add(resource.name);
        const native = converted(resource);
        if (!native) { findings.push(problem(source.path, 'UNSUPPORTED_MCP_CONVERSION')); continue; }
        const before = own(servers, resource.name) ? fingerprintValue(servers[resource.name]) : undefined;
        const after = fingerprintValue(native);
        if (native.trust === true && before !== after) {
          findings.push(problem(source.path, 'MCP_TRUST_ESCALATION')); continue;
        }
        const path = ['mcpServers', resource.name];
        targets.push({ resourceId: resource.id, key: resource.name,
          slotId: fingerprintValue([document.snapshot.resolvedPath, 'mcp', JSON.stringify(path)]), path: source.path,
          ...(before === undefined ? {} : { beforeFingerprint: before }), afterFingerprint: after });
        if (before !== after) changes.push({ path, value: native });
      }
      if (findings.length) return { files: [], targets: [], findings };
      return { files: changes.length ? [{ path: source.path, bytes: editJsonDocument(document.text, changes),
        mode: document.snapshot.kind === 'missing' ? 0o600 : document.snapshot.mode, expected: document.snapshot }] : [], targets, findings };
    } catch { return { files: [], targets: [], findings: [problem(source.path, 'UNREADABLE_SOURCE')] }; }
  },
};
