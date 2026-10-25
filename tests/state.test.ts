import { afterEach, expect, it } from 'vitest';
import { join } from 'node:path';
import { mkdir, symlink } from 'node:fs/promises';
import { encodeAuthorityConfig, getStatePaths, readState } from '../src/state.js';
import { sourceRef } from '../src/resources/skills.js';
import { snapshotPath } from '../src/fs/snapshot.js';
import { createSandbox, putFile, type Sandbox } from './helpers/sandbox.js';

let sandbox: Sandbox | undefined;
afterEach(async () => { await sandbox?.cleanup(); });
it('reads absent choices without creating any state and round-trips exact approved authority', async () => {
  sandbox = await createSandbox();
  const before = await snapshotPath(sandbox.root);
  const empty = await readState(sandbox.context, 'project');
  expect(empty.choices).toBeUndefined();
  expect((await snapshotPath(sandbox.root)).digest).toBe(before.digest);
  const source = sourceRef('claude-code', join(sandbox.context.projectRoot, '.claude', 'skills'), 'project', 'shared', 'Claude Code');
  const value = { version: 1 as const, sources: [source], resourceAuthorities: { 'skill:review': 'exact-instance' } };
  await putFile(empty.preferencePath, encodeAuthorityConfig(value));
  const loaded = await readState(sandbox.context, 'project');
  expect(loaded.choices).toEqual(value);
  expect(loaded.preferencePath).toBe(join(sandbox.context.projectRoot, '.mishmash', 'sources.json'));
});
it('keys private-project preferences by actual project root and honors explicit XDG roots', async () => {
  sandbox = await createSandbox();
  const paths = await getStatePaths(sandbox.context, 'private-project');
  const alias = join(sandbox.root, 'project-alias');
  await symlink(sandbox.context.projectRoot, alias);
  const aliased = await getStatePaths({ ...sandbox.context, projectRoot: alias }, 'private-project');
  expect(aliased.preferencePath).toBe(paths.preferencePath);
  expect(paths.preferencePath.startsWith(join(sandbox.context.configHome, 'mishmash', 'projects'))).toBe(true);
  expect(paths.ownershipPath).toBe(join(sandbox.context.stateHome, 'mishmash', 'ownership.json'));
  expect((await getStatePaths(sandbox.context, 'user')).preferencePath).toBe(join(sandbox.context.configHome, 'mishmash', 'sources.json'));
});
it('does not expose malformed preference bodies', async () => {
  sandbox = await createSandbox();
  const paths = await getStatePaths(sandbox.context);
  await mkdir(join(sandbox.context.configHome, 'mishmash', 'projects'), { recursive: true });
  const secret = 'temporary-state-secret';
  await putFile(paths.preferencePath, `{ "bad": "${secret}`);
  const result = await readState(sandbox.context);
  expect(result.choices).toBeUndefined();
  expect(result.findings[0]?.code).toBe('INVALID_STATE');
  expect(JSON.stringify(result.findings).includes(secret)).toBe(false);
});
