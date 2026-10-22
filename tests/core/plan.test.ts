import { afterEach, expect, it } from 'vitest';
import { cp, mkdir, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { AgentId, AuthorityConfig, DestinationRequest, OwnershipState, ResourceInstance, SyncRequest } from '../../src/model.js';
import { discover } from '../../src/core/discover.js';
import { applyPlan } from '../../src/fs/apply.js';
import { planSync } from '../../src/core/plan.js';
import { fingerprintValue, snapshotMatches, snapshotPath } from '../../src/fs/snapshot.js';
import { decodeAuthorityConfig, decodeOwnershipState, encodeAuthorityConfig, encodeOwnershipState, getStatePaths, readState } from '../../src/state.js';
import { sourceRef } from '../../src/resources/skills.js';
import { createSandbox, putFile, putSkill, type Sandbox } from '../helpers/sandbox.js';

let sandbox: Sandbox | undefined;
afterEach(async () => { await sandbox?.cleanup(); });

const emptyAuthority = (): AuthorityConfig => ({ version: 1, sources: [], resourceAuthorities: {} });
function request(resourceIds: readonly string[], destinations: readonly DestinationRequest[], extra: Partial<SyncRequest> = {}): SyncRequest {
  return {
    resourceIds, authority: emptyAuthority(), destinations, configuration: 'private-project', skillMode: 'copy', ...extra,
  };
}
async function inventoryFor(box: Sandbox = sandbox!): Promise<Awaited<ReturnType<typeof discover>>> {
  return discover(box.context);
}
async function loadState(box: Sandbox = sandbox!) { return readState(box.context, 'private-project'); }
function skill(inventory: Awaited<ReturnType<typeof discover>>, name: string, sourcePath?: string): ResourceInstance {
  const result = inventory.resources.find(resource => resource.kind === 'skill' && resource.name === name
    && (!sourcePath || resource.path === sourcePath));
  if (!result) throw new Error(`Expected discovered skill: ${name}`);
  return result;
}
function mcp(inventory: Awaited<ReturnType<typeof discover>>, name: string, nativeAgent?: AgentId): ResourceInstance {
  const result = inventory.resources.find(resource => resource.kind === 'mcp' && resource.name === name
    && (!nativeAgent || (resource.kind === 'mcp' && resource.definition.nativeAgent === nativeAgent)));
  if (!result) throw new Error(`Expected discovered MCP definition: ${name}`);
  return result;
}
function resources(operations: Awaited<ReturnType<typeof planSync>>['operations']) {
  return operations.filter(operation => operation.purpose === 'resource');
}
function stateContent(plan: Awaited<ReturnType<typeof planSync>>, pathIncludes: string): Uint8Array {
  const operation = plan.operations.find(item => item.purpose === 'state' && item.kind === 'write' && item.path.includes(pathIncludes));
  if (!operation || operation.kind !== 'write' || operation.content.kind !== 'bytes') throw new Error(`Expected planned state bytes: ${pathIncludes}`);
  return operation.content.bytes;
}

it('requires an exact choice for divergent same-name sources and plans only the chosen tree', async () => {
  sandbox = await createSandbox();
  const nativeRoot = join(sandbox.context.projectRoot, '.claude', 'skills');
  const sharedRoot = join(sandbox.context.projectRoot, '.agents', 'skills');
  const native = await putSkill(nativeRoot, 'review', 'Native review guidance');
  const shared = await putSkill(sharedRoot, 'review', 'Shared review guidance');
  await putFile(join(native, 'assets', 'native-only'), 'native asset');
  await putFile(join(shared, 'assets', 'shared-only'), 'shared asset');
  const before = await snapshotPath(sandbox.root);
  const inventory = await inventoryFor();
  const nativeResource = skill(inventory, 'review', native);
  const sharedResource = skill(inventory, 'review', shared);
  const destination: DestinationRequest = { agentId: 'codex', placement: 'user' };
  const unresolved = await planSync(sandbox.context, inventory,
    request([nativeResource.id, sharedResource.id], [destination]), await loadState());
  expect(unresolved.findings.some(finding => finding.code === 'AUTHORITY_REQUIRED')).toBe(true);

  const approved = request([nativeResource.id, sharedResource.id], [destination], {
    authority: { version: 1, sources: [nativeResource.source], resourceAuthorities: { 'skill:review': nativeResource.id } },
  });
  const plan = await planSync(sandbox.context, inventory, approved, await loadState());
  expect(plan.findings.some(finding => finding.severity === 'error')).toBe(false);
  const writes = resources(plan.operations).filter(operation => operation.kind === 'write' && operation.content.kind === 'source');
  expect(writes.length).toBeGreaterThan(0);
  expect(writes.every(operation => operation.kind === 'write' && operation.content.kind === 'source' && operation.content.path.startsWith(native))).toBe(true);
  expect(writes.some(operation => operation.kind === 'write' && operation.content.kind === 'source' && operation.content.path.includes('shared-only'))).toBe(false);
  expect(plan.summary.resources).toEqual([{ id: nativeResource.id, name: 'review', kind: 'skill' }]);
  expect(plan.summary.authorities.map(source => source.id)).toEqual([nativeResource.source.id]);
  expect(await snapshotMatches(before)).toBe(true);
});

it('plans complete copy trees with binary assets, empty directories, executable modes, and safe internal links', async () => {
  sandbox = await createSandbox();
  const root = join(sandbox.context.projectRoot, '.claude', 'skills');
  const source = await putSkill(root, 'whole-tree', 'A complete skill');
  await putFile(join(source, 'assets', 'bytes.bin'), new Uint8Array([0, 255, 4, 17]));
  await putFile(join(source, 'scripts', 'inspect.sh'), '#!/bin/sh\nexit 97\n', 0o755);
  await mkdir(join(source, 'references', 'empty', 'nested'), { recursive: true });
  await symlink('inspect.sh', join(source, 'scripts', 'inspect-link'));
  await symlink('scripts/inspect-link', join(source, 'inspect-link'));
  const before = await snapshotPath(sandbox.root);
  const inventory = await inventoryFor();
  const selected = skill(inventory, 'whole-tree', source);
  const plan = await planSync(sandbox.context, inventory,
    request([selected.id], [{ agentId: 'codex', placement: 'user' }]), await loadState());
  expect(plan.findings.some(finding => finding.severity === 'error')).toBe(false);
  const operations = resources(plan.operations);
  expect(operations.some(operation => operation.kind === 'mkdir' && operation.path.endsWith('/references/empty/nested'))).toBe(true);
  expect(operations.some(operation => operation.kind === 'write' && operation.path.endsWith('/scripts/inspect.sh') && operation.mode === 0o755)).toBe(true);
  const binary = operations.find(operation => operation.kind === 'write' && operation.path.endsWith('/assets/bytes.bin'));
  expect(binary?.kind === 'write' && binary.content.kind === 'source' && binary.content.snapshot.kind === 'file').toBe(true);
  const nestedLink = operations.find(operation => operation.kind === 'symlink' && operation.path.endsWith('/scripts/inspect-link'));
  const outerLink = operations.find(operation => operation.kind === 'symlink' && operation.path.endsWith('/whole-tree/inspect-link'));
  expect(nestedLink?.kind === 'symlink' && nestedLink.target === 'inspect.sh').toBe(true);
  expect(outerLink?.kind === 'symlink' && outerLink.target === 'scripts/inspect-link').toBe(true);
  expect(operations.indexOf(nestedLink!) < operations.indexOf(outerLink!)).toBe(true);
  expect(operations.some(operation => operation.kind === 'write' && operation.path.endsWith('/SKILL.md'))).toBe(true);
  expect(plan.summary.skillMode).toBe('copy');
  expect(await snapshotMatches(before)).toBe(true);
  const applied = await applyPlan(plan, { confirmed: true });
  expect(applied.status).toBe('applied');
  const target = join(sandbox.context.homeDir, '.agents', 'skills', 'whole-tree');
  expect((await stat(join(target, 'scripts', 'inspect.sh'))).mode & 0o777).toBe(0o755);
  expect(await readFile(join(target, 'assets', 'bytes.bin'))).toEqual(Buffer.from([0, 255, 4, 17]));
  expect(await readlink(join(target, 'inspect-link'))).toBe('scripts/inspect-link');
});

it('plans links only when relevant and avoids a redundant link for an authority already discovered by the destination', async () => {
  sandbox = await createSandbox();
  const extraRoot = join(sandbox.context.projectRoot, 'provided-skills');
  const source = await putSkill(extraRoot, 'external-guide', 'Explicit external guidance');
  const discoveredRoot = join(sandbox.context.projectRoot, '.agents', 'skills');
  const discoveredPath = await putSkill(discoveredRoot, 'already-authority', 'Already discovered guidance');
  const inventory = await discover({
    ...sandbox.context,
    extraSources: [sourceRef('shared', extraRoot, 'project', 'shared', 'Explicit source')],
  });
  const selected = skill(inventory, 'external-guide', source);
  const linkPlan = await planSync(sandbox.context, inventory,
    request([selected.id], [{ agentId: 'gemini-cli', placement: 'user' }], { skillMode: 'link' }), await loadState());
  expect(linkPlan.findings.some(finding => finding.severity === 'error')).toBe(false);
  expect(resources(linkPlan.operations).some(operation => operation.kind === 'symlink')).toBe(true);

  const alreadySelected = skill(inventory, 'already-authority', discoveredPath);
  const alreadyDiscovered = await planSync(sandbox.context, inventory,
    request([alreadySelected.id], [{ agentId: 'codex', placement: 'project' }], { skillMode: 'link' }), await loadState());
  expect(resources(alreadyDiscovered.operations)).toEqual([]);
  expect(alreadyDiscovered.summary.unchanged).toBe(1);
  const userPlacement = await planSync(sandbox.context, inventory,
    request([alreadySelected.id], [{ agentId: 'codex', placement: 'user' }]), await loadState());
  expect(userPlacement.findings.some(finding => finding.severity === 'error')).toBe(false);
  const userTarget = join(sandbox.context.homeDir, '.agents', 'skills', 'already-authority');
  expect(resources(userPlacement.operations).some(operation => operation.kind === 'write' && operation.path.startsWith(userTarget))).toBe(true);

});

it('coalesces aliased native skill destinations and links from their physical parent', async () => {
  sandbox = await createSandbox();
  const physicalRoot = join(sandbox.context.projectRoot, 'physical-skills');
  await mkdir(join(physicalRoot, 'skills'), { recursive: true });
  await symlink(physicalRoot, join(sandbox.context.projectRoot, '.agents'));
  await symlink(physicalRoot, join(sandbox.context.projectRoot, '.gemini'));
  const sourceRoot = join(sandbox.context.projectRoot, 'provided-skills');
  const copiedPath = await putSkill(sourceRoot, 'aliased-copy', 'Shared guidance');
  const linkedPath = await putSkill(sourceRoot, 'aliased-link', 'Linked guidance');
  const inventory = await discover({
    ...sandbox.context,
    extraSources: [sourceRef('shared', sourceRoot, 'project', 'shared', 'Provided directory')],
  });
  const copied = skill(inventory, 'aliased-copy', copiedPath);
  const before = await snapshotPath(sandbox.root);
  const copyPlan = await planSync(sandbox.context, inventory,
    request([copied.id], [
      { agentId: 'codex', placement: 'project' },
      { agentId: 'gemini-cli', placement: 'project' },
    ]), await loadState());
  expect(copyPlan.findings.some(finding => finding.severity === 'error')).toBe(false);
  const copyOperations = resources(copyPlan.operations);
  expect(new Set(copyOperations.map(operation => operation.path)).size).toBe(copyOperations.length);
  expect(copyOperations.filter(operation => operation.kind === 'write' && operation.path.endsWith('/SKILL.md'))).toHaveLength(1);
  const target = join(physicalRoot, 'skills', 'aliased-copy');
  expect(copyOperations.filter(operation => operation.kind === 'mkdir' && operation.path === target)).toHaveLength(1);
  const ownership = decodeOwnershipState(JSON.parse(Buffer.from(stateContent(copyPlan, '/mishmash/ownership.json')).toString('utf8')) as unknown);
  expect(ownership.receipts.filter(receipt => receipt.resourceId === copied.id)).toHaveLength(1);
  expect(ownership.receipts.find(receipt => receipt.resourceId === copied.id)?.path).toBe(target);

  const linked = skill(inventory, 'aliased-link', linkedPath);
  const linkPlan = await planSync(sandbox.context, inventory,
    request([linked.id], [{ agentId: 'codex', placement: 'project' }], { skillMode: 'link' }), await loadState());
  const link = resources(linkPlan.operations).find(operation => operation.kind === 'symlink');
  expect(link?.kind).toBe('symlink');
  if (!link || link.kind !== 'symlink') throw new Error('Expected a planned skill symlink');
  expect(resolve(dirname(link.path), link.target)).toBe(linked.path);
  expect(await snapshotMatches(before)).toBe(true);
});

it('blocks skill metadata names that do not match their native directory names', async () => {
  sandbox = await createSandbox();
  const root = join(sandbox.context.projectRoot, 'provided-skills');
  const source = await putSkill(root, 'physical-name', 'Temporary description');
  await putFile(join(source, 'SKILL.md'), '---\nname: logical-name\ndescription: Stable policy\n---\nBody\n');
  const inventory = await discover({
    ...sandbox.context,
    extraSources: [sourceRef('shared', root, 'project', 'shared', 'Provided directory')],
  });
  const selected = skill(inventory, 'logical-name', source);
  const plan = await planSync(sandbox.context, inventory,
    request([selected.id], [{ agentId: 'codex', placement: 'project' }]), await loadState());
  expect(plan.findings.some(finding => finding.code === 'SKILL_NAME_DIRECTORY_MISMATCH' && finding.path === source)).toBe(true);
  expect(resources(plan.operations)).toEqual([]);
});


it('blocks private-project publication and destinations reached through escaping parent symlinks', async () => {
  sandbox = await createSandbox();
  const privateRoot = join(sandbox.context.projectRoot, 'private-skills');
  const privateSkill = await putSkill(privateRoot, 'private-guide', 'Private project guidance');
  const privateInventory = await discover({
    ...sandbox.context,
    extraSources: [sourceRef('shared', privateRoot, 'project', 'private', 'Private project skills')],
  });
  const selected = skill(privateInventory, 'private-guide', privateSkill);
  const privatePlan = await planSync(sandbox.context, privateInventory,
    request([selected.id], [{ agentId: 'codex', placement: 'project' }]), await loadState());
  expect(privatePlan.findings.some(finding => finding.code === 'PRIVATE_RESOURCE_PUBLICATION')).toBe(true);
  expect(resources(privatePlan.operations)).toEqual([]);

  const userSource = await putSkill(join(sandbox.context.homeDir, '.claude', 'skills'), 'personal-guide', 'Private user guidance');
  const userInventory = await inventoryFor();
  const userResource = skill(userInventory, 'personal-guide', userSource);
  const privateUserPlan = await planSync(sandbox.context, userInventory,
    request([userResource.id], [{ agentId: 'codex', placement: 'user' }]), await loadState());
  expect(privateUserPlan.findings.some(finding => finding.severity === 'error')).toBe(false);
  expect(resources(privateUserPlan.operations).some(operation => operation.path.startsWith(sandbox!.context.homeDir))).toBe(true);
  const published = await planSync(sandbox.context, userInventory,
    request([userResource.id], [{ agentId: 'codex', placement: 'project' }]), await loadState());
  expect(published.findings.some(finding => finding.code === 'PRIVATE_RESOURCE_PUBLICATION')).toBe(true);
  const projectStorage = await planSync(sandbox.context, userInventory,
    request([userResource.id], [{ agentId: 'codex', placement: 'user' }], { configuration: 'project' }),
    await readState(sandbox.context, 'project'));
  expect(projectStorage.findings.some(finding => finding.code === 'PRIVATE_AUTHORITY_SHARED_STORAGE')).toBe(true);
  expect(projectStorage.operations.filter(operation => operation.purpose === 'state')).toEqual([]);
  const userStorage = await planSync(sandbox.context, userInventory,
    request([userResource.id], [{ agentId: 'codex', placement: 'user' }], { configuration: 'user' }),
    await readState(sandbox.context, 'user'));
  expect(userStorage.findings.some(finding => finding.code === 'PRIVATE_AUTHORITY_SHARED_STORAGE')).toBe(false);
  expect(userStorage.operations.some(operation => operation.purpose === 'state' && operation.kind === 'write'
    && operation.path.endsWith('/mishmash/sources.json'))).toBe(true);


  const outside = join(sandbox.root, 'outside-project');
  await mkdir(outside, { recursive: true });
  await symlink(outside, join(sandbox.context.projectRoot, '.agents'));
  const ordinaryRoot = join(sandbox.context.projectRoot, '.claude', 'skills');
  const ordinary = await putSkill(ordinaryRoot, 'ordinary', 'Public project guidance');
  const inventory = await inventoryFor();
  const resource = skill(inventory, 'ordinary', ordinary);
  const unsafe = await planSync(sandbox.context, inventory,
    request([resource.id], [{ agentId: 'codex', placement: 'project' }]), await loadState());
  expect(unsafe.findings.some(finding => finding.code === 'UNSAFE_DESTINATION_PATH')).toBe(true);
  expect(resources(unsafe.operations)).toEqual([]);
});

it('blocks an unmanaged skill collision and selected-source drift without overwriting either', async () => {
  sandbox = await createSandbox();
  const sourceRoot = join(sandbox.context.projectRoot, '.claude', 'skills');
  const source = await putSkill(sourceRoot, 'collision', 'Authoritative source');
  const target = join(sandbox.context.homeDir, '.agents', 'skills', 'collision');
  await putSkill(join(sandbox.context.homeDir, '.agents', 'skills'), 'collision', 'Existing unmanaged destination');
  const inventory = await inventoryFor();
  const selected = skill(inventory, 'collision', source);
  const collision = await planSync(sandbox.context, inventory,
    request([selected.id], [{ agentId: 'codex', placement: 'user' }]), await loadState());
  expect(collision.findings.some(finding => finding.code === 'UNMANAGED_DESTINATION_COLLISION' && finding.path === target)).toBe(true);
  expect(resources(collision.operations).some(operation => operation.path.startsWith(target))).toBe(false);

  await putFile(join(source, 'assets', 'changed-after-discovery'), 'stale source');
  const stale = await planSync(sandbox.context, inventory,
    request([selected.id], [{ agentId: 'pi', placement: 'user' }]), await loadState());
  expect(stale.findings.some(finding => finding.code === 'STALE_SOURCE' && finding.path === source)).toBe(true);
});

it('requires an explicit authority for cross-adapter native MCP interpretations', async () => {
  sandbox = await createSandbox();
  await putFile(join(sandbox.context.projectRoot, '.mcp.json'), JSON.stringify({
    mcpServers: { variant: { type: 'stdio', command: 'source-command' } },
  }));
  const inventory = await inventoryFor();
  const claude = mcp(inventory, 'variant', 'claude-code');
  const copilot = mcp(inventory, 'variant', 'github-copilot-cli');
  expect(claude.id).not.toBe(copilot.id);
  expect(claude.source.id).toBe(copilot.source.id);
  const destination: DestinationRequest = { agentId: 'gemini-cli', placement: 'project' };
  const unresolved = await planSync(sandbox.context, inventory,
    request([claude.id, copilot.id], [destination]), await loadState());
  expect(unresolved.findings.some(finding => finding.code === 'AUTHORITY_REQUIRED')).toBe(true);

  const approved = await planSync(sandbox.context, inventory,
    request([claude.id, copilot.id], [destination], {
      authority: { version: 1, sources: [claude.source], resourceAuthorities: { 'mcp:variant': claude.id } },
    }), await loadState());
  expect(approved.findings.some(finding => finding.severity === 'error')).toBe(false);
  expect(approved.summary.resources.map(resource => resource.id)).toEqual([claude.id]);
  expect(resources(approved.operations).some(operation => operation.kind === 'write'
    && operation.path === join(sandbox!.context.projectRoot, '.gemini', 'settings.json'))).toBe(true);
});

it('coalesces selected MCP edits into one native file while preserving unchecked registrations and settings', async () => {
  sandbox = await createSandbox();
  const sourcePath = join(sandbox.context.projectRoot, '.mcp.json');
  await putFile(sourcePath, JSON.stringify({ mcpServers: {
    alpha: { type: 'stdio', command: 'alpha-command' },
    beta: { type: 'stdio', command: 'beta-command' },
    sourceUnchecked: { type: 'stdio', command: 'never-copy' },
  } }));
  const targetPath = join(sandbox.context.projectRoot, '.gemini', 'settings.json');
  await putFile(targetPath, JSON.stringify({ ui: { theme: 'native' }, mcpServers: { targetUnchecked: { command: 'leave-in-place' } } }));
  const before = await snapshotPath(sandbox.root);
  const inventory = await inventoryFor();
  const selected = ['alpha', 'beta'].map(name => mcp(inventory, name, 'claude-code'));
  const plan = await planSync(sandbox.context, inventory,
    request(selected.map(resource => resource.id), [{ agentId: 'gemini-cli', placement: 'project' }]), await loadState());
  expect(plan.findings.some(finding => finding.severity === 'error')).toBe(false);
  const nativeWrites = resources(plan.operations).filter(operation => operation.kind === 'write' && operation.path === targetPath);
  expect(nativeWrites).toHaveLength(1);
  expect(nativeWrites[0]?.kind === 'write' && nativeWrites[0].content.kind === 'bytes').toBe(true);
  if (!nativeWrites[0] || nativeWrites[0].kind !== 'write' || nativeWrites[0].content.kind !== 'bytes') throw new Error('Expected coalesced native config bytes');
  const output = JSON.parse(Buffer.from(nativeWrites[0].content.bytes).toString('utf8')) as {
    ui: { theme: string }; mcpServers: Record<string, { command: string }>;
  };
  expect(output.ui.theme).toBe('native');
  expect(output.mcpServers.alpha?.command).toBe('alpha-command');
  expect(output.mcpServers.beta?.command).toBe('beta-command');
  expect(output.mcpServers.targetUnchecked?.command).toBe('leave-in-place');
  expect(output.mcpServers.sourceUnchecked).toBeUndefined();
  expect(await snapshotMatches(before)).toBe(true);
});

it('blocks unmanaged MCP collisions, owned drift, and destination changes after state was read', async () => {
  sandbox = await createSandbox();
  const sourcePath = join(sandbox.context.projectRoot, '.mcp.json');
  await putFile(sourcePath, JSON.stringify({ mcpServers: { selected: { type: 'stdio', command: 'source-command' } } }));
  const targetPath = join(sandbox.context.projectRoot, '.gemini', 'settings.json');
  await putFile(targetPath, JSON.stringify({ mcpServers: { selected: { type: 'stdio', command: 'unmanaged-command' } } }));
  const inventory = await inventoryFor();
  const selected = mcp(inventory, 'selected', 'claude-code');
  const destination: DestinationRequest = { agentId: 'gemini-cli', placement: 'project' };
  const collision = await planSync(sandbox.context, inventory, request([selected.id], [destination]), await loadState());
  expect(collision.findings.some(finding => finding.code === 'UNMANAGED_MCP_COLLISION' && finding.path === targetPath)).toBe(true);
  expect(resources(collision.operations).some(operation => operation.path === targetPath)).toBe(false);

  const owned = { type: 'stdio', command: 'prior-owned-output' };
  await putFile(targetPath, JSON.stringify({ mcpServers: { selected: owned } }));
  const targetSnapshot = await snapshotPath(targetPath);
  const statePaths = await getStatePaths(sandbox.context, 'private-project');
  const ownership: OwnershipState = { version: 1, receipts: [{
    slotId: fingerprintValue([targetSnapshot.resolvedPath, 'mcp', JSON.stringify(['mcpServers', 'selected'])]),
    path: targetPath, kind: 'mcp', key: 'selected', sourceId: selected.source.id, resourceId: selected.id,
    fingerprint: fingerprintValue(owned),
  }] };
  await mkdir(join(sandbox.context.configHome, 'mishmash', 'projects'), { recursive: true });
  await mkdir(join(sandbox.context.stateHome, 'mishmash'), { recursive: true, mode: 0o700 });
  await writeFile(statePaths.ownershipPath, encodeOwnershipState(ownership), { mode: 0o600 });
  const changedState = await loadState();
  await putFile(targetPath, JSON.stringify({ mcpServers: { selected: { type: 'stdio', command: 'edited-out-of-band' } } }));
  const drift = await planSync(sandbox.context, inventory, request([selected.id], [destination]), changedState);
  expect(drift.findings.some(finding => finding.code === 'OWNED_MCP_DRIFT')).toBe(true);

  const readBeforeMutation = await loadState();
  await putFile(readBeforeMutation.preferencePath, JSON.stringify({ version: 1, sources: [], resourceAuthorities: {} }));
  const staleState = await planSync(sandbox.context, inventory, request([selected.id], [destination]), readBeforeMutation);
  expect(staleState.findings.some(finding => finding.code === 'STALE_STATE')).toBe(true);
});

it('plans safe preference and ownership intents while preserving unrelated remembered choices without credentials', async () => {
  sandbox = await createSandbox();
  const sourceRoot = join(sandbox.context.projectRoot, '.claude', 'skills');
  const source = await putSkill(sourceRoot, 'remembered', 'Remembered source');
  const inventory = await inventoryFor();
  const selected = skill(inventory, 'remembered', source);
  const paths = await getStatePaths(sandbox.context, 'private-project');
  const previous: AuthorityConfig = {
    version: 1, sources: [sourceRef('shared', join(sandbox.root, 'retained-source'), 'user', 'private', 'Retained source')],
    resourceAuthorities: { 'skill:elsewhere': 'retained-resource-id' },
  };
  await mkdir(dirname(paths.preferencePath), { recursive: true });
  await writeFile(paths.preferencePath, encodeAuthorityConfig(previous), { mode: 0o600 });
  const plan = await planSync(sandbox.context, inventory,
    request([selected.id], [{ agentId: 'codex', placement: 'user' }], {
      authority: { version: 1, sources: [selected.source], resourceAuthorities: { 'skill:remembered': selected.id } },
    }), await loadState());
  expect(plan.findings.some(finding => finding.severity === 'error')).toBe(false);
  const choices = decodeAuthorityConfig(JSON.parse(Buffer.from(stateContent(plan, '/projects/')).toString('utf8')) as unknown);
  expect(choices.resourceAuthorities['skill:elsewhere']).toBe('retained-resource-id');
  expect(choices.resourceAuthorities['skill:remembered']).toBe(selected.id);
  expect(choices.sources.some(sourceRef => sourceRef.id === selected.source.id)).toBe(true);
  const ownership = decodeOwnershipState(JSON.parse(Buffer.from(stateContent(plan, '/mishmash/ownership.json')).toString('utf8')) as unknown);
  expect(ownership.receipts.some(receipt => receipt.kind === 'skill' && receipt.resourceId === selected.id)).toBe(true);
  expect(JSON.stringify({ summary: plan.summary, findings: plan.findings, receipts: ownership.receipts, choices })).not.toContain('credential-marker');
  expect(plan.operations.filter(operation => operation.purpose === 'state').every(operation => operation.kind === 'mkdir' || operation.kind === 'write')).toBe(true);
});

it('plans private metadata beneath absent approved XDG roots without creating them', async () => {
  sandbox = await createSandbox();
  const sourceRoot = join(sandbox.context.projectRoot, '.claude', 'skills');
  const source = await putSkill(sourceRoot, 'first-run', 'First run skill');
  await rm(sandbox.context.configHome, { recursive: true, force: true });
  await rm(sandbox.context.stateHome, { recursive: true, force: true });
  const before = await snapshotPath(sandbox.root);
  const inventory = await inventoryFor();
  const selected = skill(inventory, 'first-run', source);
  const state = await readState(sandbox.context, 'private-project');
  const paths = await getStatePaths(sandbox.context, 'private-project');
  const plan = await planSync(sandbox.context, inventory,
    request([selected.id], [{ agentId: 'codex', placement: 'user' }]), state);
  expect(plan.findings.some(finding => finding.severity === 'error')).toBe(false);
  expect(plan.operations.some(operation => operation.purpose === 'state' && operation.kind === 'write' && operation.path === paths.preferencePath)).toBe(true);
  expect(plan.operations.some(operation => operation.purpose === 'state' && operation.kind === 'write' && operation.path === paths.ownershipPath)).toBe(true);
  expect(plan.operations.some(operation => operation.purpose === 'state' && operation.kind === 'mkdir' && operation.path === sandbox!.context.configHome)).toBe(true);
  expect(plan.operations.some(operation => operation.purpose === 'state' && operation.kind === 'mkdir' && operation.path.startsWith(sandbox!.context.stateHome))).toBe(false);
  const privateConfigDirs = plan.operations.filter(operation => operation.purpose === 'state' && operation.kind === 'mkdir' && operation.path.startsWith(sandbox!.context.configHome));
  expect(privateConfigDirs.length).toBeGreaterThan(0);
  expect(privateConfigDirs.every(operation => operation.kind === 'mkdir' && operation.mode === 0o700)).toBe(true);
  expect(await snapshotMatches(before)).toBe(true);
});

it('applies skill copies through safe parent symlinks and bootstraps absent XDG roots privately', async () => {
  sandbox = await createSandbox();
  const sourceRoot = join(sandbox.context.projectRoot, '.claude', 'skills');
  const source = await putSkill(sourceRoot, 'applied-through-alias', 'Safe alias destination');
  const physicalOutput = join(sandbox.context.projectRoot, 'physical-output');
  await mkdir(join(physicalOutput, 'skills'), { recursive: true });
  await symlink(physicalOutput, join(sandbox.context.projectRoot, '.agents'));
  await rm(sandbox.context.configHome, { recursive: true, force: true });
  await rm(sandbox.context.stateHome, { recursive: true, force: true });
  const inventory = await inventoryFor();
  const selected = skill(inventory, 'applied-through-alias', source);
  const loadedState = await readState(sandbox.context, 'private-project');
  const paths = await getStatePaths(sandbox.context, 'private-project');
  const plan = await planSync(sandbox.context, inventory,
    request([selected.id], [{ agentId: 'codex', placement: 'project' }]), loadedState);
  expect(plan.findings.some(finding => finding.severity === 'error')).toBe(false);
  expect(plan.operations.some(operation => operation.purpose === 'state' && operation.kind === 'mkdir'
    && operation.path.startsWith(sandbox!.context.stateHome))).toBe(false);
  expect(plan.operations.filter(operation => operation.kind === 'mkdir' && operation.path.startsWith(sandbox!.context.configHome))
    .every(operation => operation.kind === 'mkdir' && operation.mode === 0o700)).toBe(true);
  const result = await applyPlan(plan, { confirmed: true });
  expect(result.status, JSON.stringify(result.findings)).toBe('applied');
  const target = join(physicalOutput, 'skills', 'applied-through-alias');
  expect((await snapshotPath(target)).kind).toBe('directory');
  expect((await readFile(join(target, 'SKILL.md'), 'utf8')).includes('Safe alias destination')).toBe(true);
  expect((await stat(sandbox.context.configHome)).mode & 0o777).toBe(0o700);
  expect((await stat(join(sandbox.context.configHome, 'mishmash'))).mode & 0o777).toBe(0o700);
  expect((await stat(sandbox.context.stateHome)).mode & 0o777).toBe(0o700);
  expect((await stat(join(sandbox.context.stateHome, 'mishmash'))).mode & 0o777).toBe(0o700);
  expect((await snapshotPath(paths.preferencePath)).kind).toBe('file');
  expect((await snapshotPath(paths.ownershipPath)).kind).toBe('file');
});

it('applies OpenCode user skills and private preferences under absent XDG roots with mode 0700', async () => {
  sandbox = await createSandbox();
  const configParents = [
    join(sandbox.root, 'missing-config-parent'),
    join(sandbox.root, 'missing-config-parent', 'nested'),
  ];
  sandbox.context.configHome = join(configParents[1]!, 'xdg-config');
  const sourceRoot = join(sandbox.context.projectRoot, '.claude', 'skills');
  const source = await putSkill(sourceRoot, 'xdg-private', 'Private user placement');
  await rm(sandbox.context.configHome, { recursive: true, force: true });
  await rm(sandbox.context.stateHome, { recursive: true, force: true });
  const inventory = await inventoryFor();
  const selected = skill(inventory, 'xdg-private', source);
  const state = await readState(sandbox.context, 'private-project');
  const paths = await getStatePaths(sandbox.context, 'private-project');
  const plan = await planSync(sandbox.context, inventory,
    request([selected.id], [{ agentId: 'opencode', placement: 'user' }]), state);
  expect(plan.findings.some(finding => finding.severity === 'error')).toBe(false);
  expect(plan.operations.some(operation => operation.kind === 'mkdir' && operation.path.startsWith(sandbox!.context.stateHome))).toBe(false);
  const privateDirs = [
    ...configParents,
    sandbox.context.configHome,
    join(sandbox.context.configHome, 'mishmash'),
    join(sandbox.context.configHome, 'mishmash', 'projects'),
    join(sandbox.context.configHome, 'opencode'),
    join(sandbox.context.configHome, 'opencode', 'skills'),
  ];
  for (const path of privateDirs) {
    const operation = plan.operations.find(item => item.kind === 'mkdir' && item.path === path);
    expect(operation?.kind === 'mkdir' && operation.mode === 0o700).toBe(true);
  }
  const result = await applyPlan(plan, { confirmed: true });
  expect(result.status).toBe('applied');
  for (const path of privateDirs) expect((await stat(path)).mode & 0o777).toBe(0o700);
  const target = join(sandbox.context.configHome, 'opencode', 'skills', 'xdg-private');
  expect((await snapshotPath(target)).kind).toBe('directory');
  expect((await snapshotPath(paths.preferencePath)).kind).toBe('file');
  expect((await snapshotPath(paths.ownershipPath)).kind).toBe('file');
});

it('applies OpenCode output and metadata through a symlinked XDG config root', async () => {
  sandbox = await createSandbox();
  const source = await putSkill(join(sandbox.context.projectRoot, '.claude', 'skills'), 'config-alias', 'Alias-safe user skill');
  const physicalConfig = join(sandbox.root, 'physical-config');
  await mkdir(physicalConfig, { recursive: true });
  await rm(sandbox.context.configHome, { recursive: true, force: true });
  sandbox.context.configHome = join(sandbox.root, 'config-alias');
  await symlink(physicalConfig, sandbox.context.configHome);
  const inventory = await inventoryFor();
  const selected = skill(inventory, 'config-alias', source);
  const loaded = await readState(sandbox.context, 'private-project');
  const paths = await getStatePaths(sandbox.context, 'private-project');
  const plan = await planSync(sandbox.context, inventory,
    request([selected.id], [{ agentId: 'opencode', placement: 'user' }]), loaded);
  expect(plan.findings.some(finding => finding.severity === 'error')).toBe(false);
  const physicalPreference = join(physicalConfig, 'mishmash', 'projects', basename(paths.preferencePath));
  const physicalOwnership = join(sandbox.context.stateHome, 'mishmash', 'ownership.json');
  expect(plan.operations.some(operation => operation.kind === 'write' && operation.path === physicalPreference)).toBe(true);
  expect(plan.operations.some(operation => operation.kind === 'write' && operation.path === physicalOwnership)).toBe(true);
  expect(plan.preconditions.some(snapshot => snapshot.path === sandbox!.context.configHome && snapshot.kind === 'symlink')).toBe(true);
  expect(plan.preconditions.some(snapshot => snapshot.path === join(sandbox!.context.configHome, 'mishmash', 'projects', basename(paths.preferencePath)))).toBe(false);
  expect(plan.preconditions.some(snapshot => snapshot.path === physicalPreference)).toBe(true);
  const result = await applyPlan(plan, { confirmed: true });
  expect(result.status).toBe('applied');
  expect((await snapshotPath(join(sandbox.context.configHome, 'opencode', 'skills', 'config-alias'))).kind).toBe('directory');
  expect((await snapshotPath(paths.preferencePath)).kind).toBe('file');
  expect((await snapshotPath(paths.ownershipPath)).kind).toBe('file');
  expect((await readState(sandbox.context, 'private-project')).findings).toEqual([]);
});

it('applies a canonical MCP edit through a safe aliased native configuration directory', async () => {
  sandbox = await createSandbox();
  const sourcePath = join(sandbox.context.projectRoot, '.mcp.json');
  await putFile(sourcePath, JSON.stringify({ mcpServers: { canonical: { type: 'stdio', command: 'do-not-run' } } }));
  const physicalGemini = join(sandbox.context.projectRoot, 'physical-gemini');
  await mkdir(physicalGemini, { recursive: true });
  await symlink(physicalGemini, join(sandbox.context.projectRoot, '.gemini'));
  const inventory = await inventoryFor();
  const selected = mcp(inventory, 'canonical', 'claude-code');
  const state = await readState(sandbox.context, 'private-project');
  const plan = await planSync(sandbox.context, inventory,
    request([selected.id], [{ agentId: 'gemini-cli', placement: 'project' }]), state);
  expect(plan.findings.some(finding => finding.severity === 'error')).toBe(false);
  const configPath = join(physicalGemini, 'settings.json');
  expect(plan.operations.some(operation => operation.kind === 'write' && operation.path === configPath)).toBe(true);
  expect(plan.preconditions.some(snapshot => snapshot.path === join(sandbox!.context.projectRoot, '.gemini', 'settings.json'))).toBe(false);
  expect(plan.preconditions.some(snapshot => snapshot.path === configPath)).toBe(true);
  expect(plan.preconditions.some(snapshot => snapshot.path === join(sandbox!.context.projectRoot, '.gemini') && snapshot.kind === 'symlink')).toBe(true);
  const result = await applyPlan(plan, { confirmed: true });
  expect(result.status).toBe('applied');
  const output = JSON.parse(await readFile(join(sandbox.context.projectRoot, '.gemini', 'settings.json'), 'utf8')) as {
    mcpServers: Record<string, { command: string }>;
  };
  expect(output.mcpServers.canonical?.command).toBe('do-not-run');
});

it('retargets an owned link before removing its old referent during apply', async () => {
  sandbox = await createSandbox();
  const source = await putSkill(join(sandbox.context.projectRoot, '.claude', 'skills'), 'link-update', 'Linked asset update');
  await putFile(join(source, 'old.txt'), 'obsolete referent');
  await symlink('old.txt', join(source, 'a'));
  await symlink('a', join(source, 'link'));
  const target = join(sandbox.context.homeDir, '.agents', 'skills', 'link-update');
  await mkdir(dirname(target), { recursive: true });
  await mkdir(target, { recursive: true });
  await writeFile(join(target, 'SKILL.md'), await readFile(join(source, 'SKILL.md')));
  await putFile(join(target, 'old.txt'), 'obsolete referent');
  await symlink('old.txt', join(target, 'a'));
  await symlink('a', join(target, 'link'));
  const previous = await snapshotPath(target);
  await rm(join(source, 'old.txt'));
  await putFile(join(source, 'new.txt'), 'new referent');
  await rm(join(source, 'a'));
  await symlink('new.txt', join(source, 'a'));
  const inventory = await inventoryFor();
  const selected = skill(inventory, 'link-update', source);
  const paths = await getStatePaths(sandbox.context, 'private-project');
  const authority: AuthorityConfig = { version: 1, sources: [selected.source], resourceAuthorities: { 'skill:link-update': selected.id } };
  const ownership: OwnershipState = { version: 1, receipts: [{
    slotId: fingerprintValue([resolve(target), 'skill']), path: resolve(target), kind: 'skill', key: 'link-update',
    sourceId: selected.source.id, resourceId: selected.id, fingerprint: previous.digest,
  }] };
  await mkdir(dirname(paths.preferencePath), { recursive: true });
  await mkdir(dirname(paths.ownershipPath), { recursive: true, mode: 0o700 });
  await writeFile(paths.preferencePath, encodeAuthorityConfig(authority), { mode: 0o600 });
  await writeFile(paths.ownershipPath, encodeOwnershipState(ownership), { mode: 0o600 });
  const plan = await planSync(sandbox.context, inventory,
    request([selected.id], [{ agentId: 'codex', placement: 'user' }], {
      authority: { version: 1, sources: [selected.source], resourceAuthorities: { 'skill:link-update': selected.id } },
    }), await loadState());
  expect(plan.findings.some(finding => finding.severity === 'error'), JSON.stringify(plan.findings)).toBe(false);
  const operations = resources(plan.operations);
  const newFile = operations.findIndex(operation => operation.kind === 'write' && operation.path === join(target, 'new.txt'));
  const link = operations.findIndex(operation => operation.kind === 'symlink' && operation.path === join(target, 'a'));
  const obsolete = operations.findIndex(operation => operation.kind === 'remove' && operation.path === join(target, 'old.txt'));
  expect(newFile).toBeGreaterThanOrEqual(0);
  expect(link).toBeGreaterThan(newFile);
  expect(obsolete).toBeGreaterThan(link);
  expect(operations.some(operation => operation.kind === 'symlink' && operation.path === join(target, 'link'))).toBe(false);
  expect(plan.preconditions.some(snapshot => snapshot.path === join(target, 'link'))).toBe(false);
  const applied = await applyPlan(plan, { confirmed: true });
  expect(applied.status, JSON.stringify(applied.findings)).toBe('applied');
  expect((await snapshotPath(join(target, 'old.txt'))).kind).toBe('missing');
  expect(await readFile(join(target, 'link'), 'utf8')).toBe('new referent');
});

it('removes obsolete symlinks before their referents during apply', async () => {
  sandbox = await createSandbox();
  const source = await putSkill(join(sandbox.context.projectRoot, '.claude', 'skills'), 'obsolete-link', 'Old link source');
  await putFile(join(source, 'a.txt'), 'obsolete referent');
  await symlink('a.txt', join(source, 'z-link'));
  const target = join(sandbox.context.homeDir, '.agents', 'skills', 'obsolete-link');
  await mkdir(dirname(target), { recursive: true });
  await mkdir(target, { recursive: true });
  await writeFile(join(target, 'SKILL.md'), await readFile(join(source, 'SKILL.md')));
  await putFile(join(target, 'a.txt'), 'obsolete referent');
  await symlink('a.txt', join(target, 'z-link'));
  const oldOutput = await snapshotPath(target);
  await rm(join(source, 'a.txt'));
  await rm(join(source, 'z-link'));
  const inventory = await inventoryFor();
  const selected = skill(inventory, 'obsolete-link', source);
  const paths = await getStatePaths(sandbox.context, 'private-project');
  const authority: AuthorityConfig = { version: 1, sources: [selected.source], resourceAuthorities: { 'skill:obsolete-link': selected.id } };
  const ownership: OwnershipState = { version: 1, receipts: [{
    slotId: fingerprintValue([resolve(target), 'skill']), path: resolve(target), kind: 'skill', key: 'obsolete-link',
    sourceId: selected.source.id, resourceId: selected.id, fingerprint: oldOutput.digest,
  }] };
  await mkdir(dirname(paths.preferencePath), { recursive: true });
  await mkdir(dirname(paths.ownershipPath), { recursive: true, mode: 0o700 });
  await writeFile(paths.preferencePath, encodeAuthorityConfig(authority), { mode: 0o600 });
  await writeFile(paths.ownershipPath, encodeOwnershipState(ownership), { mode: 0o600 });
  const plan = await planSync(sandbox.context, inventory,
    request([selected.id], [{ agentId: 'codex', placement: 'user' }], {
      authority: { version: 1, sources: [selected.source], resourceAuthorities: { 'skill:obsolete-link': selected.id } },
    }), await loadState());
  expect(plan.findings.some(finding => finding.severity === 'error'), JSON.stringify(plan.findings)).toBe(false);
  const operations = resources(plan.operations);
  const removeLink = operations.findIndex(operation => operation.kind === 'remove' && operation.path === join(target, 'z-link'));
  const removeReferent = operations.findIndex(operation => operation.kind === 'remove' && operation.path === join(target, 'a.txt'));
  expect(removeLink).toBeGreaterThanOrEqual(0);
  expect(removeReferent).toBeGreaterThan(removeLink);
  const result = await applyPlan(plan, { confirmed: true });
  expect(result.status, JSON.stringify(result.findings)).toBe('applied');
  expect((await snapshotPath(join(target, 'z-link'))).kind).toBe('missing');
  expect((await snapshotPath(join(target, 'a.txt'))).kind).toBe('missing');
});

it('removes obsolete assets only inside the selected owned skill and keeps unrelated destination skills', async () => {
  sandbox = await createSandbox();
  const source = await putSkill(join(sandbox.context.projectRoot, '.claude', 'skills'), 'maintained', 'Maintained guidance');
  await putFile(join(source, 'stable.txt'), 'still selected');
  await putFile(join(source, 'obsolete.txt'), 'old selected asset');
  const target = join(sandbox.context.homeDir, '.agents', 'skills', 'maintained');
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, { recursive: true });
  await putSkill(join(sandbox.context.homeDir, '.agents', 'skills'), 'unchecked', 'Unselected output');
  await rm(join(source, 'obsolete.txt'));
  const inventory = await inventoryFor();
  const selected = skill(inventory, 'maintained', source);
  const oldOutput = await snapshotPath(target);
  const paths = await getStatePaths(sandbox.context, 'private-project');
  const authority: AuthorityConfig = { version: 1, sources: [selected.source], resourceAuthorities: { 'skill:maintained': selected.id } };
  const ownership: OwnershipState = { version: 1, receipts: [{
    slotId: fingerprintValue([resolve(target), 'skill']), path: target, kind: 'skill', key: 'maintained',
    sourceId: selected.source.id, resourceId: selected.id, fingerprint: oldOutput.digest,
  }] };
  await mkdir(dirname(paths.preferencePath), { recursive: true });
  await mkdir(dirname(paths.ownershipPath), { recursive: true, mode: 0o700 });
  await writeFile(paths.preferencePath, encodeAuthorityConfig(authority), { mode: 0o600 });
  await writeFile(paths.ownershipPath, encodeOwnershipState(ownership), { mode: 0o600 });
  const beforePlan = await snapshotPath(sandbox.root);
  const plan = await planSync(sandbox.context, inventory,
    request([selected.id], [{ agentId: 'codex', placement: 'user' }], {
      authority: { version: 1, sources: [selected.source], resourceAuthorities: { 'skill:maintained': selected.id } },
    }), await loadState());
  expect(plan.findings.some(finding => finding.severity === 'error')).toBe(false);
  expect(resources(plan.operations).some(operation => operation.kind === 'remove' && operation.path === join(target, 'obsolete.txt'))).toBe(true);
  expect(resources(plan.operations).some(operation => operation.path.includes('/unchecked/'))).toBe(false);
  expect(plan.summary.removals).toBe(1);
  const receipts = decodeOwnershipState(JSON.parse(Buffer.from(stateContent(plan, '/mishmash/ownership.json')).toString('utf8')) as unknown);
  expect(receipts.receipts.find(receipt => receipt.resourceId === selected.id)?.fingerprint).toBe(selected.snapshot.digest);
  expect(await snapshotMatches(beforePlan)).toBe(true);
});

