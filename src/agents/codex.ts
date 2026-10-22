import { lstat, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { parse, stringify } from 'smol-toml';
import { parseTOML, type AST } from 'toml-eslint-parser';
import type { Context, Finding, McpDefinition, McpResource, PathSnapshot, Placement, SourceRef } from '../model.js';
import { errorCode, filesystemFinding, fingerprintValue, snapshotMatches, snapshotPath } from '../fs/snapshot.js';
import { isRecord } from '../resources/jsonc.js';
import { discoverSkills, resourceId, sourceRef } from '../resources/skills.js';
import type { AdapterDiscovery, NativeAdapter, PreparedMcpEdit } from './contract.js';

const id = 'codex';
const label = 'Codex';
const commonFields = new Set(['command', 'args', 'env', 'cwd', 'url', 'http_headers']);
function problem(path: string, code: string): Finding { return filesystemFinding(path, code); }
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every(item => typeof item === 'string'); }
function stringMap(value: unknown): value is Record<string, string> { return isRecord(value) && Object.values(value).every(item => typeof item === 'string'); }
function jsonValue(value: unknown): boolean {
  if (typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value));
  if (Array.isArray(value)) return value.every(jsonValue);
  return isRecord(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) && Object.values(value).every(jsonValue);
}
function definition(value: unknown): McpDefinition | undefined {
  if (!isRecord(value) || !jsonValue(value)) return undefined;
  const stdio = typeof value.command === 'string' && value.command.trim().length > 0;
  const http = typeof value.url === 'string' && value.url.trim().length > 0;
  if (stdio === http || (value.command !== undefined && !stdio) || (value.url !== undefined && !http)) return undefined;
  if (value.args !== undefined && !strings(value.args) || value.env !== undefined && !stringMap(value.env)
    || value.cwd !== undefined && typeof value.cwd !== 'string' || value.http_headers !== undefined && !stringMap(value.http_headers)) return undefined;
  if (stdio && value.http_headers !== undefined || http && ['args', 'env', 'cwd'].some(key => value[key] !== undefined)) return undefined;
  return {
    transport: stdio ? 'stdio' : 'http', nativeAgent: id, native: value,
    ...(stdio ? { command: value.command as string } : { url: value.url as string }),
    ...(value.args === undefined ? {} : { args: value.args as string[] }),
    ...(value.env === undefined ? {} : { env: value.env as Record<string, string> }),
    ...(value.cwd === undefined ? {} : { cwd: value.cwd as string }),
    ...(value.http_headers === undefined ? {} : { headers: value.http_headers as Record<string, string> }),
    unsupportedFields: Object.keys(value).filter(key => !commonFields.has(key)),
  };
}
interface TomlDocument { text: string; value: Record<string, unknown>; ast: AST.TOMLProgram; snapshot: PathSnapshot }
async function readDocument(path: string): Promise<TomlDocument> {
  const snapshot = await snapshotPath(path);
  if (snapshot.kind !== 'file' && snapshot.kind !== 'missing') throw new Error('Unsafe configuration path');
  const text = snapshot.kind === 'missing' ? '' : await readFile(path, 'utf8');
  const ast = parseTOML(text, { tomlVersion: '1.0' });
  const value = parse(text, { integersAsBigInt: 'asNeeded' });
  if (!await snapshotMatches(snapshot)) throw new Error('Configuration changed');
  if (value.mcp_servers !== undefined && !isRecord(value.mcp_servers)) throw new Error('Invalid server map');
  return { text, value, ast, snapshot };
}
async function exists(path: string, findings: Finding[]): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if (errorCode(error) !== 'ENOENT') findings.push(problem(path, 'UNREADABLE_SOURCE')); return false; }
}
function skillLocations(context: Context): SourceRef[] {
  return [{ ...sourceRef('shared', join(context.projectRoot, '.agents', 'skills'), 'project', 'shared', `${label} project skills`), agents: [id] },
    { ...sourceRef('shared', join(context.homeDir, '.agents', 'skills'), 'user', 'private', `${label} user skills`), agents: [id] }];
}
function configPath(context: Context, placement: Placement): string {
  return join(placement === 'user' ? context.homeDir : context.projectRoot, '.codex', 'config.toml');
}
function unsupportedPlacement(): Finding {
  return { severity: 'error', code: 'UNSUPPORTED_PLACEMENT', message: 'Codex has no supported private-project resource location.', remediation: 'Choose a supported scope without publishing private project resources.' };
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
  for (const placement of ['project', 'user'] as const) {
    const path = configPath(context, placement);
    const present = await exists(path, findings);
    checkedLocations.push({ agentId: id, path, kind: 'mcp', scope: placement, exists: present });
    if (!present) continue;
    try {
      const source = sourceRef(id, await realpath(path), placement, placement === 'user' ? 'private' : 'shared', `${label} ${placement} MCP`);
      sources.push(source);
      const document = await readDocument(path);
      const servers = document.value.mcp_servers;
      if (!isRecord(servers)) continue;
      for (const [name, native] of Object.entries(servers)) {
        const parsed = definition(native);
        if (!name.trim() || !parsed) { findings.push(problem(path, 'INVALID_MCP_REGISTRATION')); continue; }
        const locator = JSON.stringify(['mcp_servers', name]);
        resources.push({ kind: 'mcp', id: resourceId(source, locator), name, source, path: source.path, locator, snapshot: document.snapshot, definition: parsed });
      }
    } catch { findings.push(problem(path, 'INVALID_NATIVE_CONFIG')); }
  }
  for (const [root, scope] of [[context.projectRoot, 'project'], [context.homeDir, 'user']] as const) {
    const path = join(root, '.codex');
    checkedLocations.push({ agentId: id, path, kind: 'evidence', scope, exists: await exists(path, findings) });
  }
  return { resources, sources, findings, checkedLocations, detected: checkedLocations.some(location => location.kind !== 'skills' && location.exists) };
}

