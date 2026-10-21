import { homedir } from 'node:os';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { adapters } from './registry.js';
import { readCanonical, discoverSkills, secretDiagnostics, validateServer } from './canonical.js';
import { hashPath, readState } from './safety.js';
import { object, stable, pretty, readDocument, patchDocument, type Document } from './documents.js';
import type { Adapter, AdapterLayout, Context, Diagnostic, JsonObject, NativeFile, Operation, Plan, Scope, Server, Skill, State } from './types.js';

export interface ContextOptions { scope?: Scope; project?: string; home?: string; platform?: NodeJS.Platform; env?: Context['env']; stateDir?: string; opencodeVersion?: 1 | 2; codexHome?: string; claudeStateFile?: string; skillMode?: Context['skillMode'] }
function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
export function createContext(options: ContextOptions = {}): Context {
  const platform = options.platform ?? process.platform;
  const paths = platform === 'win32' ? path.win32 : path.posix;
  let project = paths.resolve(options.project ?? process.cwd());
  if (platform === process.platform) { try { project = realpathSync.native(project); } catch { /* Missing project is diagnosed while planning. */ } }
  const home = paths.resolve(options.home ?? homedir());
  const scope = options.scope ?? 'project';
  if (!['project', 'user', 'project-private'].includes(scope)) throw new Error('Invalid scope');
  const identity = platform === 'win32' ? project.toLowerCase() : project;
  const canonicalRoot = scope === 'project' ? paths.join(project, '.agents') : scope === 'user' ? paths.join(home, '.agents') : paths.join(home, '.agents', 'projects', digest(identity));
  return { scope, project, home, platform, env: options.env ?? (options.home ? { HOME: home, USERPROFILE: home } : { ...process.env }), canonicalRoot,
    stateRoot: options.stateDir ? paths.resolve(options.stateDir) : paths.join(home, '.local', 'state', 'mishmash', digest(canonicalRoot)),
    opencodeVersion: options.opencodeVersion ?? 2, codexHome: options.codexHome ?? (options.home ? home : undefined),
    claudeStateFile: options.claudeStateFile ? paths.resolve(options.claudeStateFile) : undefined, skillMode: options.skillMode ?? 'auto' };
}
interface FoundServer { id: string; adapter: string; document: Document; server?: Server; override?: JsonObject }
interface FoundSkill { skill: Skill; adapter: string }
interface Discovery { servers: FoundServer[]; skills: FoundSkill[]; layouts: Map<string, AdapterLayout>; documents: Map<string, Document>; diagnostics: Diagnostic[]; inputs: Set<string>; hashes: Map<string, string | null> }
function diagnostic(code: string, message: string, extra: Partial<Diagnostic> = {}): Diagnostic { return { code, severity: 'error', message, ...extra }; }
function selected(ids: string[] | undefined): string[] {
  const unique = [...new Set(ids ?? [])].sort();
  for (const id of unique) if (!adapters.has(id)) throw new Error(`Unknown adapter: ${id}`);
  return unique;
}
function inherited(context: Context, file: string): boolean {
  if (context.scope !== 'project') return false;
  const relative = path.relative(context.project, file);
  return relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative);
}
async function discover(context: Context, ids: string[]): Promise<Discovery> {
  const result: Discovery = { servers: [], skills: [], layouts: new Map(), documents: new Map(), diagnostics: [], inputs: new Set(), hashes: new Map() };
  for (const id of ids) {
    const adapter = adapters.get(id)!;
    const layout = adapter.resolve(context);
    result.layouts.set(id, layout); result.diagnostics.push(...layout.diagnostics);
    for (const file of [...(layout.inputs ?? []), ...layout.skillRoots.map(root => root.path), ...layout.mcpFiles.map(file => file.path)]) {
      result.inputs.add(file);
      if (!result.hashes.has(file)) result.hashes.set(file, await hashPath(file));
    }
    if (stable(adapter.resolve(context)) !== stable(layout)) result.diagnostics.push(diagnostic('discovery-race', 'Native resolver inputs changed during discovery', { adapter: id }));
    const skills = await discoverSkills(layout.skillRoots, context);
    result.diagnostics.push(...skills.diagnostics.map(item => ({ ...item, adapter: id })));
    skills.inputs.forEach(file => result.inputs.add(file));
    for (const skill of skills.skills) {
      result.skills.push({ skill, adapter: id });
      result.inputs.add(skill.realPath);
      if (!result.hashes.has(skill.realPath)) result.hashes.set(skill.realPath, skill.hash);
    }
    for (const spec of layout.mcpFiles) {
      result.inputs.add(spec.path);
      try {
        const key = `${spec.path}\0${spec.mapPath.join('\0')}\0${id === 'github-copilot-cli'}`;
        let document = result.documents.get(key);
        if (!document) { document = await readDocument(spec, id === 'github-copilot-cli'); result.documents.set(key, document); }
        for (const [name, value] of Object.entries(document.map).sort(([a], [b]) => a.localeCompare(b))) {
          if (spec.ignoreKeys?.includes(name)) continue;
          if (!object(value)) { result.diagnostics.push(diagnostic('native-invalid-entry', 'Native MCP server must be an object', { adapter: id, resource: name, path: spec.path })); continue; }
          const decoded = adapter.decode(value, context);
          result.diagnostics.push(...decoded.diagnostics.map(item => ({ ...item, adapter: id, resource: name, path: spec.path })));
          const unsafeOverride = secretDiagnostics(decoded.override, name);
          result.diagnostics.push(...unsafeOverride.map(item => ({ ...item, adapter: id, path: spec.path })));
          if (unsafeOverride.some(item => item.severity === 'error')) continue;
          if (decoded.server) {
            const validation = validateServer(decoded.server, name);
            result.diagnostics.push(...validation.diagnostics.map(item => ({ ...item, adapter: id, path: spec.path })));
            if (!validation.server) continue;
          }
          result.servers.push({ id: name, adapter: id, document, server: decoded.server, override: decoded.override });
        }
      } catch { result.diagnostics.push(diagnostic('native-invalid-config', 'Cannot safely parse native configuration', { adapter: id, path: spec.path })); }
    }
  }
  return result;
}
export interface Inventory { skills: { id: string; source: string; adapter: string }[]; mcp: { id: string; source: string; adapter: string; type: string }[] }
export interface Inspection { version: 1; scope: Scope; targets: string[]; inventory: Inventory; diagnostics: Diagnostic[] }
export async function inspect(context: Context, from = 'all'): Promise<Inspection> {
  const canonical = await readCanonical(context);
  const ids = from === 'all' ? (context.scope === 'project-private' ? ['claude-code'] : [...adapters.keys()].sort()) : selected(from.split(','));
  const found = await discover(context, ids);
  const skills = [...canonical.skills.map(skill => ({ id: skill.id, source: skill.path, adapter: 'canonical' })), ...found.skills.map(({ skill, adapter }) => ({ id: skill.id, source: skill.path, adapter }))];
  const mcp = [...Object.entries(canonical.mcp.mcpServers).map(([id, server]) => ({ id, source: path.join(context.canonicalRoot, 'mcp.json'), adapter: 'canonical', type: server.type })), ...found.servers.map(item => ({ id: item.id, source: item.document.spec.path, adapter: item.adapter, type: item.server?.type ?? 'native-only' }))];
  return { version: 1, scope: context.scope, targets: canonical.sync.targets, inventory: { skills, mcp }, diagnostics: sortDiagnostics([...canonical.diagnostics, ...found.diagnostics]) };
}
function sortDiagnostics(items: Diagnostic[]): Diagnostic[] { return [...new Map(items.map(item => [stable(item), item])).values()].sort((a,b) => stable(a).localeCompare(stable(b))); }
async function currentText(file: string): Promise<string | null> { try { return await readFile(file, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; } }
function ownValue<T>(record: Record<string, T> | undefined, key: string): T | undefined { return record && Object.hasOwn(record, key) ? record[key] : undefined; }
function setOwn<T>(record: Record<string, T>, key: string, value: T): void { Object.defineProperty(record, key, { value, enumerable: true, writable: true, configurable: true }); }
function isDisabled(value: JsonObject | undefined): boolean { return value?.enabled === false || value?.disabled === true || value?.active === false; }
function hasToolRestrictions(value: JsonObject | undefined): boolean {
  if (!value) return false;
  return Array.isArray(value.tools) && !value.tools.includes('*')
    || Array.isArray(value.enabled_tools) || Array.isArray(value.includeTools)
    || Array.isArray(value.disabled_tools) && value.disabled_tools.length > 0
    || Array.isArray(value.excludeTools) && value.excludeTools.length > 0
    || value.exposure === 'hidden'
    || object(value.toolExposure) && Object.keys(value.toolExposure).length > 0;
}

export interface PlanOptions { command: 'import' | 'sync'; from?: string; targets?: string[] }
function semantic(server: Server): string {
  return stable(server.type === 'stdio' ? { ...server, args: server.args ?? [], env: server.env ?? {} } : { ...server, headers: server.headers ?? {} });
}
export async function createPlan(context: Context, options: PlanOptions): Promise<Plan> {
  const canonicalHash = await hashPath(context.canonicalRoot);
  const canonical = await readCanonical(context);
  const statePath = path.join(context.stateRoot, 'state.json');
  const stateHash = await hashPath(statePath);
  const diagnostics = [...canonical.diagnostics];
  let state: State;
  try { state = await readState(statePath); } catch { state = { version: 1, managed: {} }; diagnostics.push(diagnostic('state-invalid', 'Ownership state is invalid; recover it before applying')); }
  const priorState = structuredClone(state);
  const sourceIds = options.command === 'import' ? (options.from === 'all' ? (context.scope === 'project-private' ? ['claude-code'] : [...adapters.keys()].sort()) : selected((options.from ?? '').split(',').filter(Boolean))) : [];
  if (options.command === 'import' && !options.from) throw new Error('Import requires --from');
  const targetIds = selected(options.targets?.length ? options.targets : canonical.sync.targets.length ? canonical.sync.targets : context.scope === 'project-private' ? ['claude-code'] : options.command === 'import' ? sourceIds : [...adapters.keys()]);
  const targets = selected(options.command === 'import' ? [...canonical.sync.targets, ...sourceIds, ...targetIds] : targetIds);
  const found = await discover(context, selected([...sourceIds, ...targets]));
  diagnostics.push(...found.diagnostics);
  const skillHashes = new Map(canonical.skills.map(skill => [skill.realPath, skill.hash]));
  const inputs = new Set([context.canonicalRoot, ...canonical.inputs, ...skillHashes.keys(), ...found.inputs, statePath]);
  const operations = new Map<string, Operation>();
  const generatedOutputs = new Set<string>();
  const mcp = structuredClone(canonical.mcp);
  const overrides = structuredClone(canonical.overrides);
  const skills = new Map(canonical.skills.map(skill => [skill.id, skill]));
  const importedSkills: FoundSkill[] = [];
  const importedServers: FoundServer[] = [];
  const sourceIdentity = new Map<string, string>();
  for (const item of found.servers.filter(item => sourceIds.includes(item.adapter))) {
    if (inherited(context, item.document.spec.path)) { diagnostics.push(diagnostic('inherited-resource', 'Inherited native MCP resource is inventoried but not flattened into this project', { severity: 'warning', adapter: item.adapter, resource: item.id, path: item.document.spec.path })); continue; }
    if (!item.server) { diagnostics.push(diagnostic('native-only-resource', 'Native-only entry remains active at its original location', { severity: 'warning', adapter: item.adapter, resource: item.id })); continue; }
    const existingServer = ownValue(mcp.mcpServers, item.id);
    if (existingServer && semantic(existingServer) !== semantic(item.server)) { diagnostics.push(diagnostic('mcp-name-conflict', 'Same MCP server name has different canonical intent', { resource: item.id, adapter: item.adapter })); continue; }
    setOwn(mcp.mcpServers, item.id, item.server);
    if (item.override && Object.keys(item.override).length) {
      if (!Object.hasOwn(overrides, item.adapter)) setOwn(overrides, item.adapter, { version: 1, mcpServers: {} });
      const document = overrides[item.adapter];
      const existing = ownValue(document.mcpServers, item.id);
      if (existing && stable(existing) !== stable(item.override)) diagnostics.push(diagnostic('override-conflict', 'Native source differs from existing adapter override', { resource: item.id, adapter: item.adapter }));
      else setOwn(document.mcpServers, item.id, item.override);
    }
    importedServers.push(item);
  }
  for (const item of found.skills.filter(item => sourceIds.includes(item.adapter))) {
    const skill = item.skill;
    if (inherited(context, skill.path)) { diagnostics.push(diagnostic('inherited-resource', 'Inherited skill is inventoried but not flattened into this project', { severity: 'warning', adapter: item.adapter, resource: skill.id, path: skill.path })); continue; }
    if (skill.nativeOnly) { diagnostics.push(diagnostic('native-skill-preserved', 'Native-only skill remains active at its original location; canonical adoption would change discovery semantics', { severity: 'warning', adapter: item.adapter, resource: skill.id, path: skill.path })); continue; }
    const existing = skills.get(skill.id);
    const identity = sourceIdentity.get(skill.id);
    if ((identity && identity !== skill.realPath) || (existing && existing.hash !== skill.hash)) { diagnostics.push(diagnostic('skill-name-conflict', 'Same skill name identifies distinct native resources', { resource: skill.id, adapter: item.adapter })); continue; }
    sourceIdentity.set(skill.id, skill.realPath);
    if (!existing) skills.set(skill.id, skill);
    importedSkills.push(item);
  }
  async function add(operation: Operation): Promise<void> {
    const previous = operations.get(operation.path);
    if (previous && stable(previous) !== stable(operation)) { diagnostics.push(diagnostic('artifact-conflict', 'Different operations target the same artifact', { path: operation.path })); return; }
    inputs.add(operation.path);
    if (operation.kind === 'copy' || operation.kind === 'link') inputs.add(operation.source);
    if (operation.kind === 'write' && await currentText(operation.path) === operation.content) return;
    if (operation.kind === 'copy' && await hashPath(operation.path) === await hashPath(operation.source)) return;
    if (operation.kind === 'remove' && await hashPath(operation.path) === null) return;
    operations.set(operation.path, operation);
  }
  if (options.command === 'import') {
    if (Object.keys(mcp.mcpServers).length || await hashPath(path.join(context.canonicalRoot, 'mcp.json')) !== null) await add({ kind: 'write', path: path.join(context.canonicalRoot, 'mcp.json'), content: pretty(mcp), reason: 'Adopt portable MCP intent', mode: 0o600 });
    for (const [adapter, data] of Object.entries(overrides)) await add({ kind: 'write', path: path.join(context.canonicalRoot, 'overrides', adapter, 'mcp.json'), content: pretty(data), reason: 'Preserve native server options', mode: 0o600 });
    for (const skill of skills.values()) {
      const destination = path.join(context.canonicalRoot, 'skills', skill.id);
      if (skill.path !== destination && !canonical.skills.some(item => item.id === skill.id)) await add({ kind: 'copy', path: destination, source: skill.realPath, reason: 'Adopt complete skill directory' });
    }
  }
  const syncTargets = options.command === 'import' ? targets : selected([...canonical.sync.targets, ...targets]);
  if (syncTargets.length) await add({ kind: 'write', path: path.join(context.canonicalRoot, 'sync.json'), content: pretty({ version: 1, targets: syncTargets }), reason: 'Record target selection', mode: 0o600 });

  interface Artifact { document: Document; updates: Map<string, JsonObject | undefined>; consumers: Map<string, Adapter> }
  const artifacts = new Map<string, Artifact>();
  function artifact(document: Document): Artifact {
    let item = artifacts.get(document.spec.path);
    if (!item) { item = { document, updates: new Map(), consumers: new Map() }; artifacts.set(document.spec.path, item); }
    else if (stable(item.document.mapPath) !== stable(document.mapPath)) diagnostics.push(diagnostic('shared-envelope-conflict', 'Shared native artifact has incompatible server envelopes', { path: document.spec.path }));
    return item;
  }
  for (const id of targets) {
    const adapter = adapters.get(id)!;
    const layout = found.layouts.get(id)!;
    const spec = layout.mcpFiles.find(file => file.role !== 'legacy');
    if (Object.keys(mcp.mcpServers).length && !spec) diagnostics.push(diagnostic('scope-unsupported', 'Target cannot represent MCP intent in the selected scope', { adapter: id }));
    if (spec) {
      generatedOutputs.add(spec.path);
      const document = found.documents.get(`${spec.path}\0${spec.mapPath.join('\0')}\0${id === 'github-copilot-cli'}`) ?? await readDocument(spec, id === 'github-copilot-cli');
      const output = artifact(document); output.consumers.set(id, adapter);
      const owned = priorState.managed[spec.path]?.keys?.mcp ?? [];
      for (const name of owned) if (!Object.hasOwn(mcp.mcpServers, name)) output.updates.set(name, undefined);
      for (const [name, server] of Object.entries(mcp.mcpServers)) {
        const override = ownValue(ownValue(overrides, id)?.mcpServers, name);
        const disabledSources = Object.entries(overrides).filter(([, document]) => isDisabled(ownValue(document.mcpServers, name)));
        if (disabledSources.length && !isDisabled(override)) { diagnostics.push(diagnostic('activation-incompatible', 'A disabled native server would become active in this target; resolve activation explicitly', { adapter: id, resource: name })); continue; }
        if (Object.entries(overrides).some(([source, document]) => source !== id && hasToolRestrictions(ownValue(document.mcpServers, name)))) {
          diagnostics.push(diagnostic('tool-policy-incompatible', 'A native tool restriction has no established mapping to this target; resolve the policy explicitly before cross-target projection', { adapter: id, resource: name }));
          continue;
        }
        const encoded = adapter.encode(server, override, context);
        diagnostics.push(...encoded.diagnostics.map(item => ({ ...item, adapter: id, resource: name })));
        if (!encoded.entry) continue;
        const existing = ownValue(document.map, name);
        const imported = importedServers.some(item => item.adapter === id && item.id === name && item.document.spec.path === spec.path);
        if (existing !== undefined && !owned.includes(name) && !imported && stable(existing) !== stable(encoded.entry)) {
          const decoded = object(existing) ? adapter.decode(existing, context) : undefined;
          if (!decoded?.server || semantic(decoded.server) !== semantic(server) || stable(decoded.override ?? {}) !== stable(override ?? {})) { diagnostics.push(diagnostic('unmanaged-collision', 'Unmanaged native MCP entry differs from desired intent', { adapter: id, resource: name, path: spec.path })); continue; }
        }
        const previous = output.updates.get(name);
        if (previous) {
          const merged: JsonObject = { ...previous };
          for (const [field, value] of Object.entries(encoded.entry)) {
            if (Object.hasOwn(merged, field) && stable(merged[field]) !== stable(value)) diagnostics.push(diagnostic('shared-entry-conflict', 'Shared native server fields disagree between targets', { path: spec.path, resource: name }));
            else setOwn(merged, field, value);
          }
          output.updates.set(name, merged);
        } else output.updates.set(name, encoded.entry);
      }
    }
    for (const skill of skills.values()) {
      if (context.scope === 'project-private') { diagnostics.push(diagnostic('private-skill-unsupported', 'Project-private skills cannot be safely exposed by this target', { adapter: id, resource: skill.id })); continue; }
      if (skill.nativeOnly) { diagnostics.push(diagnostic('native-skill-preserved', 'Skill has native-only metadata; original exposure remains active and no portable exposure is generated', { severity: 'warning', adapter: id, resource: skill.id })); continue; }
      const source = path.join(context.canonicalRoot, 'skills', skill.id);
      if (layout.directSkills) continue;
      if (!layout.skillDestination) { diagnostics.push(diagnostic('skills-unsupported', 'Target has no verified compatible skill exposure', { adapter: id, resource: skill.id })); continue; }
      if (layout.skillRoots.some(root => root.path === layout.skillDestination && root.ignoredDirectories?.includes(skill.id))) {
        diagnostics.push(diagnostic('reserved-skill-destination', 'The native skill name is reserved for account-managed resources', { adapter: id, resource: skill.id }));
        continue;
      }
      const destination = path.join(layout.skillDestination, skill.id);
      if (destination === source) continue;
      generatedOutputs.add(destination);
      const existingHash = await hashPath(destination);
      const imported = importedSkills.some(item => item.skill.path === destination && item.skill.id === skill.id);
      const managed = priorState.managed[destination];
      if (existingHash !== null && !managed && !imported) {
        try { if (realpathSync.native(destination) === realpathSync.native(source)) continue; } catch { /* Planned canonical source may not yet exist. */ }
        diagnostics.push(diagnostic('unmanaged-collision', 'Unmanaged skill destination already exists', { adapter: id, resource: skill.id, path: destination })); continue;
      }
      if (managed && existingHash === managed.hash && !operations.has(source)) {
        if (managed.kind === 'link') continue;
        if (managed.kind === 'copy' && existingHash === await hashPath(source)) continue;
      }
      await add(context.skillMode === 'copy' ? { kind: 'copy', path: destination, source: operations.get(source)?.kind === 'copy' ? skill.path : source, reason: 'Expose complete skill directory' } : { kind: 'link', path: destination, source, fallbackCopy: context.skillMode === 'auto', reason: 'Expose compatible skill link' });
    }
  }
  // Native import sources are cut over only in the same validated transaction.
  for (const item of importedSkills) {
    const layout = found.layouts.get(item.adapter)!;
    const destination = path.join(context.canonicalRoot, 'skills', item.skill.id);
    if (!item.skill.nativeOnly && layout.directSkills && item.skill.path !== destination && !inherited(context, item.skill.path)) await add({ kind: 'remove', path: item.skill.path, reason: 'Remove superseded native skill after canonical adoption' });
  }
  for (const item of importedServers) {
    if (item.document.spec.role === 'legacy' && !inherited(context, item.document.spec.path)) artifact(item.document).updates.set(item.id, undefined);
  }
  for (const [file, output] of artifacts) {
    for (const [name, entry] of output.updates) {
      if (!entry || !Object.hasOwn(mcp.mcpServers, name)) continue;
      for (const [adapterId, adapter] of output.consumers) {
        const decoded = adapter.decode(entry, context);
        diagnostics.push(...secretDiagnostics(decoded.override, name).map(item => ({ ...item, adapter: adapterId, path: file })));
        if (!decoded.server || decoded.diagnostics.some(item => item.severity === 'error') || semantic(decoded.server) !== semantic(mcp.mcpServers[name])) diagnostics.push(diagnostic('shared-consumer-conflict', 'Projected artifact cannot preserve intent for every participating consumer', { adapter: adapterId, resource: name, path: file }));
      }
    }
    const changed = new Map([...output.updates].filter(([name, value]) => stable(ownValue(output.document.map, name)) !== stable(value)));
    if (changed.size) await add({ kind: 'write', path: file, content: patchDocument(output.document, changed), mode: output.document.spec.private || context.scope !== 'project' ? 0o600 : undefined, reason: 'Reconcile native MCP server map' });
    const keys = Object.keys(mcp.mcpServers).filter(name => output.updates.get(name) !== undefined);
    if (operations.has(file) || priorState.managed[file]) state.managed[file] = { path: file, hash: priorState.managed[file]?.hash ?? '', kind: 'write', keys: { mcp: keys } };
  }
  for (const operation of operations.values()) {
    if (operation.kind === 'remove') delete state.managed[operation.path];
    else state.managed[operation.path] ??= { path: operation.path, hash: '', kind: operation.kind };
    if (!operation.path.startsWith(context.canonicalRoot + path.sep)) generatedOutputs.add(operation.path);
  }
  for (const file of generatedOutputs) {
    const managed = priorState.managed[file];
    if (managed && await hashPath(file) !== managed.hash) diagnostics.push(diagnostic('owned-drift', 'Owned output changed since the last successful apply', { path: file }));
  }
  // All reads and destinations are rechecked together before the first mutation.
  const preconditions = await Promise.all([...inputs].sort().map(async file => ({ path: file, hash: file === context.canonicalRoot ? canonicalHash : file === statePath ? stateHash : found.hashes.has(file) ? found.hashes.get(file)! : skillHashes.has(file) ? skillHashes.get(file)! : await hashPath(file) })));
  const ordered = [...operations.values()].sort((a,b) => {
    const rank = (operation: Operation): number => operation.kind === 'copy' && operation.path.startsWith(context.canonicalRoot + path.sep) ? 0 : operation.kind === 'remove' ? 3 : operation.kind === 'link' ? 2 : 1;
    return rank(a) - rank(b) || a.path.localeCompare(b.path);
  });
  return { version: 1, command: options.command, scope: context.scope, targets, operations: ordered, diagnostics: sortDiagnostics(diagnostics), preconditions, statePath, state };
}
