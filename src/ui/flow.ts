import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  autocompleteMultiselect, cancel, confirm, isCancel, log, select, spinner, text,
} from '@clack/prompts';
import { nativeAdapters } from '../agents/index.js';
import { resolveAuthority, authorityKey } from '../core/authority.js';
import { discover } from '../core/discover.js';
import { matchesResource, resolveSelection } from '../core/selection.js';
import { planSync } from '../core/plan.js';
import { applyPlan } from '../fs/apply.js';
import { inspectRecovery, recoverTransaction } from '../fs/recover.js';
import { readState } from '../state.js';
import { sourceRef } from '../resources/skills.js';
import type {
  AgentId, ApplyResult, AuthorityConfig, Context, DestinationRequest, Inventory, LoadedState, Placement,
  Plan, ResourceInstance, SourceRef,
} from '../model.js';
import {
  renderApplyResult, renderDiscoverySummary, renderFinding,
  renderPlanDetails, renderPlanReview, renderResourceLabel, renderSourceLabel, renderAuthorityName,
  sanitizeTerminalText,
} from './render.js';

export type ConfigurationScope = 'project' | 'private-project' | 'user';
type FlowStage = 'sources' | 'selection' | 'authority' | 'destinations' | 'placements' | 'configuration' | 'skill-mode' | 'plan';

function checkCancelled<T>(value: T | symbol): value is symbol {
  return isCancel(value);
}

function adapterLabel(agentId: AgentId): string {
  return nativeAdapters.find(adapter => adapter.id === agentId)?.label ?? agentId;
}

function operationSummary(plan: Plan): string {
  const errors = plan.findings.filter(finding => finding.severity === 'error').length;
  return errors ? `Plan ready with ${errors} blocking issue${errors === 1 ? '' : 's'}` : 'Plan ready for review';
}

async function withSpinner<T>(message: string, task: () => Promise<T>, completed: (value: T) => string, failed: string, signal: AbortSignal): Promise<T> {
  const indicator = spinner({ signal });
  let stopped = false;
  indicator.start(message);
  try {
    const result = await task();
    indicator.stop(completed(result));
    stopped = true;
    return result;
  } catch {
    indicator.error(failed);
    stopped = true;
    throw new Error('Safe operation failed.');
  } finally {
    if (!stopped) indicator.stop();
  }
}

/** Clack 1.8.1's spinner uses block(), whose Escape handler calls process.exit(0). */
export async function withClackSpinnerExitAbort<T>(task: () => Promise<T>, requestAbort: (reason: Error) => void): Promise<T> {
  const originalExit = process.exit;
  process.exit = function (code?: number): never {
    if (code === 0) {
      requestAbort(new Error('Clack spinner cancelled.'));
      return undefined as never;
    }
    return originalExit.call(process, code);
  };
  try {
    return await task();
  } finally {
    process.exit = originalExit;
  }
}

async function withSafeSpinner<T>(
  message: string,
  task: () => Promise<T>,
  completed: (value: T) => string,
  failed: string,
  signal: AbortSignal,
  requestAbort: (reason: Error) => void,
): Promise<T> {
  return withClackSpinnerExitAbort(
    () => withSpinner(message, task, completed, failed, signal),
    requestAbort,
  );
}

async function discoverInventory(context: Context, signal: AbortSignal, requestAbort: (reason: Error) => void): Promise<Inventory> {
  const inventory = await withSafeSpinner(
    'Discovering skills and MCP registrations…',
    () => discover(context),
    result => `${result.resources.filter(resource => resource.kind === 'skill').length} skills · ${result.resources.filter(resource => resource.kind === 'mcp').length} MCP registrations found`,
    'Discovery could not be completed safely.',
    signal,
    requestAbort,
  );
  log.message(renderDiscoverySummary(inventory));
  for (const finding of inventory.findings) log.message(renderFinding(finding));
  return inventory;
}

async function loadState(context: Context, configuration: ConfigurationScope): Promise<LoadedState> {
  const state = await readState(context, configuration);
  for (const finding of state.findings) log.message(renderFinding(finding));
  return state;
}

export async function includeRememberedSharedSources(context: Context, scopes: readonly ConfigurationScope[]): Promise<Context> {
  const states = await Promise.all(scopes.map(scope => readState(context, scope).catch(() => undefined)));
  const existingIds = new Set((context.extraSources ?? []).map(source => source.id));
  const candidates = new Map<string, SourceRef>();
  for (const state of states) {
    for (const source of state?.choices?.sources ?? []) {
      if (source.agentId !== 'shared' || existingIds.has(source.id)) continue;
      const existing = candidates.get(source.id);
      const agents = [...new Set([...(existing?.agents ?? []), ...(source.agents ?? [])])].sort();
      candidates.set(source.id, existing ? { ...existing, agents } : source);
    }
  }
  const remembered = [...candidates.values()];
  return remembered.length ? { ...context, extraSources: [...(context.extraSources ?? []), ...remembered] } : context;
}

