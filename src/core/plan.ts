import { readFile, realpath } from 'node:fs/promises';
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

function skillSlot(path: string): string { return fingerprintValue([resolve(path), 'skill']); }
function skillFingerprint(snapshot: PathSnapshot): string {
  return snapshot.kind === 'symlink' ? fingerprintValue(['symlink', snapshot.linkTarget ?? '']) : snapshot.digest;
}
function relativeLinkTarget(from: string, to: string): string {
  return relative(dirname(from), to) || basename(to);
}
function invalidSkillName(name: string): boolean {
  return !name.trim() || name === '.' || name === '..' || isAbsolute(name) || name.includes('/') || name.includes('\\') || name.includes('\0');
}
function sourceAgentSet(source: SourceRef): ReadonlySet<string> {
  return new Set([source.agentId, ...(source.agents ?? [])]);
}
function operationKey(operation: Operation): string { return `${operation.purpose}\0${resolve(operation.path)}`; }
function operationComparable(operation: Operation): unknown {
  const { resourceIds: _resourceIds, description: _description, ...rest } = operation;
  return rest;
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
      if (fingerprintValue(operationComparable(existing)) !== fingerprintValue(operationComparable(normalized))) {
        this.findings.push(issue('DESTINATION_SLOT_CONFLICT', 'Selected resources require incompatible writes to the same destination.', path));
      } else {
        const resourceIds = [...new Set([...existing.resourceIds, ...normalized.resourceIds])].sort();
        const index = this.operations.indexOf(existing);
        this.operations[index] = { ...existing, resourceIds };
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
function orderOperations(operations: readonly Operation[]): Operation[] {
  return [...operations].sort((a, b) => {
    if (a.purpose !== b.purpose) return a.purpose === 'resource' ? -1 : 1;
    const aRemove = a.kind === 'remove';
    const bRemove = b.kind === 'remove';
    if (aRemove !== bRemove) return aRemove ? 1 : -1;
    const depth = pathDepth(a.path) - pathDepth(b.path);
    if (depth !== 0) return aRemove ? -depth : depth;
    return a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind);
  });
}

async function addDirsForDestination(builder: PlanBuilder, directory: string, boundary: string, expectedByPath: Map<string, PathSnapshot>, resourceIds: readonly string[], purpose: 'resource' | 'state' = 'resource'): Promise<void> {
  const missing: { path: string; snapshot: PathSnapshot }[] = [];
  let current = resolve(directory);
  const root = resolve(boundary);
  while (isWithin(root, current) && current !== root) {
    const snapshot = expectedByPath.get(current) ?? await snapshotPath(current);
    builder.addPrecondition(snapshot);
    if (snapshot.kind === 'directory') break;
    if (snapshot.kind !== 'missing') break;
    missing.push({ path: current, snapshot });
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const { path, snapshot } of missing.reverse()) {
    builder.addOperation({ kind: 'mkdir', path, expected: snapshot, mode: 0o755,
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
  roots: readonly string[],
  receipts: ReadonlyMap<string, OwnershipReceipt>,
  nextReceipts: Map<string, OwnershipReceipt>,
): Promise<void> {
  if (invalidSkillName(resource.name)) {
    builder.findings.push(issue('INVALID_SKILL_NAME', 'A selected skill name cannot be used as a safe destination directory.', resource.path, resource.id));
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
  const target = resolve(destinationRoot, resource.name);
  const checked = await inspectScopedPath(target, roots, true);
  if (!checked.safe || !checked.snapshot) {
    builder.findings.push(issue('UNSAFE_DESTINATION_PATH', 'A skill destination escapes its approved scope or crosses an unsafe parent.', target, resource.id));
    return;
  }
  const current = checked.snapshot;
  builder.addPrecondition(current);
  const slotId = skillSlot(target);
  const receipt = receipts.get(slotId);
  const desiredLink = relativeLinkTarget(target, resource.path);
  const desiredFingerprint = mode === 'link' ? fingerprintValue(['symlink', desiredLink]) : resource.snapshot.digest;

  if (resourceAgentDiscovered(resource, destination.agentId)) {
    builder.destination(destination, target);
    builder.unchanged++;
    return;
  }
  if (receipt) {
    if (receipt.kind !== 'skill' || resolve(receipt.path) !== target || skillFingerprint(current) !== receipt.fingerprint) {
      builder.findings.push(issue('OWNED_OUTPUT_DRIFT', 'A selected managed skill destination changed since its last receipt.', target, resource.id));
      return;
    }
  } else if (current.kind !== 'missing') {
    const identical = mode === 'copy' ? current.kind === 'directory' && current.digest === desiredFingerprint
      : current.kind === 'symlink' && current.linkTarget === desiredLink;
    builder.destination(destination, target);
    if (identical) { builder.unchanged++; return; }
    builder.findings.push(issue('UNMANAGED_DESTINATION_COLLISION', 'A different unmanaged skill already occupies the selected destination.', target, resource.id));
    return;
  }

  builder.destination(destination, target);
  if (receipt || current.kind === 'missing') {
    nextReceipts.set(slotId, {
      slotId, path: target, kind: 'skill', key: resource.name, sourceId: resource.source.id,
      resourceId: resource.id, fingerprint: desiredFingerprint,
    });
  }
  if (current.kind === 'symlink' && mode !== 'link' || current.kind === 'directory' && mode === 'link') {
    builder.findings.push(issue('OWNED_OUTPUT_KIND_CHANGED', 'The managed skill destination has a different copy/link form than the requested output.', target, resource.id));
    return;
  }
  const desiredEntries = resource.snapshot.entries;
  if (mode === 'link') {
    if (current.kind === 'symlink' && current.linkTarget === desiredLink) {
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
      await addDirsForDestination(builder, parent, roots.find(root => isWithin(root, parent)) ?? roots[0]!, new Map([[parent, parentCheck.snapshot]]), [resource.id]);
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
    await addDirsForDestination(builder, parent, roots.find(root => isWithin(root, parent)) ?? roots[0]!, expectedByPath, [resource.id]);
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
function resourceAgentDiscovered(resource: ResourceInstance, agentId: string): boolean {
  return sourceAgentSet(resource.source).has(agentId);
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

interface MergedPreparedFile { edit: PreparedFileEdit; resourceIds: Set<string>; blocked: boolean }

async function prepareMcpDestination(
  builder: PlanBuilder,
  context: Context,
  destination: DestinationRequest,
  adapter: NativeAdapter,
  resources: readonly McpResource[],
  roots: readonly string[],
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
  for (const [slotId, targets] of targetsBySlot) {
    const first = targets[0]!;
    const expectedFingerprint = first.afterFingerprint;
    if (targets.some(target => target.afterFingerprint !== expectedFingerprint || target.path !== first.path || target.key !== first.key)) {
      builder.findings.push(issue('MCP_DESTINATION_SLOT_CONFLICT', 'Selected MCP definitions require incompatible values in the same native destination slot.', first.path));
      blockedPaths.add(resolve(first.path));
      continue;
    }
    const selectedResources = targets.map(target => resources.find(resource => resource.id === target.resourceId)).filter((item): item is McpResource => item !== undefined);
    if (selectedResources.length !== targets.length) {
      builder.findings.push(issue('INVALID_MCP_TARGET', 'A native adapter returned a target for an unselected MCP definition.', first.path));
      blockedPaths.add(resolve(first.path));
      continue;
    }
    const file = await inspectScopedPath(first.path, roots);
    if (!file.safe || !file.snapshot) {
      builder.findings.push(issue('UNSAFE_DESTINATION_PATH', 'An MCP configuration destination escapes its approved scope or crosses an unsafe parent.', first.path));
      blockedPaths.add(resolve(first.path));
      continue;
    }
    builder.addPrecondition(file.snapshot);
    if (file.snapshot.kind !== 'missing' && file.snapshot.kind !== 'file') {
      builder.findings.push(issue('UNSAFE_DESTINATION_TYPE', 'An MCP configuration destination is not a regular file.', first.path));
      blockedPaths.add(resolve(first.path));
      continue;
    }
    const receipt = receipts.get(slotId);
    if (receipt && (receipt.kind !== 'mcp' || resolve(receipt.path) !== resolve(first.path) || receipt.key !== first.key)) {
      builder.findings.push(issue('OWNERSHIP_RECEIPT_CONFLICT', 'An MCP destination receipt does not match the selected native slot.', first.path));
      blockedPaths.add(resolve(first.path));
      continue;
    }
    const before = first.beforeFingerprint;
    if (targets.some(target => target.beforeFingerprint !== before)) {
      builder.findings.push(issue('MCP_DESTINATION_SLOT_CONFLICT', 'The same MCP destination slot has inconsistent current values.', first.path));
      blockedPaths.add(resolve(first.path));
      continue;
    }
    if (receipt && before !== receipt.fingerprint) {
      builder.findings.push(issue('OWNED_MCP_DRIFT', 'A selected managed MCP registration changed since its last receipt.', first.path, selectedResources[0]?.id));
      blockedPaths.add(resolve(first.path));
      continue;
    }
    if (!receipt && before !== undefined && before !== expectedFingerprint) {
      builder.findings.push(issue('UNMANAGED_MCP_COLLISION', 'A different unmanaged MCP registration already occupies the selected native slot.', first.path, selectedResources[0]?.id));
      blockedPaths.add(resolve(first.path));
      continue;
    }
    validTargets.add(slotId);
    const chosen = selectedResources[0]!;
    if (receipt || before === undefined || before !== expectedFingerprint) {
      nextReceipts.set(slotId, {
        slotId, path: resolve(first.path), kind: 'mcp', key: first.key, sourceId: chosen.source.id,
        resourceId: chosen.id, fingerprint: expectedFingerprint,
      });
    }
    if (before === expectedFingerprint) builder.unchanged++;
    else if (before === undefined) builder.additions++;
    else builder.updates++;
    builder.destination(destination, first.path);
  }

  const filesByPath = new Map<string, MergedPreparedFile>();
  for (const edit of prepared.files) {
    const path = resolve(edit.path);
    const associated = prepared.targets.filter(target => resolve(target.path) === path);
    const resourceIds = new Set(associated.map(target => target.resourceId));
    const unsafe = !roots.some(root => isWithin(root, path)) || !await snapshotMatches(edit.expected)
      || edit.expected.path !== path || edit.expected.kind !== 'missing' && edit.expected.kind !== 'file';
    if (unsafe) {
      builder.findings.push(issue('STALE_OR_UNSAFE_MCP_EDIT', 'A prepared MCP edit is stale or outside the approved destination scope.', path));
      blockedPaths.add(path);
      continue;
    }
    if (associated.some(target => !validTargets.has(target.slotId))) blockedPaths.add(path);
    const previous = filesByPath.get(path);
    if (previous) {
      if (!snapshotsEqual(previous.edit.expected, edit.expected) || !sameBytes(previous.edit.bytes, edit.bytes)) {
        builder.findings.push(issue('MCP_FILE_EDIT_CONFLICT', 'Native adapters prepared incompatible edits for the same configuration file.', path));
        previous.blocked = true;
        blockedPaths.add(path);
      } else {
        for (const id of resourceIds) previous.resourceIds.add(id);
      }
    } else filesByPath.set(path, { edit, resourceIds, blocked: false });
  }
  for (const [path, merged] of filesByPath) {
    if (merged.blocked || blockedPaths.has(path)) continue;
    const expected = merged.edit.expected;
    builder.addPrecondition(expected);
    builder.destination(destination, path);
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
    if (boundary) await addDirsForDestination(builder, parent, boundary,
      new Map([[parent, parentCheck.snapshot], [path, expected]]), [...merged.resourceIds].sort());
    builder.addOperation({ kind: 'write', path, expected, content: { kind: 'bytes', bytes: merged.edit.bytes }, mode: merged.edit.mode,
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
  try {
    [projectRoot, homeRoot, configRoot, stateRoot] = await Promise.all([
      realRoot(context.projectRoot), realRoot(context.homeDir), realRoot(context.configHome), realRoot(context.stateHome),
    ]);
  } catch {
    builder.findings.push(issue('INVALID_CONTEXT_ROOT', 'An approved project or private context root could not be resolved safely.'));
    projectRoot = resolve(context.projectRoot); homeRoot = resolve(context.homeDir); configRoot = resolve(context.configHome); stateRoot = resolve(context.stateHome);
  }
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
        const allowedRoots = destination.placement === 'project' ? [projectRoot]
          : destination.placement === 'user' ? [homeRoot, configRoot] : [homeRoot, configRoot];
        if (location.scope !== (destination.placement === 'user' ? 'user' : 'project')
          || location.visibility !== (destination.placement === 'project' ? 'shared' : 'private')) {
          builder.findings.push(issue('DESTINATION_SCOPE_MISMATCH', 'The adapter destination scope does not match the approved placement.', location.path));
        } else {
          const directory = await inspectScopedPath(location.path, allowedRoots);
          if (!directory.safe || !directory.snapshot || directory.snapshot.kind !== 'missing' && directory.snapshot.kind !== 'directory') {
            builder.findings.push(issue('UNSAFE_DESTINATION_PATH', 'A skill destination root is unsafe or is not a directory.', location.path));
          } else {
            builder.addPrecondition(directory.snapshot);
            for (const resource of selectedSkills) {
              await skillPlan(builder, resource, destination, adapter, skillMode, location.path, allowedRoots, receiptLookup, nextReceipts);
            }
          }
        }
      }
    }
    const selectedMcp = mcpResources.filter(resource => adapter.capabilities.mcp.includes(destination.placement));
    const unsupportedMcp = mcpResources.filter(resource => !adapter.capabilities.mcp.includes(destination.placement));
    for (const resource of unsupportedMcp) builder.findings.push(issue('UNSUPPORTED_MCP_PLACEMENT', 'This destination does not support the selected MCP placement.', undefined, resource.id));
    const roots = destination.placement === 'project' ? [projectRoot]
      : destination.placement === 'user' ? [homeRoot, configRoot] : [homeRoot, configRoot];
    await prepareMcpDestination(builder, context, destination, adapter, selectedMcp, roots, receiptLookup, nextReceipts);
  }

  const choiceConfig = canonicalChoices(authority.choices);
  let statePaths: Awaited<ReturnType<typeof getStatePaths>> | undefined;
  try { statePaths = await getStatePaths(context, approvedRequest.configuration); }
  catch { builder.findings.push(issue('UNSAFE_STATE_PATH', 'The approved state location could not be resolved safely.')); }
  if (statePaths) {
    const expectedPreference = resolve(statePaths.preferencePath);
    const expectedOwnership = resolve(statePaths.ownershipPath);
    if (resolve(loadedState.preferencePath) !== expectedPreference || resolve(loadedState.ownershipPath) !== expectedOwnership) {
      builder.findings.push(issue('STATE_LOCATION_MISMATCH', 'Loaded preferences or ownership receipts do not match the approved configuration scope.'));
    }
    const statePathsSnapshots = new Map(loadedState.snapshots.map(snapshot => [resolve(snapshot.path), snapshot]));
    const preferenceSnapshot = statePathsSnapshots.get(expectedPreference);
    const ownershipSnapshot = statePathsSnapshots.get(expectedOwnership);
    if (!preferenceSnapshot || !ownershipSnapshot) builder.findings.push(issue('MISSING_STATE_PRECONDITION', 'The loaded state does not include snapshots for the approved metadata paths.'));
    const preferencesRoot = approvedRequest.configuration === 'project' ? [projectRoot] : [configRoot];
    const preferenceSafe = await inspectScopedPath(expectedPreference, preferencesRoot);
    const ownershipSafe = await inspectScopedPath(expectedOwnership, [stateRoot]);
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
      const ownershipParentSafe = await inspectScopedPath(ownershipParent, [stateRoot]);
      if (preferenceDifferent && preferenceSnapshot && preferenceParentSafe.safe && preferenceParentSafe.snapshot) {
        builder.addPrecondition(preferenceParentSafe.snapshot);
        const root = approvedRequest.configuration === 'project' ? projectRoot : configRoot;
        const expectedByPath = new Map([[preferenceParent, preferenceParentSafe.snapshot], [expectedPreference, preferenceSnapshot]]);
        await addDirsForDestination(builder, preferenceParent, root, expectedByPath, [], 'state');
        builder.addOperation({ kind: 'write', path: expectedPreference, expected: preferenceSnapshot,
          content: { kind: 'bytes', bytes: preferenceBytes }, mode: 0o600, resourceIds: [], purpose: 'state', description: 'Record approved authority preferences.' });
      }
      if (ownershipDifferent && ownershipSnapshot && ownershipParentSafe.safe && ownershipParentSafe.snapshot) {
        builder.addPrecondition(ownershipParentSafe.snapshot);
        const expectedByPath = new Map([[ownershipParent, ownershipParentSafe.snapshot], [expectedOwnership, ownershipSnapshot]]);
        await addDirsForDestination(builder, ownershipParent, stateRoot, expectedByPath, [], 'state');
        builder.addOperation({ kind: 'write', path: expectedOwnership, expected: ownershipSnapshot,
          content: { kind: 'bytes', bytes: ownershipBytes }, mode: 0o600, resourceIds: [], purpose: 'state', description: 'Record synchronization ownership receipts.' });
      }
    }
  }

  const operations = orderOperations(builder.operations);
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
