import { readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { AuthorityConfig, Context, Finding, LoadedState, OwnershipState, PathSnapshot, SourceRef, TransactionJournal } from './model.js';
import { filesystemFinding, hashBytes, snapshotMatches, snapshotPath } from './fs/snapshot.js';
import { isRecord } from './resources/jsonc.js';

export interface StatePaths { preferencePath: string; ownershipPath: string; transactionRoot: string; lockPath: string }
export async function getStatePaths(context: Context, configuration: 'project' | 'private-project' | 'user' = 'private-project'): Promise<StatePaths> {
  const root = await realpath(context.projectRoot);
  const appConfig = join(context.configHome, 'mishmash');
  const appState = join(context.stateHome, 'mishmash');
  const preferencePath = configuration === 'project' ? join(root, '.mishmash', 'sources.json')
    : configuration === 'user' ? join(appConfig, 'sources.json')
      : join(appConfig, 'projects', `${hashBytes(root)}.json`);
  return { preferencePath, ownershipPath: join(appState, 'ownership.json'), transactionRoot: join(appState, 'transactions'), lockPath: join(appState, 'apply.lock') };
}
const agents = new Set(['claude-code', 'codex', 'github-copilot-cli', 'pi', 'opencode', 'gemini-cli', 'shared']);
function isSource(value: unknown): value is SourceRef {
  return isRecord(value) && typeof value.id === 'string' && typeof value.path === 'string'
    && typeof value.agentId === 'string' && agents.has(value.agentId) && typeof value.label === 'string'
    && (value.scope === 'project' || value.scope === 'user') && (value.visibility === 'private' || value.visibility === 'shared');
}
export function decodeAuthorityConfig(value: unknown): AuthorityConfig {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.sources) || !value.sources.every(isSource)
    || !isRecord(value.resourceAuthorities) || !Object.values(value.resourceAuthorities).every(item => typeof item === 'string')) throw new Error('Invalid authority configuration.');
  return value as unknown as AuthorityConfig;
}
export function decodeOwnershipState(value: unknown): OwnershipState {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.receipts)) throw new Error('Invalid ownership record.');
  for (const receipt of value.receipts) {
    if (!isRecord(receipt) || !['slotId', 'path', 'key', 'sourceId', 'resourceId', 'fingerprint'].every(key => typeof receipt[key] === 'string')
      || (receipt.kind !== 'skill' && receipt.kind !== 'mcp')) throw new Error('Invalid ownership record.');
  }
  return value as unknown as OwnershipState;
}
export function decodeJournal(value: unknown): TransactionJournal {
  if (!isRecord(value) || value.version !== 1 || typeof value.id !== 'string' || !isRecord(value.context)
    || !['projectRoot', 'homeDir', 'configHome', 'stateHome'].every(key => typeof (value.context as Record<string, unknown>)[key] === 'string')
    || !['prepared', 'applying', 'committed', 'recovering', 'recovered', 'recovery-required'].includes(String(value.status)) || !Array.isArray(value.entries)) throw new Error('Invalid recovery journal.');
  for (const entry of value.entries) {
    if (!isRecord(entry) || typeof entry.path !== 'string' || !isRecord(entry.before)
      || !['write', 'mkdir', 'symlink', 'remove', 'chmod'].includes(String(entry.operation))
      || !['prepared', 'intent', 'replaced', 'restored'].includes(String(entry.state))) throw new Error('Invalid recovery journal.');
  }
  return value as unknown as TransactionJournal;
}
function encode(value: unknown): Uint8Array { return Buffer.from(`${JSON.stringify(value, null, 2)}\n`); }
export function encodeAuthorityConfig(value: AuthorityConfig): Uint8Array { return encode(decodeAuthorityConfig(value)); }
export function encodeOwnershipState(value: OwnershipState): Uint8Array { return encode(decodeOwnershipState(value)); }
export function encodeJournal(value: TransactionJournal): Uint8Array { return encode(decodeJournal(value)); }
async function readRecord<T>(path: string, decode: (value: unknown) => T): Promise<{ value?: T; snapshot: PathSnapshot; findings: Finding[] }> {
  const snapshot = await snapshotPath(path);
  if (snapshot.kind === 'missing') return { snapshot, findings: [] };
  if (snapshot.kind !== 'file') return { snapshot, findings: [filesystemFinding(path, 'UNSAFE_STATE_PATH')] };
  try {
    const value = decode(JSON.parse(await readFile(path, 'utf8')) as unknown);
    if (!await snapshotMatches(snapshot)) return { snapshot, findings: [filesystemFinding(path, 'STATE_CHANGED')] };
    return { value, snapshot, findings: [] };
  } catch { return { snapshot, findings: [filesystemFinding(path, 'INVALID_STATE')] }; }
}
export async function readState(context: Context, configuration: 'project' | 'private-project' | 'user' = 'private-project'): Promise<LoadedState> {
  const paths = await getStatePaths(context, configuration);
  const preferences = await readRecord(paths.preferencePath, decodeAuthorityConfig);
  const ownership = await readRecord(paths.ownershipPath, decodeOwnershipState);
  return {
    choices: preferences.value,
    ownership: ownership.value ?? { version: 1, receipts: [] },
    preferencePath: resolve(paths.preferencePath), ownershipPath: resolve(paths.ownershipPath),
    snapshots: [preferences.snapshot, ownership.snapshot], findings: [...preferences.findings, ...ownership.findings],
  };
}
