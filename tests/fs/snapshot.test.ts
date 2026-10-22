import { afterEach, describe, expect, it } from 'vitest';
import { chmod, rename, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fingerprintValue, isWithin, snapshotMatches, snapshotPath } from '../../src/fs/snapshot.js';
import { createSandbox, putFile, type Sandbox } from '../helpers/sandbox.js';

let sandbox: Sandbox | undefined;
afterEach(async () => { await sandbox?.cleanup(); });
describe('filesystem evidence', () => {
  it('detects changed bytes even when modification times are restored', async () => {
    sandbox = await createSandbox();
    const path = join(sandbox.context.projectRoot, 'data');
    await putFile(path, 'before');
    const before = await snapshotPath(path);
    await writeFile(path, 'after');
    await utimes(path, new Date(0), new Date(0));
    expect(await snapshotMatches(before)).toBe(false);
  });
  it('fingerprints nested assets and executable modes without traversing links', async () => {
    sandbox = await createSandbox();
    const root = join(sandbox.context.projectRoot, 'skill');
    await putFile(join(root, 'refs', 'run'), '#!/bin/sh\n', 0o755);
    await symlink('refs/run', join(root, 'reference'));
    const before = await snapshotPath(root);
    expect(before.entries.find(entry => entry.relativePath === 'reference')?.kind).toBe('symlink');
    await chmod(join(root, 'refs', 'run'), 0o644);
    expect(await snapshotMatches(before)).toBe(false);
  });
  it('detects a replaced parent and resolves missing children under the actual parent', async () => {
    sandbox = await createSandbox();
    const parent = join(sandbox.context.projectRoot, 'parent');
    await putFile(join(parent, 'existing'), 'one');
    const before = await snapshotPath(join(parent, 'missing'));
    await rename(parent, `${parent}-old`);
    await symlink(`${parent}-old`, parent);
    expect(await snapshotMatches(before)).toBe(false);
    expect((await snapshotPath(join(parent, 'missing'))).resolvedPath).toBe(join(`${parent}-old`, 'missing'));
  });
  it('uses semantic key order for native values and rejects sibling-prefix containment', () => {
    expect(fingerprintValue({ a: 1, b: 2 })).toBe(fingerprintValue({ b: 2, a: 1 }));
    expect(isWithin('/tmp/project', '/tmp/project-other/file')).toBe(false);
    expect(isWithin('/tmp/project', '/tmp/project/asset')).toBe(true);
  });
});
