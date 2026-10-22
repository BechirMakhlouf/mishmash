import { lstat, readdir, realpath } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import type { Context, Finding, McpDefinition, McpResource, Placement, SkillResource, SourceRef } from '../model.js';
import type { AdapterDiscovery, NativeAdapter, PreparedMcpEdit, PreparedMcpTarget } from './contract.js';
import { errorCode, filesystemFinding, fingerprintValue } from '../fs/snapshot.js';
import { editJsonDocument, isRecord, readJsonDocument } from '../resources/jsonc.js';
import { readSkillDirectory, resourceId, sourceRef } from '../resources/skills.js';

function issue(path: string, code: string, message: string, severity: Finding['severity'] = 'error'): Finding {
  return { severity, code, path, message, remediation: 'Review the native configuration and choose a supported source or destination.' };
}
function placementIssue(placement: Placement): Finding {
  return { severity: 'error', code: 'UNSUPPORTED_PLACEMENT', message: `Pi has no native ${placement} destination.`, remediation: 'Use project or user placement; keep private project resources in a private-project capable agent.' };
}
function configPath(context: Context, placement: 'project' | 'user'): string {
  return placement === 'project' ? join(context.projectRoot, '.pi', 'mcp.json') : join(context.homeDir, '.pi', 'agent', 'mcp.json');
}
function stringMap(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every(entry => typeof entry === 'string');
}
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every(entry => typeof entry === 'string'); }
function httpUrl(value: unknown): value is string {
  return typeof value === 'string' && URL.canParse(value) && ['http:', 'https:'].includes(new URL(value).protocol);
}
function exposure(value: unknown): boolean {
  return typeof value === 'string' && ['codemode', 'codemode-deferred', 'deferred', 'direct', 'hidden'].includes(value);
}
function validOAuth(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  for (const key of ['clientId', 'clientSecret', 'scope', 'clientName', 'callbackUrl', 'authServerMetadataUrl']) {
    if (value[key] !== undefined && typeof value[key] !== 'string') return false;
  }
  if (value.clientName !== undefined && !(value.clientName as string).trim()) return false;
  const port = value.callbackPort;
  if (port !== undefined && (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535)) return false;
  if (value.callbackUrl !== undefined) {
    if (!httpUrl(value.callbackUrl)) return false;
    const url = new URL(value.callbackUrl);
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.search || url.hash) return false;
    if (url.port && port !== undefined && Number(url.port) !== port) return false;
  }
  if (value.authServerMetadataUrl !== undefined) {
    if (!httpUrl(value.authServerMetadataUrl)) return false;
    const url = new URL(value.authServerMetadataUrl);
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return false;
  }
  if (value.clientRegistration !== undefined && !['dcr', 'cimd'].includes(String(value.clientRegistration))) return false;
  if (value.clientRegistration === 'cimd') {
    if (value.clientId !== undefined || value.clientName !== undefined) return false;
    if (typeof value.callbackUrl === 'string') {
      const url = new URL(value.callbackUrl);
      if (url.hostname === '[::1]' || url.pathname !== '/callback') return false;
    }
  }
  return true;
}
function definition(name: string, value: unknown): McpDefinition | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(name) || !isRecord(value)) return;
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') return;
  if (value.description !== undefined && typeof value.description !== 'string') return;
  if (value.timeout !== undefined && (typeof value.timeout !== 'number' || !Number.isFinite(value.timeout) || value.timeout <= 0)) return;
  if (value.exposure !== undefined && !exposure(value.exposure)) return;
  if (value.toolExposure !== undefined && (!isRecord(value.toolExposure) || !Object.values(value.toolExposure).every(exposure))) return;
  let portable: Omit<McpDefinition, 'nativeAgent' | 'native' | 'unsupportedFields'>;
  let known: readonly string[];
  if (httpUrl(value.url) && (value.type === undefined || value.type === 'http' || value.type === 'streamable-http')) {
    if (value.headers !== undefined && !stringMap(value.headers)) return;
    if (!validOAuth(value.oauth)) return;
    if (value.auth !== undefined) {
      if (!isRecord(value.auth) || typeof value.auth.provider !== 'string' || !value.auth.provider) return;
      const url = new URL(value.url);
      if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return;
    }
    portable = { transport: 'http', url: value.url, ...(stringMap(value.headers) ? { headers: value.headers } : {}) };
    known = ['type', 'url', 'headers'];
  } else if (typeof value.command === 'string' && value.command.trim() && (value.type === undefined || value.type === 'stdio')) {
    if (value.args !== undefined && !strings(value.args)) return;
    if (value.env !== undefined && !stringMap(value.env)) return;
    if (value.cwd !== undefined && typeof value.cwd !== 'string') return;
    portable = {
      transport: 'stdio', command: value.command,
      ...(strings(value.args) ? { args: value.args } : {}),
      ...(stringMap(value.env) ? { env: value.env } : {}),
      ...(typeof value.cwd === 'string' ? { cwd: value.cwd } : {}),
    };
    known = ['type', 'command', 'args', 'env', 'cwd'];
  } else return;
  const unsupportedFields = Object.keys(value).filter(key => !known.includes(key));
  // Pi evaluates these only at runtime. Never evaluate them here or export them as literals.
  for (const key of ['env', 'headers']) {
    const field = value[key];
    if (stringMap(field) && Object.values(field).some(entry => entry.startsWith('!') || entry.includes('${'))) unsupportedFields.push(key);
  }
  for (const key of ['command', 'cwd']) if (typeof value[key] === 'string' && value[key].startsWith('~/')) unsupportedFields.push(key);
  if (strings(value.args) && value.args.some(arg => arg.startsWith('~/'))) unsupportedFields.push('args');
  return { ...portable, nativeAgent: 'pi', native: value, unsupportedFields: [...new Set(unsupportedFields)] };
}
async function readConfig(path: string) {
  const document = await readJsonDocument(path);
  if (!document.findings.length && document.text) {
    try { JSON.parse(document.text.replace(/^\uFEFF/, '')); }
    catch { return { ...document, findings: [filesystemFinding(path, 'INVALID_NATIVE_CONFIG')] }; }
  }
  if (!document.findings.length && document.value.mcpServers !== undefined && !isRecord(document.value.mcpServers)) {
    return { ...document, findings: [filesystemFinding(path, 'INVALID_MCP_CONTAINER')] };
  }
  return document;
}
async function present(path: string, findings: Finding[]): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(errorCode(error))) findings.push(filesystemFinding(path)); return false; }
}

