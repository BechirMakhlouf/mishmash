import type { Adapter, AdapterLayout, Context, DecodeResult, Diagnostic, JsonObject, Server, SkillRoot } from '../types.js';
import { absoluteRoot, ancestorDirectories, argumentsList, configuredSkills, decodeCwd, decodeValues, diagnostic, encodeCwd, encodeSafety, encodeValues, finishDecode, hasErrors, homePath, mergeOverride, nativeOverride, paths, plainString, readConfig, samePath, uniqueRoots, unsupportedPrivate } from './b-helpers.js';

function resolve(context: Context): AdapterLayout {
  if (context.scope === 'project-private') return unsupportedPrivate('pi');
  const p = paths(context);
  const diagnostics: Diagnostic[] = [];
  const agent = absoluteRoot(context.env.PI_CODING_AGENT_DIR, p.join(context.home, '.pi', 'agent'), context, 'pi', diagnostics, 'PI_CODING_AGENT_DIR');
  // pi's shared-skill HOME preference differs from its native Node-home resolver.
  const sharedHome = absoluteRoot(context.env.HOME, context.home, context, 'pi', diagnostics, 'HOME');
  const base = context.scope === 'project' ? p.join(context.project, '.pi') : agent;
  const settingsFile = p.join(base, 'settings.json');
  const inputs = [settingsFile];
  const settings = readConfig(settingsFile, 'pi', diagnostics, true);
  const roots: SkillRoot[] = configuredSkills(settings?.skills, base, context, 'pi', diagnostics);
  roots.push({ path: p.join(base, 'skills'), kind: 'native', recursive: true });
  if (context.scope === 'project') {
    for (const directory of ancestorDirectories(context, true)) {
      inputs.push(p.join(directory, '.git'));
      const shared = p.join(directory, '.agents', 'skills');
      if (!samePath(shared, p.join(sharedHome, '.agents', 'skills'), context)) roots.push({ path: shared, kind: samePath(shared, p.join(context.canonicalRoot, 'skills'), context) ? 'canonical' : 'native', recursive: true });
    }
    diagnostics.push(diagnostic('pi', 'project-trust-required', 'Project skills/MCP require native project trust; mishmash does not read or grant trust.', 'info'));
  } else roots.push({ path: p.join(sharedHome, '.agents', 'skills'), kind: 'native', recursive: true });
  if (settings?.packages !== undefined) diagnostics.push(diagnostic('pi', 'package-resources-native', 'Package-managed skill resources remain package-managed; packages are never installed or executed during discovery.', 'warning'));
  diagnostics.push(diagnostic('pi', 'builtin-mcp-required', 'Native MCP projection requires stock builtin:mcp to remain enabled and not replaced by a third-party extension; file generation does not prove activation.', 'warning'));
  const directSkills = roots.some(root => samePath(root.path, p.join(context.canonicalRoot, 'skills'), context));
  for (const root of roots) { root.ignoreFiles = ['.gitignore', '.ignore', '.fdignore']; root.ignoredDirectories = ['node_modules']; }
  return { skillRoots: uniqueRoots(roots, context), skillDestination: p.join(base, 'skills'), directSkills, mcpFiles: [{ path: p.join(base, 'mcp.json'), format: 'json', mapPath: ['mcpServers'], role: 'primary', exposureOverlay: context.scope === 'project' }], diagnostics, inputs };
}