it('produces a true no-op when copied output and both state records already match', async () => {
  sandbox = await createSandbox();
  const sourceRoot = join(sandbox.context.projectRoot, '.claude', 'skills');
  const source = await putSkill(sourceRoot, 'unchanged', 'Stable skill');
  await putFile(join(source, 'assets', 'stable.bin'), new Uint8Array([0, 1, 255]));
  const inventory = await inventoryFor();
  const selected = skill(inventory, 'unchanged', source);
  const target = join(sandbox.context.homeDir, '.agents', 'skills', 'unchanged');
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, { recursive: true });
  const targetSnapshot = await snapshotPath(target);
  const statePaths = await getStatePaths(sandbox.context, 'private-project');
  const preferences: AuthorityConfig = { version: 1, sources: [selected.source], resourceAuthorities: { 'skill:unchanged': selected.id } };
  const ownership: OwnershipState = { version: 1, receipts: [{
    slotId: fingerprintValue([resolve(target), 'skill']), path: target, kind: 'skill', key: 'unchanged',
    sourceId: selected.source.id, resourceId: selected.id, fingerprint: targetSnapshot.digest,
  }] };
  await mkdir(dirname(statePaths.preferencePath), { recursive: true });
  await mkdir(dirname(statePaths.ownershipPath), { recursive: true, mode: 0o700 });
  await writeFile(statePaths.preferencePath, encodeAuthorityConfig(preferences), { mode: 0o600 });
  await writeFile(statePaths.ownershipPath, encodeOwnershipState(ownership), { mode: 0o600 });
  const before = await snapshotPath(sandbox.root);
  const plan = await planSync(sandbox.context, inventory,
    request([selected.id], [{ agentId: 'codex', placement: 'user' }], {
      authority: { version: 1, sources: [selected.source], resourceAuthorities: { 'skill:unchanged': selected.id } },
    }), await loadState());
  expect(plan.findings.some(finding => finding.severity === 'error')).toBe(false);
  expect(plan.operations).toEqual([]);
  expect(plan.summary.unchanged).toBe(1);
  expect(await snapshotMatches(before)).toBe(true);
});
