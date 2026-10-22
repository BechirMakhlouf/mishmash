import type { Finding, Inventory, ResourceInstance, SelectionResolution } from '../model.js';

/** Search display metadata and provenance, never skill bodies or MCP configuration values. */
export function matchesResource(query: string, resource: ResourceInstance): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const text = [
    resource.kind, resource.name, resource.description ?? '', resource.locator, resource.path,
    resource.source.label, resource.source.agentId, ...(resource.source.agents ?? []),
    resource.source.path, resource.source.scope, resource.source.visibility,
  ].join(' ').toLowerCase();
  return terms.every(term => text.includes(term));
}

/**
 * Resolve checked stable IDs against the complete inventory, not a filtered option list.
 * Distinct IDs remain distinct sources; unknown or ambiguous IDs never fall back to names.
 */
export function resolveSelection(inventory: Inventory, checkedIds: readonly string[]): SelectionResolution {
  const byId = new Map<string, ResourceInstance[]>();
  for (const resource of inventory.resources) {
    const existing = byId.get(resource.id);
    if (existing) existing.push(resource);
    else byId.set(resource.id, [resource]);
  }
  const resources: ResourceInstance[] = [];
  const findings: Finding[] = [];
  for (const id of new Set(checkedIds)) {
    const candidates = byId.get(id);
    if (!candidates) {
      findings.push({
        severity: 'error', code: 'STALE_SELECTION', resourceId: id,
        message: 'A checked resource is no longer present in the inventory.',
        remediation: 'Refresh discovery and review the checked resources again.',
      });
    } else if (candidates.length !== 1) {
      findings.push({
        severity: 'error', code: 'AMBIGUOUS_RESOURCE_ID', resourceId: id,
        message: 'A checked resource ID identifies more than one inventory entry.',
        remediation: 'Refresh discovery and resolve the source identity before selecting it.',
      });
    } else {
      resources.push(candidates[0]!);
    }
  }
  if (checkedIds.length === 0) {
    findings.push({
      severity: 'error', code: 'EMPTY_SELECTION',
      message: 'No resources are checked for synchronization.',
      remediation: 'Check at least one skill or MCP registration.',
    });
  }
  return { resources, findings };
}
