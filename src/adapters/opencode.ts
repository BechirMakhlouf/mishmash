import { existsSync } from 'node:fs';
import type { Adapter, AdapterLayout, Context, DecodeResult, Diagnostic, JsonObject, NativeFile, Server, SkillRoot } from '../types.js';
import { absoluteRoot, ancestorDirectories, argumentsList, configuredSkills, contained, decodeCwd, decodeValues, diagnostic, encodeCwd, encodeSafety, encodeValues, finishDecode, hasErrors, mergeOverride, nativeOverride, object, paths, plainString, readConfig, samePath, uniqueFiles, uniqueRoots, unsupportedPrivate } from './b-helpers.js';

const enabledFlag = (value: string | undefined): boolean => value === '1' || value === 'true';
function resolve(context: Context): AdapterLayout {
  if (context.scope === 'project-private') return unsupportedPrivate('opencode');
  const p = paths(context);
  const diagnostics: Diagnostic[] = [];
  const configBase = absoluteRoot(context.env.XDG_CONFIG_HOME, p.join(context.home, '.config'), context, 'opencode', diagnostics, 'XDG_CONFIG_HOME');
  const normalGlobal = p.join(configBase, 'opencode');
  const customGlobal = absoluteRoot(context.env.OPENCODE_CONFIG_DIR, normalGlobal, context, 'opencode', diagnostics, 'OPENCODE_CONFIG_DIR');
  const global = context.opencodeVersion === 2 ? customGlobal : normalGlobal;
  const ancestors = context.scope === 'project' ? ancestorDirectories(context, context.opencodeVersion === 1) : [];
  const currentCandidates = context.scope === 'project'
    ? [p.join(context.project, 'opencode.json'), p.join(context.project, 'opencode.jsonc'), p.join(context.project, '.opencode', 'opencode.json'), p.join(context.project, '.opencode', 'opencode.jsonc')]
    : [p.join(global, 'opencode.json'), p.join(global, 'opencode.jsonc')];
  const primary = currentCandidates.find(file => existsSync(file)) ?? currentCandidates[0]!;
  const candidates = [...currentCandidates];
  if (context.scope === 'project') {
    for (const directory of ancestors) {
      if (samePath(directory, context.home, context)) continue; // do not adopt the user's native aliases as project intent
      candidates.push(p.join(directory, 'opencode.json'), p.join(directory, 'opencode.jsonc'), p.join(directory, '.opencode', 'opencode.json'), p.join(directory, '.opencode', 'opencode.jsonc'));
    }
  } else {
    candidates.push(p.join(global, 'config.json'));
    if (context.opencodeVersion === 1) {
      candidates.push(p.join(context.home, '.opencode', 'opencode.json'), p.join(context.home, '.opencode', 'opencode.jsonc'));
      if (context.env.OPENCODE_CONFIG_DIR) candidates.push(p.join(customGlobal, 'opencode.json'), p.join(customGlobal, 'opencode.jsonc'));
    }
  }
  if (context.env.OPENCODE_CONFIG) {
    const explicit = absoluteRoot(context.env.OPENCODE_CONFIG, primary, context, 'opencode', diagnostics, 'OPENCODE_CONFIG');
    const scoped = context.scope === 'project' ? contained(explicit, context.project, context) : contained(explicit, context.home, context) || contained(explicit, global, context) || contained(explicit, customGlobal, context);
    if (scoped) candidates.push(explicit);
    else diagnostics.push(diagnostic('opencode', 'unscoped-explicit-config', 'OPENCODE_CONFIG is outside the selected scope; its definitions remain native instead of being hoisted.', 'warning'));
  }
  if (context.env.OPENCODE_CONFIG_CONTENT) diagnostics.push(diagnostic('opencode', 'inline-config-not-adopted', 'Inline OPENCODE_CONFIG_CONTENT remains native: it has no persistent source ownership/scope and may override generated configuration.', 'warning'));
  const nativeMap = context.opencodeVersion === 1 ? ['mcp'] : ['mcp', 'servers'];
  const mcpFiles: NativeFile[] = [];
  const documents: Array<{ file: string; value: JsonObject }> = [];
  for (const file of [...new Set([primary, ...candidates])]) {
    if (file !== primary && !existsSync(file)) continue;
    const value = readConfig(file, 'opencode', diagnostics);
    if (value) documents.push({ file, value });
    const mcp = value && object(value.mcp) ? value.mcp : undefined;
    const slot = mcp?.servers;
    const literalServer = object(slot) && (slot.type === 'local' || slot.type === 'remote');
    const nestedMap = object(slot) && !literalServer && (Object.keys(slot).length === 0 || Object.values(slot).some(item => object(item) && (item.type === 'local' || item.type === 'remote')));
    if (context.opencodeVersion === 2 && literalServer) {
      diagnostics.push(diagnostic('opencode', 'envelope-collision', 'A literal legacy server named servers occupies the V2 MCP envelope. It remains a legacy source; rename/disambiguate explicitly before V2 cutover.'));
    } else mcpFiles.push({ path: file, format: 'jsonc', mapPath: nativeMap, role: file === primary ? 'primary' : 'legacy', ...(context.opencodeVersion === 1 && nestedMap ? { ignoreKeys: ['servers'] } : {}) });
    if (context.opencodeVersion === 1 && nestedMap) mcpFiles.push({ path: file, format: 'jsonc', mapPath: ['mcp', 'servers'], role: 'legacy' });
    if (context.opencodeVersion === 2 && mcp && Object.entries(mcp).some(([key, item]) => (!nestedMap || key !== 'servers') && object(item) && (item.type === 'local' || item.type === 'remote' || typeof item.enabled === 'boolean'))) mcpFiles.push({ path: file, format: 'jsonc', mapPath: ['mcp'], role: 'legacy', ...(nestedMap ? { ignoreKeys: ['servers'] } : {}) });
  }
  const roots: SkillRoot[] = [];
  for (const { value } of documents) {
    const skills = object(value.skills) ? value.skills.paths : value.skills;
    roots.push(...configuredSkills(skills, context.project, context, 'opencode', diagnostics));
    if (context.opencodeVersion === 1 && object(value.skills) && value.skills.urls !== undefined) diagnostics.push(diagnostic('opencode', 'remote-skills-not-adopted', 'Remote skill catalogs remain native; discovery never fetches or installs catalogs.', 'warning'));
    if (context.opencodeVersion === 2 && object(value.skills)) diagnostics.push(diagnostic('opencode', 'legacy-skills-format', 'Legacy skills.paths are an import source; V2 native configuration uses a skills array.', 'warning'));
  }
  const externalDisabled = enabledFlag(context.env.OPENCODE_DISABLE_EXTERNAL_SKILLS);
  const claudeDisabled = externalDisabled || enabledFlag(context.env.OPENCODE_DISABLE_CLAUDE_CODE) || enabledFlag(context.env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS);
  if (context.opencodeVersion === 2 && (externalDisabled || claudeDisabled)) diagnostics.push(diagnostic('opencode', 'v2-discovery-flags-unverified', 'External-skill disable flags are verified for V1 only; V2 uses conservative native projections instead of assuming shared discovery.', 'warning'));
  const nativeDirectories = context.scope === 'project'
    ? ancestors.filter(directory => !samePath(directory, context.home, context)).map(directory => p.join(directory, '.opencode'))
    : [global, ...(context.opencodeVersion === 1 ? [p.join(context.home, '.opencode'), ...(context.env.OPENCODE_CONFIG_DIR ? [customGlobal] : [])] : [])];
  for (const directory of nativeDirectories) roots.push({ path: p.join(directory, 'skills'), kind: 'native', recursive: true }, { path: p.join(directory, 'skill'), kind: 'legacy', recursive: true });
  const aliasDirectories = context.scope === 'project' ? ancestors.filter(directory => !samePath(directory, context.home, context)) : [context.home];
  for (const directory of aliasDirectories) {
    if (!externalDisabled) roots.push({ path: p.join(directory, '.agents', 'skills'), kind: 'native', recursive: true });
    if (!claudeDisabled) roots.push({ path: p.join(directory, '.claude', 'skills'), kind: 'legacy', recursive: true });
  }
  const directSkills = !externalDisabled && roots.some(root => samePath(root.path, p.join(context.canonicalRoot, 'skills'), context));
  if (externalDisabled) diagnostics.push(diagnostic('opencode', 'shared-skills-disabled', 'External/shared skill discovery is disabled; canonical skills need native per-skill projections.', 'warning'));
  diagnostics.push(diagnostic('opencode', 'native-layering', context.opencodeVersion === 1 ? 'V1 deep-merges MCP layers and concurrent skill discovery has no reliable duplicate winner; inherited origins are not a universal project override.' : 'V2 replaces whole same-name MCP entries and later skill IDs win; ancestor traversal reaches the filesystem root, and the native scanner is bounded to six descents.', 'info'));
  if (documents.some(document => document.file !== primary)) diagnostics.push(diagnostic('opencode', 'additional-config-layers', 'Additional native config layers are import sources, not write targets; native precedence may override the primary generated file.', 'warning'));
  if (context.opencodeVersion === 2) for (const root of roots) { root.maxDepth = 6; root.ignoredDirectories = ['node_modules', '.git', '.venv', 'venv', '__pycache__']; }
  return { skillRoots: uniqueRoots(roots, context), skillDestination: context.scope === 'project' ? p.join(context.project, '.opencode', 'skills') : p.join(global, 'skills'), directSkills, mcpFiles: uniqueFiles(mcpFiles, context), diagnostics, inputs: [...new Set([...candidates, ...(context.opencodeVersion === 1 ? ancestors.map(directory => p.join(directory, '.git')) : [])])] };
}

