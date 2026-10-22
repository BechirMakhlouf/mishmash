import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readlink, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Finding, PathIdentity, PathSnapshot, TreeEntry } from '../model.js';

export function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code : 'UNKNOWN';
}
export function filesystemFinding(path: string, code = 'UNREADABLE_SOURCE'): Finding {
  return { severity: 'error', code, path, message: 'This location could not be read safely.', remediation: 'Check its permissions and native format, then rediscover.' };
}
export function isWithin(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}
export function hashBytes(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
export function fingerprintValue(value: unknown): string { return hashBytes(canonical(value)); }
async function fileDigest(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
async function parentsOf(path: string): Promise<PathIdentity[]> {
  const paths: string[] = [];
  let parent = dirname(path);
  for (;;) {
    paths.push(parent);
    const next = dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  const result: PathIdentity[] = [];
  for (const item of paths.reverse()) {
    try {
      const stat = await lstat(item, { bigint: true });
      const kind = stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other';
      result.push({ path: item, kind, dev: String(stat.dev), ino: String(stat.ino), ...(kind === 'symlink' ? { linkTarget: await readlink(item) } : {}) });
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
  }
  return result;
}
async function resolveMissing(path: string): Promise<string> {
  const suffix: string[] = [];
  let ancestor = path;
  for (;;) {
    try { return resolve(await realpath(ancestor), ...suffix); }
    catch (error) {
      if (errorCode(error) !== 'ENOENT' && errorCode(error) !== 'ENOTDIR') throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      suffix.unshift(relative(parent, ancestor));
      ancestor = parent;
    }
  }
}
async function inspectEntry(path: string, relativePath: string, entries: TreeEntry[]): Promise<TreeEntry> {
  const stat = await lstat(path);
  const mode = stat.mode & 0o777;
  let entry: TreeEntry;
  if (stat.isSymbolicLink()) {
    const linkTarget = await readlink(path);
    entry = { relativePath, kind: 'symlink', mode, linkTarget, digest: hashBytes(`symlink\0${linkTarget}`) };
  } else if (stat.isFile()) {
    entry = { relativePath, kind: 'file', mode, digest: await fileDigest(path) };
  } else if (stat.isDirectory()) {
    const children: TreeEntry[] = [];
    for (const name of (await readdir(path)).sort()) {
      children.push(await inspectEntry(join(path, name), relativePath ? `${relativePath}/${name}` : name, entries));
    }
    entry = { relativePath, kind: 'directory', mode, digest: fingerprintValue(children.map(child => [child.relativePath, child.kind, child.mode, child.digest])) };
  } else {
    entry = { relativePath, kind: 'other', mode, digest: 'unsupported' };
  }
  entries.push(entry);
  return entry;
}
export async function snapshotPath(input: string): Promise<PathSnapshot> {
  const path = resolve(input);
  const parents = await parentsOf(path);
  try {
    const entries: TreeEntry[] = [];
    const root = await inspectEntry(path, '', entries);
    const resolvedPath = await resolveMissing(path);
    return { path, kind: root.kind, mode: root.mode, digest: fingerprintValue([root.kind, root.mode, root.digest]), entries: entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath)), parents, resolvedPath, ...(root.linkTarget === undefined ? {} : { linkTarget: root.linkTarget }) };
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
    // A disappearing descendant is not a missing root: let callers refresh the source.
    try { await lstat(path); } catch (rootError) {
      if (errorCode(rootError) !== 'ENOENT') throw rootError;
      return { path, kind: 'missing', digest: 'missing', mode: 0, entries: [], parents, resolvedPath: await resolveMissing(path) };
    }
    throw new Error('Source changed while being inspected.');
  }
}
export function snapshotsEqual(before: PathSnapshot, after: PathSnapshot): boolean {
  return before.path === after.path && before.kind === after.kind && before.digest === after.digest
    && before.resolvedPath === after.resolvedPath && fingerprintValue(before.parents) === fingerprintValue(after.parents);
}
export async function snapshotMatches(before: PathSnapshot): Promise<boolean> {
  try { return snapshotsEqual(before, await snapshotPath(before.path)); } catch { return false; }
}