// Native Pi skills are recursive. Keep the shared parser/tree safety checks and provenance.
async function readRecursiveSkills(source: SourceRef): Promise<{ resources: SkillResource[]; findings: Finding[] }> {
  const resources: SkillResource[] = [];
  const findings: Finding[] = [];
  const visited = new Set<string>();
  async function visit(path: string): Promise<void> {
    try {
      const actual = await realpath(path);
      if (visited.has(actual)) return;
      visited.add(actual);
      const entries = await readdir(path, { withFileTypes: true });
      if (entries.some(entry => entry.name === 'SKILL.md')) {
        const result = await readSkillDirectory(path, source, relative(source.path, path) || '.');
        for (const resource of result.resources) {
          if (!resource.description) findings.push(issue(join(path, 'SKILL.md'), 'INVALID_SKILL_METADATA', 'Pi requires a nonempty skill description.'));
          else resources.push(resource);
        }
        findings.push(...result.findings);
        return;
      }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        if (entry.isDirectory() || entry.isSymbolicLink()) {
          const child = join(path, entry.name);
          await visit(child);
        } else if (path === source.path && entry.isFile() && entry.name.endsWith('.md')) {
          findings.push(issue(path, 'UNSUPPORTED_STANDALONE_SKILL', 'Pi standalone Markdown skills cannot be synchronized as whole skill directories.', 'warning'));
        }
      }
    } catch (error) {
      if (path === source.path || !['ENOENT', 'ENOTDIR'].includes(errorCode(error))) findings.push(filesystemFinding(path, 'INVALID_SKILL_SOURCE'));
    }
  }
  await visit(source.path);
  return { resources, findings };
}

