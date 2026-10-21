import type { Adapter, AdapterLayout, Context, DecodeResult, Diagnostic, JsonObject, Server, SkillRoot } from '../types.js';
import {
  absoluteOverride, contains, decodeCwd, decodeValues, defaultCwdWarning, diagnostic, encodeCwd,
  encodeLiteralFields, encodeValues, finishDecode, finishEncode, interpolates, literal, nativeArgs,
  nativeOverride, paths, privateUnsupported, projectDirectories, readSettings, samePath, unsupportedNative, validateEncoding,
} from './a-helpers.js';

const id = 'github-copilot-cli';
const fields = ['type', 'command', 'args', 'env', 'cwd', 'url', 'headers'] as const;

function resolve(context: Context): AdapterLayout {
  if (context.scope === 'project-private') return privateUnsupported(id);
  const p = paths(context);
  const diagnostics: Diagnostic[] = [];
  const inputs: string[] = [];
  if (context.scope === 'project') {
    const directories = projectDirectories(context, ['.git'], inputs);
    const skillRoots: SkillRoot[] = [
      { path: p.join(context.project, '.github', 'skills'), kind: 'native' },
      { path: p.join(context.project, '.agents', 'skills'), kind: 'canonical' },
      { path: p.join(context.project, '.claude', 'skills'), kind: 'legacy' },
      ...directories.slice(1).map(directory => ({ path: p.join(directory, '.github', 'skills'), kind: 'native' as const })),
    ];
    if (directories.length > 1) diagnostics.push(diagnostic(id, 'copilot-skill-ancestor-boundary', 'Parent .github skills are inventoried within the established repository; Copilot skill traversal beyond that boundary is not source-established.', 'warning'));
    diagnostics.push(diagnostic(id, 'native-project-trust', 'Copilot project MCP requires native workspace trust; synchronization does not set trust or prompt-mode opt-ins.', 'info'));
    return {
      skillRoots, skillDestination: p.join(context.project, '.agents', 'skills'), directSkills: true,
      mcpFiles: directories.flatMap((directory, index) => [
        { path: p.join(directory, '.mcp.json'), format: 'json' as const, mapPath: ['mcpServers'], role: index === 0 ? 'primary' as const : 'legacy' as const },
        { path: p.join(directory, '.github', 'mcp.json'), format: 'json' as const, mapPath: ['mcpServers'], role: 'legacy' as const },
      ]), diagnostics, inputs,
    };
  }
  const config = absoluteOverride(context, 'COPILOT_HOME', diagnostics, id) ?? p.join(context.home, '.copilot');
  const settingsFile = p.join(config, 'settings.json');
  inputs.push(settingsFile);
  const settings = context.platform === process.platform ? readSettings(settingsFile, id, diagnostics) : undefined;
  const canonical = p.join(context.canonicalRoot, 'skills');
  const relocated = Boolean(context.env.COPILOT_HOME);
  let directSkills = !relocated && samePath(context, p.join(context.home, '.agents', 'skills'), canonical);
  const skillRoots: SkillRoot[] = [
    { path: p.join(config, 'skills'), kind: 'native' },
    ...(!relocated ? [{ path: p.join(context.home, '.agents', 'skills'), kind: 'canonical' as const }] : []),
  ];
  const extraRoots: unknown[] = [];
  if (context.env.COPILOT_SKILLS_DIRS) extraRoots.push(...context.env.COPILOT_SKILLS_DIRS.split(',').map(item => item.trim()).filter(Boolean));
  if (settings?.skillDirectories !== undefined) {
    if (!Array.isArray(settings.skillDirectories)) diagnostics.push(diagnostic(id, 'invalid-skill-directories', 'Copilot skillDirectories must be an array of absolute directory paths.'));
    else extraRoots.push(...settings.skillDirectories);
  }
  for (const root of extraRoots) {
    if (typeof root !== 'string' || !p.isAbsolute(root)) diagnostics.push(diagnostic(id, 'invalid-skill-directories', 'Copilot configured skill roots must be absolute native paths; no shell expansion is performed.'));
    else {
      const normalized = p.normalize(root);
      if (!skillRoots.some(item => samePath(context, item.path, normalized))) skillRoots.push({ path: normalized, kind: 'configured' });
      // Explicit-directory discovery under relocation needs native acceptance; bridge instead of asserting it.
      if (!relocated && samePath(context, normalized, canonical)) directSkills = true;
    }
  }
  if (settings?.ignoredSkillsLocations !== undefined) {
    if (!Array.isArray(settings.ignoredSkillsLocations) || settings.ignoredSkillsLocations.some(item => typeof item !== 'string' || !p.isAbsolute(item))) {
      diagnostics.push(diagnostic(id, 'invalid-ignored-skill-locations', 'Copilot ignoredSkillsLocations must be an array of absolute directory paths.'));
    } else {
      const ignored = settings.ignoredSkillsLocations as string[];
      if (ignored.some(root => contains(context, root, canonical))) {
        directSkills = false;
        diagnostics.push(diagnostic(id, 'canonical-skills-disabled', 'Copilot explicitly ignores canonical skills; synchronization must not bypass that native exclusion.'));
      }
      for (let index = skillRoots.length - 1; index >= 0; index--) if (ignored.some(root => contains(context, root, skillRoots[index]!.path))) skillRoots.splice(index, 1);
    }
  }
  if (settings?.disabledSkills !== undefined) diagnostics.push(diagnostic(id, 'native-skill-disablement', 'Copilot name-based disabledSkills remains local; other targets do not inherit its disablement semantics.', 'warning'));
  if (relocated) diagnostics.push(diagnostic(id, 'copilot-relocated-shared-skills', 'COPILOT_HOME disables default shared-user skills; use individual native skill bridges instead of assuming a relocated shared root.', 'warning'));
  if (context.platform === 'win32' && !context.env.COPILOT_HOME) diagnostics.push(diagnostic(id, 'copilot-windows-home', 'The injected home supplies the documented Windows default layout; the native runtime fallback order is not established.', 'warning'));
  return {
    skillRoots, skillDestination: directSkills ? canonical : p.join(config, 'skills'), directSkills,
    mcpFiles: [{ path: p.join(config, 'mcp-config.json'), format: 'json', mapPath: ['mcpServers'], role: 'primary' }], diagnostics, inputs,
  };
}