function decode(entry: JsonObject, context: Context): DecodeResult {
  const diagnostics: Diagnostic[] = [];
  if (context.scope === 'project-private') return { diagnostics: unsupportedPrivate('opencode').diagnostics };
  if (entry.type === undefined && Object.keys(entry).length > 0 && Object.keys(entry).every(key => key === 'enabled' || key === 'disabled') && (typeof entry.enabled === 'boolean' || typeof entry.disabled === 'boolean')) {
    diagnostics.push(diagnostic('opencode', 'native-partial-overlay', 'An activation-only OpenCode layer is not a complete server. It remains native and requires its original lower-layer definition.', 'warning'));
    if (entry.enabled !== undefined && entry.disabled !== undefined) diagnostics.push(diagnostic('opencode', 'activation-conflict', 'Both enabled and disabled are set; activation intent is ambiguous.'));
    return finishDecode('opencode', undefined, { ...entry }, diagnostics);
  }
  const override = nativeOverride(entry, ['type', 'command', 'environment', 'cwd', 'url', 'headers'], 'opencode', diagnostics);
  if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean' || entry.disabled !== undefined && typeof entry.disabled !== 'boolean') diagnostics.push(diagnostic('opencode', 'invalid-activation', 'Native activation controls must be booleans.'));
  if (entry.enabled !== undefined && entry.disabled !== undefined) diagnostics.push(diagnostic('opencode', 'activation-conflict', 'Both enabled and disabled are set; activation intent is ambiguous.'));
  let server: Server | undefined;
  if (entry.type === 'local') {
    const argv = argumentsList(entry.command, 'opencode', context, diagnostics);
    const command = argv?.length ? plainString(argv[0], 'command', 'opencode', context, diagnostics) : undefined;
    if (!command) diagnostics.push(diagnostic('opencode', 'invalid-native-command', 'OpenCode local command must be a nonempty executable/argv array.'));
    const env = decodeValues(entry.environment, 'opencode', context, diagnostics);
    const cwd = decodeCwd(entry.cwd, context, 'opencode', override, diagnostics);
    if (entry.url !== undefined || entry.headers !== undefined) diagnostics.push(diagnostic('opencode', 'invalid-native-fields', 'Remote fields cannot be assigned to a local server.'));
    if (command && argv) server = { type: 'stdio', command, args: argv.slice(1), ...(env ? { env } : {}), ...(cwd ? { cwd } : {}) };
  } else if (entry.type === 'remote') {
    const url = plainString(entry.url, 'url', 'opencode', context, diagnostics);
    const headers = decodeValues(entry.headers, 'opencode', context, diagnostics);
    if (entry.command !== undefined || entry.environment !== undefined || entry.cwd !== undefined) diagnostics.push(diagnostic('opencode', 'invalid-native-fields', 'Local-only fields cannot be assigned to a remote server.'));
    if (context.opencodeVersion === 1) diagnostics.push(diagnostic('opencode', 'transport-negotiation', 'V1 remote transport tries Streamable HTTP then SSE; this is not a forced-SSE declaration.', 'warning'));
    if (url) server = { type: 'streamable-http', url, ...(headers ? { headers } : {}) };
  } else diagnostics.push(diagnostic('opencode', 'unsupported-transport', 'OpenCode requires native type local or remote.'));
  return finishDecode('opencode', server, override, diagnostics);
}

