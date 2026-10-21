import { readFile, lstat } from 'node:fs/promises';
import { parseTree, modify, applyEdits, type Node as JsonNode, type ParseError, type ParseOptions } from 'jsonc-parser';
import * as TOML from 'smol-toml';
import { parseTOML, type AST } from 'toml-eslint-parser';
import type { JsonObject, NativeFile } from './types.js';

export interface Document { spec: NativeFile; text: string; data: JsonObject; map: JsonObject; mapPath: string[] }
export function object(value: unknown): value is JsonObject { return value !== null && typeof value === 'object' && !Array.isArray(value); }
export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function pretty(value: unknown): string { return JSON.stringify(value, null, 2) + '\n'; }
export function parseJsonDocument(text: string, options: ParseOptions = {}): unknown {
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, options);
  if (!tree || errors.length) throw new Error('Invalid native JSON configuration');
  function value(node: JsonNode): unknown {
    if (node.type === 'array') return (node.children ?? []).map(value);
    if (node.type !== 'object') return node.value;
    const result: JsonObject = {};
    for (const property of node.children ?? []) {
      const [key, child] = property.children!;
      if (Object.hasOwn(result, key.value)) throw new Error('Duplicate native JSON key');
      Object.defineProperty(result, key.value, { value: value(child), enumerable: true, writable: true, configurable: true });
    }
    return result;
  }
  return value(tree);
}
export async function readDocument(spec: NativeFile, allowBare = false): Promise<Document> {
  let text = '';
  try {
    if ((await lstat(spec.path)).isSymbolicLink()) throw new Error('Native configuration symlinks are not safe generated artifacts');
    text = await readFile(spec.path, 'utf8');
  } catch (error) { if (!object(error) || error.code !== 'ENOENT') throw error; }
  let data: unknown = {};
  if (text.trim()) {
    if (spec.format === 'toml') data = TOML.parse(text);
    else data = parseJsonDocument(text, { allowTrailingComma: spec.format === 'jsonc', disallowComments: spec.format === 'json' });
  }
  if (!object(data)) throw new Error('Native configuration must be an object');
  let mapPath = spec.mapPath;
  if (allowBare && text.trim() && !Object.hasOwn(data, 'mcpServers') && Object.values(data).every(item => object(item) && ['command', 'url', 'type'].some(key => Object.hasOwn(item, key)))) mapPath = [];
  let node: unknown = data;
  for (const key of mapPath) {
    if (!object(node)) throw new Error('Native server map parent must be an object');
    node = Object.hasOwn(node, key) ? node[key] : undefined;
    if (node === undefined) break;
  }
  if (node !== undefined && !object(node)) throw new Error('Native server map must be an object');
  return { spec, text, data, map: (node as JsonObject | undefined) ?? {}, mapPath };
}

function inlineToml(value: unknown): string {
  // Wrapping in nested arrays asks the codec for an inline value without
  // relying on its formatting or importing an internal serialization API.
  const text = TOML.stringify({ value: [[value]] });
  const entry = parseTOML(text, { tomlVersion: '1.0' }).body[0].body[0];
  if (entry.type !== 'TOMLKeyValue' || entry.value.type !== 'TOMLArray') throw new Error('Invalid serialized TOML value');
  const inner = entry.value.elements[0];
  if (inner.type !== 'TOMLArray' || inner.elements.length !== 1) throw new Error('Invalid serialized TOML value');
  const node = inner.elements[0];
  return text.slice(node.range[0], node.range[1]);
}

