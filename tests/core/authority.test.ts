import { afterEach, expect, it } from 'vitest';
import { readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { AuthorityConfig, Inventory, McpResource, SourceRef } from '../../src/model.js';
import { authorityKey, resolveAuthority } from '../../src/core/authority.js';
import { resolveSelection } from '../../src/core/selection.js';
import { snapshotPath } from '../../src/fs/snapshot.js';
import { isRecord, readJsonDocument } from '../../src/resources/jsonc.js';
import { discoverSkills, resourceId, sourceRef } from '../../src/resources/skills.js';
import { encodeAuthorityConfig, getStatePaths, readState } from '../../src/state.js';
import { createSandbox, putFile, putSkill, type Sandbox } from '../helpers/sandbox.js';

let sandbox: Sandbox | undefined;
afterEach(async () => { await sandbox?.cleanup(); });

async function inventoryFor(...sources: SourceRef[]): Promise<Inventory> {
  const discoveries = await Promise.all(sources.map(source => discoverSkills(source)));
  return {
    resources: discoveries.flatMap(result => result.resources), sources, detectedAgents: [], checkedLocations: [],
    findings: discoveries.flatMap(result => result.findings),
  };
}

async function divergentSources() {
  sandbox = await createSandbox();
  const nativeRoot = join(sandbox.context.projectRoot, '.claude', 'skills');
  const sharedRoot = join(sandbox.context.projectRoot, '.agents', 'skills');
  const nativePath = await putSkill(nativeRoot, 'review', 'Native database review');
  const sharedPath = await putSkill(sharedRoot, 'review', 'Shared website review');
  await putFile(join(nativePath, 'assets', 'native-only'), 'native authoritative asset');
  await putFile(join(sharedPath, 'assets', 'shared-only'), 'unchecked competitor asset');
  const nativeSource = sourceRef('claude-code', nativeRoot, 'project', 'private', 'Claude Code');
  const sharedSource = sourceRef('shared', sharedRoot, 'project', 'shared', 'Shared directory');
  const inventory = await inventoryFor(nativeSource, sharedSource);
  expect(inventory.findings).toEqual([]);
  const native = inventory.resources.find(resource => resource.source.id === nativeSource.id)!;
  const shared = inventory.resources.find(resource => resource.source.id === sharedSource.id)!;
  return { inventory, native, shared, nativeSource, sharedSource, nativeRoot, sharedRoot, nativePath, sharedPath };
}

it('uses the checked native source and complete assets, never a same-named shared directory', async () => {
  const { inventory, native, shared } = await divergentSources();
  const before = await snapshotPath(sandbox!.root);
  const result = resolveAuthority(inventory, resolveSelection(inventory, [native.id]), {});
  expect(result.conflicts).toEqual([]);
  expect(result.findings).toEqual([]);
  expect(result.resources).toEqual([native]);
  expect(result.choices).toEqual({ version: 1, sources: [native.source], resourceAuthorities: { 'skill:review': native.id } });
  expect(await readFile(join(result.resources[0]!.path, 'SKILL.md'), 'utf8')).toContain('Native database review');
  expect(await readFile(join(result.resources[0]!.path, 'assets', 'native-only'), 'utf8')).toBe('native authoritative asset');
  expect(result.resources[0]!.snapshot.entries.some(entry => entry.relativePath === 'assets/shared-only')).toBe(false);
  expect(result.resources.some(resource => resource.id === shared.id)).toBe(false);
  expect((await snapshotPath(sandbox!.root)).digest).toBe(before.digest);
});

it('select-all blocks divergent duplicate names regardless of inventory order or remembered preference', async () => {
  const { inventory, native, shared } = await divergentSources();
  const remembered = resolveAuthority(inventory, resolveSelection(inventory, [native.id]), {}).choices;
  for (const resources of [[native, shared], [shared, native]]) {
    const reordered = { ...inventory, resources };
    const result = resolveAuthority(reordered, resolveSelection(reordered, resources.map(resource => resource.id)), {}, remembered);
    expect(result.resources).toEqual([]);
    expect(result.conflicts).toEqual([{ key: 'skill:review', resources }]);
    expect(result.findings).toContainEqual(expect.objectContaining({ severity: 'error', code: 'AUTHORITY_REQUIRED' }));
    expect(result.choices.resourceAuthorities['skill:review']).toBe(native.id);
  }
});

it('explicit duplicate resolution chooses only the exact selected source without merging metadata or assets', async () => {
  const { inventory, native, shared } = await divergentSources();
  const selection = resolveSelection(inventory, [native.id, shared.id]);
  const result = resolveAuthority(inventory, selection, { 'skill:review': shared.id });
  expect(result.conflicts).toEqual([]);
  expect(result.findings).toEqual([]);
  expect(result.resources).toEqual([shared]);
  expect(result.choices.sources).toEqual([shared.source]);
  expect(result.choices.resourceAuthorities).toEqual({ 'skill:review': shared.id });
  expect(await readFile(join(result.resources[0]!.path, 'SKILL.md'), 'utf8')).toContain('Shared website review');
  expect(result.resources[0]!.snapshot.entries.some(entry => entry.relativePath === 'assets/native-only')).toBe(false);
  expect(await readFile(join(native.path, 'assets', 'native-only'), 'utf8')).toBe('native authoritative asset');
});

it('does not let an explicit authority choice pull in an unchecked or wrong-name resource', async () => {
  const { inventory, native, shared } = await divergentSources();
  const selection = resolveSelection(inventory, [native.id]);
  const unchecked = resolveAuthority(inventory, selection, { 'skill:review': shared.id });
  expect(unchecked.resources).toEqual([]);
  expect(unchecked.conflicts).toEqual([{ key: 'skill:review', resources: [native] }]);
  expect(unchecked.findings).toContainEqual(expect.objectContaining({ severity: 'error', code: 'INVALID_AUTHORITY_CHOICE' }));
  const wrongKey = resolveAuthority(inventory, selection, { 'skill:different-name': native.id });
  expect(wrongKey.findings).toContainEqual(expect.objectContaining({ severity: 'error', code: 'INVALID_AUTHORITY_CHOICE' }));
  expect(wrongKey.choices.resourceAuthorities['skill:different-name']).toBeUndefined();
});

it('requires an explicit edit location even for independent byte-identical directories', async () => {
  sandbox = await createSandbox();
  const roots = [join(sandbox.context.projectRoot, 'one'), join(sandbox.context.projectRoot, 'two')];
  await Promise.all(roots.map(root => putSkill(root, 'review')));
  const inventory = await inventoryFor(...roots.map(root => sourceRef('shared', root, 'project', 'shared', root)));
  expect(inventory.resources[0]!.snapshot.digest).toBe(inventory.resources[1]!.snapshot.digest);
  expect(inventory.resources[0]!.id).not.toBe(inventory.resources[1]!.id);
  const result = resolveAuthority(inventory, resolveSelection(inventory, inventory.resources.map(resource => resource.id)), {});
  expect(result.resources).toEqual([]);
  expect(result.conflicts).toHaveLength(1);
});

it('does not infer alias authority from identical physical paths and retains chosen agent provenance', async () => {
  sandbox = await createSandbox();
  const root = join(sandbox.context.projectRoot, 'skills');
  const alias = join(sandbox.context.projectRoot, 'native-alias');
  await putSkill(root, 'review');
  await symlink(root, alias);
  const nativeSource: SourceRef = {
    ...sourceRef('claude-code', alias, 'project', 'private', 'Native alias'), agents: ['claude-code', 'codex'],
  };
  const inventory = await inventoryFor(sourceRef('shared', root, 'project', 'shared', 'Shared'), nativeSource);
  const [shared, native] = inventory.resources;
  expect(shared!.path).toBe(native!.path);
  const selection = resolveSelection(inventory, [shared!.id, native!.id]);
  expect(resolveAuthority(inventory, selection, {}).conflicts).toHaveLength(1);
  const approved = resolveAuthority(inventory, selection, { 'skill:review': native!.id });
  expect(approved.resources[0]!.source).toEqual(nativeSource);
  expect(approved.choices.sources).toEqual([nativeSource]);
});

it('persists exact approved sources and reviews a missing remembered authority without fallback', async () => {
  const { inventory, native, shared, nativeRoot, sharedSource } = await divergentSources();
  const approved = resolveAuthority(inventory, resolveSelection(inventory, [native.id]), {});
  const paths = await getStatePaths(sandbox!.context);
  await putFile(paths.preferencePath, encodeAuthorityConfig(approved.choices));
  const loaded = await readState(sandbox!.context);
  expect(loaded.findings).toEqual([]);
  expect(loaded.choices).toEqual(approved.choices);
  await rm(nativeRoot, { recursive: true });
  const refreshed = await inventoryFor(sharedSource);
  const selection = resolveSelection(refreshed, [shared.id]);
  const unresolved = resolveAuthority(refreshed, selection, {}, loaded.choices);
  expect(unresolved.resources).toEqual([]);
  expect(unresolved.conflicts).toEqual([{ key: 'skill:review', resources: refreshed.resources }]);
  expect(unresolved.findings).toContainEqual(expect.objectContaining({ severity: 'error', code: 'REMEMBERED_AUTHORITY_MISSING', resourceId: native.id }));
  expect(unresolved.choices).toEqual(approved.choices);
  const reapproved = resolveAuthority(refreshed, selection, { 'skill:review': shared.id }, loaded.choices);
  expect(reapproved.findings.some(finding => finding.severity === 'error')).toBe(false);
  expect(reapproved.resources.map(resource => resource.id)).toEqual([shared.id]);
  expect(reapproved.choices.resourceAuthorities['skill:review']).toBe(shared.id);
  expect(await readFile(paths.preferencePath, 'utf8')).toBe(Buffer.from(encodeAuthorityConfig(approved.choices)).toString());
});

it('requires explicit review before replacing an available remembered native authority with another checked source', async () => {
  const { inventory, native, shared } = await divergentSources();
  const remembered = resolveAuthority(inventory, resolveSelection(inventory, [native.id]), {}).choices;
  const selection = resolveSelection(inventory, [shared.id]);
  const unresolved = resolveAuthority(inventory, selection, {}, remembered);
  expect(unresolved.resources).toEqual([]);
  expect(unresolved.choices.resourceAuthorities['skill:review']).toBe(native.id);
  expect(unresolved.findings).toContainEqual(expect.objectContaining({ severity: 'error', code: 'REMEMBERED_AUTHORITY_CHANGED' }));
  const approved = resolveAuthority(inventory, selection, { 'skill:review': shared.id }, remembered);
  expect(approved.conflicts).toEqual([]);
  expect(approved.resources).toEqual([shared]);
  expect(approved.choices.resourceAuthorities['skill:review']).toBe(shared.id);
});

it('retains unrelated missing authority preferences during a subset synchronization without blocking it', async () => {
  const { inventory, native, sharedSource, nativeRoot } = await divergentSources();
  const remembered = resolveAuthority(inventory, resolveSelection(inventory, [native.id]), {}).choices;
  await rm(nativeRoot, { recursive: true });
  await putSkill(sharedSource.path, 'deploy', 'Deploy selected application');
  const refreshed = await inventoryFor(sharedSource);
  const deploy = refreshed.resources.find(resource => resource.name === 'deploy')!;
  const approved = resolveAuthority(refreshed, resolveSelection(refreshed, [deploy.id]), {}, remembered);
  expect(approved.resources).toEqual([deploy]);
  expect(approved.conflicts).toEqual([]);
  expect(approved.findings.some(finding => finding.severity === 'error')).toBe(false);
  expect(approved.findings).toContainEqual(expect.objectContaining({ severity: 'warning', code: 'REMEMBERED_AUTHORITY_MISSING', resourceId: native.id }));
  expect(approved.choices.resourceAuthorities).toEqual({ 'skill:review': native.id, 'skill:deploy': deploy.id });
  expect(approved.choices.sources).toEqual([native.source, deploy.source]);
});

it('blocks changed remembered privacy or location fields until the exact current source is reapproved', async () => {
  const { inventory, native } = await divergentSources();
  const original = resolveAuthority(inventory, resolveSelection(inventory, [native.id]), {}).choices;
  for (const changed of [{ ...native.source, visibility: 'shared' as const }, { ...native.source, path: join(sandbox!.root, 'old-location') }]) {
    const remembered: AuthorityConfig = { ...original, sources: [changed] };
    const selection = resolveSelection(inventory, [native.id]);
    const unresolved = resolveAuthority(inventory, selection, {}, remembered);
    expect(unresolved.resources).toEqual([]);
    expect(unresolved.findings).toContainEqual(expect.objectContaining({ severity: 'error', code: 'REMEMBERED_AUTHORITY_CHANGED' }));
    expect(unresolved.choices.sources).toEqual([changed]);
    const reapproved = resolveAuthority(inventory, selection, { 'skill:review': native.id }, remembered);
    expect(reapproved.conflicts).toEqual([]);
    expect(reapproved.findings.some(finding => finding.severity === 'error')).toBe(false);
    expect(reapproved.choices.sources).toEqual([native.source]);
  }
});

it('keeps stable remembered identity as authoritative content changes and reviews the current complete tree', async () => {
  const { inventory, native, nativePath, nativeSource } = await divergentSources();
  const remembered = resolveAuthority(inventory, resolveSelection(inventory, [native.id]), {}).choices;
  await putFile(join(nativePath, 'SKILL.md'), '---\nname: review\ndescription: Updated native description\n---\nNew authoritative instructions.\n');
  await putFile(join(nativePath, 'assets', 'new-content'), 'new selected asset');
  const refreshed = await inventoryFor(nativeSource);
  const current = refreshed.resources[0]!;
  expect(current.id).toBe(native.id);
  expect(current.snapshot.digest).not.toBe(native.snapshot.digest);
  const resolved = resolveAuthority(refreshed, resolveSelection(refreshed, [native.id]), {}, remembered);
  expect(resolved.findings).toEqual([]);
  expect(resolved.resources).toEqual([current]);
  expect(await readFile(join(resolved.resources[0]!.path, 'assets', 'new-content'), 'utf8')).toBe('new selected asset');
});

it('propagates stale selection errors without reviving a disappeared checked source from remembered choices', async () => {
  const { inventory, native, nativeRoot, sharedSource } = await divergentSources();
  const selection = resolveSelection(inventory, [native.id]);
  const remembered = resolveAuthority(inventory, selection, {}).choices;
  await rm(nativeRoot, { recursive: true });
  const refreshed = await inventoryFor(sharedSource);
  const result = resolveAuthority(refreshed, selection, {}, remembered);
  expect(result.resources).toEqual([]);
  expect(result.findings).toContainEqual(expect.objectContaining({ severity: 'error', code: 'STALE_SELECTION', resourceId: native.id }));
  expect(result.choices).toEqual(remembered);
});

it('keeps skill and MCP authority namespaces separate for actual same-named source records', async () => {
  sandbox = await createSandbox();
  const root = join(sandbox.context.projectRoot, '.claude', 'skills');
  await putSkill(root, 'review');
  const skills = await inventoryFor(sourceRef('claude-code', root, 'project', 'shared', 'Claude skills'));
  const path = join(sandbox.context.projectRoot, '.mcp.json');
  await putFile(path, JSON.stringify({ mcpServers: { review: { command: 'node', args: ['review-server.js'] } } }));
  const document = await readJsonDocument(path);
  expect(document.findings).toEqual([]);
  if (!isRecord(document.value) || !isRecord(document.value.mcpServers) || !isRecord(document.value.mcpServers.review)) throw new Error('Invalid test registration.');
  const native = document.value.mcpServers.review;
  const source = sourceRef('claude-code', path, 'project', 'private', 'Claude MCP');
  const mcp: McpResource = {
    kind: 'mcp', id: resourceId(source, 'mcpServers.review'), name: 'review', source, path,
    locator: 'mcpServers.review', snapshot: document.snapshot,
    definition: { transport: 'stdio', command: 'node', args: ['review-server.js'], nativeAgent: 'claude-code', native, unsupportedFields: [] },
  };
  const inventory: Inventory = { ...skills, resources: [...skills.resources, mcp], sources: [...skills.sources, source] };
  const resolved = resolveAuthority(inventory, resolveSelection(inventory, inventory.resources.map(resource => resource.id)), {});
  expect(authorityKey(skills.resources[0]!)).toBe('skill:review');
  expect(authorityKey(mcp)).toBe('mcp:review');
  expect(resolved.findings).toEqual([]);
  expect(resolved.conflicts).toEqual([]);
  expect(resolved.resources).toHaveLength(2);
  expect(resolved.choices.resourceAuthorities).toEqual({ 'skill:review': skills.resources[0]!.id, 'mcp:review': mcp.id });
});