async function discoverRememberedInventory(
  context: Context,
  signal: AbortSignal,
  requestAbort: (reason: Error) => void,
  scopes: readonly ConfigurationScope[] = ['private-project', 'project', 'user'],
): Promise<Inventory> {
  return discoverInventory(await includeRememberedSharedSources(context, scopes), signal, requestAbort);
}

async function chooseConfiguration(
  signal: AbortSignal,
  current: ConfigurationScope | undefined,
  allowProject: boolean,
): Promise<ConfigurationScope | undefined> {
  const options: { value: ConfigurationScope; label: string; hint: string }[] = [
    { value: 'private-project', label: 'Private to this project', hint: 'Kept in user configuration; keyed to this project.' },
    { value: 'user', label: 'User-wide', hint: 'Shared by your own projects in user configuration.' },
    { value: 'project', label: 'Project-shared', hint: 'Stored in .mishmash and shareable with the project.' },
  ];
  const filtered = allowProject ? options : options.filter(option => option.value !== 'project');
  const chosen = await select<ConfigurationScope>({
    message: 'Where should mishmash remember approved source choices?',
    options: filtered,
    ...(current && filtered.some(option => option.value === current) ? { initialValue: current } : { initialValue: 'private-project' as ConfigurationScope }),
    signal,
  });
  return checkCancelled(chosen) ? undefined : chosen;
}

async function chooseDirectory(signal: AbortSignal, message: string): Promise<string | undefined> {
  while (!signal.aborted) {
    const entered = await text({
      message,
      placeholder: 'Enter an existing directory path',
      signal,
    });
    if (checkCancelled(entered)) return undefined;
    const enteredPath = entered.trim();
    if (!enteredPath) {
      log.warn('Enter an existing directory path.');
      continue;
    }
    const candidate = resolve(enteredPath);
    try {
      if (!(await stat(candidate)).isDirectory()) throw new Error();
      return await realpath(candidate);
    } catch {
      log.warn('Choose an existing readable directory.');
    }
  }
  return undefined;
}

async function changeContext(context: Context, signal: AbortSignal): Promise<Context | undefined> {
  const rootKind = await select<'project' | 'home'>({
    message: 'Which context should change?',
    options: [
      { value: 'project', label: 'Project directory', hint: sanitizeTerminalText(context.projectRoot) },
      { value: 'home', label: 'User home directory', hint: sanitizeTerminalText(context.homeDir) },
    ],
    signal,
  });
  if (checkCancelled(rootKind)) return undefined;
  const path = await chooseDirectory(signal, rootKind === 'project' ? 'Choose the project directory to inspect:' : 'Choose the user home directory to inspect:');
  if (!path) return undefined;
  return rootKind === 'project' ? { ...context, projectRoot: path } : { ...context, homeDir: path };
}

async function addExistingSource(context: Context, signal: AbortSignal): Promise<Context | undefined> {
  const path = await chooseDirectory(signal, 'Enter an existing skill directory:');
  if (!path) return undefined;
  const placement = await select<ConfigurationScope>({
    message: 'What scope does this source belong to?',
    options: [
      { value: 'project', label: 'Project-shared', hint: 'Edit location can be shared with this project.' },
      { value: 'private-project', label: 'Private to this project', hint: 'Keep the source private to this machine and project.' },
      { value: 'user', label: 'User-wide', hint: 'Private source in your user context.' },
    ],
    signal,
  });
  if (checkCancelled(placement)) return undefined;
  const scope = placement === 'user' ? 'user' : 'project';
  const visibility = placement === 'project' ? 'shared' : 'private';
  const source = sourceRef('shared', path, scope, visibility, 'Additional skill directory');
  const existing = context.extraSources ?? [];
  return { ...context, extraSources: [...existing.filter(candidate => candidate.id !== source.id), source] };
}

async function emptyDiscoveryLoop(
  initialContext: Context,
  initialInventory: Inventory,
  signal: AbortSignal,
  requestAbort: (reason: Error) => void,
  rememberedScopes: readonly ConfigurationScope[] = ['private-project', 'project', 'user'],
): Promise<{ context: Context; inventory: Inventory } | undefined> {
  let context = initialContext;
  let inventory = initialInventory;
  while (!signal.aborted && inventory.resources.length === 0) {
    log.message('No skills or MCP registrations were found in the checked locations. Change context or add an existing skill directory; no empty picker is shown.');
    const action = await select<'context' | 'source' | 'exit'>({
      message: 'What would you like to do?',
      options: [
        { value: 'context', label: 'Change project or home context' },
        { value: 'source', label: 'Enter an existing skill directory' },
        { value: 'exit', label: 'Exit without changes' },
      ],
      signal,
    });
    if (checkCancelled(action) || action === 'exit') return undefined;
    const nextContext = action === 'context' ? await changeContext(context, signal) : await addExistingSource(context, signal);
    if (!nextContext) return undefined;
    if (action === 'context') {
      const recovery = await recoverPending(nextContext, signal, requestAbort);
      if (recovery !== 'ready') return undefined;
    }
    context = nextContext;
    inventory = await discoverRememberedInventory(context, signal, requestAbort, rememberedScopes);
  }
  return signal.aborted ? undefined : { context, inventory };
}

