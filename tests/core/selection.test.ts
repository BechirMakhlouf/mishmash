import { afterEach, expect, it } from 'vitest';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Inventory, McpResource, SourceRef } from '../../src/model.js';
import { matchesResource, resolveSelection } from '../../src/core/selection.js';
import { snapshotPath } from '../../src/fs/snapshot.js';
import { isRecord, readJsonDocument } from '../../src/resources/jsonc.js';
import { discoverSkills, resourceId, sourceRef } from '../../src/resources/skills.js';
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

it('searches actual metadata and provenance without reading skill bodies or assets as labels', async () => {
  sandbox = await createSandbox();
  const root = join(sandbox.context.projectRoot, '.claude', 'skills');
  const directory = join(root, 'folder-not-name');
  await putFile(join(directory, 'SKILL.md'), '---\nname: Careful Review\ndescription: Inspect database migrations\n---\nbody-only-needle\n');
  await putFile(join(directory, 'assets', 'reference'), 'asset-only-needle');
  const inventory = await inventoryFor(sourceRef('claude-code', root, 'project', 'private', 'Claude Code'));
  expect(inventory.findings).toEqual([]);
  const resource = inventory.resources[0]!;
  expect(matchesResource('  CAREFUL migrations CLAUDE private  ', resource)).toBe(true);
  expect(matchesResource('folder-not-name project', resource)).toBe(true);
  expect(matchesResource('', resource)).toBe(true);
  expect(matchesResource('body-only-needle', resource)).toBe(false);
  expect(matchesResource('asset-only-needle', resource)).toBe(false);
  expect(matchesResource('migrations user', resource)).toBe(false);
});

it('resolves checked IDs against all resources while a filter hides another checked resource', async () => {
  sandbox = await createSandbox();
  const root = join(sandbox.context.projectRoot, 'existing-skills');
  await putSkill(root, 'review', 'Review database changes');
  await putSkill(root, 'deploy', 'Deploy web applications');
  await putSkill(root, 'unchecked');
  const inventory = await inventoryFor(sourceRef('shared', root, 'project', 'shared', 'Existing shared source'));
  const review = inventory.resources.find(resource => resource.name === 'review')!;
  const deploy = inventory.resources.find(resource => resource.name === 'deploy')!;
  const checkedIds = Object.freeze([deploy.id, review.id]);
  const visible = inventory.resources.filter(resource => matchesResource('database', resource));
  expect(visible.map(resource => resource.id)).toEqual([review.id]);
  const before = await snapshotPath(sandbox.root);
  const result = resolveSelection(inventory, checkedIds);
  expect(result.findings).toEqual([]);
  expect(result.resources.map(resource => resource.id)).toEqual([deploy.id, review.id]);
  expect(checkedIds).toEqual([deploy.id, review.id]);
  expect((await snapshotPath(sandbox.root)).digest).toBe(before.digest);
  expect(result.resources.flatMap(resource => resource.snapshot.entries.map(entry => entry.relativePath))).toContain('SKILL.md');
});

it('keeps checked identities through inventory reordering, new entries, metadata and asset edits', async () => {
  sandbox = await createSandbox();
  const root = join(sandbox.context.projectRoot, 'skills');
  const directory = await putSkill(root, 'review', 'Original metadata');
  const source = sourceRef('codex', root, 'project', 'shared', 'Codex');
  const first = await inventoryFor(source);
  const original = first.resources[0]!;
  await putFile(join(directory, 'SKILL.md'), '---\nname: renamed-display-name\ndescription: Changed metadata\n---\nActual updated guidance.\n');
  await putFile(join(directory, 'assets', 'instructions'), 'updated complete directory asset');
  await putSkill(root, 'added-before-review');
  const refreshed = await inventoryFor(source);
  const reordered = { ...refreshed, resources: [...refreshed.resources].reverse() };
  const result = resolveSelection(reordered, [original.id]);
  expect(result.findings).toEqual([]);
  expect(result.resources).toHaveLength(1);
  expect(result.resources[0]?.id).toBe(original.id);
  expect(result.resources[0]?.name).toBe('renamed-display-name');
  expect(result.resources[0]?.snapshot.digest).not.toBe(original.snapshot.digest);
  expect(await readFile(join(result.resources[0]!.path, 'assets', 'instructions'), 'utf8')).toBe('updated complete directory asset');
});

