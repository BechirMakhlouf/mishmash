import type {
  AgentId, ApplyResult, CheckedLocation, Finding, Inventory, LoadedState,
  Plan, ResourceInstance, SourceRef,
} from '../model.js';
import { nativeAdapters } from '../agents/index.js';

const adapterLabels = new Map<AgentId, string>(nativeAdapters.map(adapter => [adapter.id, adapter.label]));

/** Remove terminal control sequences and invisible direction/format controls from untrusted text. */
export function sanitizeTerminalText(value: string): string {
  const withoutSequences = value
    .replace(/\u001b\](?:(?!\u0007|\u001b\\)[\s\S])*(?:\u0007|\u001b\\|$)/g, '')
    .replace(/\u009d(?:(?!\u0007|\u009c)[\s\S])*(?:\u0007|\u009c|$)/g, '')
    .replace(/\u001b(?:[PX^_])(?:(?!\u001b\\)[\s\S])*(?:\u001b\\|$)/g, '')
    .replace(/\u0090(?:(?!\u009c)[\s\S])*(?:\u009c|$)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u009b[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[ -/]*[@-~]/g, '');
  return withoutSequences
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function short(value: string | undefined, limit = 88): string | undefined {
  if (value === undefined) return undefined;
  const safe = sanitizeTerminalText(value);
  if (!safe) return undefined;
  return safe.length > limit ? `${safe.slice(0, limit - 1)}…` : safe;
}

export function renderAuthorityName(key: string): string {
  const name = key.replace(/^(skill|mcp):/, '');
  return short(name, 70) ?? '(unnamed resource)';
}

export function sourceScopeLabel(source: SourceRef): string {
  const scope = source.scope === 'project' && source.visibility === 'private' ? 'private project' : source.scope;
  return `${scope}, ${source.visibility}`;
}

function agentLabel(id: AgentId | 'shared'): string {
  return id === 'shared' ? 'Shared directory' : adapterLabels.get(id) ?? id;
}

function sourceAttribution(source: SourceRef): string {
  const agents = source.agents?.length ? source.agents.map(agentLabel).join(', ') : agentLabel(source.agentId);
  return `${short(source.label, 64) ?? agentLabel(source.agentId)} · ${agents}`;
}

export function renderResourceLabel(resource: ResourceInstance): { label: string; hint: string } {
  const name = short(resource.name, 70) ?? '(unnamed resource)';
  const description = resource.kind === 'skill' ? short(resource.description, 100) : undefined;
  return {
    label: description ? `${name} — ${description}` : name,
    hint: `${sourceAttribution(resource.source)} · ${sourceScopeLabel(resource.source)}`,
  };
}

export function renderSourceLabel(source: SourceRef): { label: string; hint: string } {
  const agents = source.agents?.length ? source.agents.map(agentLabel).join(', ') : agentLabel(source.agentId);
  return {
    label: `${short(source.label, 68) ?? agentLabel(source.agentId)} · ${sourceScopeLabel(source)}`,
    hint: `${sanitizeTerminalText(source.path)}${agents ? ` · ${sanitizeTerminalText(agents)}` : ''}`,
  };
}

function renderResourceLine(resource: ResourceInstance): string {
  const description = resource.kind === 'skill' ? short(resource.description, 80) : undefined;
  return `  ${resource.kind === 'skill' ? 'Skill' : 'MCP'}: ${short(resource.name, 80) ?? '(unnamed)'}${description ? ` — ${description}` : ''} · ${sourceAttribution(resource.source)} · ${sourceScopeLabel(resource.source)}`;
}

export function renderDiscoverySummary(inventory: Inventory): string[] {
  const skills = inventory.resources.filter(resource => resource.kind === 'skill');
  const mcp = inventory.resources.filter(resource => resource.kind === 'mcp');
  const detected = inventory.detectedAgents.map(agentLabel);
  const lines = [
    `${skills.length} skills · ${mcp.length} MCP registrations · ${inventory.sources.length} sources · ${inventory.checkedLocations.length} checked locations`,
    `Detected agents: ${detected.length ? detected.join(', ') : 'none'}`,
    `Supported destinations not detected: ${nativeAdapters.filter(adapter => !inventory.detectedAgents.includes(adapter.id)).map(adapter => adapter.label).join(', ') || 'none'}`,
    'Sources:',
  ];
  if (inventory.sources.length) {
    for (const source of inventory.sources) {
      lines.push(`  ${sourceAttribution(source)} · ${sourceScopeLabel(source)} · ${sanitizeTerminalText(source.path)}`);
    }
  } else lines.push('  No usable source directories found.');
  lines.push('Resources:');
  if (inventory.resources.length) lines.push(...inventory.resources.map(renderResourceLine));
  else lines.push('  No skills or MCP registrations found.');
  lines.push('Checked locations:');
  if (inventory.checkedLocations.length) {
    for (const location of inventory.checkedLocations) lines.push(`  ${checkedLocationLine(location)}`);
  } else lines.push('  No locations were checked.');
  if (inventory.findings.length) lines.push(`Discovery findings: ${inventory.findings.length} · review details before applying.`);
  return lines;
}

function checkedLocationLine(location: CheckedLocation): string {
  return `${agentLabel(location.agentId)} ${location.kind} (${location.scope}, ${location.exists ? 'found' : 'not found'}): ${sanitizeTerminalText(location.path)}`;
}

export function renderFinding(finding: Finding): string {
  const severity = finding.severity === 'error' ? 'Blocking' : 'Warning';
  const path = finding.path ? ` · ${sanitizeTerminalText(finding.path)}` : '';
  const remediation = finding.remediation ? ` · ${sanitizeTerminalText(finding.remediation)}` : '';
  return `${severity} ${sanitizeTerminalText(finding.code)}: ${sanitizeTerminalText(finding.message)}${path}${remediation}`;
}


export function renderPlanReview(plan: Plan, state: LoadedState, checkedCount: number, activeSources: readonly SourceRef[]): string[] {
  const summary = plan.summary;
  const lines = [
    `Checked ${checkedCount} resource${checkedCount === 1 ? '' : 's'} · ${summary.resources.length} authoritative resource${summary.resources.length === 1 ? '' : 's'} (${summary.resources.filter(item => item.kind === 'skill').length} skills, ${summary.resources.filter(item => item.kind === 'mcp').length} MCP)`,
    `Changes: ${summary.additions} additions · ${summary.updates} updates · ${summary.removals} removals · ${summary.unchanged} unchanged`,
    `Skill behavior: ${summary.skillMode ? summary.skillMode === 'link' ? 'links remain connected to the source' : 'copies require another sync after source edits' : 'not applicable'}`,
    'Authoritative edit locations:',
  ];
  if (summary.authorities.length) {
    for (const source of summary.authorities) lines.push(`  ${sourceAttribution(source)} · ${sourceScopeLabel(source)} · ${sanitizeTerminalText(source.path)}`);
  } else lines.push('  No authoritative sources resolved.');
  lines.push('Selected source directories:');
  if (activeSources.length) {
    for (const source of activeSources) lines.push(`  ${sourceAttribution(source)} · ${sourceScopeLabel(source)} · ${sanitizeTerminalText(source.path)}`);
  } else lines.push('  None selected.');
  lines.push('Destinations:');
  if (summary.destinations.length) {
    for (const destination of summary.destinations) {
      const paths = destination.paths.length ? destination.paths.map(sanitizeTerminalText).join(', ') : 'no resolved path';
      lines.push(`  ${agentLabel(destination.agentId)} · ${destination.placement}: ${paths}`);
    }
  } else lines.push('  None selected.');
  const resourceOperations = plan.operations.filter(operation => operation.purpose === 'resource');
  const stateOperations = plan.operations.filter(operation => operation.purpose === 'state');
  const operationCounts = new Map<string, number>();
  for (const operation of resourceOperations) operationCounts.set(operation.kind, (operationCounts.get(operation.kind) ?? 0) + 1);
  lines.push(`Planned file operations: ${[...operationCounts].map(([kind, count]) => `${count} ${kind}`).join(' · ') || 'none'}`);
  lines.push(`Generated configuration/state files: ${stateOperations.length ? stateOperations.map(operation => sanitizeTerminalText(operation.path)).join(', ') : 'none'}`);
  lines.push(`Authority preferences: ${sanitizeTerminalText(state.preferencePath)}`);
  lines.push(`Private ownership state: ${sanitizeTerminalText(state.ownershipPath)}`);
  lines.push(`Findings: ${plan.findings.length}${plan.findings.some(finding => finding.severity === 'error') ? ' · blocking errors prevent apply' : ''}`);
  return lines;
}

export function renderPlanDetails(plan: Plan): string[] {
  const lines = ['Plan details:'];
  for (const operation of plan.operations) {
    lines.push(`  ${operation.kind} · ${sanitizeTerminalText(operation.description)} · ${sanitizeTerminalText(operation.path)}${operation.purpose === 'state' ? ' · generated state' : ''}`);
  }
  if (!plan.operations.length) lines.push('  No filesystem changes are planned.');
  lines.push('Sources and resources:');
  for (const resource of plan.summary.resources) lines.push(`  ${resource.kind} · ${short(resource.name, 80) ?? '(unnamed)'}`);
  if (!plan.summary.resources.length) lines.push('  No authoritative resources resolved.');
  lines.push('Findings:');
  if (plan.findings.length) lines.push(...plan.findings.map(finding => `  ${renderFinding(finding)}`));
  else lines.push('  None.');
  return lines;
}

export function renderApplyResult(result: ApplyResult, mode: 'apply' | 'recovery' = 'apply'): string[] {
  let status: string;
  switch (result.status) {
    case 'applied': status = 'Synchronization applied'; break;
    case 'unchanged': status = 'Already synchronized; no files changed'; break;
    case 'recovered': status = mode === 'apply' ? 'Apply rolled back; the original state was restored' : 'Recovery completed'; break;
    case 'recovery-required': status = mode === 'apply' ? 'Apply stopped with partial changes; recovery is still required' : 'Recovery is still required'; break;
    case 'blocked': status = 'Synchronization was blocked'; break;
    case 'cancelled': status = mode === 'apply' ? 'Apply was cancelled before mutation' : 'Recovery was cancelled after safe settlement'; break;
    case 'declined': status = 'No changes were applied'; break;
  }
  const lines = [status, `${result.changed} changed · ${result.unchanged} unchanged`];
  if (result.backupPath) lines.push(`Recovery backups: ${sanitizeTerminalText(result.backupPath)}`);
  if (result.transactionPath) lines.push(`Transaction: ${sanitizeTerminalText(result.transactionPath)}`);
  if (result.findings.length) lines.push(...result.findings.map(finding => renderFinding(finding)));
  return lines;
}