async function recoverPending(context: Context, signal: AbortSignal, requestAbort: (reason: Error) => void): Promise<'ready' | 'cancelled' | 'blocked'> {
  const status = await withSafeSpinner(
    'Checking for interrupted transactions…',
    () => inspectRecovery(context),
    result => result.transactions.length ? `${result.transactions.length} interrupted transaction${result.transactions.length === 1 ? '' : 's'} need review` : 'No interrupted transaction',
    'Recovery status could not be inspected safely.',
    signal,
    requestAbort,
  );
  if (status.findings.length) {
    for (const finding of status.findings) log.message(renderFinding(finding));
    return 'blocked';
  }
  for (const transaction of status.transactions) {
    log.warn(`An interrupted transaction needs explicit recovery at ${sanitizeTerminalText(transaction.path)}.`);
    const approved = await confirm({
      message: 'Recover this transaction before continuing?',
      initialValue: false,
      signal,
    });
    if (checkCancelled(approved)) return 'cancelled';
    if (!approved) {
      log.message('Recovery was declined; no synchronization was started.');
      return 'blocked';
    }
    const result = await withSafeSpinner(
      'Settling the interrupted transaction…',
      () => recoverTransaction(transaction, { confirmed: true, signal }),
      outcome => outcome.status === 'recovered' ? 'Recovery settled' : 'Recovery needs attention',
      'Recovery could not be completed safely.',
      signal,
      requestAbort,
    );
    log.message(renderApplyResult(result, 'recovery'));
    if (result.status !== 'recovered') return 'blocked';
  }
  if (status.transactions.length) {
    const remaining = await inspectRecovery(context);
    if (remaining.transactions.length || remaining.findings.length) {
      for (const finding of remaining.findings) log.message(renderFinding(finding));
      log.error('Recovery remains pending; no synchronization can be applied.');
      return 'blocked';
    }
  }
  return signal.aborted ? 'cancelled' : 'ready';
}

function sourcesWithResources(inventory: Inventory): SourceRef[] {
  const resourceSources = new Set(inventory.resources.map(resource => resource.source.id));
  return inventory.sources.filter(source => resourceSources.has(source.id));
}

function exactRememberedSource(source: SourceRef, remembered: SourceRef): boolean {
  return source.id === remembered.id && source.path === remembered.path && source.scope === remembered.scope
    && source.visibility === remembered.visibility && source.agentId === remembered.agentId && source.label === remembered.label;
}

function initialSourceIds(inventory: Inventory, state: LoadedState): string[] {
  const available = sourcesWithResources(inventory);
  if (state.choices?.sources.length) {
    return available.filter(source => state.choices!.sources.some(remembered => exactRememberedSource(source, remembered))).map(source => source.id);
  }
  return available.map(source => source.id);
}

async function chooseSources(
  inventory: Inventory,
  initialValues: readonly string[],
  signal: AbortSignal,
): Promise<string[] | undefined> {
  const sources = sourcesWithResources(inventory);
  if (!sources.length) return [];
  const byId = new Map(sources.map(source => [source.id, source]));
  const options = sources.map(source => {
    const view = renderSourceLabel(source);
    return { value: source.id, label: view.label, hint: view.hint };
  });
  const result = await autocompleteMultiselect({
    message: 'Choose the source directories to consider authoritative:',
    options,
    initialValues: [...initialValues],
    required: true,
    maxItems: 7,
    placeholder: 'Filter source directories…',
    filter: (query, option) => {
      const source = byId.get(option.value);
      if (!source) return false;
      const text = [source.label, source.path, source.scope, source.visibility, source.agentId, ...(source.agents ?? [])].join(' ');
      return query.trim().toLowerCase().split(/\s+/).every(term => text.toLowerCase().includes(term));
    },
    signal,
  });
  return checkCancelled(result) ? undefined : result;
}

function resourcesByKind(inventory: Inventory, kind: ResourceInstance['kind']): ResourceInstance[] {
  return inventory.resources.filter(resource => resource.kind === kind);
}

function hasPrivateSource(inventory: Inventory, sourceIds: readonly string[]): boolean {
  const selected = new Set(sourceIds);
  return inventory.sources.some(source => selected.has(source.id) && source.visibility === 'private');
}

async function chooseResourceIds(
  inventory: Inventory,
  kind: ResourceInstance['kind'],
  current: readonly string[],
  initialized: boolean,
  selectedSources: readonly string[],
  signal: AbortSignal,
): Promise<string[] | undefined> {
  const resources = resourcesByKind(inventory, kind);
  if (!resources.length) return [];
  const byId = new Map(resources.map(resource => [resource.id, resource]));
  const initialValues = initialized ? [...current] : resources.filter(resource => selectedSources.includes(resource.source.id)).map(resource => resource.id);
  const result = await autocompleteMultiselect({
    message: kind === 'skill' ? 'Choose skills to synchronize:' : 'Choose MCP registrations to synchronize:',
    options: resources.map(resource => {
      const view = renderResourceLabel(resource);
      return { value: resource.id, label: view.label, hint: view.hint };
    }),
    initialValues,
    required: false,
    maxItems: 7,
    placeholder: kind === 'skill' ? 'Filter skills…' : 'Filter MCP registrations…',
    filter: (query, option) => {
      const resource = byId.get(option.value);
      return resource ? matchesResource(query, resource) : false;
    },
    signal,
  });
  return checkCancelled(result) ? undefined : result;
}