function decode(entry: JsonObject, context: Context): DecodeResult {
  const diagnostics: Diagnostic[] = [];
  if (context.scope === 'project-private') return { diagnostics: unsupportedPrivate('pi').diagnostics };
  if (!('command' in entry) && !('url' in entry) && !('type' in entry)) {
    if (context.scope === 'project' && Object.keys(entry).length > 0 && Object.keys(entry).every(key => ['enabled', 'exposure', 'toolExposure'].includes(key))) {
      diagnostics.push(diagnostic('pi', 'pi-exposure-overlay', 'This project entry only overrides enabled/exposure/toolExposure on a user server. It remains native and cannot be hoisted into an independent project server.', 'warning'));
      return finishDecode('pi', undefined, { ...entry }, diagnostics);
    }
    return { diagnostics: [diagnostic('pi', 'invalid-native-server', 'An incomplete pi entry is not an independent server or a valid project exposure-only overlay.')] };
  }
  const override = nativeOverride(entry, ['type', 'command', 'args', 'env', 'cwd', 'url', 'headers'], 'pi', diagnostics);
  let server: Server | undefined;
  if (entry.type === 'sse') diagnostics.push(diagnostic('pi', 'unsupported-transport', 'pi 1.3.0 explicitly rejects legacy SSE.'));
  else if (entry.command !== undefined && entry.url !== undefined) diagnostics.push(diagnostic('pi', 'ambiguous-native-transport', 'A pi server cannot contain both command and url.'));
  else if (entry.command !== undefined) {
    if (entry.type !== undefined && entry.type !== 'stdio') diagnostics.push(diagnostic('pi', 'invalid-native-transport', 'A pi command server must use stdio.'));
    const command = plainString(entry.command, 'command', 'pi', context, diagnostics);
    const args = argumentsList(entry.args, 'pi', context, diagnostics);
    const env = decodeValues(entry.env, 'pi', context, diagnostics);
    const cwd = decodeCwd(entry.cwd, context, 'pi', override, diagnostics);
    if (entry.headers !== undefined) diagnostics.push(diagnostic('pi', 'invalid-native-fields', 'Headers cannot be assigned to a stdio server.'));
    if (command !== undefined) server = { type: 'stdio', command: homePath(command, context), ...(args ? { args: args.map(item => homePath(item, context)) } : {}), ...(env ? { env } : {}), ...(cwd ? { cwd } : {}) };
  } else {
    if (entry.type !== undefined && !['http', 'streamable-http'].includes(String(entry.type))) diagnostics.push(diagnostic('pi', 'invalid-native-transport', 'The remote pi server type must be http or streamable-http.'));
    if (entry.args !== undefined || entry.env !== undefined || entry.cwd !== undefined) diagnostics.push(diagnostic('pi', 'invalid-native-fields', 'Stdio-only fields cannot be assigned to a remote server.'));
    const url = plainString(entry.url, 'url', 'pi', context, diagnostics);
    const headers = decodeValues(entry.headers, 'pi', context, diagnostics);
    if (url) server = { type: 'streamable-http', url, ...(headers ? { headers } : {}) };
  }
  return finishDecode('pi', server, override, diagnostics);
}

function encode(server: Server, override: JsonObject | undefined, context: Context) {
  const diagnostics: Diagnostic[] = [];
  if (context.scope === 'project-private') return { diagnostics: unsupportedPrivate('pi').diagnostics };
  encodeSafety(server, 'pi', context, diagnostics);
  let entry: JsonObject = {};
  if (server.type === 'sse') diagnostics.push(diagnostic('pi', 'unsupported-transport', 'pi 1.3.0 explicitly rejects legacy SSE.'));
  else if (server.type === 'stdio') {
    entry = { command: server.command, ...(server.args ? { args: server.args } : {}) };
    const env = encodeValues(server.env, 'pi', context, diagnostics);
    const cwd = encodeCwd(server.cwd, context, 'pi', diagnostics);
    if (env) entry.env = env;
    if (cwd !== undefined) entry.cwd = cwd;
  } else {
    entry = { type: 'http', url: server.url };
    const headers = encodeValues(server.headers, 'pi', context, diagnostics);
    if (headers) entry.headers = headers;
  }
  mergeOverride(entry, override, 'pi', diagnostics, ['type', 'command', 'args', 'env', 'cwd', 'url', 'headers']);
  if (!hasErrors(diagnostics)) diagnostics.push(...decode(entry, context).diagnostics.filter(item => item.severity === 'error'));
  return { ...(!hasErrors(diagnostics) ? { entry } : {}), diagnostics };
}

export const pi: Adapter = { id: 'pi', resolve, decode, encode };
