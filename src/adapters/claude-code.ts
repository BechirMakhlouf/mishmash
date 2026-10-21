import type { Adapter, AdapterLayout, Context, DecodeResult, Diagnostic, JsonObject, Server } from '../types.js';
import {
  absoluteOverride, decodeValues, defaultCwdWarning, diagnostic, encodeLiteralFields, encodeValues,
  finishDecode, finishEncode, literal, nativeArgs, nativeOverride, paths, projectDirectories, unsupportedNative, validateEncoding,
} from './a-helpers.js';

const id = 'claude-code';
const fields = ['type', 'command', 'args', 'env', 'url', 'headers'] as const;

function resolve(context: Context): AdapterLayout {
  const p = paths(context);
  const diagnostics: Diagnostic[] = [];
  const inputs: string[] = [];
  if (context.scope === 'project') {
    return {
      skillRoots: projectDirectories(context, ['.git'], inputs).map(directory => ({ path: p.join(directory, '.claude', 'skills'), kind: 'native', ignoredDirectories: ['synced', 'anthropic-skills'] })),
      skillDestination: p.join(context.project, '.claude', 'skills'), directSkills: false,
      mcpFiles: [{ path: p.join(context.project, '.mcp.json'), format: 'json', mapPath: ['mcpServers'], role: 'primary' }], diagnostics, inputs,
    };
  }
  const config = absoluteOverride(context, 'CLAUDE_CONFIG_DIR', diagnostics, id) ?? p.join(context.home, '.claude');
  const skillRoots: AdapterLayout['skillRoots'] = context.scope === 'user' ? [{ path: p.join(config, 'skills'), kind: 'native', ignoredDirectories: ['synced', 'anthropic-skills'] }] : [];
  const stateFile = context.claudeStateFile;
  if (stateFile && !p.isAbsolute(stateFile)) diagnostics.push(diagnostic(id, 'invalid-state-file', 'The explicit Claude state file must be an absolute native path.'));
  if (context.env.CLAUDE_CONFIG_DIR && !stateFile) {
    diagnostics.push(diagnostic(id, 'unknown-claude-state-file', 'CLAUDE_CONFIG_DIR relocates skills, but its mixed MCP state filename is not established; provide an explicit Claude state file.'));
  }
  const usable = !diagnostics.some(item => item.severity === 'error');
  if (context.platform === 'win32' && context.scope === 'project-private') {
    diagnostics.push(diagnostic(id, 'claude-project-key', 'The private map uses the injected normalized project identity; native Windows writer identity normalization requires local confirmation.', 'warning'));
  }
  return {
    skillRoots, ...(context.scope === 'user' ? { skillDestination: p.join(config, 'skills') } : {}), directSkills: false,
    mcpFiles: usable ? [{ path: stateFile ? p.normalize(stateFile) : p.join(context.home, '.claude.json'), format: 'json', private: true, role: 'primary', mapPath: context.scope === 'user' ? ['mcpServers'] : ['projects', p.resolve(context.project), 'mcpServers'] }] : [],
    diagnostics,
  };
}

function decode(entry: JsonObject, context: Context): DecodeResult {
  const diagnostics: Diagnostic[] = [];
  const override = nativeOverride(entry, fields);
  if ('cwd' in entry) diagnostics.push(diagnostic(id, 'unsupported-cwd', 'Claude has no established general stdio cwd field; the native option is retained without inventing portable semantics.'));
  if (entry.type === undefined || entry.type === 'stdio') {
    if (entry.url !== undefined || entry.headers !== undefined) diagnostics.push(diagnostic(id, 'mixed-native-transport', 'Claude requires an explicit remote type and cannot mix remote fields with stdio.'));
    const command = literal(entry.command, 'claude', id, diagnostics);
    const args = nativeArgs(entry.args, 'claude', id, diagnostics);
    const env = decodeValues(entry.env, 'claude', id, diagnostics);
    defaultCwdWarning(id, diagnostics);
    return finishDecode(id, { type: 'stdio', command, ...(args ? { args } : {}), ...(env ? { env } : {}) }, override, diagnostics);
  }
  if (entry.type === 'http' || entry.type === 'streamable-http' || entry.type === 'sse') {
    if (entry.command !== undefined || entry.args !== undefined || entry.env !== undefined) diagnostics.push(diagnostic(id, 'mixed-native-transport', 'Remote Claude servers cannot contain stdio transport fields.'));
    const url = literal(entry.url, 'claude', id, diagnostics);
    const headers = decodeValues(entry.headers, 'claude', id, diagnostics);
    return finishDecode(id, { type: entry.type === 'sse' ? 'sse' : 'streamable-http', url, ...(headers ? { headers } : {}) }, override, diagnostics);
  }
  diagnostics.push(diagnostic(id, 'unsupported-transport', 'This native Claude transport has no canonical representation; the original definition must remain native.'));
  return unsupportedNative(id, entry, diagnostics);
}

function encode(server: Server, override: JsonObject | undefined, context: Context) {
  const diagnostics: Diagnostic[] = [];
  validateEncoding(id, server, diagnostics);
  if (diagnostics.some(item => item.severity === 'error')) return { diagnostics };
  encodeLiteralFields(server, 'claude', id, diagnostics);
  let entry: JsonObject;
  if (server.type === 'stdio') {
    if (server.cwd || override?.cwd !== undefined) diagnostics.push(diagnostic(id, 'unsupported-cwd', 'Claude cannot faithfully encode an explicit stdio working directory.'));
    entry = { type: 'stdio', command: server.command, args: server.args ?? [] };
    const env = encodeValues(server.env, 'claude', id, diagnostics);
    if (env) entry.env = env;
  } else {
    entry = { type: server.type === 'sse' ? 'sse' : 'http', url: server.url };
    const headers = encodeValues(server.headers, 'claude', id, diagnostics);
    if (headers) entry.headers = headers;
  }
  return finishEncode(id, entry, override, [...fields, 'cwd'], diagnostics);
}

export const claudeCode: Adapter = { id, resolve, decode, encode };