function selectedResources(inventory: Inventory, ids: readonly string[]): ResourceInstance[] {
  const selected = new Set(ids);
  return inventory.resources.filter(resource => selected.has(resource.id));
}

async function reconcileRetainedChoices(
  inventory: Inventory,
  sourceIds: string[],
  skillIds: string[],
  mcpIds: string[],
  signal: AbortSignal,
): Promise<boolean> {
  const resourceIds = new Set(inventory.resources.map(resource => resource.id));
  const staleResources = [...skillIds, ...mcpIds].filter(id => !resourceIds.has(id));
  if (staleResources.length) {
    log.warn(`${staleResources.length} previously checked resource${staleResources.length === 1 ? '' : 's'} are no longer present; no substitute was selected.`);
    const remove = await confirm({
      message: 'Remove those stale IDs and review the current inventory?',
      initialValue: false,
      signal,
    });
    if (checkCancelled(remove) || !remove) return false;
    for (let index = skillIds.length - 1; index >= 0; index--) if (!resourceIds.has(skillIds[index]!)) skillIds.splice(index, 1);
    for (let index = mcpIds.length - 1; index >= 0; index--) if (!resourceIds.has(mcpIds[index]!)) mcpIds.splice(index, 1);
  }
  const sourceSet = new Set(sourcesWithResources(inventory).map(source => source.id));
  const staleSources = sourceIds.filter(id => !sourceSet.has(id));
  if (staleSources.length) {
    log.warn(`${staleSources.length} previously chosen source${staleSources.length === 1 ? '' : 's'} are no longer available; no replacement was chosen.`);
    const remove = await confirm({
      message: 'Remove those unavailable source IDs and review the current sources?',
      initialValue: false,
      signal,
    });
    if (checkCancelled(remove) || !remove) return false;
    const retained = sourceIds.filter(id => sourceSet.has(id));
    sourceIds.splice(0, sourceIds.length, ...retained);
  }
  return true;
}

async function sourceConsistency(
  inventory: Inventory,
  sourceIds: string[],
  resourceIds: readonly string[],
  signal: AbortSignal,
): Promise<'ok' | 'sources' | 'selection' | 'cancelled'> {
  const sourceSet = new Set(sourceIds);
  const outside = selectedResources(inventory, resourceIds).filter(resource => !sourceSet.has(resource.source.id));
  if (!outside.length) return 'ok';
  const missing = [...new Map(outside.map(resource => [resource.source.id, resource.source])).values()];
  log.warn(`Some checked resources come from ${missing.length} source director${missing.length === 1 ? 'y' : 'ies'} not included in the authoritative source choice.`);
  for (const source of missing) log.message(`  ${sanitizeTerminalText(source.label)} · ${sanitizeTerminalText(source.path)}`);
  const action = await select<'sources' | 'selection'>({
    message: 'Review those source choices before planning:',
    options: [
      { value: 'sources', label: 'Choose their source directories explicitly' },
      { value: 'selection', label: 'Review checked resources instead' },
    ],
    signal,
  });
  return checkCancelled(action) ? 'cancelled' : action;
}

function selectedChoiceMap(choices: Readonly<Record<string, string>>, resources: readonly ResourceInstance[]): Record<string, string> {
  const groups = new Map<string, Set<string>>();
  for (const resource of resources) {
    const ids = groups.get(authorityKey(resource)) ?? new Set<string>();
    ids.add(resource.id);
    groups.set(authorityKey(resource), ids);
  }
  const result: Record<string, string> = {};
  for (const [key, id] of Object.entries(choices)) if (groups.get(key)?.has(id)) result[key] = id;
  return result;
}

async function chooseAuthorities(
  inventory: Inventory,
  resourceIds: readonly string[],
  remembered: AuthorityConfig | undefined,
  existingChoices: Readonly<Record<string, string>>,
  signal: AbortSignal,
  forceReview = false,
): Promise<{ choices: Record<string, string> } | undefined> {
  const selection = resolveSelection(inventory, resourceIds);
  const selected = selectedChoiceMap(existingChoices, selection.resources);
  const preview = resolveAuthority(inventory, selection, selected, remembered);
  for (const finding of preview.findings) {
    if (finding.code.startsWith('REMEMBERED_') || finding.code === 'AUTHORITY_REQUIRED') log.message(renderFinding(finding));
  }
  const conflicts = new Map(preview.conflicts.map(conflict => [conflict.key, conflict] as const));
  if (forceReview) {
    const groups = new Map<string, ResourceInstance[]>();
    for (const resource of selection.resources) {
      const key = authorityKey(resource);
      const group = groups.get(key) ?? [];
      group.push(resource);
      groups.set(key, group);
    }
    for (const [key, resources] of groups) if (resources.length > 1) conflicts.set(key, { key, resources });
  }
  for (const conflict of conflicts.values()) {
    const candidates = conflict.resources;
    const initial = selected[conflict.key] ?? remembered?.resourceAuthorities[conflict.key];
    while (!signal.aborted) {
      const prompt = await select<string | null>({
        message: `Select the exact source for ${renderAuthorityName(conflict.key)}:`,
        options: [
          { value: null, label: 'Choose an authoritative source…', hint: 'No source is selected until you make a choice.' },
          ...candidates.map(resource => {
            const view = renderResourceLabel(resource);
            return { value: resource.id, label: `${view.label} · ${view.hint}`, hint: sanitizeTerminalText(resource.source.path) };
          }),
        ],
        initialValue: candidates.some(resource => resource.id === initial) ? initial : null,
        signal,
      });
      if (checkCancelled(prompt)) return undefined;
      if (prompt === null) {
        log.warn('Choose one exact source; authority cannot be inferred from list order.');
        continue;
      }
      selected[conflict.key] = prompt;
      break;
    }
    if (signal.aborted) return undefined;
  }
  return { choices: selected };
}