function decode(entry: JsonObject, context: Context): DecodeResult {
  const diagnostics: Diagnostic[] = [];
  if (context.scope === 'project-private') return { diagnostics: privateUnsupported(id).diagnostics };
  let override = nativeOverride(entry, fields);
  if (entry.tools !== undefined && (!Array.isArray(entry.tools) || entry.tools.some(item => typeof item !== 'string'))) diagnostics.push(diagnostic(id, 'invalid-native-tools', 'Copilot tools must be an array of tool names, including an intentionally empty allowlist.'));
  if (entry.type === undefined || entry.type === 'stdio' || entry.type === 'local') {
    if (entry.url !== undefined || entry.headers !== undefined) diagnostics.push(diagnostic(id, 'mixed-native-transport', 'Copilot remote fields cannot be interpreted as stdio without an explicit remote type.'));
    const command = literal(entry.command, 'copilot', id, diagnostics);
    const args = nativeArgs(entry.args, 'copilot', id, diagnostics);
    const env = decodeValues(entry.env, 'copilot', id, diagnostics);
    if (typeof entry.cwd === 'string' && interpolates(entry.cwd, 'copilot')) diagnostics.push(diagnostic(id, 'unsupported-interpolation', 'A native working directory with interpolation requires an explicit local binding.'));
    const cwd = decodeCwd(entry.cwd, context, id, diagnostics);
    if (entry.cwd !== undefined && !cwd) override = { ...override, cwd: entry.cwd };
    if (entry.cwd === undefined) defaultCwdWarning(id, diagnostics);
    return finishDecode(id, { type: 'stdio', command, ...(args ? { args } : {}), ...(env ? { env } : {}), ...(cwd ? { cwd } : {}) }, override, diagnostics);
  }
  if (entry.type === 'http' || entry.type === 'streamable-http' || entry.type === 'sse') {
    if (entry.command !== undefined || entry.args !== undefined || entry.env !== undefined || entry.cwd !== undefined) diagnostics.push(diagnostic(id, 'mixed-native-transport', 'Copilot remote servers cannot contain stdio transport fields.'));
    const url = literal(entry.url, 'copilot', id, diagnostics);
    const headers = decodeValues(entry.headers, 'copilot', id, diagnostics);
    return finishDecode(id, { type: entry.type === 'sse' ? 'sse' : 'streamable-http', url, ...(headers ? { headers } : {}) }, override, diagnostics);
  }
  diagnostics.push(diagnostic(id, 'unsupported-transport', 'The native Copilot transport cannot be represented by canonical MCP intent.'));
  return unsupportedNative(id, entry, diagnostics);
}

function encode(server: Server, override: JsonObject | undefined, context: Context) {
  const diagnostics: Diagnostic[] = [];
  if (context.scope === 'project-private') diagnostics.push(...privateUnsupported(id).diagnostics);
  validateEncoding(id, server, diagnostics);
  if (diagnostics.some(item => item.severity === 'error')) return { diagnostics };
  encodeLiteralFields(server, 'copilot', id, diagnostics);
  const tools = override?.tools ?? ['*'];
  if (!Array.isArray(tools) || tools.some(item => typeof item !== 'string')) diagnostics.push(diagnostic(id, 'invalid-native-tools', 'Copilot tools must be a string allowlist.'));
  let entry: JsonObject;
  if (server.type === 'stdio') {
    entry = { type: 'stdio', command: server.command, args: server.args ?? [], tools };
    const env = encodeValues(server.env, 'copilot', id, diagnostics);
    if (env) entry.env = env;
    if (server.cwd) {
      const cwd = encodeCwd(server.cwd, context, id, diagnostics);
      if (cwd && (interpolates(cwd, 'copilot') || cwd.startsWith('~'))) diagnostics.push(diagnostic(id, 'literal-interpolation', 'The absolute working directory would be interpreted by Copilot expansion.'));
      if (cwd) entry.cwd = cwd;
    }
  } else {
    entry = { type: server.type === 'sse' ? 'sse' : 'http', url: server.url, tools };
    const headers = encodeValues(server.headers, 'copilot', id, diagnostics);
    if (headers) entry.headers = headers;
  }
  return finishEncode(id, entry, override, fields, diagnostics);
}

export const githubCopilotCli: Adapter = { id, resolve, decode, encode };
