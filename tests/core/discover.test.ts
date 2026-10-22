import { afterEach, expect, it } from 'vitest';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { discover } from '../../src/core/discover.js';
import { snapshotMatches, snapshotPath } from '../../src/fs/snapshot.js';
import { sourceRef } from '../../src/resources/skills.js';
import { createSandbox, putFile, putSkill, type Sandbox } from '../helpers/sandbox.js';

let sandbox: Sandbox | undefined;
afterEach(async () => { await sandbox?.cleanup(); });

it('aggregates actual adapter discovery with exact scopes, checked roots, shared provenance, and read-only snapshots', async () => {
  sandbox = await createSandbox();
  const { context } = sandbox;
  const sharedProject = join(context.projectRoot, '.agents', 'skills');
  const sharedUser = join(context.homeDir, '.agents', 'skills');
  const extraRoot = join(context.projectRoot, 'provided-skills');
  const nativeRoot = join(context.projectRoot, '.claude', 'skills');
  const sharedSkill = await putSkill(sharedProject, 'common', 'Shared project policy');
  await putSkill(sharedUser, 'personal', 'Private user policy');
  await putSkill(extraRoot, 'provided', 'Manually supplied policy');
  await putSkill(nativeRoot, 'claude-only', 'Claude native policy');
  await putFile(join(context.projectRoot, '.mcp.json'), JSON.stringify({ mcpServers: { shared: { type: 'stdio', command: 'never-run' } } }));
  for (const path of [
    join(context.projectRoot, '.codex'), join(context.homeDir, '.copilot'), join(context.projectRoot, '.pi'),
    join(context.projectRoot, '.opencode'), join(context.projectRoot, '.gemini'),
  ]) await mkdir(path, { recursive: true });

  const configured = {
    ...context,
    extraSources: [sourceRef('shared', extraRoot, 'project', 'shared', 'Provided directory')],
  };
  const before = await snapshotPath(sandbox.root);
  const inventory = await discover(configured);
  expect(await snapshotMatches(before)).toBe(true);
  expect(inventory.detectedAgents).toEqual([
    'claude-code', 'codex', 'gemini-cli', 'github-copilot-cli', 'opencode', 'pi',
  ]);
  expect(inventory.findings).toEqual([]);
  expect(inventory.checkedLocations.some(location => location.path === extraRoot && location.exists && location.kind === 'skills')).toBe(true);
  expect(inventory.checkedLocations.some(location => location.path === join(context.projectRoot, '.codex') && location.exists && location.kind === 'evidence')).toBe(true);

  const shared = inventory.resources.filter(resource => resource.kind === 'skill' && resource.name === 'common');
  expect(shared).toHaveLength(1);
  expect(shared[0]!.path).toBe(sharedSkill);
  expect(shared[0]!.source.agentId).toBe('shared');
  expect(shared[0]!.source.scope).toBe('project');
  expect(shared[0]!.source.visibility).toBe('shared');
  expect(shared[0]!.source.agents).toEqual(['codex', 'gemini-cli', 'github-copilot-cli', 'opencode', 'pi']);

  const personal = inventory.resources.find(resource => resource.kind === 'skill' && resource.name === 'personal');
  expect(personal?.source).toMatchObject({ agentId: 'shared', scope: 'user', visibility: 'private' });
  expect(inventory.resources.some(resource => resource.kind === 'skill' && resource.name === 'provided' && resource.path.endsWith('/provided'))).toBe(true);
  const claude = inventory.resources.find(resource => resource.kind === 'skill' && resource.name === 'claude-only');
  expect(claude?.source).toMatchObject({ agentId: 'claude-code', scope: 'project', visibility: 'shared' });

  const mcp = inventory.resources.filter(resource => resource.kind === 'mcp' && resource.name === 'shared');
  expect(mcp).toHaveLength(2);
  expect(new Set(mcp.map(resource => resource.id)).size).toBe(2);
  expect(new Set(mcp.map(resource => resource.source.id)).size).toBe(1);
  expect(new Set(mcp.map(resource => resource.locator)).size).toBe(1);
  expect(new Set(mcp.map(resource => resource.kind === 'mcp' ? resource.definition.nativeAgent : '')).size).toBe(2);
  expect(await readFile(join(sharedSkill, 'SKILL.md'), 'utf8')).toContain('Shared project policy');
  expect(await snapshotMatches(before)).toBe(true);
});

it('does not treat an existing shared skill directory as native agent detection', async () => {
  sandbox = await createSandbox();
  const path = await putSkill(join(sandbox.context.projectRoot, '.agents', 'skills'), 'shared-only');
  const before = await snapshotPath(sandbox.root);
  const inventory = await discover(sandbox.context);
  expect(inventory.detectedAgents).toEqual([]);
  expect(inventory.resources.filter(resource => resource.kind === 'skill' && resource.name === 'shared-only')).toHaveLength(1);
  expect(inventory.resources.find(resource => resource.kind === 'skill' && resource.name === 'shared-only')?.path).toBe(path);
  expect(await snapshotMatches(before)).toBe(true);
});

it('reports an explicitly supplied missing source without silently dropping its checked location', async () => {
  sandbox = await createSandbox();
  const extra = join(sandbox.context.projectRoot, 'missing-skills');
  const inventory = await discover({
    ...sandbox.context,
    extraSources: [sourceRef('shared', extra, 'project', 'shared', 'Requested directory')],
  });
  expect(inventory.checkedLocations.some(location => location.path === extra && !location.exists)).toBe(true);
  expect(inventory.findings.some(finding => finding.code === 'MISSING_EXTRA_SOURCE' && finding.path === extra)).toBe(true);
});
