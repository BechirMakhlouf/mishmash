import type {
  AuthorityConfig, AuthorityConflict, AuthorityResolution, Finding, Inventory,
  ResourceInstance, SelectionResolution, SourceRef,
} from '../model.js';
import { resolveSelection } from './selection.js';

/** Names share an authority only within the same resource kind. */
export function authorityKey(resource: ResourceInstance): string {
  return `${resource.kind}:${resource.name}`;
}

function sameSource(a: SourceRef, b: SourceRef): boolean {
  return a.id === b.id && a.path === b.path && a.scope === b.scope && a.visibility === b.visibility;
}

/**
 * Resolve current selections without preferring a native/shared source or merging assets.
 * Every distinct selected ID needs an explicit tie-break, even for identical copies or
 * aliases. Remembered choices are reviewable preferences, never tie-break permission.
 * Subset synchronization preserves unrelated preferences, including unavailable sources.
 * SourceRef records logical identity only; physical retargeting is reviewed using current
 * discovery paths and planner snapshots, not inferred from remembered configuration.
 */
export function resolveAuthority(
  inventory: Inventory,
  selection: SelectionResolution,
  explicitChoices: Readonly<Record<string, string>>,
  rememberedChoices?: AuthorityConfig,
): AuthorityResolution {
  const currentSelection = resolveSelection(inventory, selection.resources.map(resource => resource.id));
  const findings: Finding[] = [...selection.findings];
  for (const finding of currentSelection.findings) {
    if (!findings.some(existing => existing.code === finding.code && existing.resourceId === finding.resourceId)) {
      findings.push(finding);
    }
  }
  const groups = new Map<string, ResourceInstance[]>();
  const inventoryById = new Map<string, ResourceInstance[]>();
  for (const resource of inventory.resources) {
    const existing = inventoryById.get(resource.id);
    if (existing) existing.push(resource);
    else inventoryById.set(resource.id, [resource]);
  }
  for (const resource of currentSelection.resources) {
    const key = authorityKey(resource);
    const existing = groups.get(key);
    if (existing) existing.push(resource);
    else groups.set(key, [resource]);
  }
  const explicit = new Map<string, ResourceInstance>();
  for (const [key, id] of Object.entries(explicitChoices)) {
    const chosen = groups.get(key)?.find(resource => resource.id === id);
    if (chosen) explicit.set(key, chosen);
    else findings.push({
      severity: 'error', code: 'INVALID_AUTHORITY_CHOICE', resourceId: id,
      message: 'An authority choice does not identify a checked resource with that name and kind.',
      remediation: 'Choose an authority from the currently checked resources.',
    });
  }

  const rememberedProblems = new Set<string>();
  for (const [key, id] of Object.entries(rememberedChoices?.resourceAuthorities ?? {})) {
    if (explicit.has(key)) continue;
    const candidates = inventoryById.get(id);
    const rememberedResource = candidates?.length === 1 ? candidates[0] : undefined;
    const source = rememberedResource?.source;
    const recordedSources = rememberedChoices?.sources.filter(recorded => recorded.id === source?.id) ?? [];
    const sourceMatches = source !== undefined && recordedSources.some(recorded => sameSource(recorded, source));
    const selected = groups.get(key);
    const selectionDiffers = selected?.length === 1 && selected[0]!.id !== id;
    const unavailable = rememberedResource === undefined;
    if (!unavailable && authorityKey(rememberedResource) === key && sourceMatches && !selectionDiffers) continue;
    if (selected) rememberedProblems.add(key);
    findings.push({
      severity: selected ? 'error' : 'warning',
      code: unavailable ? 'REMEMBERED_AUTHORITY_MISSING' : 'REMEMBERED_AUTHORITY_CHANGED',
      resourceId: id,
      ...(source ? { path: source.path } : {}),
      message: unavailable
        ? 'A remembered authoritative resource is not available in the current inventory.'
        : 'A remembered authority differs from the current resource or checked source.',
      remediation: selected
        ? 'Explicitly choose the authoritative checked resource again before continuing.'
        : 'Review this retained preference when selecting that resource again; no substitute was chosen.',
    });
  }

  const currentSources = [...inventory.sources, ...inventory.resources.map(resource => resource.source)];
  for (const source of rememberedChoices?.sources ?? []) {
    const candidates = currentSources.filter(current => current.id === source.id);
    if (candidates.some(current => sameSource(current, source))) continue;
    // A source reapproved for this selection no longer needs its own stale-source warning.
    if ([...explicit.values()].some(resource => resource.source.id === source.id)) continue;
    findings.push({
      severity: 'warning', code: candidates.length ? 'REMEMBERED_SOURCE_CHANGED' : 'REMEMBERED_SOURCE_MISSING',
      path: source.path,
      message: candidates.length
        ? 'A remembered source has different location, agent, scope, or privacy information.'
        : 'A remembered source is not available in the current inventory.',
      remediation: 'Review the exact source before using it again; its preference has not been relocated.',
    });
  }

  const resources: ResourceInstance[] = [];
  const conflicts: AuthorityConflict[] = [];
  const sources = [...(rememberedChoices?.sources ?? [])];
  const resourceAuthorities: Record<string, string> = { ...rememberedChoices?.resourceAuthorities };
  for (const [key, candidates] of groups) {
    const chosen = explicit.get(key);
    const invalidExplicit = Object.hasOwn(explicitChoices, key) && !chosen;
    if (!chosen && (candidates.length > 1 || rememberedProblems.has(key) || invalidExplicit)) {
      conflicts.push({ key, resources: candidates });
      if (candidates.length > 1 && !invalidExplicit) findings.push({
        severity: 'error', code: 'AUTHORITY_REQUIRED',
        message: 'Multiple checked resources have the same name and kind without an explicit authority.',
        remediation: 'Choose exactly which checked source should remain authoritative; resources will not be merged.',
      });
      continue;
    }
    const authority = chosen ?? candidates[0]!;
    resources.push(authority);
    resourceAuthorities[key] = authority.id;
    const sourceIndex = sources.findIndex(source => source.id === authority.source.id);
    if (sourceIndex === -1) sources.push(authority.source);
    else sources[sourceIndex] = authority.source;
  }
  return { resources, choices: { version: 1, sources, resourceAuthorities }, conflicts, findings };
}