function supportedPlacements(agentId: AgentId, kinds: readonly ResourceInstance['kind'][]): Placement[] {
  const adapter = nativeAdapters.find(candidate => candidate.id === agentId);
  if (!adapter || kinds.length === 0) return [];
  return (['project', 'private-project', 'user'] as const).filter(placement => kinds.every(kind =>
    kind === 'skill' ? adapter.capabilities.skills.includes(placement) : adapter.capabilities.mcp.includes(placement)));
}

async function chooseDestinationAgents(
  inventory: Inventory,
  selected: readonly ResourceInstance[],
  current: readonly AgentId[],
  signal: AbortSignal,
): Promise<AgentId[] | undefined> {
  const kinds = [...new Set(selected.map(resource => resource.kind))];
  const adapters = nativeAdapters.filter(adapter => supportedPlacements(adapter.id, kinds).length > 0);
  if (!adapters.length) {
    log.error('No destination supports every selected resource kind in a shared placement.');
    return [];
  }
  const detected = new Set(inventory.detectedAgents);
  const compatibleIds = new Set(adapters.map(adapter => adapter.id));
  const incompatibleCurrent = current.filter(agentId => !compatibleIds.has(agentId));
  if (incompatibleCurrent.length) log.warn(`Previously chosen destinations no longer support the selected resource kinds and must be chosen again: ${incompatibleCurrent.map(adapterLabel).join(', ')}.`);
  const options = adapters.map(adapter => ({
    value: adapter.id,
    label: adapter.label,
    hint: detected.has(adapter.id) ? 'Detected in this context' : 'Supported destination · not detected',
  }));
  const result = await autocompleteMultiselect({
    message: 'Choose destination agents (the source is not added automatically):',
    options,
    initialValues: current.some(agentId => compatibleIds.has(agentId))
      ? current.filter(agentId => compatibleIds.has(agentId))
      : adapters.filter(adapter => detected.has(adapter.id)).map(adapter => adapter.id),
    required: true,
    maxItems: 7,
    placeholder: 'Filter destinations…',
    signal,
  });
  return checkCancelled(result) ? undefined : result;
}

async function choosePlacements(
  agents: readonly AgentId[],
  kinds: readonly ResourceInstance['kind'][],
  current: Readonly<Partial<Record<AgentId, Placement>>>,
  signal: AbortSignal,
  forceReview = false,
): Promise<Partial<Record<AgentId, Placement>> | undefined> {
  const result: Partial<Record<AgentId, Placement>> = {};
  for (const agentId of agents) {
    const supported = supportedPlacements(agentId, kinds);
    const existing = current[agentId];
    if (!forceReview && existing && supported.includes(existing)) {
      result[agentId] = existing;
      continue;
    }
    const options: { value: Placement | null; label: string; hint?: string }[] = [
      { value: null, label: 'Choose a placement…', hint: 'Placement is explicit and may be private.' },
      ...supported.map(placement => ({
        value: placement,
        label: placement === 'project' ? 'Project-shared' : placement === 'private-project' ? 'Private to this project' : 'User-wide',
        hint: placement === 'project' ? 'Project resources are shareable.' : 'Kept in a private user location.',
      })),
    ];
    while (!signal.aborted) {
      const answer = await select<Placement | null>({
        message: `Place resources for ${adapterLabel(agentId)}:`,
        options,
        ...(current[agentId] && supported.includes(current[agentId]!) ? { initialValue: current[agentId]! } : { initialValue: null }),
        signal,
      });
      if (checkCancelled(answer)) return undefined;
      if (answer) { result[agentId] = answer; break; }
      log.warn('Choose a placement before continuing.');
    }
  }
  return signal.aborted ? undefined : result;
}

function supportsLinks(agents: readonly AgentId[]): boolean {
  return agents.length > 0 && agents.every(agentId => nativeAdapters.find(adapter => adapter.id === agentId)?.capabilities.links === true);
}

