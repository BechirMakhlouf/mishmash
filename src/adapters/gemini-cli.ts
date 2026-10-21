import type { Adapter, AdapterLayout, Context, DecodeResult, Diagnostic, JsonObject, Server } from '../types.js';
import { absoluteRoot, argumentsList, decodeCwd, decodeValues, diagnostic, encodeCwd, encodeSafety, encodeValues, finishDecode, hasErrors, mergeOverride, nativeOverride, paths, plainString, readConfig, samePath, unsupportedPrivate } from './b-helpers.js';

// Gemini v0.64.0 drops these explicit MCP environment overrides before spawning.
const blockedExecutionEnvironment = new Set([
  'NODE_OPTIONS', 'NODE_CLI_FLAGS', '_FORCE_NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE',
  'PYTHONPATH', 'PYTHONSTARTUP', 'RUBYOPT', 'RUBYLIB', 'PERL5OPT', 'PERL5LIB',
  'LD_PRELOAD', 'LD_AUDIT', 'LD_DEBUG', 'LD_PROFILE', 'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES', 'DYLD_FORCE_FLAT_NAMESPACE', 'DYLD_LIBRARY_PATH', 'DYLD_FRAMEWORK_PATH',
  'DYLD_FALLBACK_LIBRARY_PATH', 'DYLD_FALLBACK_FRAMEWORK_PATH', 'BASH_ENV', 'ENV', 'PERL5DB',
  'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'CLASSPATH', 'DOTNET_STARTUP_HOOKS', 'CORECLR_PROFILER_PATH', 'CORECLR_ENABLE_PROFILING',
]);
function checkEnvironment(value: unknown, diagnostics: Diagnostic[]): void {
  if (value && typeof value === 'object' && Object.keys(value).some(key => blockedExecutionEnvironment.has(key.toUpperCase()))) {
    diagnostics.push(diagnostic('gemini-cli', 'blocked-native-environment', 'Gemini ignores an explicitly configured execution environment variable; this intent cannot be projected faithfully.'));
  }
}