// Replace only the selected native server keys. JSONC edits preserve every unrelated
// field/comment; TOML edits replace complete selected server tables, not the file.
export function patchDocument(doc: Document, updates: Map<string, JsonObject | undefined>): string {
  if (doc.spec.format !== 'toml') {
    let text = doc.text.trim() ? doc.text : '{}\n';
    for (const [id, entry] of [...updates].sort(([a], [b]) => a.localeCompare(b))) {
      text = applyEdits(text, modify(text, [...doc.mapPath, id], entry, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: doc.text.includes('\r\n') ? '\r\n' : '\n' } }));
    }
    return text.endsWith('\n') ? text : text + '\n';
  }
  const expected = { ...doc.data };
  let map = expected;
  for (const key of doc.mapPath) {
    const child = Object.hasOwn(map, key) ? map[key] : undefined;
    if (child !== undefined && !object(child)) throw new Error('Native server map parent must be an object');
    const copy = { ...(child as JsonObject | undefined) };
    Object.defineProperty(map, key, { value: copy, enumerable: true, writable: true, configurable: true });
    map = copy;
  }
  for (const [id, entry] of updates) {
    if (entry === undefined) delete map[id];
    else Object.defineProperty(map, id, { value: entry, enumerable: true, writable: true, configurable: true });
  }
  const ast = parseTOML(doc.text, { tomlVersion: '1.0' });
  const edits: { start: number; end: number; text: string }[] = [];
  const pending = new Map(updates);
  const prefix = (parent: (string | number)[], child: (string | number)[]): boolean => parent.length <= child.length && parent.every((key, index) => key === child[index]);
  const selected = (keys: (string | number)[]): boolean => prefix(doc.mapPath, keys) && keys.length > doc.mapPath.length && updates.has(String(keys[doc.mapPath.length]));
  const keyPath = (entry: AST.TOMLKeyValue): string[] => entry.key.keys.map(key => key.type === 'TOMLBare' ? key.name : key.value);
  function patchInline(table: AST.TOMLInlineTable, parent: (string | number)[]): string {
    const parts: string[] = [];
    let nested = false;
    for (const entry of table.body) {
      const keys = [...parent, ...keyPath(entry)];
      if (selected(keys)) continue;
      if (prefix(keys, doc.mapPath)) {
        if (entry.value.type !== 'TOMLInlineTable') throw new Error('Native server map parent must be a table');
        parts.push(doc.text.slice(entry.range[0], entry.value.range[0]) + patchInline(entry.value, keys));
        nested = true;
      } else parts.push(doc.text.slice(entry.range[0], entry.range[1]));
    }
    if (!nested) {
      const remaining = doc.mapPath.slice(parent.length);
      for (const [id, entry] of updates) if (entry !== undefined) parts.push([...remaining, id].map(key => JSON.stringify(key)).join('.') + ' = ' + inlineToml(entry));
      if (remaining.length && !Object.keys(map).length) parts.push(remaining.map(key => JSON.stringify(key)).join('.') + ' = {}');
    }
    return `{ ${parts.join(', ')} }`;
  }
  function visit(entry: AST.TOMLKeyValue, parent: (string | number)[]): void {
    const keys = [...parent, ...keyPath(entry)];
    if (selected(keys)) {
      edits.push({ start: entry.range[0], end: entry.range[1], text: '' });
    } else if (prefix(keys, doc.mapPath)) {
      if (entry.value.type !== 'TOMLInlineTable') throw new Error('Native server map parent must be a table');
      edits.push({ start: entry.value.range[0], end: entry.value.range[1], text: patchInline(entry.value, keys) });
      pending.clear();
    }
  }
  for (const entry of ast.body[0].body) {
    if (entry.type === 'TOMLKeyValue') visit(entry, []);
    else if (selected(entry.resolvedKey)) edits.push({ start: entry.range[0], end: entry.range[1], text: '' });
    else for (const child of entry.body) visit(child, entry.resolvedKey);
  }
  let output = doc.text;
  for (const edit of edits.sort((a, b) => b.start - a.start)) output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
  for (const [id, entry] of [...pending].sort(([a], [b]) => a.localeCompare(b))) {
    if (!entry) continue;
    let data: JsonObject = { [id]: entry };
    for (const key of [...doc.mapPath].reverse()) data = { [key]: data };
    output = output.replace(/\s*$/, '\n\n') + TOML.stringify(data);
  }
  let parsed = TOML.parse(output);
  let actual: unknown = parsed;
  for (const key of doc.mapPath) actual = object(actual) ? actual[key] : undefined;
  if (actual === undefined && Object.keys(map).length === 0 && doc.mapPath.length) {
    let empty: JsonObject = {};
    for (const key of [...doc.mapPath].reverse()) empty = { [key]: empty };
    output += '\n' + TOML.stringify(empty);
    parsed = TOML.parse(output);
  }
  if (stable(parsed) !== stable(expected)) throw new Error('Native TOML patch would change unrelated configuration');
  return output;
}
