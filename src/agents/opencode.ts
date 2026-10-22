import { lstat, readdir, realpath } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import type { Context, Finding, McpDefinition, McpResource, Placement, SkillResource, SourceRef } from '../model.js';
import type { AdapterDiscovery, NativeAdapter, PreparedMcpEdit, PreparedMcpTarget } from './contract.js';
import { errorCode, filesystemFinding, fingerprintValue } from '../fs/snapshot.js';
import { editJsonDocument, isRecord, readJsonDocument } from '../resources/jsonc.js';
import { readSkillDirectory, resourceId, sourceRef } from '../resources/skills.js';

type Schema = 'legacy' | 'current';
function issue(path: string, code: string, message: string, severity: Finding['severity'] = 'error'): Finding {
  return { severity, code, path, message, remediation: 'Review the native configuration and choose a supported source or destination.' };
}
function placementIssue(placement: Placement): Finding {
  return { severity: 'error', code: 'UNSUPPORTED_PLACEMENT', message: `OpenCode has no native ${placement} destination.`, remediation: 'Use project or user placement; keep private project resources in a private-project capable agent.' };
}
function configPaths(context: Context, placement: 'project' | 'user'): string[] {
  const directories = placement === 'project' ? [context.projectRoot, join(context.projectRoot, '.opencode')] : [join(context.configHome, 'opencode')];
  return directories.flatMap(directory => [join(directory, 'opencode.json'), join(directory, 'opencode.jsonc')]);
}
function stringMap(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every(entry => typeof entry === 'string');
}
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every(entry => typeof entry === 'string'); }
function httpUrl(value: unknown): value is string {
  // OpenCode expands env/file substitutions at runtime. Keep those opaque, never read them here.
  return typeof value === 'string' && (value.includes('{env:') || value.includes('{file:') || (URL.canParse(value) && ['http:', 'https:'].includes(new URL(value).protocol)));
}
function positiveInteger(value: unknown): boolean { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0; }
function validTimeout(value: unknown, schema: Schema): boolean {
  if (value === undefined) return true;
  if (positiveInteger(value)) return true; // Current normalizer also accepts the legacy shorthand.
  return schema === 'current' && isRecord(value) && Object.keys(value).every(key => ['startup', 'catalog', 'execution'].includes(key) && positiveInteger(value[key]));
}
function validOAuth(value: unknown, schema: Schema): boolean {
  if (value === undefined || value === false) return true;
  if (!isRecord(value)) return false;
  const keys = schema === 'legacy' ? ['clientId', 'clientSecret', 'scope', 'redirectUri'] : ['client_id', 'client_secret', 'scope', 'redirect_uri', 'auth_server_metadata_url'];
  for (const key of keys) if (value[key] !== undefined && typeof value[key] !== 'string') return false;
  const port = value[schema === 'legacy' ? 'callbackPort' : 'callback_port'];
  return port === undefined || (typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535);
}
function definition(value: unknown, schema: Schema): McpDefinition | undefined {
  if (!isRecord(value) || !validTimeout(value.timeout, schema)) return;
  for (const key of schema === 'legacy' ? ['enabled'] : ['disabled', 'codemode']) if (value[key] !== undefined && typeof value[key] !== 'boolean') return;
  if (schema === 'current' && value.protocol !== undefined && !['legacy', 'auto', '2026-07-28'].includes(String(value.protocol))) return;
  let portable: Omit<McpDefinition, 'nativeAgent' | 'native' | 'unsupportedFields'>;
  let known: readonly string[];
  if (value.type === 'local' && strings(value.command) && value.command.length > 0 && value.command[0]!.trim()) {
    if (value.environment !== undefined && !stringMap(value.environment)) return;
    if (value.cwd !== undefined && typeof value.cwd !== 'string') return;
    portable = { transport: 'stdio', command: value.command[0]!, args: value.command.slice(1), ...(stringMap(value.environment) ? { env: value.environment } : {}), ...(typeof value.cwd === 'string' ? { cwd: value.cwd } : {}) };
    known = ['type', 'command', 'environment', 'cwd'];
  } else if (value.type === 'remote' && httpUrl(value.url)) {
    if (value.headers !== undefined && !stringMap(value.headers)) return;
    if (!validOAuth(value.oauth, schema)) return;
    portable = { transport: 'http', url: value.url, ...(stringMap(value.headers) ? { headers: value.headers } : {}) };
    known = ['type', 'url', 'headers'];
  } else return;
  const unsupportedFields = Object.keys(value).filter(key => !known.includes(key));
  for (const key of known) {
    const field = value[key];
    const values = typeof field === 'string' ? [field] : strings(field) ? field : stringMap(field) ? Object.values(field) : [];
    if (values.some(item => /\{(?:env|file):/.test(item))) unsupportedFields.push(key);
  }
  return { ...portable, nativeAgent: 'opencode', native: value, unsupportedFields: [...new Set(unsupportedFields)] };
}
interface Registration { name: string; native: unknown; nativePath: string[]; schema: Schema }
function registrations(value: Record<string, unknown>): Registration[] {
  if (!isRecord(value.mcp)) return [];
  const result: Registration[] = [];
  for (const [name, native] of Object.entries(value.mcp)) {
    if (name === 'servers' && isRecord(native) && native.type !== 'local' && native.type !== 'remote') {
      for (const [key, entry] of Object.entries(native)) result.push({ name: key, native: entry, nativePath: ['mcp', 'servers', key], schema: 'current' });
    } else if (name !== 'timeout' || (isRecord(native) && (native.type === 'local' || native.type === 'remote'))) {
      result.push({ name, native, nativePath: ['mcp', name], schema: 'legacy' });
    }
  }
  return result;
}
function containerFindings(value: Record<string, unknown>, path: string): Finding[] {
  if (value.mcp !== undefined && !isRecord(value.mcp)) return [filesystemFinding(path, 'INVALID_MCP_CONTAINER')];
  if (!isRecord(value.mcp)) return [];
  const servers = value.mcp.servers;
  if (servers !== undefined && !isRecord(servers)) return [filesystemFinding(path, 'INVALID_MCP_CONTAINER')];
  const timeout = value.mcp.timeout;
  if (timeout !== undefined && !(isRecord(timeout) && (timeout.type === 'local' || timeout.type === 'remote')) && !validTimeout(timeout, 'current')) return [filesystemFinding(path, 'INVALID_MCP_CONTAINER')];
  return [];
}
function nativeSchema(resource: McpResource): Schema | undefined {
  try {
    const path: unknown = JSON.parse(resource.locator);
    if (!Array.isArray(path) || path[0] !== 'mcp' || path[path.length - 1] !== resource.name) return;
    if (path.length === 2) return 'legacy';
    if (path.length === 3 && path[1] === 'servers') return 'current';
  } catch { /* A locator is not a source of executable code or diagnostics. */ }
  return;
}
async function present(path: string, findings: Finding[]): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(errorCode(error))) findings.push(filesystemFinding(path)); return false; }
}
async function readSkills(source: SourceRef): Promise<{ resources: SkillResource[]; findings: Finding[] }> {
  const resources: SkillResource[] = [];
  const findings: Finding[] = [];
  const visited = new Set<string>();
  async function visit(path: string, depth: number): Promise<void> {
    try {
      const actual = await realpath(path);
      if (visited.has(actual)) return;
      visited.add(actual);
      const entries = await readdir(path, { withFileTypes: true });
      if (entries.some(entry => entry.name === 'SKILL.md')) {
        const result = await readSkillDirectory(path, source, relative(source.path, path) || '.');
        for (const resource of result.resources) {
          if (!resource.description || resource.description.length > 1024 || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(resource.name) || resource.name.length > 64 || resource.name !== path.split(/[\\/]/).pop()) {
            findings.push(issue(join(path, 'SKILL.md'), 'INVALID_SKILL_METADATA', 'OpenCode requires a matching valid skill name and a nonempty description.'));
          } else resources.push(resource);
        }
        findings.push(...result.findings);
        return;
      }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith('.') || ['node_modules', 'vendor'].includes(entry.name)) continue;
        if (depth < 6 && (entry.isDirectory() || entry.isSymbolicLink())) await visit(join(path, entry.name), depth + 1);
        else if (depth === 0 && entry.isFile() && entry.name.endsWith('.md')) findings.push(issue(path, 'UNSUPPORTED_STANDALONE_SKILL', 'Standalone Markdown skills cannot be synchronized as whole skill directories.', 'warning'));
      }
    } catch (error) {
      if (path === source.path || !['ENOENT', 'ENOTDIR'].includes(errorCode(error))) findings.push(filesystemFinding(path, 'INVALID_SKILL_SOURCE'));
    }
  }
  await visit(source.path, 0);
  return { resources, findings };
}

