import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import type { AgentId, Finding, Scope, SkillResource, SourceRef, Visibility } from '../model.js';
import { errorCode, filesystemFinding, isWithin, snapshotMatches, snapshotPath } from '../fs/snapshot.js';

/** Source identity is the resolved location and logical scope, not its discovering agent or label. */
export function sourceRef(agentId: AgentId | 'shared', path: string, scope: Scope, visibility: Visibility, label: string): SourceRef {
  const absolute = resolve(path);
  return { id: JSON.stringify([absolute, scope, visibility]), agentId, path: absolute, scope, visibility, label };
}
export function resourceId(source: SourceRef, locator: string): string { return JSON.stringify([source.id, locator]); }
export interface SkillReadResult { resources: readonly SkillResource[]; findings: readonly Finding[] }
export async function readSkillDirectory(path: string, source: SourceRef, locator = basename(path)): Promise<SkillReadResult> {
  try {
    const actual = await realpath(path);
    const snapshot = await snapshotPath(actual);
    const metadataPath = join(actual, 'SKILL.md');
    const text = await readFile(metadataPath, 'utf8');
    let name = basename(path);
    let description: string | undefined;
    const normalized = text.replace(/^\uFEFF/, '');
    if (/^---\r?\n/.test(normalized)) {
      const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(normalized);
      if (!match) return { resources: [], findings: [filesystemFinding(metadataPath, 'INVALID_SKILL_METADATA')] };
      const document = parseDocument(match[1]!, { uniqueKeys: true });
      if (document.errors.length) return { resources: [], findings: [filesystemFinding(metadataPath, 'INVALID_SKILL_METADATA')] };
      const value: unknown = document.toJS({ maxAliasCount: 0 });
      if (value !== null && (typeof value !== 'object' || Array.isArray(value))) return { resources: [], findings: [filesystemFinding(metadataPath, 'INVALID_SKILL_METADATA')] };
      const fields = (value ?? {}) as Record<string, unknown>;
      if (fields.name !== undefined && (typeof fields.name !== 'string' || !fields.name.trim())) return { resources: [], findings: [filesystemFinding(metadataPath, 'INVALID_SKILL_METADATA')] };
      if (fields.description !== undefined && typeof fields.description !== 'string') return { resources: [], findings: [filesystemFinding(metadataPath, 'INVALID_SKILL_METADATA')] };
      if (typeof fields.name === 'string') name = fields.name.trim();
      if (typeof fields.description === 'string') description = fields.description.trim();
    }
    for (const entry of snapshot.entries) {
      if (entry.kind === 'other') return { resources: [], findings: [filesystemFinding(path, 'UNSUPPORTED_SKILL_ENTRY')] };
      if (entry.kind === 'symlink') {
        if (!entry.linkTarget || isAbsolute(entry.linkTarget)) return { resources: [], findings: [filesystemFinding(path, 'UNSAFE_SKILL_LINK')] };
        const referent = await realpath(join(actual, entry.relativePath));
        if (!isWithin(actual, referent)) return { resources: [], findings: [filesystemFinding(path, 'UNSAFE_SKILL_LINK')] };
      }
    }
    if (!await snapshotMatches(snapshot)) return { resources: [], findings: [filesystemFinding(path, 'SOURCE_CHANGED')] };
    return { resources: [{ kind: 'skill', id: resourceId(source, locator), name, ...(description ? { description } : {}), source, path: actual, locator, snapshot }], findings: [] };
  } catch { return { resources: [], findings: [filesystemFinding(path)] }; }
}
export async function discoverSkills(source: SourceRef): Promise<SkillReadResult> {
  const resources: SkillResource[] = [];
  const findings: Finding[] = [];
  try {
    const stat = await lstat(source.path);
    if (!stat.isDirectory() && !stat.isSymbolicLink()) return { resources, findings: [filesystemFinding(source.path, 'INVALID_SKILL_SOURCE')] };
    // An explicitly supplied source may itself be one skill.
    try {
      await lstat(join(source.path, 'SKILL.md'));
      return readSkillDirectory(source.path, source, '.');
    } catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
    for (const entry of (await readdir(source.path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const child = join(source.path, entry.name);
      try { await lstat(join(child, 'SKILL.md')); }
      catch (error) {
        if (errorCode(error) !== 'ENOENT') findings.push(filesystemFinding(child));
        continue;
      }
      const result = await readSkillDirectory(child, source, entry.name);
      resources.push(...result.resources);
      findings.push(...result.findings);
    }
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') findings.push(filesystemFinding(source.path));
  }
  return { resources, findings };
}
