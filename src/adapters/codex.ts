import fs from 'node:fs';
import { parse as parseToml } from 'smol-toml';
import type { Adapter, AdapterLayout, Context, DecodeResult, Diagnostic, JsonObject, Server, Value } from '../types.js';
import {
  absoluteOverride, decodeCwd, defaultCwdWarning, diagnostic, encodeCwd, finishDecode, finishEncode,
  nativeOverride, object, own, paths, privateUnsupported, projectDirectories, samePath, unsupportedNative, validateEncoding,
} from './a-helpers.js';

const id = 'codex';
const fields = ['command', 'args', 'env', 'env_vars', 'cwd', 'url', 'http_headers', 'env_http_headers'] as const;

function projectMarkers(config: string, context: Context, diagnostics: Diagnostic[]): string[] {
  if (context.platform !== process.platform) return ['.git'];
  try {
    const value = parseToml(fs.readFileSync(config, 'utf8')).project_root_markers;
    if (value === undefined) return ['.git'];
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item || paths(context).isAbsolute(item) || item === '..' || /[\\/]/.test(item))) {
      diagnostics.push(diagnostic(id, 'invalid-root-markers', 'Codex project root markers must be a list of simple directory entry names.'));
      return [];
    }
    return value as string[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') diagnostics.push(diagnostic(id, 'invalid-native-config', 'Codex discovery configuration could not be read as TOML.'));
    return ['.git'];
  }
}

function resolve(context: Context): AdapterLayout {
  if (context.scope === 'project-private') return privateUnsupported(id);
  const p = paths(context);
  const diagnostics: Diagnostic[] = [];
  const inputs: string[] = [];
  let home = context.platform === 'win32' ? context.codexHome : context.env.HOME || context.home;
  if (!home || !p.isAbsolute(home)) {
    diagnostics.push(diagnostic(id, 'unknown-codex-home', 'Codex requires its Windows profile known-folder home; inject codexHome instead of substituting HOME, USERPROFILE, or AppData.'));
    home = undefined;
  }
  let configHome = absoluteOverride(context, 'CODEX_HOME', diagnostics, id) ?? (home ? p.join(home, '.codex') : undefined);
  if (context.env.CODEX_HOME && configHome && context.platform === process.platform) {
    try {
      if (!fs.statSync(configHome).isDirectory()) throw new Error('not a directory');
      configHome = fs.realpathSync(configHome);
    } catch {
      diagnostics.push(diagnostic(id, 'invalid-codex-home', 'CODEX_HOME must identify an existing directory; Codex will not create or use a missing override.'));
    }
  }
  if (context.scope === 'project') {
    const configFile = configHome ? p.join(configHome, 'config.toml') : undefined;
    if (configFile) inputs.push(configFile);
    const directories = projectDirectories(context, configFile ? projectMarkers(configFile, context, diagnostics) : ['.git'], inputs);
    diagnostics.push(diagnostic(id, 'native-project-trust', 'Codex project MCP layers require native trust; synchronization does not grant trust or enable disabled layers.', 'info'));
    return {
      skillRoots: directories.flatMap(directory => [
        { path: p.join(directory, '.agents', 'skills'), kind: 'canonical' as const, recursive: true, maxDepth: 6, maxEntries: 20000, maxDirectories: 2000 },
        { path: p.join(directory, '.codex', 'skills'), kind: 'native' as const, recursive: true, maxDepth: 6, maxEntries: 20000, maxDirectories: 2000 },
      ]),
      skillDestination: p.join(context.project, '.agents', 'skills'), directSkills: true,
      mcpFiles: directories.map((directory, index) => ({ path: p.join(directory, '.codex', 'config.toml'), format: 'toml', mapPath: ['mcp_servers'], role: index === 0 ? 'primary' : 'legacy' })), diagnostics, inputs,
    };
  }
  const shared = home ? p.join(home, '.agents', 'skills') : undefined;
  const canonical = p.join(context.canonicalRoot, 'skills');
  const directSkills = shared !== undefined && samePath(context, shared, canonical);
  if (shared && !directSkills) diagnostics.push(diagnostic(id, 'codex-shared-home-mismatch', 'Codex shared skill home differs from the canonical home; individual skills must be bridged to the verified native reader root.', 'warning'));
  return {
    skillRoots: [
      ...(shared ? [{ path: shared, kind: 'canonical' as const, recursive: true, maxDepth: 6, maxEntries: 20000, maxDirectories: 2000 }] : []),
      ...(configHome ? [{ path: p.join(configHome, 'skills'), kind: 'legacy' as const, recursive: true, maxDepth: 6, maxEntries: 20000, maxDirectories: 2000 }] : []),
    ],
    ...(shared ? { skillDestination: shared } : {}), directSkills,
    mcpFiles: configHome ? [{ path: p.join(configHome, 'config.toml'), format: 'toml', mapPath: ['mcp_servers'], role: 'primary' }] : [], diagnostics,
  };
}

