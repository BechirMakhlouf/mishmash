import { lstat, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { nativeAdapters } from '../agents/index.js';
import type { NativeAdapter } from '../agents/contract.js';
import type { AgentId, CheckedLocation, Context, Finding, Inventory, ResourceInstance, SourceRef } from '../model.js';
import { errorCode, filesystemFinding, fingerprintValue, snapshotsEqual } from '../fs/snapshot.js';
import { discoverSkills, resourceId, sourceRef } from '../resources/skills.js';

function sortedUnique(values: readonly AgentId[]): AgentId[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function mergeSources(sources: readonly SourceRef[]): Map<string, SourceRef> {
  const grouped = new Map<string, SourceRef[]>();
  for (const source of sources) {
    const group = grouped.get(source.id);
    if (group) group.push(source);
    else grouped.set(source.id, [source]);
  }
  const result = new Map<string, SourceRef>();
  for (const [id, group] of grouped) {
    const shared = group.some(source => source.agentId === 'shared');
    const agents = sortedUnique(group.flatMap(source => [
      ...(source.agentId === 'shared' ? [] : [source.agentId]),
      ...(source.agents ?? []),
    ]));
    const owners = sortedUnique(group.flatMap(source => source.agentId === 'shared' ? [] : [source.agentId]));
    const agentId = shared ? 'shared' : owners[0] ?? group[0]!.agentId;
    const first = [...group].sort((a, b) => a.label.localeCompare(b.label) || a.agentId.localeCompare(b.agentId))[0]!;
    result.set(id, {
      ...first,
      agentId,
      ...(agents.length ? { agents } : {}),
    });
  }
  return result;
}

function resourceSemantics(resource: ResourceInstance): string {
  return fingerprintValue(resource.kind === 'mcp'
    ? [resource.name, resource.description ?? null, resource.locator, resource.definition]
    : [resource.name, resource.description ?? null, resource.locator]);
}

function sortFindings(findings: readonly Finding[]): Finding[] {
  const unique = new Map<string, Finding>();
  for (const finding of findings) {
    const key = JSON.stringify([finding.severity, finding.code, finding.path ?? '', finding.resourceId ?? '', finding.message, finding.remediation ?? '']);
    unique.set(key, finding);
  }
  return [...unique.values()].sort((a, b) =>
    a.severity.localeCompare(b.severity) || a.code.localeCompare(b.code)
    || (a.path ?? '').localeCompare(b.path ?? '') || (a.resourceId ?? '').localeCompare(b.resourceId ?? '')
    || a.message.localeCompare(b.message));
}

function sortLocations(locations: readonly CheckedLocation[]): CheckedLocation[] {
  const unique = new Map<string, CheckedLocation>();
  for (const location of locations) {
    const key = JSON.stringify([location.agentId, resolve(location.path), location.kind, location.scope]);
    const prior = unique.get(key);
    unique.set(key, prior ? { ...prior, exists: prior.exists || location.exists } : location);
  }
  return [...unique.values()].sort((a, b) => a.agentId.localeCompare(b.agentId)
    || a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind) || a.scope.localeCompare(b.scope));
}

async function canonicalSource(source: SourceRef): Promise<SourceRef> {
  const path = await realpath(source.path);
  return {
    ...sourceRef(source.agentId, path, source.scope, source.visibility, source.label),
    ...(source.agents ? { agents: sortedUnique(source.agents) } : {}),
  };
}

/** Read a deterministic inventory from native adapters and explicit existing skill roots. */
export async function discover(context: Context, adapters: readonly NativeAdapter[] = nativeAdapters): Promise<Inventory> {
  const findings: Finding[] = [];
  const checkedLocations: CheckedLocation[] = [];
  const detectedAgents = new Set<AgentId>();
  const rawSources: SourceRef[] = [];
  const rawResources: ResourceInstance[] = [];

  const results = await Promise.all(adapters.map(async adapter => {
    try { return { adapter, discovery: await adapter.discover(context) }; }
    catch {
      return { adapter, failure: true as const };
    }
  }));

  for (const result of results) {
    if ('failure' in result) {
      findings.push({ severity: 'error', code: 'ADAPTER_DISCOVERY_FAILED',
        message: 'A native configuration could not be inspected safely.',
        remediation: 'Check the configured locations and rediscover.' });
      continue;
    }
    const { adapter, discovery } = result;
    if (discovery.detected) detectedAgents.add(adapter.id);
    findings.push(...discovery.findings);
    checkedLocations.push(...discovery.checkedLocations);
    for (const source of discovery.sources) {
      try { rawSources.push(await canonicalSource(source)); }
      catch { findings.push(filesystemFinding(source.path, 'SOURCE_CHANGED')); }
    }
    for (const resource of discovery.resources) {
      try {
        const source = await canonicalSource(resource.source);
        const id = resource.kind === 'mcp'
          ? resourceId(source, JSON.stringify([resource.locator, resource.definition.nativeAgent]))
          : resourceId(source, resource.locator);
        rawSources.push(source);
        rawResources.push({ ...resource, id, source });
      } catch { findings.push(filesystemFinding(resource.path, 'SOURCE_CHANGED')); }
    }
  }

  for (const extra of context.extraSources ?? []) {
    const configuredPath = resolve(extra.path);
    let exists = false;
    try {
      const stat = await lstat(configuredPath);
      exists = stat.isDirectory() || stat.isSymbolicLink();
      if (!exists) findings.push(filesystemFinding(configuredPath, 'INVALID_EXTRA_SOURCE'));
      else {
        const actual = await realpath(configuredPath);
        const source = sourceRef('shared', actual, extra.scope, extra.visibility, extra.label);
        const result = await discoverSkills(source);
        rawSources.push({ ...source, ...(extra.agents ? { agents: sortedUnique(extra.agents) } : {}) });
        rawResources.push(...result.resources.map(resource => ({
          ...resource,
          source: { ...source, ...(extra.agents ? { agents: sortedUnique(extra.agents) } : {}) },
        })));
        findings.push(...result.findings);
      }
    } catch (error) {
      if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') {
        findings.push(filesystemFinding(configuredPath, 'MISSING_EXTRA_SOURCE'));
      } else findings.push(filesystemFinding(configuredPath));
    }
    checkedLocations.push({ agentId: 'shared', path: configuredPath, kind: 'skills', scope: extra.scope, exists });
  }

  const sources = mergeSources(rawSources);
  const byId = new Map<string, ResourceInstance[]>();
  for (const resource of rawResources) {
    const group = byId.get(resource.id);
    if (group) group.push(resource);
    else byId.set(resource.id, [resource]);
  }
  const resources: ResourceInstance[] = [];
  for (const [id, group] of byId) {
    const representative = [...group].sort((a, b) => resourceSemantics(a).localeCompare(resourceSemantics(b)))[0]!;
    const inconsistent = group.some(resource => !snapshotsEqual(resource.snapshot, representative.snapshot)
      || resourceSemantics(resource) !== resourceSemantics(representative));
    if (inconsistent) findings.push({ severity: 'error', code: 'INCONSISTENT_RESOURCE_SNAPSHOT',
      resourceId: id, path: representative.path,
      message: 'The same physical resource was read with inconsistent contents or native semantics.',
      remediation: 'Resolve the changed or conflicting source and rediscover before planning.' });
    const source = sources.get(representative.source.id) ?? representative.source;
    resources.push({ ...representative, source });
  }

  resources.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)
    || a.source.id.localeCompare(b.source.id) || a.id.localeCompare(b.id));
  return {
    resources,
    sources: [...sources.values()].sort((a, b) => a.id.localeCompare(b.id)),
    detectedAgents: [...detectedAgents].sort((a, b) => a.localeCompare(b)),
    checkedLocations: sortLocations(checkedLocations),
    findings: sortFindings(findings),
  };
}
