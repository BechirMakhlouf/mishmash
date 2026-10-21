import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parseJsonDocument } from '../documents.js';
import { secretDiagnostics, validateServer } from '../canonical.js';
import type { AdapterLayout, Context, Cwd, DecodeResult, Diagnostic, EncodeResult, JsonObject, Server, Value } from '../types.js';

export function paths(context: Context): typeof path.posix { return context.platform === 'win32' ? path.win32 : path.posix; }
export function diagnostic(adapter: string, code: string, message: string, severity: Diagnostic['severity'] = 'error'): Diagnostic {
  return { adapter, code, severity, message };
}
export function privateUnsupported(adapter: string): AdapterLayout {
  return { skillRoots: [], mcpFiles: [], directSkills: false, diagnostics: [diagnostic(adapter, 'unsupported-private-scope', 'This adapter cannot represent project-private resources; no public or user projection is permitted.')] };
}
export function absoluteOverride(context: Context, name: string, diagnostics: Diagnostic[], adapter: string): string | undefined {
  const value = context.env[name];
  if (!value) return undefined;
  if (!paths(context).isAbsolute(value)) {
    diagnostics.push(diagnostic(adapter, 'invalid-native-root', `${name} must be an absolute native path; shell expansion is not performed.`));
    return undefined;
  }
  return paths(context).normalize(value);
}
export function samePath(context: Context, left: string, right: string): boolean {
  // Do not infer filesystem case sensitivity from a platform name.
  return paths(context).resolve(left) === paths(context).resolve(right);
}
export function contains(context: Context, root: string, candidate: string): boolean {
  const p = paths(context);
  const relative = p.relative(root, candidate);
  return relative === '' || (!p.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${p.sep}`));
}
export function projectDirectories(context: Context, markers: string[] = ['.git'], inputs: string[] = []): string[] {
  const p = paths(context);
  const selected = p.resolve(context.project);
  if (markers.length === 0) return [selected];
  const walked: string[] = [];
  let current = selected;
  while (true) {
    walked.push(current);
    const candidates = markers.map(marker => p.join(current, marker));
    inputs.push(...candidates);
    if (candidates.some(candidate => fs.existsSync(candidate))) return walked;
    const parent = p.dirname(current);
    if (parent === current) return [selected];
    current = parent;
  }
}
export function readSettings(file: string, adapter: string, diagnostics: Diagnostic[]): JsonObject | undefined {
  let source: string;
  try { source = fs.readFileSync(file, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') diagnostics.push(diagnostic(adapter, 'native-settings-read', 'Native discovery settings could not be read.'));
    return undefined;
  }
  try {
    const value = parseJsonDocument(source);
    if (object(value)) return value;
  } catch { /* Report a redacted configuration diagnostic below. */ }
  diagnostics.push(diagnostic(adapter, 'invalid-native-settings', 'Native discovery settings must be a valid JSONC object.'));
  return undefined;
}
export function object(value: unknown): value is JsonObject { return typeof value === 'object' && value !== null && !Array.isArray(value); }
export function own<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, { value, enumerable: true, writable: true, configurable: true });
}
export function nativeOverride(entry: JsonObject, known: readonly string[]): JsonObject | undefined {
  const result = Object.fromEntries(Object.entries(entry).filter(([key]) => !known.includes(key)));
  return Object.keys(result).length ? result : undefined;
}
export function unsupportedNative(adapter: string, entry: JsonObject, diagnostics: Diagnostic[]): DecodeResult {
  const unsafe = secretDiagnostics(entry);
  diagnostics.push(...unsafe.map(item => ({ ...item, adapter })));
  return { ...(!unsafe.length ? { override: { ...entry } } : {}), diagnostics };
}
export function finishDecode(adapter: string, server: unknown, override: JsonObject | undefined, diagnostics: Diagnostic[]): DecodeResult {
  const validation = validateServer(server);
  diagnostics.push(...validation.diagnostics.map(item => ({ ...item, adapter })));
  const unsafeOverride = override ? secretDiagnostics(override) : [];
  diagnostics.push(...unsafeOverride.map(item => ({ ...item, adapter })));
  if (override && !unsafeOverride.length) diagnostics.push(diagnostic(adapter, 'native-options', 'Native-only server options are preserved in this adapter override and are not portable to other targets.', 'warning'));
  return {
    ...(validation.server && !diagnostics.some(item => item.severity === 'error') ? { server: validation.server } : {}),
    ...(override && !unsafeOverride.length ? { override } : {}), diagnostics,
  };
}
export function finishEncode(adapter: string, entry: JsonObject, override: JsonObject | undefined, reserved: readonly string[], diagnostics: Diagnostic[]): EncodeResult {
  if (override) {
    diagnostics.push(...secretDiagnostics(override).map(item => ({ ...item, adapter })));
    for (const [key, value] of Object.entries(override)) {
      if (Object.hasOwn(entry, key)) {
        if (!isDeepStrictEqual(entry[key], value)) diagnostics.push(diagnostic(adapter, 'override-conflict', 'A native override conflicts with a projected canonical field.'));
      } else if (reserved.includes(key)) {
        diagnostics.push(diagnostic(adapter, 'override-conflict', 'A native override introduces a conflicting canonical transport or field.'));
      } else {
        own(entry, key, value);
      }
    }
  }
  return diagnostics.some(item => item.severity === 'error') ? { diagnostics } : { entry, diagnostics };
}
export function validateEncoding(adapter: string, server: Server, diagnostics: Diagnostic[]): void {
  diagnostics.push(...validateServer(server).diagnostics.map(item => ({ ...item, adapter })));
}
export type Interpolation = 'claude' | 'copilot';
export function interpolates(value: string, mode: Interpolation): boolean {
  return mode === 'claude' ? /\$\{/.test(value) : /\$\{|\$[A-Za-z_][A-Za-z0-9_]*/.test(value);
}
export function literal(value: unknown, mode: Interpolation, adapter: string, diagnostics: Diagnostic[]): string | undefined {
  if (typeof value !== 'string') { diagnostics.push(diagnostic(adapter, 'invalid-native-value', 'A native string field has an invalid representation.')); return undefined; }
  if (interpolates(value, mode)) { diagnostics.push(diagnostic(adapter, 'unsupported-interpolation', 'Native interpolation in this field cannot be represented as a canonical literal.')); return undefined; }
  return value;
}
export function decodeValues(value: unknown, mode: Interpolation, adapter: string, diagnostics: Diagnostic[]): Record<string, Value> | undefined {
  if (value === undefined) return undefined;
  if (!object(value)) { diagnostics.push(diagnostic(adapter, 'invalid-native-values', 'Native environment or header values must be a string map.')); return undefined; }
  const result: Record<string, Value> = {};
  for (const [name, item] of Object.entries(value)) {
    if (typeof item !== 'string') { diagnostics.push(diagnostic(adapter, 'invalid-native-value', 'Native environment or header values must be strings.')); continue; }
    const reference = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(item) ?? (mode === 'copilot' ? /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(item) : null);
    if (reference) {
      if (mode === 'claude' && reference[1] === 'ANTHROPIC_API_KEY') diagnostics.push(diagnostic(adapter, 'protected-environment-reference', 'Claude does not reliably forward this protected credential reference to MCP servers.'));
      own(result, name, { env: reference[1]! });
    } else if (interpolates(item, mode)) {
      diagnostics.push(diagnostic(adapter, 'unsupported-interpolation', 'Composite or defaulted native interpolation cannot be represented without changing its semantics.'));
    } else own(result, name, item);
  }
  return result;
}
export function encodeValues(value: Record<string, Value> | undefined, mode: Interpolation, adapter: string, diagnostics: Diagnostic[]): JsonObject | undefined {
  if (value === undefined) return undefined;
  const result: Record<string, string> = {};
  for (const [name, item] of Object.entries(value)) {
    if (typeof item === 'string') {
      if (interpolates(item, mode)) diagnostics.push(diagnostic(adapter, 'literal-interpolation', 'A canonical literal would be expanded by this native reader; no verified literal escape is available.'));
      own(result, name, item);
    } else {
      if (mode === 'claude' && item.env === 'ANTHROPIC_API_KEY') diagnostics.push(diagnostic(adapter, 'protected-environment-reference', 'Claude does not reliably forward this protected credential reference to MCP servers.'));
      own(result, name, `\${${item.env}}`);
    }
  }
  return result;
}
export function nativeArgs(value: unknown, mode: Interpolation, adapter: string, diagnostics: Diagnostic[]): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) { diagnostics.push(diagnostic(adapter, 'invalid-native-args', 'Native arguments must be an array of literal strings.')); return undefined; }
  return value.map(item => literal(item, mode, adapter, diagnostics)).filter((item): item is string => item !== undefined);
}
export function encodeLiteralFields(server: Server, mode: Interpolation, adapter: string, diagnostics: Diagnostic[]): void {
  for (const item of server.type === 'stdio' ? [server.command, ...(server.args ?? [])] : [server.url]) {
    if (interpolates(item, mode)) diagnostics.push(diagnostic(adapter, 'literal-interpolation', 'A canonical literal command, argument, or URL would be interpreted by this native reader.'));
  }
}
export function decodeCwd(value: unknown, context: Context, adapter: string, diagnostics: Diagnostic[]): Cwd | undefined {
  if (value === undefined) return undefined;
  const p = paths(context);
  if (typeof value !== 'string' || !p.isAbsolute(value)) {
    diagnostics.push(diagnostic(adapter, 'unsupported-cwd', 'The native working directory has an unresolved relative or expansion-dependent base; it remains native-only.'));
    return undefined;
  }
  const anchors: [Cwd['base'], string][] = [['source', context.canonicalRoot], ...(context.scope === 'project' ? [['project', context.project] as [Cwd['base'], string]] : []), ['home', context.home]];
  for (const [base, root] of anchors) if (contains(context, root, value)) return { base, path: p.relative(root, value).split(p.sep).join('/') || '.' };
  diagnostics.push(diagnostic(adapter, 'unsupported-cwd', 'The native working directory requires an explicit machine-local binding outside canonical anchors.'));
  return undefined;
}
export function encodeCwd(cwd: Cwd, context: Context, adapter: string, diagnostics: Diagnostic[]): string | undefined {
  const p = paths(context);
  if (cwd.base === 'project' && context.scope !== 'project') {
    diagnostics.push(diagnostic(adapter, 'unsupported-cwd', 'A project-relative working directory is valid only in project scope.'));
    return undefined;
  }
  const root = cwd.base === 'project' ? context.project : cwd.base === 'home' ? context.home : context.canonicalRoot;
  const result = p.resolve(root, cwd.path);
  if (p.isAbsolute(cwd.path) || !contains(context, root, result) || cwd.path.includes('\\')) {
    diagnostics.push(diagnostic(adapter, 'invalid-cwd', 'The working directory must be a contained portable relative path.'));
    return undefined;
  }
  return result;
}
export function defaultCwdWarning(adapter: string, diagnostics: Diagnostic[]): void {
  diagnostics.push(diagnostic(adapter, 'native-cwd-default', 'Omitted working directory retains the native session-dependent default; cross-target working-directory equivalence is not established.', 'warning'));
}