function stringMap(value: unknown, diagnostics: Diagnostic[]): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!object(value) || Object.values(value).some(item => typeof item !== 'string')) {
    diagnostics.push(diagnostic(id, 'invalid-native-values', 'Codex native value maps must contain strings.'));
    return undefined;
  }
  return value as Record<string, string>;
}
function decode(entry: JsonObject, context: Context): DecodeResult {
  const diagnostics: Diagnostic[] = [];
  if (context.scope === 'project-private') return { diagnostics: privateUnsupported(id).diagnostics };
  let override = nativeOverride(entry, fields);
  if ('type' in entry || (entry.command !== undefined) === (entry.url !== undefined)) {
    diagnostics.push(diagnostic(id, 'invalid-native-transport', 'Codex requires exactly one command or URL and has no generic type discriminator or legacy SSE transport.'));
    return unsupportedNative(id, entry, diagnostics);
  }
  if (entry.environment_id !== undefined) diagnostics.push(diagnostic(id, 'unsupported-executor', 'Executor-backed Codex servers require environment-specific bindings and cannot be projected as local stdio.'));
  if (entry.bearer_token_env_var !== undefined) diagnostics.push(diagnostic(id, 'unsupported-bearer-reference', 'Codex bearer-token references add a Bearer prefix; canonical header references contain the full header value. Keep the native binding until explicitly mapped.'));
  if (entry.command !== undefined) {
    if (entry.http_headers !== undefined || entry.env_http_headers !== undefined || entry.bearer_token_env_var !== undefined) diagnostics.push(diagnostic(id, 'mixed-native-transport', 'Codex stdio servers cannot contain HTTP transport fields.'));
    const env: Record<string, Value> = { ...stringMap(entry.env, diagnostics) };
    if (entry.env_vars !== undefined) {
      if (!Array.isArray(entry.env_vars)) diagnostics.push(diagnostic(id, 'invalid-native-env', 'Codex forwarded environment variables must be an array.'));
      else for (const value of entry.env_vars) {
        const name = typeof value === 'string' ? value : object(value) && value.source === 'local' && Object.keys(value).every(key => key === 'name' || key === 'source') ? value.name : undefined;
        if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
          diagnostics.push(diagnostic(id, 'unsupported-environment-source', 'Codex environment forwarding requires a valid name and local source; remote executor references are not portable.'));
        } else if (Object.hasOwn(env, name)) diagnostics.push(diagnostic(id, 'native-env-conflict', 'Codex config defines both a literal and a forwarded value for one environment name.'));
        else own(env, name, { env: name });
      }
    }
    const cwd = decodeCwd(entry.cwd, context, id, diagnostics);
    if (entry.cwd !== undefined && !cwd) override = { ...override, cwd: entry.cwd };
    if (entry.cwd === undefined) defaultCwdWarning(id, diagnostics);
    return finishDecode(id, { type: 'stdio', command: entry.command, ...(entry.args !== undefined ? { args: entry.args } : {}), ...(Object.keys(env).length ? { env } : {}), ...(cwd ? { cwd } : {}) }, override, diagnostics);
  }
  if (entry.args !== undefined || entry.env !== undefined || entry.env_vars !== undefined || entry.cwd !== undefined) diagnostics.push(diagnostic(id, 'mixed-native-transport', 'Codex HTTP servers cannot contain stdio transport fields.'));
  const headers: Record<string, Value> = { ...stringMap(entry.http_headers, diagnostics) };
  for (const [name, variable] of Object.entries(stringMap(entry.env_http_headers, diagnostics) ?? {})) {
    if (Object.hasOwn(headers, name)) diagnostics.push(diagnostic(id, 'native-header-conflict', 'Codex config defines both a literal and an environment reference for one header.'));
    else own(headers, name, { env: variable });
  }
  return finishDecode(id, { type: 'streamable-http', url: entry.url, ...(Object.keys(headers).length ? { headers } : {}) }, override, diagnostics);
}

function encode(server: Server, override: JsonObject | undefined, context: Context) {
  const diagnostics: Diagnostic[] = [];
  if (context.scope === 'project-private') diagnostics.push(...privateUnsupported(id).diagnostics);
  validateEncoding(id, server, diagnostics);
  if (server.type === 'sse') diagnostics.push(diagnostic(id, 'unsupported-transport', 'Codex does not support canonical legacy SSE; it cannot be relabeled as Streamable HTTP.'));
  if (override?.environment_id !== undefined) diagnostics.push(diagnostic(id, 'unsupported-executor', 'A local canonical server cannot silently acquire a remote executor binding.'));
  if (diagnostics.some(item => item.severity === 'error')) return { diagnostics };
  let entry: JsonObject;
  if (server.type === 'stdio') {
    entry = { command: server.command, args: server.args ?? [] };
    const env: Record<string, string> = {};
    const envVars: string[] = [];
    for (const [name, value] of Object.entries(server.env ?? {})) {
      if (typeof value === 'string') own(env, name, value);
      else if (name === value.env) envVars.push(name);
      else diagnostics.push(diagnostic(id, 'unsupported-environment-rename', 'Codex can forward an environment variable only under its original name.'));
    }
    if (Object.keys(env).length) entry.env = env;
    if (envVars.length) entry.env_vars = envVars;
    if (server.cwd) entry.cwd = encodeCwd(server.cwd, context, id, diagnostics);
  } else {
    entry = { url: server.url };
    const literals: Record<string, string> = {};
    const references: Record<string, string> = {};
    for (const [name, value] of Object.entries(server.headers ?? {})) {
      if (typeof value === 'string') own(literals, name, value);
      else own(references, name, value.env);
    }
    if (Object.keys(literals).length) entry.http_headers = literals;
    if (Object.keys(references).length) entry.env_http_headers = references;
  }
  return finishEncode(id, entry, override, [...fields, 'type', 'bearer_token', 'bearer_token_env_var'], diagnostics);
}

export const codex: Adapter = { id, resolve, decode, encode };