interface TextEdit { start: number; end: number; text: string }
function keys(key: AST.TOMLKey): string[] { return key.keys.map(part => part.type === 'TOMLBare' ? part.name : part.value); }
function startsWith(path: readonly (string | number)[], prefix: readonly string[]): boolean {
  return prefix.every((part, index) => path[index] === part);
}
function inline(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(inline).join(', ')}]`;
  if (isRecord(value)) return `{ ${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)} = ${inline(item)}`).join(', ')} }`;
  return stringify({ value }).trim().slice('value = '.length);
}
// Inline ancestors can contain unchecked registrations. Only edit the selected value,
// including when its keys use quoted/dotted syntax, never reserialize the ancestor.
function editInline(node: AST.TOMLInlineTable, remaining: readonly string[], native: Record<string, unknown>): TextEdit[] {
  for (const entry of node.body) {
    const path = keys(entry.key);
    if (startsWith(remaining, path)) {
      if (path.length === remaining.length) return [{ start: entry.value.range[0], end: entry.value.range[1], text: inline(native) }];
      if (entry.value.type !== 'TOMLInlineTable') throw new Error('Invalid inline ancestor');
      return editInline(entry.value, remaining.slice(path.length), native);
    }
  }
  // Several dotted assignments can jointly define the selected table.
  const descendants = node.body.filter(entry => startsWith(keys(entry.key), remaining));
  if (descendants.length) {
    const replacement = `${remaining.map(key => JSON.stringify(key)).join('.')} = ${inline(native)}`;
    return descendants.map((entry, index) => {
      if (!index) return { start: entry.range[0], end: entry.range[1], text: replacement };
      const previous = node.body[node.body.indexOf(entry) - 1]!;
      return { start: previous.range[1], end: entry.range[1], text: '' };
    });
  }
  return [{ start: node.range[1] - 1, end: node.range[1] - 1, text: `${node.body.length ? ', ' : ''}${remaining.map(key => JSON.stringify(key)).join('.')} = ${inline(native)} ` }];
}
function editRegistration(document: TomlDocument, name: string, native: Record<string, unknown>): string {
  const target = ['mcp_servers', name];
  const edits: TextEdit[] = [];
  for (const entry of document.ast.body[0].body) {
    if (entry.type === 'TOMLKeyValue') {
      const path = keys(entry.key);
      if (startsWith(target, path) && path.length < target.length) {
        if (entry.value.type !== 'TOMLInlineTable') throw new Error('Invalid inline ancestor');
        edits.push(...editInline(entry.value, target.slice(path.length), native));
        return applyTextEdits(document.text, edits);
      }
    } else {
      for (const item of entry.body) {
        const path = [...entry.resolvedKey, ...keys(item.key)];
        if (startsWith(target, path as string[]) && path.length < target.length) {
          if (item.value.type !== 'TOMLInlineTable') throw new Error('Invalid inline ancestor');
          edits.push(...editInline(item.value, target.slice(path.length), native));
          return applyTextEdits(document.text, edits);
        }
      }
    }
  }
  for (const entry of document.ast.body[0].body) {
    if (entry.type === 'TOMLKeyValue') {
      if (startsWith(keys(entry.key), target)) edits.push({ start: entry.range[0], end: entry.range[1], text: '' });
      continue;
    }
    if (startsWith(entry.resolvedKey, target)) {
      // Header only: comments and whitespace outside selected expressions survive.
      const delimiter = entry.kind === 'array' ? ']]' : ']';
      const closing = document.text.indexOf(delimiter, entry.key.range[1]);
      if (closing < 0) throw new Error('Missing table delimiter');
      edits.push({ start: entry.range[0], end: closing + delimiter.length, text: '' });
    }
    for (const item of entry.body) {
      if (startsWith([...entry.resolvedKey, ...keys(item.key)], target)) edits.push({ start: item.range[0], end: item.range[1], text: '' });
    }
  }
  const result = applyTextEdits(document.text, edits);
  return `${result}${result && !result.endsWith('\n') ? '\n' : ''}\n[mcp_servers.${JSON.stringify(name)}]\n${Object.entries(native).map(([key, value]) => `${JSON.stringify(key)} = ${inline(value)}\n`).join('')}`;
}
function applyTextEdits(text: string, edits: readonly TextEdit[]): string {
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  return text;
}
function nativeFor(resource: McpResource): Record<string, unknown> | undefined {
  const value = resource.definition;
  if (value.nativeAgent === id) return definition(value.native)?.transport === value.transport ? { ...value.native } : undefined;
  if (value.unsupportedFields.length || value.transport === 'sse') return undefined;
  const native: Record<string, unknown> = value.transport === 'stdio' ? {
    command: value.command, ...(value.args === undefined ? {} : { args: value.args }), ...(value.env === undefined ? {} : { env: value.env }), ...(value.cwd === undefined ? {} : { cwd: value.cwd }),
  } : { url: value.url, ...(value.headers === undefined ? {} : { http_headers: value.headers }) };
  // Fields from a contradictory transport cannot silently disappear.
  if (value.transport === 'stdio' && (value.url !== undefined || value.headers !== undefined)
    || value.transport === 'http' && (value.command !== undefined || value.args !== undefined || value.env !== undefined || value.cwd !== undefined)) return undefined;
  return definition(native) ? native : undefined;
}
async function prepareMcpEdit(context: Context, placement: Placement, resources: readonly McpResource[]): Promise<PreparedMcpEdit> {
  if (placement === 'private-project') return { files: [], targets: [], findings: [unsupportedPlacement()] };
  if (!resources.length) return { files: [], targets: [], findings: [] };
  const path = configPath(context, placement);
  try {
    const original = await readDocument(path);
    if (isRecord(original.value.mcp_servers) && Object.entries(original.value.mcp_servers).some(([name, value]) => !name.trim() || !definition(value))) {
      return { files: [], targets: [], findings: [problem(path, 'INVALID_MCP_REGISTRATION')] };
    }
    let document = original;
    const targets: PreparedMcpEdit['targets'][number][] = [];
    const findings: Finding[] = [];
    const seen = new Set<string>();
    for (const resource of resources) {
      if (!resource.name.trim() || seen.has(resource.name)) { findings.push(problem(path, 'DUPLICATE_MCP_TARGET')); continue; }
      seen.add(resource.name);
      if (resource.source.scope === 'project' && resource.source.visibility === 'private') { findings.push(problem(path, 'PRIVATE_RESOURCE_PUBLICATION')); continue; }
      if (Object.hasOwn(resource.definition.native, 'default_tools_approval_mode') || isRecord(resource.definition.native.tools)
        && Object.values(resource.definition.native.tools).some(tool => isRecord(tool) && Object.hasOwn(tool, 'approval_mode'))) {
        findings.push({ ...problem(path, 'MCP_APPROVAL_PROPAGATION'), resourceId: resource.id }); continue;
      }
      const native = nativeFor(resource);
      if (!native) { findings.push({ ...problem(path, 'UNSUPPORTED_MCP_CONVERSION'), resourceId: resource.id }); continue; }
      const servers = original.value.mcp_servers;
      const before = isRecord(servers) && Object.hasOwn(servers, resource.name) ? servers[resource.name] : undefined;
      const afterFingerprint = fingerprintValue(native);
      targets.push({ resourceId: resource.id, key: resource.name, path,
        slotId: fingerprintValue([original.snapshot.resolvedPath, 'mcp', JSON.stringify(['mcp_servers', resource.name])]),
        ...(before === undefined ? {} : { beforeFingerprint: fingerprintValue(before) }), afterFingerprint });
      if (before !== undefined && fingerprintValue(before) === afterFingerprint) continue;
      const text = editRegistration(document, resource.name, native);
      const ast = parseTOML(text, { tomlVersion: '1.0' });
      const value = parse(text, { integersAsBigInt: 'asNeeded' });
      document = { ...document, text, ast, value };
    }
    if (findings.length) return { files: [], targets, findings };
    return { files: document.text === original.text ? [] : [{ path, bytes: Buffer.from(document.text), mode: original.snapshot.kind === 'missing' ? 0o600 : original.snapshot.mode, expected: original.snapshot }], targets, findings };
  } catch { return { files: [], targets: [], findings: [problem(path, 'INVALID_NATIVE_CONFIG')] }; }
}

export const codexAdapter: NativeAdapter = {
  id, label, capabilities: { skills: ['project', 'user'], mcp: ['project', 'user'], links: true, transports: ['stdio', 'http'] }, discover,
  skillDestination(context, placement) {
    if (placement === 'private-project') return { findings: [unsupportedPlacement()] };
    return { location: { path: join(placement === 'user' ? context.homeDir : context.projectRoot, '.agents', 'skills'), scope: placement, visibility: placement === 'user' ? 'private' : 'shared' }, findings: [] };
  }, prepareMcpEdit,
};