async function chooseSkillMode(
  skillsSelected: boolean,
  destinations: readonly AgentId[],
  current: 'copy' | 'link' | undefined,
  signal: AbortSignal,
): Promise<'copy' | 'link' | undefined> {
  if (!skillsSelected) return undefined;
  if (!supportsLinks(destinations)) {
    log.message('Selected destinations do not all support skill links; skills will be copied.');
    return 'copy';
  }
  const mode = await select<'copy' | 'link'>({
    message: 'How should selected skills reach the destinations?',
    options: [
      { value: 'copy', label: 'Copy', hint: 'Edits to the source require another synchronization.' },
      { value: 'link', label: 'Link', hint: 'Destination skill paths remain connected to the authoritative source.' },
    ],
    ...(current ? { initialValue: current } : {}),
    signal,
  });
  return checkCancelled(mode) ? undefined : mode;
}

function destinationRequests(agents: readonly AgentId[], placements: Readonly<Partial<Record<AgentId, Placement>>>): DestinationRequest[] {
  return agents.flatMap(agentId => placements[agentId] ? [{ agentId, placement: placements[agentId]! }] : []);
}

function blocking(plan: Plan): boolean {
  return plan.findings.some(finding => finding.severity === 'error');
}

async function reviewPlan(
  plan: Plan,
  state: LoadedState,
  checkedCount: number,
  activeSources: readonly SourceRef[],
  inventory: Inventory,
  signal: AbortSignal,
): Promise<'apply' | 'edit' | 'cancelled' | undefined> {
  log.message(renderPlanReview(plan, state, checkedCount, activeSources));
  for (const finding of plan.findings) log.message(renderFinding(finding));
  const canApply = !blocking(plan);
  const action = await select<'apply' | 'details' | 'edit' | 'cancel'>({
    message: canApply ? 'Review the synchronization plan:' : 'Resolve the blocking findings before applying:',
    options: [
      { value: 'details', label: 'Show full safe details' },
      { value: 'edit', label: 'Change choices' },
      { value: 'apply', label: 'Continue to final confirmation', disabled: !canApply },
      { value: 'cancel', label: 'Cancel' },
    ],
    initialValue: canApply ? 'details' : 'details',
    signal,
  });
  if (checkCancelled(action) || action === 'cancel') return 'cancelled';
  if (action === 'details') {
    log.message(renderPlanDetails(plan, inventory.resources));
    return undefined;
  }
  if (action === 'edit') return 'edit';
  return 'apply';
}

async function chooseEditStage(signal: AbortSignal): Promise<FlowStage | undefined> {
  const stage = await select<FlowStage>({
    message: 'Which choices should change?',
    options: [
      { value: 'sources', label: 'Authoritative source directories' },
      { value: 'selection', label: 'Selected skills and MCP registrations' },
      { value: 'authority', label: 'Exact source for selected conflicts' },
      { value: 'destinations', label: 'Destination agents' },
      { value: 'placements', label: 'Project, private-project, or user placement' },
      { value: 'skill-mode', label: 'Skill copy or link behavior' },
      { value: 'configuration', label: 'Authority preference storage scope' },
    ],
    signal,
  });
  return checkCancelled(stage) ? undefined : stage;
}

function selectedSourceRecords(inventory: Inventory, ids: readonly string[]): SourceRef[] {
  const selected = new Set(ids);
  return inventory.sources.filter(source => selected.has(source.id));
}

function displayPlanFailure(): void {
  // Native parser and filesystem errors can contain configuration bytes or credentials.
  log.error('Planning could not be completed safely. No changes were written.');
}