function resolve(context: Context): AdapterLayout {
  if (context.scope === 'project-private') return unsupportedPrivate('gemini-cli');
  const p = paths(context);
  const diagnostics: Diagnostic[] = [];
  const nativeHome = absoluteRoot(context.env.GEMINI_CLI_HOME, context.home, context, 'gemini-cli', diagnostics, 'GEMINI_CLI_HOME');
  const root = context.scope === 'project' ? context.project : nativeHome;
  const settingsFile = p.join(root, '.gemini', 'settings.json');
  const settings = readConfig(settingsFile, 'gemini-cli', diagnostics);
  const shared = p.join(root, '.agents', 'skills');
  const skillsEnabled = !(settings?.skills && typeof settings.skills === 'object' && 'enabled' in settings.skills && settings.skills.enabled === false);
  if (!skillsEnabled) diagnostics.push(diagnostic('gemini-cli', 'skills-disabled', 'Native skills.enabled is false; writing skill directories does not activate discovery.', 'warning'));
  if (settings?.mcp !== undefined) diagnostics.push(diagnostic('gemini-cli', 'native-global-mcp-controls', 'The native top-level mcp settings remain unmanaged; global filtering/activation is not a per-server canonical property.', 'warning'));
  if (context.scope === 'project') diagnostics.push(diagnostic('gemini-cli', 'project-trust-required', 'Gemini workspace skills/settings and MCP activation require native folder trust; mishmash never changes it.', 'info'));
  return {
    skillRoots: [{ path: p.join(root, '.gemini', 'skills'), kind: 'native', recursive: false }, { path: shared, kind: 'native', recursive: false }],
    skillDestination: p.join(root, '.gemini', 'skills'),
    // Disabled discovery cannot be repaired by redundant native copies either.
    directSkills: skillsEnabled && samePath(shared, p.join(context.canonicalRoot, 'skills'), context),
    mcpFiles: [{ path: settingsFile, format: 'jsonc', mapPath: ['mcpServers'], role: 'primary' }], diagnostics, inputs: [settingsFile],
  };
}
function decode(entry: JsonObject, context: Context): DecodeResult {
  const diagnostics: Diagnostic[] = [];
  if (context.scope === 'project-private') return { diagnostics: unsupportedPrivate('gemini-cli').diagnostics };
  const override = nativeOverride(entry, ['command', 'args', 'env', 'cwd', 'url', 'httpUrl', 'type', 'headers'], 'gemini-cli', diagnostics);
  let server: Server | undefined;
  const hasRemote = entry.url !== undefined || entry.httpUrl !== undefined;
  if (hasRemote && entry.command !== undefined) diagnostics.push(diagnostic('gemini-cli', 'ambiguous-native-transport', 'A Gemini entry containing both command and remote URLs needs explicit resolution; URL precedence is not portable stdio intent.'));
  if (hasRemote) {
    if (entry.httpUrl !== undefined && entry.url !== undefined && entry.httpUrl !== entry.url) diagnostics.push(diagnostic('gemini-cli', 'conflicting-native-urls', 'Deprecated httpUrl and url disagree; httpUrl precedence cannot be silently flattened.'));
    if (entry.httpUrl !== undefined && entry.type === 'sse') diagnostics.push(diagnostic('gemini-cli', 'conflicting-native-transport', 'Deprecated httpUrl forces HTTP but type requests SSE.'));
    let type: 'streamable-http' | 'sse' | undefined;
    if (entry.httpUrl !== undefined || entry.type === 'http') type = 'streamable-http';
    else if (entry.type === 'sse') type = 'sse';
    else if (entry.type === undefined) diagnostics.push(diagnostic('gemini-cli', 'ambiguous-native-transport', 'An untyped Gemini url negotiates HTTP with SSE fallback. Select explicit native http/sse before portable adoption.'));
    else diagnostics.push(diagnostic('gemini-cli', 'unsupported-transport', 'Gemini remote type must explicitly be http or sse.'));
    const url = plainString(entry.httpUrl ?? entry.url, 'url', 'gemini-cli', context, diagnostics);
    const headers = decodeValues(entry.headers, 'gemini-cli', context, diagnostics);
    if (entry.args !== undefined || entry.env !== undefined || entry.cwd !== undefined) diagnostics.push(diagnostic('gemini-cli', 'invalid-native-fields', 'Stdio-only fields cannot be flattened into remote intent.'));
    if (entry.httpUrl !== undefined) diagnostics.push(diagnostic('gemini-cli', 'deprecated-http-url', 'Deprecated httpUrl will render as explicit url plus type:http.', 'warning'));
    if (type && url) server = { type, url, ...(headers ? { headers } : {}) };
  } else if (entry.command !== undefined) {
    if (entry.type !== undefined && entry.type !== 'stdio') diagnostics.push(diagnostic('gemini-cli', 'invalid-native-transport', 'The native command entry has a non-stdio type.'));
    const command = plainString(entry.command, 'command', 'gemini-cli', context, diagnostics);
    const args = argumentsList(entry.args, 'gemini-cli', context, diagnostics);
    const env = decodeValues(entry.env, 'gemini-cli', context, diagnostics);
    checkEnvironment(entry.env, diagnostics);
    const cwd = decodeCwd(entry.cwd, context, 'gemini-cli', override, diagnostics);
    if (entry.headers !== undefined) diagnostics.push(diagnostic('gemini-cli', 'invalid-native-fields', 'Remote headers cannot be assigned to a stdio entry.'));
    if (command) server = { type: 'stdio', command, ...(args ? { args } : {}), ...(env ? { env } : {}), ...(cwd ? { cwd } : {}) };
  } else diagnostics.push(diagnostic('gemini-cli', 'unsupported-native-server', 'The entry has no supported stdio/HTTP/SSE definition; tcp alone is not a supported native transport.'));
  return finishDecode('gemini-cli', server, override, diagnostics);
}
function encode(server: Server, override: JsonObject | undefined, context: Context) {
  const diagnostics: Diagnostic[] = [];
  if (context.scope === 'project-private') return { diagnostics: unsupportedPrivate('gemini-cli').diagnostics };
  encodeSafety(server, 'gemini-cli', context, diagnostics);
  if (server.type === 'stdio') checkEnvironment(server.env, diagnostics);
  let entry: JsonObject;
  if (server.type === 'stdio') {
    entry = { command: server.command, ...(server.args ? { args: server.args } : {}) };
    const env = encodeValues(server.env, 'gemini-cli', context, diagnostics);
    const cwd = encodeCwd(server.cwd, context, 'gemini-cli', diagnostics);
    if (env) entry.env = env;
    if (cwd !== undefined) entry.cwd = cwd;
  } else {
    entry = { type: server.type === 'sse' ? 'sse' : 'http', url: server.url };
    const headers = encodeValues(server.headers, 'gemini-cli', context, diagnostics);
    if (headers) entry.headers = headers;
  }
  mergeOverride(entry, override, 'gemini-cli', diagnostics, ['command', 'args', 'env', 'cwd', 'url', 'httpUrl', 'type', 'headers']);
  if (!hasErrors(diagnostics)) diagnostics.push(...decode(entry, context).diagnostics.filter(item => item.severity === 'error'));
  return { ...(!hasErrors(diagnostics) ? { entry } : {}), diagnostics };
}
export const geminiCli: Adapter = { id: 'gemini-cli', resolve, decode, encode };