it('reports a stale checked source rather than substituting an available same-named resource', async () => {
  sandbox = await createSandbox();
  const nativeRoot = join(sandbox.context.projectRoot, '.claude', 'skills');
  const sharedRoot = join(sandbox.context.projectRoot, '.agents', 'skills');
  const nativePath = await putSkill(nativeRoot, 'review');
  await putSkill(sharedRoot, 'review');
  const native = sourceRef('claude-code', nativeRoot, 'project', 'shared', 'Claude Code');
  const shared = sourceRef('shared', sharedRoot, 'project', 'shared', 'Shared');
  const first = await inventoryFor(native, shared);
  const checked = first.resources.find(resource => resource.source.id === native.id)!;
  await rm(nativePath, { recursive: true });
  const refreshed = await inventoryFor(native, shared);
  const result = resolveSelection(refreshed, [checked.id]);
  expect(refreshed.resources).toHaveLength(1);
  expect(result.resources).toEqual([]);
  expect(result.findings).toContainEqual(expect.objectContaining({ severity: 'error', code: 'STALE_SELECTION', resourceId: checked.id }));
});

it('deduplicates repeated checkbox IDs without conflating same-named source instances', async () => {
  sandbox = await createSandbox();
  const nativeRoot = join(sandbox.context.homeDir, '.claude', 'skills');
  const sharedRoot = join(sandbox.context.projectRoot, 'skills');
  await putSkill(nativeRoot, 'review');
  await putSkill(sharedRoot, 'review');
  const inventory = await inventoryFor(
    sourceRef('claude-code', nativeRoot, 'user', 'private', 'Claude Code'),
    sourceRef('shared', sharedRoot, 'project', 'shared', 'Shared'),
  );
  const [native, shared] = inventory.resources;
  const result = resolveSelection(inventory, [shared!.id, native!.id, shared!.id]);
  expect(result.findings).toEqual([]);
  expect(result.resources.map(resource => resource.source.scope)).toEqual(['project', 'user']);
  expect(new Set(result.resources.map(resource => resource.id)).size).toBe(2);
});

it('blocks ambiguous inventory IDs instead of selecting the first entry', async () => {
  sandbox = await createSandbox();
  const root = join(sandbox.context.projectRoot, 'skills');
  await putSkill(root, 'review');
  const inventory = await inventoryFor(sourceRef('shared', root, 'project', 'shared', 'Shared'));
  const resource = inventory.resources[0]!;
  const result = resolveSelection({ ...inventory, resources: [resource, resource] }, [resource.id]);
  expect(result.resources).toEqual([]);
  expect(result.findings).toContainEqual(expect.objectContaining({ severity: 'error', code: 'AMBIGUOUS_RESOURCE_ID' }));
});

it('rejects an empty checkbox selection', async () => {
  sandbox = await createSandbox();
  const result = resolveSelection(await inventoryFor(), []);
  expect(result.resources).toEqual([]);
  expect(result.findings).toContainEqual(expect.objectContaining({ severity: 'error', code: 'EMPTY_SELECTION' }));
});

it('does not search native MCP execution fields or credential-bearing values', async () => {
  sandbox = await createSandbox();
  const path = join(sandbox.context.projectRoot, '.mcp.json');
  await putFile(path, JSON.stringify({ mcpServers: { database: { command: 'execution-only-needle', env: { TOKEN: 'private-value-needle' } } } }));
  const document = await readJsonDocument(path);
  expect(document.findings).toEqual([]);
  if (!isRecord(document.value) || !isRecord(document.value.mcpServers) || !isRecord(document.value.mcpServers.database)) throw new Error('Invalid test registration.');
  const native = document.value.mcpServers.database;
  const source = sourceRef('claude-code', path, 'project', 'shared', 'Claude MCP');
  const resource: McpResource = {
    kind: 'mcp', id: resourceId(source, 'mcpServers.database'), name: 'database', source, path,
    locator: 'mcpServers.database', snapshot: document.snapshot,
    definition: { transport: 'stdio', command: String(native.command), nativeAgent: 'claude-code', native, unsupportedFields: [] },
  };
  expect(matchesResource('mcp database claude', resource)).toBe(true);
  expect(matchesResource('execution-only-needle', resource)).toBe(false);
  expect(matchesResource('private-value-needle', resource)).toBe(false);
});