export const opencodeAdapter: NativeAdapter = {
  id: 'opencode',
  label: 'OpenCode',
  capabilities: { skills: ['project', 'user'], mcp: ['project', 'user'], links: true, transports: ['stdio', 'http'] },
  skillDestination(context, placement) {
    if (placement === 'private-project') return { findings: [placementIssue(placement)] };
    return { location: { path: placement === 'project' ? join(context.projectRoot, '.opencode', 'skills') : join(context.configHome, 'opencode', 'skills'), scope: placement, visibility: placement === 'project' ? 'shared' : 'private' }, findings: [] };
  },
  async discover(context): Promise<AdapterDiscovery> {
    const resources: AdapterDiscovery['resources'][number][] = [];
    const sources: SourceRef[] = [];
    const findings: Finding[] = [];
    const checkedLocations: AdapterDiscovery['checkedLocations'][number][] = [];
    let detected = false;
    for (const [path, scope] of [[join(context.projectRoot, '.opencode'), 'project'], [join(context.configHome, 'opencode'), 'user']] as const) {
      const exists = await present(path, findings);
      checkedLocations.push({ agentId: 'opencode', path, kind: 'evidence', scope, exists });
      detected ||= exists;
    }
    const roots: SourceRef[] = [];
    for (const scope of ['project', 'user'] as const) {
      const nativeRoot = scope === 'project' ? join(context.projectRoot, '.opencode') : join(context.configHome, 'opencode');
      for (const name of ['skills', 'skill']) roots.push(sourceRef('opencode', join(nativeRoot, name), scope, scope === 'project' ? 'shared' : 'private', `OpenCode ${scope} skills`));
      for (const name of ['.claude', '.agents']) {
        roots.push(sourceRef(name === '.agents' ? 'shared' : 'claude-code', join(scope === 'project' ? context.projectRoot : context.homeDir, name, 'skills'), scope, scope === 'project' ? 'shared' : 'private', `${name === '.agents' ? 'Shared' : 'Claude-compatible'} ${scope} skills`));
      }
      for (const path of configPaths(context, scope)) {
        try {
          const document = await readJsonDocument(path);
          const exists = document.snapshot.kind !== 'missing';
          checkedLocations.push({ agentId: 'opencode', path, kind: 'mcp', scope, exists });
          detected ||= exists;
          findings.push(...document.findings, ...containerFindings(document.value, path));
          if (!exists || document.findings.length) continue;
          const configured = document.value.skills;
          const paths = Array.isArray(configured) ? configured : isRecord(configured) ? configured.paths : undefined;
          if (paths !== undefined && !strings(paths)) findings.push(filesystemFinding(path, 'INVALID_SKILL_PATHS'));
          else if (strings(paths)) for (const item of paths) {
            if (!item || /^https?:\/\//.test(item) || /\{(?:env|file):/.test(item)) {
              findings.push(issue(path, 'UNSUPPORTED_SKILL_SOURCE', 'A configured skill source requires network access or runtime substitution and was not read.', 'warning')); continue;
            }
            const expanded = item.startsWith('~/') ? join(context.homeDir, item.slice(2)) : resolve(context.projectRoot, item);
            roots.push(sourceRef('opencode', expanded, scope, scope === 'project' ? 'shared' : 'private', `OpenCode configured ${scope} skills`));
          }
          if (isRecord(configured) && Array.isArray(configured.urls) && configured.urls.length) findings.push(issue(path, 'UNSUPPORTED_SKILL_SOURCE', 'Remote skill sources are not fetched during discovery.', 'warning'));
          if (containerFindings(document.value, path).length) continue;
          const source = sourceRef('opencode', document.snapshot.resolvedPath, scope, scope === 'project' ? 'shared' : 'private', `OpenCode ${scope} MCP`);
          sources.push(source);
          const entries = registrations(document.value);
          const names = new Set<string>();
          for (const entry of entries) {
            if (isRecord(entry.native) && entry.native.type === undefined && typeof entry.native.enabled === 'boolean' && Object.keys(entry.native).length === 1) {
              findings.push(issue(path, 'INHERITED_MCP_OVERRIDE', 'An enabled-only OpenCode override is not a standalone registration.', 'warning')); continue;
            }
            const parsed = definition(entry.native, entry.schema);
            if (!parsed || !entry.name.trim()) { findings.push(filesystemFinding(path, 'INVALID_MCP_ENTRY')); continue; }
            if (names.has(entry.name)) findings.push(issue(path, 'MCP_SCHEMA_COLLISION', 'A server is registered in both OpenCode MCP schemas. Choose a single native registration.'));
            names.add(entry.name);
            const locator = JSON.stringify(entry.nativePath);
            resources.push({ kind: 'mcp', id: resourceId(source, locator), name: entry.name, source, path: document.snapshot.resolvedPath, locator, snapshot: document.snapshot, definition: parsed });
          }
        } catch { findings.push(filesystemFinding(path)); }
      }
    }
    for (const source of new Map(roots.map(root => [root.id, root])).values()) {
      const exists = await present(source.path, findings);
      checkedLocations.push({ agentId: 'opencode', path: source.path, kind: 'skills', scope: source.scope, exists });
      if (!exists) continue;
      try {
        const canonical = sourceRef(source.agentId, await realpath(source.path), source.scope, source.visibility, source.label);
        const associated: SourceRef = canonical.agentId === 'opencode' ? canonical : { ...canonical, agents: canonical.agentId === 'shared' ? ['opencode'] : ['claude-code', 'opencode'] };
        sources.push(associated);
        const result = await readSkills(associated);
        resources.push(...result.resources);
        findings.push(...result.findings);
      } catch { findings.push(filesystemFinding(source.path)); }
    }
    return { resources, sources, checkedLocations, detected, findings };
  },
  async prepareMcpEdit(context, placement, resources): Promise<PreparedMcpEdit> {
    if (placement === 'private-project') return { files: [], targets: [], findings: [placementIssue(placement)] };
    if (!resources.length) return { files: [], targets: [], findings: [] };
    const candidates = configPaths(context, placement);
    let path = candidates[0]!;
    try {
      for (const candidate of candidates) if (await present(candidate, [])) path = candidate;
      const document = await readJsonDocument(path);
      const findings: Finding[] = [...document.findings, ...containerFindings(document.value, path)];
      if (findings.length) return { files: [], targets: [], findings };
      const entries = registrations(document.value);
      const mcp = isRecord(document.value.mcp) ? document.value.mcp : {};
      const hasCurrent = isRecord(mcp.servers) && mcp.servers.type !== 'local' && mcp.servers.type !== 'remote';
      const targets: PreparedMcpTarget[] = [];
      const changes: { path: string[]; value: unknown }[] = [];
      const selected = new Set<string>();
      for (const resource of resources) {
        if (resource.source.scope === 'project' && resource.source.visibility === 'private') {
          findings.push(issue(path, 'PRIVATE_SCOPE_VIOLATION', 'A private project registration cannot be published to this OpenCode destination.')); continue;
        }
        if (!resource.name.trim() || selected.has(resource.name)) { findings.push(issue(path, 'MCP_SCHEMA_COLLISION', 'Multiple selected resources target the same OpenCode registration.')); continue; }
        selected.add(resource.name);
        const existing = entries.filter(entry => entry.name === resource.name);
        if (existing.length > 1) { findings.push(issue(path, 'MCP_SCHEMA_COLLISION', 'The destination registers this server in both OpenCode MCP schemas.')); continue; }
        const value = resource.definition;
        if (Object.keys(value.native).some(key => /^(trust|trusted|approved|approval|authenticated|authorized)$/i.test(key))) {
          findings.push(issue(path, 'UNSUPPORTED_MCP_AUTHORIZATION', 'Selected native authorization state cannot be propagated.')); continue;
        }
        let schema: Schema = existing[0]?.schema ?? (hasCurrent ? 'current' : 'legacy');
        let native: Readonly<Record<string, unknown>>;
        if (value.nativeAgent === 'opencode') {
          const original = nativeSchema(resource);
          if (!original || (existing[0] && original !== schema)) {
            findings.push(issue(path, 'UNSUPPORTED_MCP_TRANSLATION', 'Different OpenCode MCP schemas require explicit native migration.')); continue;
          }
          schema = original;
          native = value.native;
        } else {
          if (value.unsupportedFields.length || value.transport === 'sse'
            || (value.transport === 'stdio' ? value.url !== undefined || value.headers !== undefined : value.command !== undefined || value.args !== undefined || value.env !== undefined || value.cwd !== undefined)) {
            findings.push(issue(path, 'UNSUPPORTED_MCP_TRANSLATION', 'This registration has native semantics that cannot be represented safely in OpenCode.')); continue;
          }
          const values = [value.command, value.url, value.cwd, ...(value.args ?? []), ...Object.values(value.env ?? {}), ...Object.values(value.headers ?? {})];
          if (values.some(item => item && /\$\{|\{(?:env|file):|^!|^~\//.test(item))) {
            findings.push(issue(path, 'UNSUPPORTED_MCP_TRANSLATION', 'Runtime substitutions need native review before conversion to OpenCode.')); continue;
          }
          native = value.transport === 'stdio'
            ? { type: 'local', command: [value.command, ...(value.args ?? [])], ...(value.env === undefined ? {} : { environment: value.env }), ...(value.cwd === undefined ? {} : { cwd: value.cwd }) }
            : { type: 'remote', url: value.url, ...(value.headers === undefined ? {} : { headers: value.headers }) };
        }
        if ((schema === 'legacy' && ['servers', 'timeout'].includes(resource.name) && Object.hasOwn(mcp, resource.name) && !existing.length)
          || (schema === 'current' && Object.hasOwn(mcp, 'servers') && !hasCurrent)) {
          findings.push(issue(path, 'MCP_SCHEMA_COLLISION', 'This registration conflicts with an existing OpenCode MCP namespace.')); continue;
        }
        if (!definition(native, schema)) { findings.push(filesystemFinding(path, 'INVALID_MCP_ENTRY')); continue; }
        const nativePath = schema === 'current' ? ['mcp', 'servers', resource.name] : ['mcp', resource.name];
        const before = existing[0] ? fingerprintValue(existing[0].native) : undefined;
        const after = fingerprintValue(native);
        targets.push({ resourceId: resource.id, key: resource.name, path: document.snapshot.resolvedPath, slotId: fingerprintValue([document.snapshot.resolvedPath, 'mcp', JSON.stringify(nativePath)]), ...(before === undefined ? {} : { beforeFingerprint: before }), afterFingerprint: after });
        if (before !== after) changes.push({ path: nativePath, value: native });
      }
      if (findings.some(finding => finding.severity === 'error')) return { files: [], targets: [], findings };
      return { files: changes.length ? [{ path, bytes: editJsonDocument(document.text, changes), mode: document.snapshot.kind === 'missing' ? 0o600 : document.snapshot.mode, expected: document.snapshot }] : [], targets, findings };
    } catch { return { files: [], targets: [], findings: [filesystemFinding(path)] }; }
  },
};
