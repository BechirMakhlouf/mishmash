import { readFile } from 'node:fs/promises';
import { applyEdits, getNodeValue, modify, parseTree, type Node, type ParseError, type JSONPath } from 'jsonc-parser';
import type { Finding, PathSnapshot } from '../model.js';
import { filesystemFinding, snapshotMatches, snapshotPath } from '../fs/snapshot.js';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function hasDuplicateKeys(node: Node): boolean {
  if (node.type === 'object') {
    const keys = new Set<string>();
    for (const property of node.children ?? []) {
      const key: unknown = property.children?.[0]?.value;
      if (typeof key !== 'string' || keys.has(key)) return true;
      keys.add(key);
    }
  }
  return node.children?.some(hasDuplicateKeys) ?? false;
}
export interface JsonDocument { path: string; text: string; value: Record<string, unknown>; snapshot: PathSnapshot; findings: readonly Finding[] }
export async function readJsonDocument(path: string): Promise<JsonDocument> {
  const snapshot = await snapshotPath(path);
  if (snapshot.kind === 'missing') return { path, text: '', value: {}, snapshot, findings: [] };
  if (snapshot.kind !== 'file') return { path, text: '', value: {}, snapshot, findings: [filesystemFinding(path, 'UNSAFE_CONFIG_PATH')] };
  try {
    const text = await readFile(path, 'utf8');
    const errors: ParseError[] = [];
    const tree = parseTree(text, errors, { allowTrailingComma: true, disallowComments: false });
    if (errors.length || !tree || hasDuplicateKeys(tree)) return { path, text: '', value: {}, snapshot, findings: [filesystemFinding(path, 'INVALID_NATIVE_CONFIG')] };
    const value: unknown = getNodeValue(tree);
    if (!isRecord(value)) return { path, text: '', value: {}, snapshot, findings: [filesystemFinding(path, 'INVALID_NATIVE_CONFIG')] };
    if (!await snapshotMatches(snapshot)) return { path, text: '', value: {}, snapshot, findings: [filesystemFinding(path, 'SOURCE_CHANGED')] };
    return { path, text, value, snapshot, findings: [] };
  } catch { return { path, text: '', value: {}, snapshot, findings: [filesystemFinding(path)] }; }
}
export function editJsonDocument(text: string, changes: readonly { path: JSONPath; value: unknown }[]): Uint8Array {
  let result = text.trim() ? text : '{}\n';
  for (const change of changes) {
    result = applyEdits(result, modify(result, change.path, change.value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' } }));
  }
  return Buffer.from(result.endsWith('\n') ? result : `${result}\n`);
}
