import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parseJsonDocument } from '../documents.js';
import { secretDiagnostics, validateServer } from '../canonical.js';
import type { AdapterLayout, Context, Cwd, DecodeResult, Diagnostic, JsonObject, NativeFile, Server, SkillRoot, Value } from '../types.js';

export type Flavor = 'pi' | 'opencode' | 'gemini-cli';
export const paths = (context: Context): typeof path => context.platform === 'win32' ? path.win32 : path.posix;
export const object = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value);
export const diagnostic = (adapter: Flavor, code: string, message: string, severity: Diagnostic['severity'] = 'error'): Diagnostic => ({ adapter, code, severity, message });
function own(record: JsonObject, key: string, value: unknown): void {
  Object.defineProperty(record, key, { value, enumerable: true, configurable: true, writable: true });
}
export function unsupportedPrivate(adapter: Flavor): AdapterLayout {
  return { skillRoots: [], directSkills: false, mcpFiles: [], diagnostics: [diagnostic(adapter, 'unsupported-private-scope', 'This adapter cannot represent project-private resources; no project or user files will be used.')] };
}
export function contained(candidate: string, root: string, context: Context): boolean {
  const p = paths(context);
  const relative = p.relative(p.resolve(root), p.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${p.sep}`) && relative !== '..' && !p.isAbsolute(relative));
}
export function samePath(a: string, b: string, context: Context): boolean {
  return paths(context).relative(a, b) === '';
}
export function homePath(value: string, context: Context): string {
  const p = paths(context);
  return value === '~' ? context.home : /^~[/\\]/.test(value) ? p.join(context.home, value.slice(2)) : value;
}
export function absoluteRoot(value: string | undefined, fallback: string, context: Context, adapter: Flavor, diagnostics: Diagnostic[], name: string): string {
  if (!value) return fallback;
  const expanded = homePath(value, context);
  if (!paths(context).isAbsolute(expanded)) {
    diagnostics.push(diagnostic(adapter, 'relative-config-root', `${name} must be absolute to resolve native configuration safely.`));
    return fallback;
  }
  return paths(context).normalize(expanded);
}
export function readConfig(file: string, adapter: Flavor, diagnostics: Diagnostic[], strict = false): JsonObject | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const text = readFileSync(file, 'utf8');
    const value = parseJsonDocument(text, { allowTrailingComma: !strict && adapter !== 'gemini-cli', disallowComments: strict });
    if (!object(value)) throw new Error('Invalid document');
    return value;
  } catch {
    diagnostics.push({ ...diagnostic(adapter, 'invalid-native-config', 'Native configuration is unreadable or invalid; it was not ignored.'), path: file });
    return undefined;
  }
}
export function ancestorDirectories(context: Context, gitBoundary: boolean): string[] {
  const p = paths(context);
  const result: string[] = [];
  let directory = p.resolve(context.project);
  while (true) {
    result.push(directory);
    if (gitBoundary && existsSync(p.join(directory, '.git'))) break;
    const parent = p.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return result;
}
export function uniqueRoots(roots: SkillRoot[], context: Context): SkillRoot[] {
  return roots.filter((root, index) => roots.findIndex(other => samePath(root.path, other.path, context)) === index);
}
export function uniqueFiles(files: NativeFile[], context: Context): NativeFile[] {
  return files.filter((file, index) => files.findIndex(other => samePath(file.path, other.path, context) && JSON.stringify(file.mapPath) === JSON.stringify(other.mapPath)) === index);
}
export function configuredSkills(value: unknown, base: string, context: Context, adapter: Flavor, diagnostics: Diagnostic[]): SkillRoot[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    diagnostics.push(diagnostic(adapter, 'unsupported-configured-skills', 'Configured skill sources must be an array of local paths; native patterns and package sources are not portable.', 'warning'));
    return [];
  }
  const result: SkillRoot[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !item || /^[!+-]/.test(item) || /[*?\[\]{}]/.test(item) || /^[a-z][a-z\d+.-]*:\/\//i.test(item) || /^(?:npm:|git:|github:)/.test(item)) {
      diagnostics.push(diagnostic(adapter, 'unsupported-configured-skill-source', 'A configured non-local/pattern skill source remains native; it was not fetched, executed or flattened.', 'warning'));
      continue;
    }
    const p = paths(context);
    const expanded = homePath(item, context);
    const source = p.resolve(base, expanded);
    if (context.scope === 'project' && !contained(source, context.project, context)) {
      diagnostics.push(diagnostic(adapter, 'configured-skill-outside-scope', 'A configured skill source outside this project remains native rather than being adopted into a shared project.', 'warning'));
      continue;
    }
    if (adapter === 'opencode' && context.scope === 'user' && !p.isAbsolute(expanded)) {
      diagnostics.push(diagnostic(adapter, 'session-relative-skill-source', 'A user-configured workspace-relative skill source remains native instead of being flattened into static user scope.', 'warning'));
      continue;
    }
    result.push({ path: source, kind: 'configured', recursive: true });
  }
  return result;
}

const variableName = /^[A-Za-z_][A-Za-z0-9_]*$/;
export function reference(value: string, flavor: Flavor): string | undefined {
  const match = flavor === 'opencode' ? /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value) : /^(?:\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*))$/.exec(value);
  return match?.[1] ?? match?.[2];
}
export function interpolates(value: string, flavor: Flavor, context: Context, transportValues = true): boolean {
  if (flavor === 'opencode') return /\{(?:env|file):[^}]*\}/.test(value);
  return /\$(?:\{|[A-Za-z_])/.test(value) || (transportValues && flavor === 'gemini-cli' && context.platform === 'win32' && /%[^%]+%/.test(value));
}
export function decodeValues(value: unknown, flavor: Flavor, context: Context, diagnostics: Diagnostic[]): Record<string, Value> | undefined {
  if (value === undefined) return undefined;
  if (!object(value)) {
    diagnostics.push(diagnostic(flavor, 'invalid-native-values', 'Native environment/headers must be a string-valued object.'));
    return undefined;
  }
  const result: Record<string, Value> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== 'string') {
      diagnostics.push(diagnostic(flavor, 'invalid-native-value', 'Native environment/header values must be strings.'));
      continue;
    }
    const ref = reference(raw, flavor) ?? (flavor === 'gemini-cli' && context.platform === 'win32' ? /^%([A-Za-z_][A-Za-z0-9_]*)%$/.exec(raw)?.[1] : undefined);
    if (ref) { own(result, key, { env: ref }); continue; }
    if (flavor === 'pi') {
      if (raw.startsWith('!')) {
        diagnostics.push(diagnostic(flavor, 'native-secret-command', 'A native secret-producing shell command cannot become portable intent; the source remains native.'));
        continue;
      }
      // pi escapes dollar and bang before applying its template resolver.
      let literal = '';
      let unsafe = false;
      for (let index = 0; index < raw.length; index++) {
        const char = raw[index]!;
        if (char === '$' && (raw[index + 1] === '$' || raw[index + 1] === '!')) literal += raw[++index];
        else { literal += char; if (char === '$' && /[A-Za-z_{]/.test(raw[index + 1] ?? '')) unsafe = true; }
      }
      if (!unsafe) { own(result, key, literal); continue; }
    } else if (!interpolates(raw, flavor, context)) { own(result, key, raw); continue; }
    diagnostics.push(diagnostic(flavor, 'native-template-not-portable', 'A compound, fallback or file interpolation cannot be represented as a literal or single environment reference.'));
  }
  return result;
}
export function encodeValues(value: Record<string, Value> | undefined, flavor: Flavor, context: Context, diagnostics: Diagnostic[]): JsonObject | undefined {
  if (!value) return undefined;
  const result: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') {
      if (!object(item) || typeof item.env !== 'string' || !variableName.test(item.env)) {
        diagnostics.push(diagnostic(flavor, 'invalid-environment-reference', 'An environment reference has an invalid variable name.'));
        continue;
      }
      own(result, key, flavor === 'opencode' ? `{env:${item.env}}` : `\${${item.env}}`);
    } else if (flavor === 'pi') {
      own(result, key, item.replaceAll('$', () => '$$').replace(/^!/, '$!'));
    } else if (interpolates(item, flavor, context)) {
      diagnostics.push(diagnostic(flavor, 'literal-interpolation', 'The native reader would expand a canonical literal; no lossless literal encoding is established.'));
    } else own(result, key, item);
  }
  return result;
}
export function plainString(value: unknown, field: string, flavor: Flavor, context: Context, diagnostics: Diagnostic[]): string | undefined {
  if (typeof value !== 'string' || !value) {
    diagnostics.push(diagnostic(flavor, 'invalid-native-field', `Native ${field} must be a nonempty string.`));
    return undefined;
  }
  if (flavor !== 'pi' && interpolates(value, flavor, context, false)) {
    diagnostics.push(diagnostic(flavor, 'native-interpolated-field', `Native ${field} contains interpolation not representable by the canonical field.`));
    return undefined;
  }
  return value;
}
export function argumentsList(value: unknown, flavor: Flavor, context: Context, diagnostics: Diagnostic[]): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    diagnostics.push(diagnostic(flavor, 'invalid-native-args', 'Native arguments must be a string array; command strings are never shell-split.'));
    return undefined;
  }
  if (flavor !== 'pi' && value.some(item => interpolates(item, flavor, context, false))) diagnostics.push(diagnostic(flavor, 'native-interpolated-field', 'Native argv contains interpolation not representable by literal canonical arguments.'));
  return value as string[];
}
export function decodeCwd(value: unknown, context: Context, flavor: Flavor, override: JsonObject, diagnostics: Diagnostic[]): Cwd | undefined {
  if (value === undefined) {
    diagnostics.push(diagnostic(flavor, 'native-cwd-default', 'Omitted cwd retains this target’s session/workspace default, not a universal cross-harness default.', 'warning'));
    return undefined;
  }
  const raw = plainString(value, 'cwd', flavor, context, diagnostics);
  if (raw === undefined) return undefined;
  const p = paths(context);
  const expanded = flavor === 'pi' ? homePath(raw, context) : raw;
  if (!p.isAbsolute(expanded)) {
    if (context.scope === 'project' && contained(p.resolve(context.project, expanded), context.project, context)) return { base: 'project', path: p.relative(context.project, p.resolve(context.project, expanded)).split(p.sep).join('/') || '.' };
    override.cwd = raw;
    diagnostics.push(diagnostic(flavor, 'session-relative-cwd', 'Session-relative cwd cannot be anchored statically in this scope; the source remains native until an explicit local binding is provided.'));
    return undefined;
  }
  const anchors: Array<[Cwd['base'], string]> = [['source', context.canonicalRoot], ...(context.scope === 'project' ? [['project', context.project] as [Cwd['base'], string]] : []), ['home', context.home]];
  for (const [base, root] of anchors) if (contained(expanded, root, context)) return { base, path: p.relative(root, expanded).split(p.sep).join('/') || '.' };
  override.cwd = raw;
  diagnostics.push(diagnostic(flavor, 'machine-local-cwd', 'An absolute cwd outside canonical/project/home anchors requires an explicit local binding; the source remains native.'));
  return undefined;
}
export function encodeCwd(cwd: Cwd | undefined, context: Context, flavor: Flavor, diagnostics: Diagnostic[]): string | undefined {
  if (!cwd) return undefined;
  const p = paths(context);
  if (!['project', 'home', 'source'].includes(cwd.base) || typeof cwd.path !== 'string' || p.isAbsolute(cwd.path) || (cwd.base === 'project' && context.scope !== 'project')) {
    diagnostics.push(diagnostic(flavor, 'unsupported-cwd', 'The cwd anchor/path is invalid or unavailable in the selected scope.'));
    return undefined;
  }
  const root = cwd.base === 'project' ? context.project : cwd.base === 'home' ? context.home : context.canonicalRoot;
  const result = p.resolve(root, cwd.path);
  if (!contained(result, root, context)) diagnostics.push(diagnostic(flavor, 'escaping-cwd', 'The cwd path escapes its declared anchor.'));
  if (flavor !== 'pi' && interpolates(result, flavor, context, false)) diagnostics.push(diagnostic(flavor, 'literal-interpolation', 'The resolved cwd would be interpolated by the native reader.'));
  return result;
}
function overrideValues(value: unknown, flavor: Flavor, encode: boolean, keys: string[] = []): unknown {
  const interpolated = flavor !== 'pi' || keys.length === 2 && keys[0] === 'oauth' && keys[1] === 'clientSecret';
  if (!encode && interpolated && typeof value === 'string') {
    const env = reference(value, flavor);
    if (env) return { env };
  }
  if (encode && interpolated && object(value) && Object.keys(value).length === 1 && typeof value.env === 'string' && variableName.test(value.env)) {
    return flavor === 'opencode' ? `{env:${value.env}}` : `\${${value.env}}`;
  }
  if (Array.isArray(value)) return value.map((item, index) => overrideValues(item, flavor, encode, [...keys, String(index)]));
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, overrideValues(item, flavor, encode, [...keys, key])]));
  return value;
}
export function nativeOverride(entry: JsonObject, portable: string[], flavor: Flavor, diagnostics: Diagnostic[]): JsonObject {
  const result: JsonObject = {};
  for (const [key, value] of Object.entries(entry)) {
    if (portable.includes(key)) continue;
    if (/^(?:trust|trusted|allowAll|allow_all|auth)$/i.test(key)) {
      diagnostics.push(diagnostic(flavor, 'excluded-native-state', 'Native trust/provider-credential state is not synchronized.', value === false ? 'warning' : 'error'));
      continue;
    }
    own(result, key, overrideValues(value, flavor, false, [key]));
  }
  if (Object.keys(result).length) diagnostics.push(diagnostic(flavor, 'native-options-retained', 'Native-only server options were retained in this adapter’s override.', 'warning'));
  return result;
}
export function safeDiagnostics(value: unknown, flavor: Flavor, native = true): Diagnostic[] {
  return secretDiagnostics(native ? overrideValues(value, flavor, false) : value).map(item => ({ ...item, adapter: flavor }));
}
export function mergeOverride(entry: JsonObject, override: JsonObject | undefined, flavor: Flavor, diagnostics: Diagnostic[], reserved: readonly string[]): JsonObject {
  if (!override) return entry;
  diagnostics.push(...safeDiagnostics(override, flavor));
  for (const [key, value] of Object.entries(override)) {
    if (/^(?:trust|trusted|allowAll|allow_all|auth)$/i.test(key)) {
      diagnostics.push(diagnostic(flavor, 'excluded-native-state', 'Native trust/provider-credential state cannot be exported.'));
      continue;
    }
    if (Object.hasOwn(entry, key)) {
      if (!isDeepStrictEqual(entry[key], overrideValues(value, flavor, true, [key]))) diagnostics.push(diagnostic(flavor, 'override-conflict', 'An adapter override conflicts with a projected canonical field.'));
    } else if (reserved.includes(key)) diagnostics.push(diagnostic(flavor, 'override-conflict', 'An adapter override introduces a conflicting canonical field.'));
    else own(entry, key, overrideValues(value, flavor, true, [key]));
  }
  return entry;
}
export function finishDecode(flavor: Flavor, server: Server | undefined, override: JsonObject, diagnostics: Diagnostic[]): DecodeResult {
  if (server) diagnostics.push(...validateServer(server).diagnostics.map(item => ({ ...item, adapter: flavor })));
  const unsafe = safeDiagnostics(override, flavor);
  diagnostics.push(...unsafe);
  return { ...(!hasErrors(diagnostics) && server ? { server } : {}), ...(!unsafe.length ? optionalOverride(override) : {}), diagnostics };
}
export function encodeSafety(server: Server, flavor: Flavor, context: Context, diagnostics: Diagnostic[]): void {
  diagnostics.push(...validateServer(server).diagnostics.map(item => ({ ...item, adapter: flavor })));
  if (server.type === 'stdio') {
    plainString(server.command, 'command', flavor, context, diagnostics);
    argumentsList(server.args, flavor, context, diagnostics);
    if (flavor === 'pi' && [server.command, ...(server.args ?? [])].some(item => /^~(?:$|[/\\])/.test(item))) diagnostics.push(diagnostic(flavor, 'literal-home-expansion', 'pi would expand a literal leading tilde in command/argv; no lossless native literal encoding is established.'));
  } else plainString(server.url, 'url', flavor, context, diagnostics);
}
export const hasErrors = (diagnostics: Diagnostic[]): boolean => diagnostics.some(item => item.severity === 'error');
export const optionalOverride = (override: JsonObject): { override?: JsonObject } => Object.keys(override).length ? { override } : {};