export async function runInteractiveFlow(initialContext: Context, signal: AbortSignal, requestAbort: (reason: Error) => void): Promise<void> {
  let context = initialContext;
  let inventory: Inventory;
  let state: LoadedState;
  let configuration: ConfigurationScope = 'private-project';
  let sourceIds: string[] = [];
  let skillIds: string[] = [];
  let mcpIds: string[] = [];
  let selectionInitialized = false;
  let explicitChoices: Record<string, string> = {};
  let destinationAgents: AgentId[] = [];
  let placements: Partial<Record<AgentId, Placement>> = {};
  let skillMode: 'copy' | 'link' | undefined;
  let plan: Plan | undefined;
  let stage: FlowStage = 'sources';
  let manageSources = false;
  let forceAuthorityReview = false;
  let forcePlacementReview = false;

  try {
    const recovery = await recoverPending(context, signal, requestAbort);
    if (recovery !== 'ready') {
      if (recovery === 'cancelled') cancel('Cancelled before synchronization; no synchronization files were written.');
      return;
    }
    inventory = await discoverRememberedInventory(context, signal, requestAbort);
    if (inventory.resources.length === 0) {
      const found = await emptyDiscoveryLoop(context, inventory, signal, requestAbort);
      if (!found) {
        cancel('Cancelled before synchronization; no synchronization files were written.');
        return;
      }
      context = found.context;
      inventory = found.inventory;
    }


    const chosenConfiguration = await chooseConfiguration(signal, undefined, true);
    if (!chosenConfiguration) {
      cancel('Cancelled before synchronization; no synchronization files were written.');
      return;
    }
    configuration = chosenConfiguration;
    state = await loadState(context, configuration);
    sourceIds = initialSourceIds(inventory, state);
    stage = 'sources';

    while (!signal.aborted) {
      if (stage === 'sources' && manageSources) {
        manageSources = false;
        const action = await select<'choose' | 'add' | 'context'>({
          message: 'How should source context change?',
          options: [
            { value: 'choose', label: 'Choose discovered source directories' },
            { value: 'add', label: 'Add an existing skill directory' },
            { value: 'context', label: 'Change project or home context' },
          ],
          signal,
        });
        if (checkCancelled(action)) { cancel('Cancelled before synchronization; no synchronization files were written.'); return; }
        if (action !== 'choose') {
          const nextContext = action === 'add' ? await addExistingSource(context, signal) : await changeContext(context, signal);
          if (!nextContext) { cancel('Cancelled before synchronization; no synchronization files were written.'); return; }
          if (action === 'context') {
            const recovery = await recoverPending(nextContext, signal, requestAbort);
            if (recovery !== 'ready') {
              if (recovery === 'cancelled') cancel('Cancelled before synchronization; no synchronization files were written.');
              return;
            }
          }
          context = nextContext;
          inventory = await discoverRememberedInventory(context, signal, requestAbort, [configuration]);
          if (inventory.resources.length === 0) {
            const found = await emptyDiscoveryLoop(context, inventory, signal, requestAbort, [configuration]);
            if (!found) { cancel('Cancelled before synchronization; no synchronization files were written.'); return; }
            context = found.context;
            inventory = found.inventory;
          }
          state = await loadState(context, configuration);
          if (!await reconcileRetainedChoices(inventory, sourceIds, skillIds, mcpIds, signal)) {
            cancel('Cancelled because previous source or resource choices need explicit review.');
            return;
          }
          explicitChoices = selectedChoiceMap(explicitChoices, selectedResources(inventory, [...skillIds, ...mcpIds]));
          stage = 'sources';
          continue;
        }
      }
      if (stage === 'sources') {
        const chosen = await chooseSources(inventory, sourceIds, signal);
        if (!chosen) { cancel('Cancelled before synchronization; no synchronization files were written.'); return; }
        sourceIds = chosen;
        if (hasPrivateSource(inventory, sourceIds) && configuration === 'project') {
          log.warn('Project-shared preferences cannot contain private source locations.');
          const nextConfiguration = await chooseConfiguration(signal, undefined, false);
          if (!nextConfiguration) { cancel('Cancelled before synchronization; no synchronization files were written.'); return; }
          configuration = nextConfiguration;
          state = await loadState(context, configuration);
        }
        if (!selectionInitialized) {
          const active = new Set(sourceIds);
          skillIds = inventory.resources.filter(resource => resource.kind === 'skill' && active.has(resource.source.id)).map(resource => resource.id);
          mcpIds = inventory.resources.filter(resource => resource.kind === 'mcp' && active.has(resource.source.id)).map(resource => resource.id);
          selectionInitialized = true;
        }
        const consistency = await sourceConsistency(inventory, sourceIds, [...skillIds, ...mcpIds], signal);
        if (consistency === 'cancelled') { cancel('Cancelled before synchronization; no synchronization files were written.'); return; }
        if (consistency !== 'ok') { stage = consistency; continue; }
        stage = 'selection';
        continue;
      }

      if (stage === 'selection') {
        const skills = await chooseResourceIds(inventory, 'skill', skillIds, true, sourceIds, signal);
        if (!skills) { cancel('Cancelled before synchronization; no synchronization files were written.'); return; }
        skillIds = skills;
        const mcps = await chooseResourceIds(inventory, 'mcp', mcpIds, true, sourceIds, signal);
        if (!mcps) { cancel('Cancelled before synchronization; no synchronization files were written.'); return; }
        mcpIds = mcps;
        if (skillIds.length + mcpIds.length === 0) {
          log.warn('Select at least one skill or MCP registration. MCP-only selection is supported.');
          continue;
        }
        const consistency = await sourceConsistency(inventory, sourceIds, [...skillIds, ...mcpIds], signal);
        if (consistency === 'cancelled') { cancel('Cancelled before synchronization; no synchronization files were written.'); return; }
        if (consistency !== 'ok') { stage = consistency; continue; }
        stage = 'authority';
        continue;
      }

      if (stage === 'authority') {
        const revisitingAuthority = forceAuthorityReview;
        const choices = await chooseAuthorities(inventory, [...skillIds, ...mcpIds], state.choices, explicitChoices, signal, revisitingAuthority);
        if (!choices) { cancel('Cancelled before synchronization; no synchronization files were written.'); return; }
        explicitChoices = choices.choices;
        forceAuthorityReview = false;
        stage = revisitingAuthority ? 'plan' : 'destinations';
        continue;
      }

      if (stage === 'destinations') {
        const chosen = await chooseDestinationAgents(inventory, selectedResources(inventory, [...skillIds, ...mcpIds]), destinationAgents, signal);
        if (!chosen) { cancel('Cancelled before synchronization; no synchronization files were written.'); return; }
        if (!chosen.length) return;
        const kinds = [...new Set(selectedResources(inventory, [...skillIds, ...mcpIds]).map(resource => resource.kind))];
        const previouslySelected = new Set(destinationAgents);
        const retainedPlacements: Partial<Record<AgentId, Placement>> = {};
        for (const agentId of chosen) {
          const placement = placements[agentId];
          if (previouslySelected.has(agentId) && placement && supportedPlacements(agentId, kinds).includes(placement)) {
            retainedPlacements[agentId] = placement;
          }
        }
        destinationAgents = chosen;
        placements = retainedPlacements;
        stage = 'placements';
        continue;
      }

      if (stage === 'placements') {
        const kinds = [...new Set(selectedResources(inventory, [...skillIds, ...mcpIds]).map(resource => resource.kind))];
        const chosen = await choosePlacements(destinationAgents, kinds, placements, signal, forcePlacementReview);
        if (!chosen) { cancel('Cancelled before synchronization; no synchronization files were written.'); return; }
        forcePlacementReview = false;
        placements = chosen;
        stage = 'skill-mode';
        continue;
      }

      if (stage === 'skill-mode') {
        const chosen = await chooseSkillMode(skillIds.length > 0, destinationAgents, skillMode, signal);
        if (skillIds.length && !chosen) { cancel('Cancelled before synchronization; no synchronization files were written.'); return; }
        skillMode = chosen;
        stage = 'plan';
        continue;
      }

      if (stage === 'configuration') {
        const chosen = await chooseConfiguration(signal, configuration, !hasPrivateSource(inventory, sourceIds));
        if (!chosen) { cancel('Cancelled before synchronization; no synchronization files were written.'); return; }
        configuration = chosen;
        state = await loadState(context, configuration);
        stage = 'authority';
        continue;
      }

      if (stage === 'plan') {
        const resourceIds = [...skillIds, ...mcpIds];
        const selection = resolveSelection(inventory, resourceIds);
        const authority = resolveAuthority(
          inventory,
          selection,
          selectedChoiceMap(explicitChoices, selection.resources),
          state.choices,
        );
        const request = {
          resourceIds,
          authority: authority.choices,
          destinations: destinationRequests(destinationAgents, placements),
          ...(skillIds.length && skillMode ? { skillMode } : {}),
          configuration,
        };
        try {
          plan = await withSafeSpinner(
            'Building a read-only synchronization plan…',
            () => planSync(context, inventory, request, state),
            operationSummary,
            'Planning failed safely.',
            signal,
            requestAbort,
          );
        } catch (error) {
          displayPlanFailure();
          return;
        }
        stage = 'plan';
        const action = await reviewPlan(plan, state, skillIds.length + mcpIds.length, selectedSourceRecords(inventory, sourceIds), inventory, signal);
        if (action === 'cancelled') { cancel('Cancelled before synchronization; no synchronization files were written.'); return; }
        if (action === 'edit') {
          const nextStage = await chooseEditStage(signal);
          if (!nextStage) { cancel('Cancelled before synchronization; no synchronization files were written.'); return; }
          if (nextStage === 'authority') forceAuthorityReview = true;
          if (nextStage === 'placements') forcePlacementReview = true;
          if (nextStage === 'sources') manageSources = true;
          stage = nextStage;
          continue;
        }
        if (!action) continue;
        if (blocking(plan)) continue;
        const approved = await confirm({
          message: 'Apply this reviewed plan? No is the safe default.',
          initialValue: false,
          signal,
        });
        if (checkCancelled(approved)) { cancel('Cancelled before synchronization; no synchronization files were written.'); return; }
        if (!approved) {
          log.message('No synchronization changes were written.');
          return;
        }
        let result: ApplyResult;
        try {
          result = await withSafeSpinner(
            'Applying the confirmed plan…',
            () => applyPlan(plan!, { confirmed: true, signal }),
            outcome => outcome.status === 'applied' ? `${outcome.changed} change${outcome.changed === 1 ? '' : 's'} applied` : outcome.status,
            'Apply did not complete; checking recovery status before reporting.',
            signal,
            requestAbort,
          );
        } catch {
          log.error('Apply stopped unexpectedly. Inspect transaction recovery before retrying.');
          try {
            const recovery = await inspectRecovery(context);
            for (const finding of recovery.findings) log.message(renderFinding(finding));
            for (const transaction of recovery.transactions) log.warn(`Recovery may be required at ${sanitizeTerminalText(transaction.path)}.`);
          } catch {
            log.error('Recovery status could not be inspected; do not retry until the transaction state is reviewed.');
          }
          return;
        }
        log.message([`Reviewed ${plan.summary.resources.length} authoritative resources across ${plan.summary.destinations.length} destinations.`, ...renderApplyResult(result)]);
        if (result.status === 'recovery-required') {
          log.warn('The transaction needs recovery; no further writes will be attempted in this run.');
        }
        return;
      }
    }
    cancel('Cancelled before synchronization; no synchronization files were written.');
  } catch {
    log.error('The interaction could not continue safely. Sensitive configuration details were not displayed.');
  }
}