export const piAdapter: NativeAdapter = {
  id: 'pi',
  label: 'Pi',
  capabilities: { skills: ['project', 'user'], mcp: ['project', 'user'], links: true, transports: ['stdio', 'http'] },
  skillDestination(context, placement) {
    if (placement === 'private-project') return { findings: [placementIssue(placement)] };
    return { location: { path: placement === 'project' ? join(context.projectRoot, '.pi', 'skills') : join(context.homeDir, '.pi', 'agent', 'skills'), scope: placement, visibility: placement === 'project' ? 'shared' : 'private' }, findings: [] };
  },
  async discover(context): Promise<AdapterDiscovery> {
    const resources: AdapterDiscovery['resources'][number][] = [];
    const sources: SourceRef[] = [];
    const findings: Finding[] = [];
    const checkedLocations: AdapterDiscovery['checkedLocations'][number][] = [];
    let detected = false;
    for (const [path, scope] of [[join(context.projectRoot, '.pi'), 'project'], [join(context.homeDir, '.pi', 'agent'), 'user']] as const) {
      const exists = await present(path, findings);
      checkedLocations.push({ agentId: 'pi', path, kind: 'evidence', scope, exists });
      detected ||= exists;
    }
    const roots: SourceRef[] = [
      sourceRef('pi', join(context.projectRoot, '.pi', 'skills'), 'project', 'shared', 'Pi project skills'),
      sourceRef('pi', join(context.homeDir, '.pi', 'agent', 'skills'), 'user', 'private', 'Pi user skills'),
      sourceRef('shared', join(context.projectRoot, '.agents', 'skills'), 'project', 'shared', 'Shared project skills'),
      sourceRef('shared', join(context.homeDir, '.agents', 'skills'), 'user', 'private', 'Shared user skills'),
    ];
    for (const scope of ['project', 'user'] as const) {
      const path = join(dirname(configPath(context, scope)), 'settings.json');
      try {
        const settings = await readJsonDocument(path);
        checkedLocations.push({ agentId: 'pi', path, kind: 'evidence', scope, exists: settings.snapshot.kind !== 'missing' });
        findings.push(...settings.findings);
        if (settings.value.skills !== undefined) {
          if (!strings(settings.value.skills)) findings.push(filesystemFinding(path, 'INVALID_SKILL_PATHS'));
          else for (const item of settings.value.skills) {
            if (!item.trim() || /^[!+-]|[*?\[\]{}]/.test(item)) {
              findings.push(issue(path, 'UNSUPPORTED_SKILL_PATH_PATTERN', 'Configured skill filters require native resolution; provide a concrete directory source.', 'warning'));
              continue;
            }
            const expanded = item.startsWith('~/') ? join(context.homeDir, item.slice(2)) : resolve(dirname(path), item);
            roots.push(sourceRef('pi', expanded, scope, scope === 'project' ? 'shared' : 'private', `Pi configured ${scope} skills`));
          }
        }
      } catch { findings.push(filesystemFinding(path)); }
    }
    for (const source of new Map(roots.map(root => [root.id, root])).values()) {
      const exists = await present(source.path, findings);
      checkedLocations.push({ agentId: 'pi', path: source.path, kind: 'skills', scope: source.scope, exists });
      if (!exists) continue;
      try {
        const canonical = sourceRef(source.agentId, await realpath(source.path), source.scope, source.visibility, source.label);
        const associated: SourceRef = canonical.agentId === 'shared' ? { ...canonical, agents: ['pi'] } : canonical;
        sources.push(associated);
        const result = await readRecursiveSkills(associated);
        resources.push(...result.resources);
        findings.push(...result.findings);
      } catch { findings.push(filesystemFinding(source.path)); }
    }
    for (const scope of ['project', 'user'] as const) {
      const path = configPath(context, scope);
      try {
        const document = await readConfig(path);
        const exists = document.snapshot.kind !== 'missing';
        checkedLocations.push({ agentId: 'pi', path, kind: 'mcp', scope, exists });
        detected ||= exists;
        findings.push(...document.findings);
        if (!exists || document.findings.length) continue;
        const source = sourceRef('pi', document.snapshot.resolvedPath, scope, scope === 'project' ? 'shared' : 'private', `Pi ${scope} MCP`);
        sources.push(source);
        const entries = isRecord(document.value.mcpServers) ? document.value.mcpServers : {};
        const namespaces = new Set<string>();
        for (const [name, native] of Object.entries(entries)) {
          if (scope === 'project' && isRecord(native) && native.command === undefined && native.url === undefined && native.type === undefined) {
            findings.push(issue(path, 'INHERITED_MCP_OVERRIDE', 'A Pi project MCP override depends on a user registration and is not a standalone synchronization source.', 'warning'));
            continue;
          }
          const parsed = definition(name, native);
          if (!parsed || (scope === 'project' && parsed.native.auth !== undefined)) {
            findings.push(filesystemFinding(path, 'INVALID_MCP_ENTRY'));
            continue;
          }
          const namespace = name.replace(/-/g, '_');
          if (namespaces.has(namespace)) { findings.push(filesystemFinding(path, 'MCP_NAMESPACE_COLLISION')); continue; }
          namespaces.add(namespace);
          const locator = JSON.stringify(['mcpServers', name]);
          resources.push({ kind: 'mcp', id: resourceId(source, locator), name, ...(typeof parsed.native.description === 'string' ? { description: parsed.native.description } : {}), path: document.snapshot.resolvedPath, source, locator, snapshot: document.snapshot, definition: parsed });
        }
      } catch { findings.push(filesystemFinding(path)); }
    }
    return { resources, sources, checkedLocations, detected, findings };
  },
  async prepareMcpEdit(context, placement, resources): Promise<PreparedMcpEdit> {
    if (placement === 'private-project') return { files: [], targets: [], findings: [placementIssue(placement)] };
    if (!resources.length) return { files: [], targets: [], findings: [] };
    const path = configPath(context, placement);
    try {
      const document = await readConfig(path);
      if (document.findings.length) return { files: [], targets: [], findings: document.findings };
      const entries = isRecord(document.value.mcpServers) ? document.value.mcpServers : {};
      const changes: { path: string[]; value: unknown }[] = [];
      const targets: PreparedMcpTarget[] = [];
      const findings: Finding[] = [];
      const selected = new Set<string>();
      for (const resource of resources) {
        if (resource.source.scope === 'project' && resource.source.visibility === 'private') {
          findings.push(issue(path, 'PRIVATE_SCOPE_VIOLATION', 'A private project registration cannot be published to this Pi destination.')); continue;
        }
        const name = resource.name;
        if (selected.has(name.replace(/-/g, '_')) || Object.keys(entries).some(key => key !== name && key.replace(/-/g, '_') === name.replace(/-/g, '_'))) {
          findings.push(issue(path, 'MCP_NAMESPACE_COLLISION', 'Selected registrations collide in the Pi tool namespace.')); continue;
        }
        selected.add(name.replace(/-/g, '_'));
        const value = resource.definition;
        if (Object.keys(value.native).some(key => /^(trust|trusted|approved|approval|authenticated|authorized)$/i.test(key))) {
          findings.push(issue(path, 'UNSUPPORTED_MCP_AUTHORIZATION', 'Selected native authorization state cannot be propagated.')); continue;
        }
        let native: Readonly<Record<string, unknown>>;
        if (value.nativeAgent === 'pi') native = value.native;
        else {
          if (value.unsupportedFields.length || value.transport === 'sse'
            || (value.transport === 'stdio' ? value.url !== undefined || value.headers !== undefined : value.command !== undefined || value.args !== undefined || value.env !== undefined || value.cwd !== undefined)) {
            findings.push(issue(path, 'UNSUPPORTED_MCP_TRANSLATION', 'This registration has native semantics that cannot be represented safely in Pi.')); continue;
          }
          const values = [value.command, value.url, value.cwd, ...(value.args ?? []), ...Object.values(value.env ?? {}), ...Object.values(value.headers ?? {})];
          if (values.some(item => item && /\$\{|\{(?:env|file):|^!|^~\//.test(item))) {
            findings.push(issue(path, 'UNSUPPORTED_MCP_TRANSLATION', 'Runtime substitutions need native review before conversion to Pi.')); continue;
          }
          native = value.transport === 'stdio'
            ? { command: value.command, ...(value.args === undefined ? {} : { args: value.args }), ...(value.env === undefined ? {} : { env: value.env }), ...(value.cwd === undefined ? {} : { cwd: value.cwd }) }
            : { url: value.url, ...(value.headers === undefined ? {} : { headers: value.headers }) };
        }
        if (!definition(name, native) || (placement === 'project' && native.auth !== undefined)) {
          findings.push(filesystemFinding(path, 'INVALID_MCP_ENTRY')); continue;
        }
        const nativePath = ['mcpServers', name];
        const before = Object.hasOwn(entries, name) ? fingerprintValue(entries[name]) : undefined;
        const after = fingerprintValue(native);
        targets.push({ resourceId: resource.id, key: name, path: document.snapshot.resolvedPath, slotId: fingerprintValue([document.snapshot.resolvedPath, 'mcp', JSON.stringify(nativePath)]), ...(before === undefined ? {} : { beforeFingerprint: before }), afterFingerprint: after });
        if (before !== after) changes.push({ path: nativePath, value: native });
      }
      if (findings.some(finding => finding.severity === 'error')) return { files: [], targets: [], findings };
      return {
        files: changes.length ? [{ path, bytes: editJsonDocument(document.text, changes), expected: document.snapshot, mode: document.snapshot.kind === 'missing' ? 0o600 : document.snapshot.mode }] : [],
        targets, findings,
      };
    } catch { return { files: [], targets: [], findings: [filesystemFinding(path)] }; }
  },
};