function versionedOverride(override: JsonObject | undefined, context: Context, diagnostics: Diagnostic[]): JsonObject | undefined {
  if (!override) return undefined;
  const result = { ...override };
  if (context.opencodeVersion === 1 && ('codemode' in result || 'protocol' in result)) diagnostics.push(diagnostic('opencode', 'unsupported-v2-options', 'V2 Code Mode/protocol settings have no lossless V1 representation.'));
  if ('enabled' in result && 'disabled' in result) diagnostics.push(diagnostic('opencode', 'activation-conflict', 'Both enabled and disabled cannot be projected.'));
  if (context.opencodeVersion === 2 && typeof result.enabled === 'boolean') { result.disabled = !result.enabled; delete result.enabled; }
  if (context.opencodeVersion === 1 && typeof result.disabled === 'boolean') { result.enabled = !result.disabled; delete result.disabled; }
  if (typeof result.timeout === 'number' && context.opencodeVersion === 2) result.timeout = { startup: result.timeout, catalog: result.timeout, execution: result.timeout };
  if (object(result.timeout) && context.opencodeVersion === 1) {
    const timeout = result.timeout;
    const values = Object.values(timeout);
    if (values.length === 3 && Object.keys(timeout).every(key => ['startup', 'catalog', 'execution'].includes(key)) && values.every(value => typeof value === 'number' && value === values[0])) result.timeout = values[0];
    else diagnostics.push(diagnostic('opencode', 'unsupported-phase-timeouts', 'Distinct or partial V2 phase timeouts cannot be represented by a V1 numeric timeout.'));
  }
  if (object(result.oauth)) {
    const oauth = { ...result.oauth };
    const pairs = [['clientId', 'client_id'], ['clientSecret', 'client_secret'], ['callbackPort', 'callback_port'], ['redirectUri', 'redirect_uri']] as const;
    for (const [v1, v2] of pairs) {
      const source = context.opencodeVersion === 2 ? v1 : v2;
      const destination = context.opencodeVersion === 2 ? v2 : v1;
      if (source in oauth) {
        if (destination in oauth && JSON.stringify(oauth[source]) !== JSON.stringify(oauth[destination])) diagnostics.push(diagnostic('opencode', 'oauth-option-conflict', 'OAuth options conflict across major-version spellings.'));
        else oauth[destination] = oauth[source];
        delete oauth[source];
      }
    }
    if (context.opencodeVersion === 1 && ['auth_server_metadata_url', 'cimd', 'dcr'].some(key => key in oauth)) diagnostics.push(diagnostic('opencode', 'unsupported-v2-oauth', 'V2-specific OAuth registration options have no established V1 projection.'));
    result.oauth = oauth;
  }
  return result;
}
function encode(server: Server, override: JsonObject | undefined, context: Context) {
  const diagnostics: Diagnostic[] = [];
  if (context.scope === 'project-private') return { diagnostics: unsupportedPrivate('opencode').diagnostics };
  encodeSafety(server, 'opencode', context, diagnostics);
  let entry: JsonObject;
  if (server.type === 'stdio') {
    entry = { type: 'local', command: [server.command, ...(server.args ?? [])] };
    const environment = encodeValues(server.env, 'opencode', context, diagnostics);
    const cwd = encodeCwd(server.cwd, context, 'opencode', diagnostics);
    if (environment) entry.environment = environment;
    if (cwd !== undefined) entry.cwd = cwd;
  } else {
    entry = { type: 'remote', url: server.url };
    if (server.type === 'sse') diagnostics.push(diagnostic('opencode', 'unsupported-transport', 'OpenCode has no lossless explicit legacy-SSE native declaration; V1 fallback is not forced SSE and V2 uses Streamable HTTP.'));
    const headers = encodeValues(server.headers, 'opencode', context, diagnostics);
    if (headers) entry.headers = headers;
  }
  mergeOverride(entry, versionedOverride(override, context, diagnostics), 'opencode', diagnostics, ['type', 'command', 'environment', 'cwd', 'url', 'headers']);
  if (!hasErrors(diagnostics)) diagnostics.push(...decode(entry, context).diagnostics.filter(item => item.severity === 'error'));
  return { ...(!hasErrors(diagnostics) ? { entry } : {}), diagnostics };
}
export const opencode: Adapter = { id: 'opencode', resolve, decode, encode };
