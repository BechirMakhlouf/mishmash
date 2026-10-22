import { lstat, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { NativeAdapter, PreparedFileEdit, PreparedMcpTarget } from '../agents/contract.js';
import { nativeAdapters } from '../agents/index.js';
import type {
  AuthorityConfig, Context, DestinationRequest, Finding, Inventory, LoadedState, McpResource,
  Operation, PathSnapshot, Plan, PlanSummary, ResourceInstance, SkillResource, SourceRef, SyncRequest,
  TreeEntry, OwnershipReceipt,
} from '../model.js';
import { errorCode, fingerprintValue, isWithin, snapshotMatches, snapshotPath, snapshotsEqual } from '../fs/snapshot.js';
import { encodeAuthorityConfig, encodeOwnershipState, getStatePaths } from '../state.js';
import { resolveAuthority } from './authority.js';
import { resolveSelection } from './selection.js';

function issue(code: string, message: string, path?: string, resourceId?: string, remediation = 'Review the selected source and destination, then rediscover.'): Finding {
  return { severity: 'error', code, message, ...(path ? { path } : {}), ...(resourceId ? { resourceId } : {}), remediation };
}
function warning(code: string, message: string, path?: string, resourceId?: string): Finding {
  return { severity: 'warning', code, message, ...(path ? { path } : {}), ...(resourceId ? { resourceId } : {}) };
}
function sortedFindings(findings: readonly Finding[]): Finding[] {
  const unique = new Map<string, Finding>();
  for (const finding of findings) {
    unique.set(JSON.stringify([finding.severity, finding.code, finding.path ?? '', finding.resourceId ?? '', finding.message, finding.remediation ?? '']), finding);
  }
  return [...unique.values()].sort((a, b) => a.severity.localeCompare(b.severity) || a.code.localeCompare(b.code)
    || (a.path ?? '').localeCompare(b.path ?? '') || (a.resourceId ?? '').localeCompare(b.resourceId ?? '') || a.message.localeCompare(b.message));
}
function canonicalChoices(config: AuthorityConfig): AuthorityConfig {
  const sources = [...new Map(config.sources.map(source => [source.id, source])).values()]
    .sort((a, b) => a.id.localeCompare(b.id));
  const resourceAuthorities = Object.fromEntries(Object.entries(config.resourceAuthorities).sort(([a], [b]) => a.localeCompare(b)));
  return { version: 1, sources, resourceAuthorities };
}
function sameBytes(a: Uint8Array, b: Uint8Array): boolean { return Buffer.from(a).equals(Buffer.from(b)); }
function uniqueSnapshots(snapshots: readonly PathSnapshot[], findings: Finding[]): PathSnapshot[] {
  const byPath = new Map<string, PathSnapshot>();
  for (const snapshot of snapshots) {
    const previous = byPath.get(snapshot.path);
    if (previous && !snapshotsEqual(previous, snapshot)) {
      findings.push(issue('INCONSISTENT_PRECONDITION', 'A planned path has inconsistent reviewed snapshots.', snapshot.path));
    } else if (!previous) byPath.set(snapshot.path, snapshot);
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}
async function realRoot(path: string): Promise<string> { return resolve(await realpath(path)); }
async function projectedRoot(path: string): Promise<string> {
  const suffix: string[] = [];
  let current = resolve(path);
  for (;;) {
    try { return resolve(await realpath(current), ...suffix); }
    catch (error) {
      if (errorCode(error) !== 'ENOENT' && errorCode(error) !== 'ENOTDIR') throw error;
      let exists = false;
      try { await lstat(current); exists = true; }
      catch (statError) { if (errorCode(statError) !== 'ENOENT') throw statError; }
      if (exists) throw new Error('An existing approved root could not be resolved safely.');
      const parent = dirname(current);
      if (parent === current) throw error;
      suffix.unshift(basename(current));
      current = parent;
    }
  }
}

async function resolvedParent(path: string): Promise<string> {
  const suffix: string[] = [];
  let current = dirname(resolve(path));
  for (;;) {
    try { return resolve(await realpath(current), ...suffix); }
    catch (error) {
      if (errorCode(error) !== 'ENOENT' && errorCode(error) !== 'ENOTDIR') throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      suffix.unshift(relative(parent, current));
      current = parent;
    }
  }
}

async function inspectScopedPath(path: string, roots: readonly string[], allowFinalLink = false): Promise<{ snapshot?: PathSnapshot; safe: boolean }> {
  const absolute = resolve(path);
  if (!roots.some(root => isWithin(root, absolute))) return { safe: false };
  try {
    const snapshot = await snapshotPath(absolute);
    const parent = await resolvedParent(absolute);
    const parentEntries = snapshot.parents.filter(entry => entry.path !== absolute);
    const validParents = parentEntries.every(entry => entry.kind === 'directory' || entry.kind === 'symlink');
    const safeParent = roots.some(root => isWithin(root, parent));
    const safeTarget = snapshot.kind === 'symlink' ? allowFinalLink
      : roots.some(root => isWithin(root, snapshot.resolvedPath));
    return { snapshot, safe: safeParent && safeTarget && validParents };
  } catch { return { safe: false }; }
}
async function addPhysicalPrecondition(builder: PlanBuilder, snapshot: PathSnapshot, canonical?: PathSnapshot): Promise<void> {
  if (snapshot.kind === 'symlink' || resolve(snapshot.path) === resolve(snapshot.resolvedPath)) {
    builder.addPrecondition(snapshot);
    return;
  }
  for (const parent of snapshot.parents) {
    if (parent.kind !== 'symlink') continue;
    const alias = await snapshotPath(parent.path);
    if (alias.kind !== 'symlink' || alias.linkTarget !== parent.linkTarget) {
      builder.findings.push(issue('DESTINATION_CHANGED', 'A destination symlink changed while its physical location was being reviewed.', parent.path));
      return;
    }
    builder.addPrecondition(alias);
  }
  const physical = canonical ?? await snapshotPath(snapshot.resolvedPath);
  if (physical.kind !== snapshot.kind || physical.digest !== snapshot.digest || physical.mode !== snapshot.mode
    || resolve(physical.resolvedPath) !== resolve(snapshot.resolvedPath)) {
    builder.findings.push(issue('DESTINATION_CHANGED', 'A destination changed while its physical location was being reviewed.', snapshot.path));
    return;
  }
  builder.addPrecondition(physical);
}

function skillSlot(path: string): string { return fingerprintValue([resolve(path), 'skill']); }
function skillFingerprint(snapshot: PathSnapshot): string {
  return snapshot.kind === 'symlink'
    ? fingerprintValue(['symlink', snapshot.linkTarget ?? '', resolve(snapshot.resolvedPath)]) : snapshot.digest;
}
function relativeLinkTarget(parent: string, to: string): string {
  return relative(parent, to) || basename(to);
}
async function physicalEntryPath(path: string, snapshot: PathSnapshot): Promise<string> {
  return snapshot.kind === 'symlink' ? resolve(await resolvedParent(path), basename(path)) : resolve(snapshot.resolvedPath);
}
function invalidSkillName(name: string): boolean {
  return !name.trim() || name === '.' || name === '..' || isAbsolute(name) || name.includes('/') || name.includes('\\') || name.includes('\0');
}
function operationKey(operation: Operation): string {
  return operation.expected.kind === 'symlink' ? resolve(operation.path) : resolve(operation.expected.resolvedPath);
}
function operationComparable(operation: Operation): unknown {
  const { resourceIds: _resourceIds, description: _description, ...rest } = operation;
  return rest;
}
function sameMkdirIntent(first: Operation, second: Operation): boolean {
  return first.kind === 'mkdir' && second.kind === 'mkdir' && first.mode === second.mode
    && first.expected.kind === 'missing' && second.expected.kind === 'missing'
    && resolve(first.expected.resolvedPath) === resolve(second.expected.resolvedPath);
}

class PlanBuilder {
  readonly findings: Finding[];
  readonly operations: Operation[] = [];
  readonly preconditions: PathSnapshot[] = [];
  readonly destinationPaths = new Map<string, Set<string>>();
  additions = 0;
  updates = 0;
  removals = 0;
  unchanged = 0;

  constructor(findings: readonly Finding[]) { this.findings = [...findings]; }

  addPrecondition(snapshot: PathSnapshot): void { this.preconditions.push(snapshot); }

  addOperation(operation: Operation): void {
    const path = resolve(operation.path);
    const normalized = { ...operation, path } as Operation;
    const key = operationKey(normalized);
    const existing = this.operations.find(item => operationKey(item) === key);
    if (existing) {
      const identical = fingerprintValue(operationComparable(existing)) === fingerprintValue(operationComparable(normalized));
      const sharedDirectory = sameMkdirIntent(existing, normalized);
      if (!identical && !sharedDirectory) {
        this.findings.push(issue('DESTINATION_SLOT_CONFLICT', 'Selected resources require incompatible writes to the same destination.', path));
      } else {
        const resourceIds = [...new Set([...existing.resourceIds, ...normalized.resourceIds])].sort();
        const purpose = existing.purpose === 'resource' || normalized.purpose === 'resource' ? 'resource' : 'state';
        const index = this.operations.indexOf(existing);
        this.operations[index] = { ...existing, resourceIds, purpose } as Operation;
      }
      return;
    }
    this.operations.push(normalized);
  }

  destination(request: DestinationRequest, path: string): void {
    const key = `${request.agentId}\0${request.placement}`;
    const paths = this.destinationPaths.get(key) ?? new Set<string>();
    paths.add(resolve(path));
    this.destinationPaths.set(key, paths);
  }
}

function pathDepth(path: string): number { return resolve(path).split(sep).filter(Boolean).length; }
function compareOperations(a: Operation, b: Operation): number {
  const aRemove = a.kind === 'remove';
  const bRemove = b.kind === 'remove';
  if (aRemove !== bRemove) return aRemove ? 1 : -1;
  const depth = pathDepth(a.path) - pathDepth(b.path);
  if (depth !== 0) return aRemove ? -depth : depth;
  return a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind);
}
function orderOperations(operations: readonly Operation[], findings: Finding[]): Operation[] {
  const result: Operation[] = [];
  for (const purpose of ['resource', 'state'] as const) {
    const group = operations.filter(operation => operation.purpose === purpose);
    result.push(...group.filter(operation => operation.kind !== 'symlink').sort(compareOperations));
    const pending = new Map(group.filter((operation): operation is Extract<Operation, { kind: 'symlink' }> => operation.kind === 'symlink')
      .map(operation => [resolve(operation.path), operation]));
    while (pending.size) {
      const ready = [...pending.entries()].filter(([, operation]) =>
        !pending.has(resolve(dirname(operation.path), operation.target)))
        .sort(([a], [b]) => a.localeCompare(b));
      if (!ready.length) {
        const path = [...pending.keys()].sort()[0]!;
        findings.push(issue('SKILL_LINK_CYCLE', 'Planned skill links contain a dependency cycle.', path));
        result.push(...[...pending.values()].sort((a, b) => a.path.localeCompare(b.path)));
        break;
      }
      for (const [path, operation] of ready) {
        result.push(operation);
        pending.delete(path);
      }
    }
  }
  return result;
}

async function addDirsForDestination(builder: PlanBuilder, directory: string, boundary: string, expectedByPath: Map<string, PathSnapshot>, resourceIds: readonly string[], purpose: 'resource' | 'state' = 'resource', directoryMode = 0o755): Promise<void> {
  const missing: { path: string; snapshot: PathSnapshot }[] = [];
  let current = resolve(directory);
  const root = resolve(boundary);
  while (isWithin(root, current)) {
    const snapshot = expectedByPath.get(current) ?? await snapshotPath(current);
    builder.addPrecondition(snapshot);
    if (snapshot.kind === 'directory') break;
    if (snapshot.kind !== 'missing') break;
    missing.push({ path: current, snapshot });
    if (current === root) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const { path, snapshot } of missing.reverse()) {
    builder.addOperation({ kind: 'mkdir', path, expected: snapshot, mode: directoryMode,
      resourceIds, purpose, description: 'Create a destination directory.' });
  }
}

async function skillPlan(
  builder: PlanBuilder,
  resource: SkillResource,
  destination: DestinationRequest,
  adapter: NativeAdapter,
  mode: 'copy' | 'link',
  destinationRoot: string,
  destinationScope: 'project' | 'user',
  destinationVisibility: 'shared' | 'private',
  roots: readonly string[],
  directoryMode: number,
  receipts: ReadonlyMap<string, OwnershipReceipt>,
  nextReceipts: Map<string, OwnershipReceipt>,
): Promise<void> {
  const directoryName = basename(resource.path);
  if (invalidSkillName(directoryName)) {
    builder.findings.push(issue('INVALID_SKILL_NAME', 'A selected skill directory cannot be used as a safe destination name.', resource.path, resource.id));
    return;
  }
  if (resource.name !== directoryName) {
    builder.findings.push(issue('SKILL_NAME_DIRECTORY_MISMATCH', 'A skill metadata name must match its native directory name.', resource.path, resource.id,
      'Correct the SKILL.md name to match this directory, then rediscover.'));
    return;
  }


  if (resource.source.visibility === 'private' && (destination.placement === 'project' || destination.placement === 'user')
    && !(resource.source.scope === 'user' && destination.placement === 'user')) {
    builder.findings.push(issue('PRIVATE_RESOURCE_PUBLICATION', 'A private skill cannot be published to this destination scope.', resource.path, resource.id));
    return;
  }
  if (mode === 'link' && !adapter.capabilities.links) {
    builder.findings.push(issue('UNSUPPORTED_SKILL_LINK', 'This destination does not support linked skills.', destinationRoot, resource.id));
    return;
  }
  if (!await snapshotMatches(resource.snapshot)) {
    builder.findings.push(issue('STALE_SOURCE', 'A selected skill changed after discovery.', resource.path, resource.id));
    return;
  }
  builder.addPrecondition(resource.snapshot);
  const target = resolve(destinationRoot, directoryName);
  const checked = await inspectScopedPath(target, roots, true);
  if (!checked.safe || !checked.snapshot) {
    builder.findings.push(issue('UNSAFE_DESTINATION_PATH', 'A skill destination escapes its approved scope or crosses an unsafe parent.', target, resource.id));
    return;
  }
  const current = checked.snapshot;
  builder.addPrecondition(current);
  const slotPath = await physicalEntryPath(target, current);
  const slotId = skillSlot(slotPath);
  const receipt = receipts.get(slotId);
  const desiredLink = relativeLinkTarget(await resolvedParent(target), resource.path);
  const desiredFingerprint = mode === 'link'
    ? fingerprintValue(['symlink', desiredLink, resolve(resource.path)]) : resource.snapshot.digest;


  if (await sameDiscoveredRoot(resource, destinationRoot, destinationScope, destinationVisibility)) {
    builder.destination(destination, target);
    builder.unchanged++;
    return;
  }
  if (receipt) {
    if (receipt.kind !== 'skill' || resolve(receipt.path) !== slotPath || receipt.key !== directoryName || skillFingerprint(current) !== receipt.fingerprint) {
      builder.findings.push(issue('OWNED_OUTPUT_DRIFT', 'A selected managed skill destination changed since its last receipt.', target, resource.id));
      return;
    }
  } else if (current.kind !== 'missing') {
    const identical = mode === 'copy' ? current.kind === 'directory' && current.digest === desiredFingerprint
      : current.kind === 'symlink' && current.linkTarget === desiredLink && resolve(current.resolvedPath) === resolve(resource.path);
    builder.destination(destination, target);
    if (identical) { builder.unchanged++; return; }
    builder.findings.push(issue('UNMANAGED_DESTINATION_COLLISION', 'A different unmanaged skill already occupies the selected destination.', target, resource.id));
    return;
  }

  builder.destination(destination, target);
  if (receipt || current.kind === 'missing') {
    nextReceipts.set(slotId, {
      slotId, path: slotPath, kind: 'skill', key: directoryName, sourceId: resource.source.id,
      resourceId: resource.id, fingerprint: desiredFingerprint,
    });
  }
  if (current.kind === 'symlink' && mode !== 'link' || current.kind === 'directory' && mode === 'link') {
    builder.findings.push(issue('OWNED_OUTPUT_KIND_CHANGED', 'The managed skill destination has a different copy/link form than the requested output.', target, resource.id));
    return;
  }
  const desiredEntries = resource.snapshot.entries;
  if (mode === 'link') {
    if (current.kind === 'symlink' && skillFingerprint(current) === desiredFingerprint) {
      if (receipt) builder.unchanged++;
      else builder.unchanged++;
    } else {
      const parent = dirname(target);
      const parentCheck = await inspectScopedPath(parent, roots);
      if (!parentCheck.safe || !parentCheck.snapshot) {
        builder.findings.push(issue('UNSAFE_DESTINATION_PATH', 'A skill destination parent escapes its approved scope.', parent, resource.id));
        return;
      }
      builder.addPrecondition(parentCheck.snapshot);
      await addDirsForDestination(builder, parent, roots.find(root => isWithin(root, parent)) ?? roots[0]!, new Map([[parent, parentCheck.snapshot]]), [resource.id], 'resource', directoryMode);
      builder.addOperation({ kind: 'symlink', path: target, expected: current, target: desiredLink,
        resourceIds: [resource.id], purpose: 'resource', description: `Link skill ${resource.name} to its authoritative source.` });
      if (receipt) builder.updates++; else builder.additions++;
    }
    return;
  }

  if (current.kind === 'missing') {
    const parent = dirname(target);
    const parentCheck = await inspectScopedPath(parent, roots);
    if (!parentCheck.safe || !parentCheck.snapshot) {
      builder.findings.push(issue('UNSAFE_DESTINATION_PATH', 'A skill destination parent escapes its approved scope.', parent, resource.id));
      return;
    }
    builder.addPrecondition(parentCheck.snapshot);
    const expectedByPath = new Map<string, PathSnapshot>([[parentCheck.snapshot.path, parentCheck.snapshot], [target, current]]);
    for (const entry of desiredEntries) {
      const entryPath = entry.relativePath ? resolve(target, ...entry.relativePath.split('/')) : target;
      if (!isWithin(target, entryPath)) {
        builder.findings.push(issue('UNSAFE_SKILL_TREE', 'A skill entry escapes its destination directory.', entryPath, resource.id));
        return;
      }
      if (entryPath !== target) {
        const snapshot = await snapshotPath(entryPath);
        expectedByPath.set(entryPath, snapshot);
        builder.addPrecondition(snapshot);
      }
    }
    await addDirsForDestination(builder, parent, roots.find(root => isWithin(root, parent)) ?? roots[0]!, expectedByPath, [resource.id], 'resource', directoryMode);
    for (const entry of desiredEntries) {
      const path = entry.relativePath ? resolve(target, ...entry.relativePath.split('/')) : target;
      const expected = expectedByPath.get(path) ?? current;
      if (entry.kind === 'directory') {
        builder.addOperation({ kind: 'mkdir', path, expected, mode: entry.mode,
          resourceIds: [resource.id], purpose: 'resource', description: `Create skill directory ${resource.name}.` });
      } else if (entry.kind === 'file') {
        const sourcePath = entry.relativePath ? resolve(resource.path, ...entry.relativePath.split('/')) : resource.path;
        const sourceSnapshot = await snapshotPath(sourcePath);
        if (sourceSnapshot.kind !== 'file') {
          builder.findings.push(issue('STALE_SOURCE', 'A selected skill file changed after discovery.', sourcePath, resource.id));
          return;
        }
        builder.addPrecondition(sourceSnapshot);
        builder.addOperation({ kind: 'write', path, expected,
          content: { kind: 'source', path: sourcePath, snapshot: sourceSnapshot }, mode: entry.mode,
          resourceIds: [resource.id], purpose: 'resource', description: `Copy skill file ${resource.name}.` });
      } else if (entry.kind === 'symlink' && entry.linkTarget !== undefined) {
        builder.addOperation({ kind: 'symlink', path, expected, target: entry.linkTarget,
          resourceIds: [resource.id], purpose: 'resource', description: `Copy internal skill link ${resource.name}.` });
      } else {
        builder.findings.push(issue('UNSUPPORTED_SKILL_ENTRY', 'A selected skill contains an unsupported filesystem entry.', sourcePathForEntry(resource.path, entry), resource.id));
        return;
      }
    }
    if (receipt) builder.updates++; else builder.additions++;
    return;
  }

  if (current.kind !== 'directory') {
    builder.findings.push(issue('OWNED_OUTPUT_KIND_CHANGED', 'The managed skill destination is not a directory.', target, resource.id));
    return;
  }
  const currentByPath = new Map(current.entries.map(entry => [entry.relativePath, entry]));
  const desiredByPath = new Map(desiredEntries.map(entry => [entry.relativePath, entry]));
  const obsolete = current.entries.filter(entry => entry.relativePath && !desiredByPath.has(entry.relativePath));
  const obsoleteSet = new Set(obsolete.map(entry => entry.relativePath));
  for (const entry of obsolete) {
    const parent = entry.relativePath.includes('/') ? entry.relativePath.slice(0, entry.relativePath.lastIndexOf('/')) : '';
    if (obsoleteSet.has(parent)) continue;
    const path = resolve(target, ...entry.relativePath.split('/'));
    const snapshot = await snapshotPath(path);
    builder.addPrecondition(snapshot);
    builder.addOperation({ kind: 'remove', path, expected: snapshot, resourceIds: [resource.id], purpose: 'resource',
      description: `Remove obsolete owned skill entry ${entry.relativePath}.` });
    builder.removals++;
  }
  for (const entry of desiredEntries) {
    const path = entry.relativePath ? resolve(target, ...entry.relativePath.split('/')) : target;
    if (!isWithin(target, path)) {
      builder.findings.push(issue('UNSAFE_SKILL_TREE', 'A skill entry escapes its destination directory.', path, resource.id));
      return;
    }
    const existingEntry = currentByPath.get(entry.relativePath);
    const expected = entry.relativePath === '' ? current : await snapshotPath(path);
    builder.addPrecondition(expected);
    if (!existingEntry) {
      if (entry.kind === 'directory') builder.addOperation({ kind: 'mkdir', path, expected, mode: entry.mode,
        resourceIds: [resource.id], purpose: 'resource', description: `Create skill directory ${resource.name}.` });
      else if (entry.kind === 'file') {
        const sourcePath = resolve(resource.path, ...entry.relativePath.split('/'));
        const sourceSnapshot = await snapshotPath(sourcePath);
        if (sourceSnapshot.kind !== 'file') { builder.findings.push(issue('STALE_SOURCE', 'A selected skill file changed after discovery.', sourcePath, resource.id)); return; }
        builder.addPrecondition(sourceSnapshot);
        builder.addOperation({ kind: 'write', path, expected, content: { kind: 'source', path: sourcePath, snapshot: sourceSnapshot }, mode: entry.mode,
          resourceIds: [resource.id], purpose: 'resource', description: `Copy skill file ${resource.name}.` });
      } else if (entry.kind === 'symlink' && entry.linkTarget !== undefined) builder.addOperation({ kind: 'symlink', path, expected, target: entry.linkTarget,
        resourceIds: [resource.id], purpose: 'resource', description: `Copy internal skill link ${resource.name}.` });
      continue;
    }
    if (existingEntry.kind !== entry.kind) {
      builder.findings.push(issue('OWNED_OUTPUT_KIND_CHANGED', 'An owned skill entry changed type and cannot be safely replaced.', path, resource.id));
      continue;
    }
    if (entry.kind === 'directory') {
      if ((existingEntry.mode & 0o777) !== entry.mode) builder.addOperation({ kind: 'chmod', path, expected, mode: entry.mode,
        resourceIds: [resource.id], purpose: 'resource', description: `Update skill directory mode ${resource.name}.` });
    } else if (entry.kind === 'file') {
      const desiredDigest = fingerprintValue(['file', entry.mode, entry.digest]);
      if (expected.kind === 'file' && expected.digest === desiredDigest) continue;
      if (expected.kind !== 'file') { builder.findings.push(issue('OWNED_OUTPUT_KIND_CHANGED', 'An owned skill file cannot be safely replaced.', path, resource.id)); continue; }
      const sourcePath = resolve(resource.path, ...entry.relativePath.split('/'));
      const sourceSnapshot = await snapshotPath(sourcePath);
      if (sourceSnapshot.kind !== 'file') { builder.findings.push(issue('STALE_SOURCE', 'A selected skill file changed after discovery.', sourcePath, resource.id)); return; }
      builder.addPrecondition(sourceSnapshot);
      builder.addOperation({ kind: 'write', path, expected, content: { kind: 'source', path: sourcePath, snapshot: sourceSnapshot }, mode: entry.mode,
        resourceIds: [resource.id], purpose: 'resource', description: `Update skill file ${resource.name}.` });
    } else if (entry.kind === 'symlink' && entry.linkTarget !== undefined) {
      if (expected.kind === 'symlink' && expected.linkTarget === entry.linkTarget) continue;
      if (expected.kind !== 'symlink') { builder.findings.push(issue('OWNED_OUTPUT_KIND_CHANGED', 'An owned skill link cannot be safely replaced.', path, resource.id)); continue; }
      builder.addOperation({ kind: 'symlink', path, expected, target: entry.linkTarget, resourceIds: [resource.id], purpose: 'resource', description: `Update internal skill link ${resource.name}.` });
    }
  }
  if (builder.operations.some(operation => operation.resourceIds.includes(resource.id))) builder.updates++;
  else builder.unchanged++;
}

function sourcePathForEntry(root: string, entry: TreeEntry): string {
  return entry.relativePath ? resolve(root, ...entry.relativePath.split('/')) : root;
}
async function sameDiscoveredRoot(
  resource: SkillResource,
  destinationRoot: string,
  destinationScope: 'project' | 'user',
  destinationVisibility: 'shared' | 'private',
): Promise<boolean> {
  if (resource.source.scope !== destinationScope || resource.source.visibility !== destinationVisibility) return false;
  try { return resolve(await realpath(resource.source.path)) === resolve(await realpath(destinationRoot)); }
  catch { return false; }
}

function selectedChoiceMap(request: SyncRequest, resources: readonly ResourceInstance[]): Record<string, string> {
  const keys = new Set(resources.map(resource => `${resource.kind}:${resource.name}`));
  return Object.fromEntries(Object.entries(request.authority.resourceAuthorities).filter(([key]) => keys.has(key)));
}
function selectedGroup(resources: readonly ResourceInstance[], kind: ResourceInstance['kind']): ResourceInstance[] {
  return resources.filter(resource => resource.kind === kind);
}

function receiptMap(receipts: readonly OwnershipReceipt[], findings: Finding[]): Map<string, OwnershipReceipt> {
  const result = new Map<string, OwnershipReceipt>();
  for (const receipt of receipts) {
    const prior = result.get(receipt.slotId);
    if (prior && fingerprintValue(prior) !== fingerprintValue(receipt)) {
      findings.push(issue('DUPLICATE_OWNERSHIP_RECEIPT', 'Ownership metadata contains conflicting destination receipts.', receipt.path));
    } else result.set(receipt.slotId, receipt);
  }
  return result;
}


function privacyAllowed(resource: ResourceInstance, placement: DestinationRequest['placement']): boolean {
  if (resource.source.visibility === 'shared') return true;
  if (resource.source.scope === 'project') return placement === 'private-project';
  return placement === 'user' || placement === 'private-project';
}

interface MergedPreparedFile { edit: PreparedFileEdit; path: string; expected: PathSnapshot; resourceIds: Set<string>; blocked: boolean }

async function prepareMcpDestination(
  builder: PlanBuilder,
  context: Context,
  destination: DestinationRequest,
  adapter: NativeAdapter,
  resources: readonly McpResource[],
  roots: readonly string[],
  privateConfigRoots: readonly string[],
  receipts: Map<string, OwnershipReceipt>,
  nextReceipts: Map<string, OwnershipReceipt>,
): Promise<void> {
  if (!resources.length) return;
  for (const resource of resources) {
    if (!privacyAllowed(resource, destination.placement)) {
      builder.findings.push(issue('PRIVATE_RESOURCE_PUBLICATION', 'A private MCP definition cannot be published to this destination scope.', resource.path, resource.id));
    }
    if (!adapter.capabilities.transports.includes(resource.definition.transport)) {
      builder.findings.push(issue('UNSUPPORTED_MCP_TRANSPORT', 'The destination does not support this MCP transport.', resource.path, resource.id));
    }
    if (!await snapshotMatches(resource.snapshot)) builder.findings.push(issue('STALE_SOURCE', 'A selected MCP source changed after discovery.', resource.path, resource.id));
    builder.addPrecondition(resource.snapshot);
  }
  const prepared = await adapter.prepareMcpEdit(context, destination.placement, resources);
  builder.findings.push(...prepared.findings);
  const targetsBySlot = new Map<string, PreparedMcpTarget[]>();
  const blockedPaths = new Set<string>();
  for (const target of prepared.targets) {
    const group = targetsBySlot.get(target.slotId);
    if (group) group.push(target); else targetsBySlot.set(target.slotId, [target]);
  }
  const validTargets = new Set<string>();
  const targetPhysicalPaths = new Map<string, string>();
  for (const [slotId, targets] of targetsBySlot) {
    const first = targets[0]!;
    const expectedFingerprint = first.afterFingerprint;
    if (targets.some(target => target.afterFingerprint !== expectedFingerprint || target.key !== first.key)) {
      builder.findings.push(issue('MCP_DESTINATION_SLOT_CONFLICT', 'Selected MCP definitions require incompatible values in the same native destination slot.', first.path));
      continue;
    }
    const selectedResources = targets.map(target => resources.find(resource => resource.id === target.resourceId)).filter((item): item is McpResource => item !== undefined);
    if (selectedResources.length !== targets.length) {
      builder.findings.push(issue('INVALID_MCP_TARGET', 'A native adapter returned a target for an unselected MCP definition.', first.path));
      continue;
    }
    const file = await inspectScopedPath(first.path, roots);
    if (!file.safe || !file.snapshot) {
      builder.findings.push(issue('UNSAFE_DESTINATION_PATH', 'An MCP configuration destination escapes its approved scope or crosses an unsafe parent.', first.path));
      continue;
    }
    if (file.snapshot.kind !== 'missing' && file.snapshot.kind !== 'file') {
      builder.findings.push(issue('UNSAFE_DESTINATION_TYPE', 'An MCP configuration destination is not a regular file.', first.path));
      continue;
    }
    const physicalPath = await physicalEntryPath(first.path, file.snapshot);
    const canonicalFile = await snapshotPath(physicalPath);
    if (canonicalFile.kind !== file.snapshot.kind || canonicalFile.digest !== file.snapshot.digest
      || canonicalFile.mode !== file.snapshot.mode || resolve(canonicalFile.resolvedPath) !== physicalPath) {
      builder.findings.push(issue('DESTINATION_CHANGED', 'An MCP configuration changed while its physical location was being reviewed.', first.path));
      continue;
    }
    await addPhysicalPrecondition(builder, file.snapshot, canonicalFile);
    let aliasesMatch = true;
    for (const target of targets.slice(1)) {
      const alias = await inspectScopedPath(target.path, roots);
      if (!alias.safe || !alias.snapshot || alias.snapshot.kind !== file.snapshot.kind
        || alias.snapshot.digest !== file.snapshot.digest || alias.snapshot.mode !== file.snapshot.mode
        || resolve(alias.snapshot.resolvedPath) !== physicalPath) {
        aliasesMatch = false;
        break;
      }
      await addPhysicalPrecondition(builder, alias.snapshot, canonicalFile);
    }
    if (!aliasesMatch) {
      builder.findings.push(issue('MCP_DESTINATION_SLOT_CONFLICT', 'The same physical MCP slot has inconsistent native file snapshots.', first.path));
      continue;
    }
    targetPhysicalPaths.set(slotId, physicalPath);
    const receipt = receipts.get(slotId);
    if (receipt && (receipt.kind !== 'mcp' || resolve(receipt.path) !== physicalPath || receipt.key !== first.key)) {
      builder.findings.push(issue('OWNERSHIP_RECEIPT_CONFLICT', 'An MCP destination receipt does not match the selected native slot.', first.path));
      blockedPaths.add(physicalPath);
      continue;
    }
    const before = first.beforeFingerprint;
    if (targets.some(target => target.beforeFingerprint !== before)) {
      builder.findings.push(issue('MCP_DESTINATION_SLOT_CONFLICT', 'The same MCP destination slot has inconsistent current values.', first.path));
      blockedPaths.add(physicalPath);
      continue;
    }
    if (receipt && before !== receipt.fingerprint) {
      builder.findings.push(issue('OWNED_MCP_DRIFT', 'A selected managed MCP registration changed since its last receipt.', first.path, selectedResources[0]?.id));
      blockedPaths.add(physicalPath);
      continue;
    }
    if (!receipt && before !== undefined && before !== expectedFingerprint) {
      builder.findings.push(issue('UNMANAGED_MCP_COLLISION', 'A different unmanaged MCP registration already occupies the selected native slot.', first.path, selectedResources[0]?.id));
      blockedPaths.add(physicalPath);
      continue;
    }
    validTargets.add(slotId);
    const chosen = selectedResources[0]!;
    if (receipt || before === undefined || before !== expectedFingerprint) {
      nextReceipts.set(slotId, {
        slotId, path: physicalPath, kind: 'mcp', key: first.key, sourceId: chosen.source.id,
        resourceId: chosen.id, fingerprint: expectedFingerprint,
      });
    }
    if (before === expectedFingerprint) builder.unchanged++;
    else if (before === undefined) builder.additions++;
    else builder.updates++;
    builder.destination(destination, physicalPath);
  }

  const filesByPath = new Map<string, MergedPreparedFile>();
  for (const edit of prepared.files) {
    const aliasPath = resolve(edit.path);
    const path = resolve(edit.expected.resolvedPath);
    const associated = prepared.targets.filter(target => targetPhysicalPaths.get(target.slotId) === path || resolve(target.path) === aliasPath);
    const resourceIds = new Set(associated.map(target => target.resourceId));
    const alias = await inspectScopedPath(aliasPath, roots);
    const physical = await inspectScopedPath(path, roots);
    const expected = physical.snapshot;
    const unsafe = !await snapshotMatches(edit.expected) || edit.expected.path !== aliasPath
      || (edit.expected.kind !== 'missing' && edit.expected.kind !== 'file')
      || !alias.safe || !alias.snapshot || !physical.safe || !expected
      || expected.kind !== edit.expected.kind || expected.digest !== edit.expected.digest
      || expected.mode !== edit.expected.mode || resolve(expected.resolvedPath) !== path;
    if (unsafe || !expected || !alias.snapshot) {
      builder.findings.push(issue('STALE_OR_UNSAFE_MCP_EDIT', 'A prepared MCP edit is stale or outside the approved destination scope.', aliasPath));
      blockedPaths.add(path);
      continue;
    }
    await addPhysicalPrecondition(builder, alias.snapshot, expected);
    await addPhysicalPrecondition(builder, edit.expected, expected);
    if (!associated.length) {
      builder.findings.push(issue('UNSCOPED_MCP_EDIT', 'A native adapter prepared a file edit without a selected registration target.', aliasPath));
      blockedPaths.add(path);
      continue;
    }
    if (associated.some(target => !validTargets.has(target.slotId))) blockedPaths.add(path);
    const previous = filesByPath.get(path);
    if (previous) {
      if (!snapshotsEqual(previous.expected, expected) || !sameBytes(previous.edit.bytes, edit.bytes)) {
        builder.findings.push(issue('MCP_FILE_EDIT_CONFLICT', 'Native adapters prepared incompatible edits for the same physical configuration file.', path));
        previous.blocked = true;
        blockedPaths.add(path);
      } else {
        for (const id of resourceIds) previous.resourceIds.add(id);
      }
    } else filesByPath.set(path, { edit, path, expected, resourceIds, blocked: false });
  }
  for (const [path, merged] of filesByPath) {
    if (merged.blocked || blockedPaths.has(path)) continue;
    const expected = merged.expected;
    builder.addPrecondition(expected);
    builder.destination(destination, merged.path);
    if (expected.kind === 'file') {
      try {
        if (sameBytes(await readFile(path), merged.edit.bytes)) continue;
      } catch {
        builder.findings.push(issue('STALE_OR_UNSAFE_MCP_EDIT', 'A prepared MCP configuration could not be re-read safely.', path));
        continue;
      }
    }
    const parent = dirname(path);
    const parentCheck = await inspectScopedPath(parent, roots);
    if (!parentCheck.safe || !parentCheck.snapshot) {
      builder.findings.push(issue('UNSAFE_DESTINATION_PATH', 'An MCP configuration parent escapes its approved scope.', parent));
      continue;
    }
    builder.addPrecondition(parentCheck.snapshot);
    const boundary = roots.find(root => isWithin(root, parent));
    if (boundary) {
      const directoryMode = destination.placement !== 'project' && privateConfigRoots.some(root => isWithin(root, parent)) ? 0o700 : 0o755;
      await addDirsForDestination(builder, parent, boundary,
        new Map([[parent, parentCheck.snapshot], [path, expected]]), [...merged.resourceIds].sort(), 'resource', directoryMode);
    }
    builder.addOperation({ kind: 'write', path: merged.path, expected, content: { kind: 'bytes', bytes: merged.edit.bytes }, mode: merged.edit.mode,
      resourceIds: [...merged.resourceIds].sort(), purpose: 'resource', description: `Update selected MCP registrations for ${destination.agentId}.` });
  }
}

/** Build a deterministic, read-only plan from the exact selected authority and native capabilities. */
export async function planSync(
  context: Context,
  inventory: Inventory,
  approvedRequest: SyncRequest,
  loadedState: LoadedState,
  adapters: readonly NativeAdapter[] = nativeAdapters,
): Promise<Plan> {
  const builder = new PlanBuilder([...inventory.findings, ...loadedState.findings]);
  const selection = resolveSelection(inventory, approvedRequest.resourceIds);
  builder.findings.push(...selection.findings);
  const authority = resolveAuthority(inventory, selection, selectedChoiceMap(approvedRequest, selection.resources), loadedState.choices);
  builder.findings.push(...authority.findings);
  const selected = authority.resources;
  if (!selected.length && !builder.findings.some(finding => finding.code === 'EMPTY_SELECTION')) {
    builder.findings.push(issue('EMPTY_AUTHORITY_SELECTION', 'No selected resource has an approved authoritative source.'));
  }
  const byAgent = new Map(adapters.map(adapter => [adapter.id, adapter]));
  const destinations = new Map<string, DestinationRequest>();
  for (const destination of approvedRequest.destinations) {
    const key = `${destination.agentId}\0${destination.placement}`;
    if (!destinations.has(key)) destinations.set(key, destination);
  }
  const placements = new Map<string, Set<string>>();
  for (const destination of destinations.values()) {
    const set = placements.get(destination.agentId) ?? new Set<string>();
    set.add(destination.placement);
    placements.set(destination.agentId, set);
  }
  for (const [agentId, values] of placements) if (values.size > 1) {
    builder.findings.push(issue('CONFLICTING_DESTINATION_PLACEMENT', 'A destination agent was assigned more than one placement.', undefined));
  }
  if (!destinations.size) builder.findings.push(issue('EMPTY_DESTINATIONS', 'Choose at least one destination agent.'));

  let projectRoot: string;
  let homeRoot: string;
  let configRoot: string;
  let stateRoot: string;
  try { projectRoot = await realRoot(context.projectRoot); }
  catch {
    builder.findings.push(issue('INVALID_CONTEXT_ROOT', 'The approved project root could not be resolved safely.'));
    projectRoot = resolve(context.projectRoot);
  }
  try { homeRoot = await realRoot(context.homeDir); }
  catch {
    builder.findings.push(issue('INVALID_CONTEXT_ROOT', 'The approved home root could not be resolved safely.'));
    homeRoot = resolve(context.homeDir);
  }
  try { configRoot = await projectedRoot(context.configHome); }
  catch {
    builder.findings.push(issue('UNSAFE_STATE_ROOT', 'The approved configuration root could not be resolved safely.'));
    configRoot = resolve(context.configHome);
  }
  try { stateRoot = await projectedRoot(context.stateHome); }
  catch {
    builder.findings.push(issue('UNSAFE_STATE_ROOT', 'The approved state root could not be resolved safely.'));
    stateRoot = resolve(context.stateHome);
  }
  const projectRoots = [...new Set([resolve(context.projectRoot), projectRoot])];
  const homeRoots = [...new Set([resolve(context.homeDir), homeRoot])];
  const configRoots = [...new Set([resolve(context.configHome), configRoot])];
  const stateRoots = [...new Set([resolve(context.stateHome), stateRoot])];
  const skillResources = selectedGroup(selected, 'skill') as SkillResource[];
  const mcpResources = selectedGroup(selected, 'mcp') as McpResource[];
  if (skillResources.length && approvedRequest.skillMode !== 'copy' && approvedRequest.skillMode !== 'link') {
    builder.findings.push(issue('MISSING_SKILL_MODE', 'Choose copy or link behavior for selected skills.'));
  }

  const receiptLookup = receiptMap(loadedState.ownership.receipts, builder.findings);
  const nextReceipts = new Map(receiptLookup);
  const skillMode = approvedRequest.skillMode;
  for (const destination of destinations.values()) {
    const adapter = byAgent.get(destination.agentId);
    if (!adapter) {
      builder.findings.push(issue('UNSUPPORTED_DESTINATION', 'The selected destination adapter is unavailable.'));
      continue;
    }
    const selectedSkills = skillResources.filter(resource => adapter.capabilities.skills.includes(destination.placement));
    const unsupportedSkills = skillResources.filter(resource => !adapter.capabilities.skills.includes(destination.placement));
    for (const resource of unsupportedSkills) builder.findings.push(issue('UNSUPPORTED_SKILL_PLACEMENT', 'This destination does not support the selected skill placement.', undefined, resource.id));
    if (selectedSkills.length && skillMode) {
      const resolved = adapter.skillDestination(context, destination.placement);
      builder.findings.push(...resolved.findings);
      if (!resolved.location) {
        if (!resolved.findings.length) builder.findings.push(issue('UNRESOLVED_SKILL_DESTINATION', 'The adapter did not resolve a supported skill destination.'));
      } else {
        const location = resolved.location;
        const allowedRoots = destination.placement === 'project' ? projectRoots
          : destination.placement === 'user' ? [...homeRoots, ...configRoots] : [...homeRoots, ...configRoots];
        if (location.scope !== (destination.placement === 'user' ? 'user' : 'project')
          || location.visibility !== (destination.placement === 'project' ? 'shared' : 'private')) {
          builder.findings.push(issue('DESTINATION_SCOPE_MISMATCH', 'The adapter destination scope does not match the approved placement.', location.path));
        } else {
          const directory = await inspectScopedPath(location.path, allowedRoots);
          if (!directory.safe || !directory.snapshot || directory.snapshot.kind !== 'missing' && directory.snapshot.kind !== 'directory') {
            builder.findings.push(issue('UNSAFE_DESTINATION_PATH', 'A skill destination root is unsafe or is not a directory.', location.path));
          } else {
            await addPhysicalPrecondition(builder, directory.snapshot);
            const directoryMode = destination.placement !== 'project' && configRoots.some(root => isWithin(root, directory.snapshot!.resolvedPath)) ? 0o700 : 0o755;
            for (const resource of selectedSkills) {
              await skillPlan(builder, resource, destination, adapter, skillMode, directory.snapshot.resolvedPath,
                location.scope, location.visibility, allowedRoots, directoryMode, receiptLookup, nextReceipts);
            }
          }
        }
      }
    }
    const selectedMcp = mcpResources.filter(resource => adapter.capabilities.mcp.includes(destination.placement));
    const unsupportedMcp = mcpResources.filter(resource => !adapter.capabilities.mcp.includes(destination.placement));
    for (const resource of unsupportedMcp) builder.findings.push(issue('UNSUPPORTED_MCP_PLACEMENT', 'This destination does not support the selected MCP placement.', undefined, resource.id));
    const roots = destination.placement === 'project' ? projectRoots
      : destination.placement === 'user' ? [...homeRoots, ...configRoots] : [...homeRoots, ...configRoots];
    await prepareMcpDestination(builder, context, destination, adapter, selectedMcp, roots, configRoots, receiptLookup, nextReceipts);
  }

  const choiceConfig = canonicalChoices(authority.choices);
  const privateProjectMetadataBlocked = approvedRequest.configuration === 'project' && (
    selected.some(resource => resource.source.visibility === 'private')
    || choiceConfig.sources.some(source => source.visibility === 'private')
    || Object.entries(choiceConfig.resourceAuthorities).some(([key, id]) => inventory.resources.some(resource =>
      resource.id === id && `${resource.kind}:${resource.name}` === key && resource.source.visibility === 'private'))
  );
  if (privateProjectMetadataBlocked) builder.findings.push(issue('PRIVATE_AUTHORITY_SHARED_STORAGE',
    'Private source locations cannot be persisted in shared project preferences.', undefined, undefined,
    'Choose user or private-project configuration storage for private source authority.'));
  let statePaths: Awaited<ReturnType<typeof getStatePaths>> | undefined;
  try { statePaths = await getStatePaths(context, approvedRequest.configuration); }
  catch { builder.findings.push(issue('UNSAFE_STATE_PATH', 'The approved state location could not be resolved safely.')); }
  if (statePaths && !privateProjectMetadataBlocked) {
    const expectedPreference = resolve(statePaths.preferencePath);
    const expectedOwnership = resolve(statePaths.ownershipPath);
    if (resolve(loadedState.preferencePath) !== expectedPreference || resolve(loadedState.ownershipPath) !== expectedOwnership) {
      builder.findings.push(issue('STATE_LOCATION_MISMATCH', 'Loaded preferences or ownership receipts do not match the approved configuration scope.'));
    }
    const statePathsSnapshots = new Map(loadedState.snapshots.map(snapshot => [resolve(snapshot.path), snapshot]));
    const preferenceSnapshot = statePathsSnapshots.get(expectedPreference);
    const ownershipSnapshot = statePathsSnapshots.get(expectedOwnership);
    if (!preferenceSnapshot || !ownershipSnapshot) builder.findings.push(issue('MISSING_STATE_PRECONDITION', 'The loaded state does not include snapshots for the approved metadata paths.'));
    const preferencesRoot = approvedRequest.configuration === 'project' ? projectRoots : configRoots;
    const preferenceSafe = await inspectScopedPath(expectedPreference, preferencesRoot);
    const ownershipSafe = await inspectScopedPath(expectedOwnership, stateRoots);
    if (!preferenceSafe.safe || !preferenceSafe.snapshot || !ownershipSafe.safe || !ownershipSafe.snapshot) {
      builder.findings.push(issue('UNSAFE_STATE_PATH', 'A state metadata path escapes its approved private or project scope.'));
    } else {
      for (const loaded of [preferenceSnapshot, ownershipSnapshot]) {
        if (loaded) {
          if (!await snapshotMatches(loaded)) builder.findings.push(issue('STALE_STATE', 'Preferences or ownership receipts changed after they were read.', loaded.path));
          builder.addPrecondition(loaded);
        }
      }
      const preferenceBytes = encodeAuthorityConfig(choiceConfig);
      const ownershipState = { version: 1 as const, receipts: [...nextReceipts.values()].sort((a, b) => a.slotId.localeCompare(b.slotId)) };
      const ownershipBytes = encodeOwnershipState(ownershipState);
      const currentPreferenceBytes = preferenceSnapshot?.kind === 'file' ? await readFile(expectedPreference).catch(() => undefined) : undefined;
      const currentOwnershipBytes = ownershipSnapshot?.kind === 'file' ? await readFile(expectedOwnership).catch(() => undefined) : undefined;
      const preferenceDifferent = !currentPreferenceBytes || !sameBytes(currentPreferenceBytes, preferenceBytes);
      const ownershipDifferent = !currentOwnershipBytes || !sameBytes(currentOwnershipBytes, ownershipBytes);
      const preferenceParent = dirname(expectedPreference);
      const ownershipParent = dirname(expectedOwnership);
      const preferenceParentSafe = await inspectScopedPath(preferenceParent, preferencesRoot);
      const ownershipParentSafe = await inspectScopedPath(ownershipParent, stateRoots);
      if (preferenceDifferent && preferenceSnapshot && preferenceParentSafe.safe && preferenceParentSafe.snapshot) {
        builder.addPrecondition(preferenceParentSafe.snapshot);
        const root = preferencesRoot.find(candidate => isWithin(candidate, preferenceParent)) ?? projectRoot;
        const expectedByPath = new Map([[preferenceParent, preferenceParentSafe.snapshot], [expectedPreference, preferenceSnapshot]]);
        await addDirsForDestination(builder, preferenceParent, root, expectedByPath, [], 'state',
          approvedRequest.configuration === 'project' ? 0o755 : 0o700);
        builder.addOperation({ kind: 'write', path: expectedPreference, expected: preferenceSnapshot,
          content: { kind: 'bytes', bytes: preferenceBytes }, mode: 0o600, resourceIds: [], purpose: 'state', description: 'Record approved authority preferences.' });
      }
      if (ownershipDifferent && ownershipSnapshot && ownershipParentSafe.safe && ownershipParentSafe.snapshot) {
        builder.addPrecondition(ownershipParentSafe.snapshot);
        const expectedByPath = new Map([[ownershipParent, ownershipParentSafe.snapshot], [expectedOwnership, ownershipSnapshot]]);
        builder.addOperation({ kind: 'write', path: expectedOwnership, expected: ownershipSnapshot,
          content: { kind: 'bytes', bytes: ownershipBytes }, mode: 0o600, resourceIds: [], purpose: 'state', description: 'Record synchronization ownership receipts.' });
      }
    }
  }

  const operations = orderOperations(builder.operations, builder.findings);
  const preconditions = uniqueSnapshots(builder.preconditions, builder.findings);
  const summary: PlanSummary = {
    authorities: [...new Map(selected.map(resource => [resource.source.id, resource.source])).values()].sort((a, b) => a.id.localeCompare(b.id)),
    resources: selected.map(resource => ({ id: resource.id, name: resource.name, kind: resource.kind })).sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    destinations: [...destinations.values()].map(destination => ({
      agentId: destination.agentId, placement: destination.placement,
      paths: [...(builder.destinationPaths.get(`${destination.agentId}\0${destination.placement}`) ?? [])].sort(),
    })).sort((a, b) => a.agentId.localeCompare(b.agentId) || a.placement.localeCompare(b.placement)),
    additions: builder.additions, updates: builder.updates, removals: builder.removals, unchanged: builder.unchanged,
    ...(skillResources.length && skillMode ? { skillMode } : {}),
  };
  const findings = sortedFindings(builder.findings);
  const base = { version: 1 as const, context, request: approvedRequest, operations, preconditions, findings, summary };
  const id = fingerprintValue(base);
  return { ...base, id };
}
