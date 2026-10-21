import { lstat, readdir, readFile, readlink, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseTree, type Node as JsonNode, type ParseError } from 'jsonc-parser';
import { parseDocument } from 'yaml';
import ignore from 'ignore';
import { hashPath } from './safety.js';
import type { CanonicalData, Context, Diagnostic, JsonObject, OverrideDocument, Server, Skill, SkillRoot } from './types.js';

const envName = /^[A-Za-z_][A-Za-z0-9_]*$/;
const skillName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const object = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value: JsonObject, fields: string[]): boolean => Object.keys(value).every(key => fields.includes(key));
const missing = (error: unknown): boolean => object(error) && error.code === 'ENOENT';
const diagnostic = (code: string, message: string, resource?: string, severity: Diagnostic['severity'] = 'error'): Diagnostic => ({ code, severity, message, ...(resource === undefined ? {} : { resource }) });
const reference = (value: unknown): value is { env: string } => object(value) && exact(value, ['env']) && typeof value.env === 'string' && envName.test(value.env);
const normalizedKey = (key: string): string => key.replace(/[^a-z0-9]/gi, '').toLowerCase();

function credentialKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return /(?:authorization|proxyauthorization|cookie|setcookie|password|passwd|clientsecret|privatekey|apikey|accesstoken|refreshtoken|idtoken|sessiontoken|authtoken|bearertoken|credentials?|secrets?)$/.test(normalized)
    || /(?:^|_)(?:TOKEN|PASSWORD|PASSWD|SECRET|API_KEY|PRIVATE_KEY|ACCESS_KEY|ACCESS_KEY_ID|SECRET_ACCESS_KEY|AUTHORIZATION|COOKIE)(?:_|$)/i.test(key)
    || normalized === 'token';
}

function forbiddenKey(key: string): boolean {
  return /^(?:trust|trusted|truststate|trustapprovals|trustedfolders|trustedprojects|allowall|allowalltools|allowallpaths|allowallurls|dangerouslyskippermissions|oauthstate|oauthcredentials|oauthsession|sessions|logins|loginstate|clientstate|tokenstore|tokencache)$/.test(normalizedKey(key));
}

function credentialUrl(value: string): boolean {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return false;
  try {
    const url = new URL(value);
    return Boolean(url.username || url.password) || [...url.searchParams.keys()].some(credentialKey)
      || [...new URLSearchParams(url.hash.slice(1)).keys()].some(credentialKey);
  } catch {
    // Also catch userinfo in malformed URLs, without including their contents in diagnostics.
    return /^[a-z][a-z0-9+.-]*:\/\/[^/]*@/i.test(value);
  }
}

function credentialLiteral(value: string): boolean {
  return /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.:-]+/i.test(value)
    || /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|AKIA[A-Z0-9]{16})\b/.test(value)
    || /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/.test(value)
    || /(?:^|\s)--?(?:api[-_]?key|access[-_]?token|auth[-_]?token|refresh[-_]?token|password|client[-_]?secret|private[-_]?key|token|secret)(?:=|\s+)\S+/i.test(value)
    || /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|private[_-]?key|password|token|secret)\s*=\s*\S+/i.test(value);
}

/** Find prohibited persisted credentials/state without resolving references or echoing values. */
export function secretDiagnostics(value: unknown, resource?: string): Diagnostic[] {
  const findings = new Set<string>();
  const seen = new Set<object>();
  function visit(item: unknown): void {
    if (typeof item === 'string') {
      if (credentialUrl(item)) findings.add('secret-url');
      if (credentialLiteral(item)) findings.add('secret-literal');
      return;
    }
    if (item === null || typeof item !== 'object' || seen.has(item)) return;
    seen.add(item);
    if (reference(item)) return;
    if (Array.isArray(item)) {
      for (let index = 0; index < item.length; index++) {
        const argument: unknown = item[index];
        if (typeof argument === 'string' && /^--?(?:api[-_]?key|access[-_]?token|auth[-_]?token|refresh[-_]?token|password|client[-_]?secret|private[-_]?key|token|secret)$/i.test(argument) && index + 1 < item.length) findings.add('secret-literal');
        visit(argument);
      }
      return;
    }
    for (const [key, child] of Object.entries(item)) {
      if (item === value && ['mcpservers', 'servers'].includes(normalizedKey(key)) && object(child) && Object.values(child).every(object)) {
        for (const server of Object.values(child)) visit(server);
        continue;
      }
      if (forbiddenKey(key)) findings.add('forbidden-state');
      if (credentialKey(key) && !reference(child) && child !== undefined && child !== null) findings.add('secret-literal');
      visit(child);
    }
  }
  visit(value);
  return [...findings].sort(compare).map(code => diagnostic(code,
    code === 'secret-url' ? 'Credential-bearing URLs cannot be synchronized; use a supported environment reference.'
      : code === 'forbidden-state' ? 'Authentication, trust, session, and allow-all state cannot be synchronized.'
      : 'Literal credentials cannot be synchronized; replace them with explicit environment references.', resource));
}

function validValues(value: unknown, header: boolean): boolean {
  return object(value) && Object.entries(value).every(([key, entry]) =>
    (header ? /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) : envName.test(key))
    && (typeof entry === 'string' && !entry.includes('\0') && (!header || !/[\r\n]/.test(entry)) || reference(entry)));
}

function validCwd(value: unknown): boolean {
  if (!object(value) || !exact(value, ['base', 'path']) || typeof value.base !== 'string' || !['project', 'home', 'source'].includes(value.base) || typeof value.path !== 'string' || !value.path || /[\0\r\n]/.test(value.path)) return false;
  return !path.posix.isAbsolute(value.path) && !path.win32.isAbsolute(value.path)
    && !/^[a-z]:/i.test(value.path) && !value.path.split(/[\\/]/).includes('..');
}

function validCommand(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value !== value.trim() || /[\0\r\n]/.test(value)) return false;
  // Spaces in an executable path are valid; a bare shell-style command line is not.
  return !/\s/.test(value) || path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || /^\.[\\/]/.test(value);
}

/** Strict portable MCP variants. Native-only fields belong in an explicit override. */
export function validateServer(value: unknown, resource?: string): { server?: Server; diagnostics: Diagnostic[] } {
  const diagnostics = secretDiagnostics(value, resource);
  let valid = false;
  if (object(value) && value.type === 'stdio') {
    valid = exact(value, ['type', 'command', 'args', 'env', 'cwd']) && validCommand(value.command)
      && (!Object.hasOwn(value, 'args') || Array.isArray(value.args) && value.args.every(item => typeof item === 'string' && !item.includes('\0')))
      && (!Object.hasOwn(value, 'env') || validValues(value.env, false))
      && (!Object.hasOwn(value, 'cwd') || validCwd(value.cwd));
  } else if (object(value) && (value.type === 'streamable-http' || value.type === 'sse')) {
    valid = exact(value, ['type', 'url', 'headers']) && typeof value.url === 'string' && value.url === value.url.trim() && !/[\0\r\n]/.test(value.url)
      && (!Object.hasOwn(value, 'headers') || validValues(value.headers, true));
    if (valid) {
      try { valid = ['http:', 'https:'].includes(new URL(value.url as string).protocol); } catch { valid = false; }
    }
  }
  if (!valid) diagnostics.push(diagnostic('mcp-invalid-server', 'Server must match exactly one canonical transport variant with valid command, values, URL, and relative working directory.', resource));
  return diagnostics.some(item => item.severity === 'error') ? { diagnostics } : { server: value as Server, diagnostics };
}

function duplicateJsonKeys(node: JsonNode): boolean {
  if (node.type === 'object') {
    const keys = new Set<string>();
    for (const property of node.children ?? []) {
      const key = String(property.children?.[0]?.value);
      if (keys.has(key)) return true;
      keys.add(key);
    }
  }
  return (node.children ?? []).some(duplicateJsonKeys);
}

async function readJson(file: string, diagnostics: Diagnostic[], inputs: Set<string>): Promise<unknown> {
  inputs.add(file);
  let content: string;
  try {
    if (!(await lstat(file)).isFile()) {
      diagnostics.push(diagnostic('canonical-invalid-config', 'Canonical documents must be regular files, not symbolic links.', file));
      return undefined;
    }
    content = await readFile(file, 'utf8');
  }
  catch (error) {
    if (!missing(error)) diagnostics.push(diagnostic('canonical-invalid-config', 'Canonical configuration could not be read.', file));
    return undefined;
  }
  const errors: ParseError[] = [];
  const tree = parseTree(content, errors, { disallowComments: true, allowTrailingComma: false, allowEmptyContent: false });
  if (!tree || errors.length || duplicateJsonKeys(tree)) {
    diagnostics.push(diagnostic('canonical-invalid-json', 'Canonical configuration must be strict JSON with unique object keys.', file));
    return undefined;
  }
  try { return JSON.parse(content) as unknown; }
  catch { diagnostics.push(diagnostic('canonical-invalid-json', 'Canonical configuration must be strict JSON.', file)); return undefined; }
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value) && value === value.trim() && !/[\x00-\x1f\x7f]/.test(value);
}

/** Read only: no directory creation, environment expansion, native execution, or mutations. */
export async function readCanonical(context: Context): Promise<CanonicalData> {
  const diagnostics: Diagnostic[] = [];
  const inputs = new Set<string>([context.canonicalRoot]);
  const data: CanonicalData = { sync: { version: 1, targets: [] }, mcp: { version: 1, mcpServers: {} }, overrides: {}, skills: [], diagnostics, inputs: [] };
  const syncPath = path.join(context.canonicalRoot, 'sync.json');
  const sync = await readJson(syncPath, diagnostics, inputs);
  if (sync !== undefined) {
    diagnostics.push(...secretDiagnostics(sync, syncPath));
    if (!object(sync) || !exact(sync, ['version', 'targets']) || sync.version !== 1 || !Array.isArray(sync.targets) || !sync.targets.every(validId) || new Set(sync.targets).size !== sync.targets.length) {
      diagnostics.push(diagnostic('canonical-invalid-config', 'sync.json requires version 1 and a unique array of nonempty target IDs, with no unknown properties.', syncPath));
    } else data.sync = { version: 1, targets: [...sync.targets] as string[] };
  }
  const mcpPath = path.join(context.canonicalRoot, 'mcp.json');
  const mcp = await readJson(mcpPath, diagnostics, inputs);
  if (mcp !== undefined) {
    if (!object(mcp) || !exact(mcp, ['version', 'mcpServers']) || mcp.version !== 1 || !object(mcp.mcpServers)) {
      diagnostics.push(...secretDiagnostics(mcp, mcpPath));
      diagnostics.push(diagnostic('canonical-invalid-config', 'mcp.json requires version 1 and an mcpServers object, with no unknown properties.', mcpPath));
    } else {
      for (const id of Object.keys(mcp.mcpServers).sort(compare)) {
        const result = validateServer(mcp.mcpServers[id], mcpPath);
        diagnostics.push(...result.diagnostics);
        if (!validId(id)) diagnostics.push(diagnostic('canonical-invalid-config', 'MCP server IDs must be nonempty strings without control characters.', mcpPath));
        else if (result.server) {
          if (context.scope === 'user' && result.server.type === 'stdio' && result.server.cwd?.base === 'project') diagnostics.push(diagnostic('canonical-invalid-config', 'Project-relative working directories are unavailable at user scope.', mcpPath));
          else Object.defineProperty(data.mcp.mcpServers, id, { value: result.server, enumerable: true, writable: true, configurable: true });
        }
      }
    }
  }
  const overridesPath = path.join(context.canonicalRoot, 'overrides');
  inputs.add(overridesPath);
  try {
    if ((await lstat(overridesPath)).isSymbolicLink()) {
      diagnostics.push(diagnostic('canonical-invalid-config', 'Canonical override collections must not be symbolic links.', overridesPath));
      throw new Error('Unsafe override collection');
    }
    const entries = (await readdir(overridesPath, { withFileTypes: true })).sort((a, b) => compare(a.name, b.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const directory = path.join(overridesPath, entry.name);
      inputs.add(directory);
      if (!entry.isDirectory() || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.name)) {
        diagnostics.push(diagnostic('canonical-invalid-config', 'Override entries must be adapter-ID directories, not files or symbolic links.', directory));
        continue;
      }
      const file = path.join(directory, 'mcp.json');
      const override = await readJson(file, diagnostics, inputs);
      if (override === undefined) continue;
      const secrets = secretDiagnostics(override, file);
      diagnostics.push(...secrets);
      if (!object(override) || !exact(override, ['version', 'mcpServers']) || override.version !== 1 || !object(override.mcpServers)
        || !Object.entries(override.mcpServers).every(([id, options]) => validId(id) && object(options))) {
        diagnostics.push(diagnostic('canonical-invalid-config', 'Override mcp.json requires version 1 and a map of server IDs to native option objects, with no unknown document properties.', file));
      } else if (!secrets.length) Object.defineProperty(data.overrides, entry.name, { value: override as unknown as OverrideDocument, enumerable: true, writable: true, configurable: true });
    }
  } catch (error) { if (!missing(error)) diagnostics.push(diagnostic('canonical-invalid-config', 'Canonical override directory could not be read.', overridesPath)); }
  const discovered = await discoverSkills([{ path: path.join(context.canonicalRoot, 'skills'), kind: 'canonical' }], context);
  data.skills = discovered.skills;
  diagnostics.push(...discovered.diagnostics);
  for (const input of discovered.inputs) inputs.add(input);
  data.inputs = [...inputs].sort(compare);
  return data;
}

function contained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

/** Inspect all assets, not just SKILL.md; never copy a link that changes its containment. */
async function validateTree(root: string, diagnostics: Diagnostic[]): Promise<void> {
  const traversed = new Set<string>();
  async function walk(current: string, ancestors: Set<string>): Promise<void> {
    const info = await lstat(current);
    let resolved = current;
    if (info.isSymbolicLink()) {
      const link = await readlink(current);
      if (path.isAbsolute(link) || path.win32.isAbsolute(link) || !contained(root, path.resolve(path.dirname(current), link))) {
        diagnostics.push(diagnostic('skill-unsafe-link', 'Skill assets must use contained relative symbolic links.', root)); return;
      }
      try { resolved = await realpath(current); }
      catch { diagnostics.push(diagnostic('skill-unsafe-link', 'Skill assets contain a broken or cyclic symbolic link.', root)); return; }
      if (!contained(root, resolved)) { diagnostics.push(diagnostic('skill-unsafe-link', 'Skill asset symbolic link escapes the skill directory.', root)); return; }
    }
    const target = info.isSymbolicLink() ? await stat(current) : info;
    if (!target.isDirectory() && !target.isFile()) { diagnostics.push(diagnostic('skill-invalid', 'Skill trees may contain only regular files, directories, and safe symbolic links.', root)); return; }
    if (!target.isDirectory()) return;
    resolved = await realpath(resolved);
    if (ancestors.has(resolved)) { diagnostics.push(diagnostic('skill-unsafe-link', 'Skill assets contain a symbolic-link directory cycle.', root)); return; }
    if (traversed.has(resolved)) return;
    traversed.add(resolved);
    const next = new Set(ancestors).add(resolved);
    for (const name of (await readdir(current)).sort(compare)) await walk(path.join(current, name), next);
  }
  try { await walk(root, new Set()); }
  catch { diagnostics.push(diagnostic('skill-invalid', 'Skill tree could not be completely read.', root)); }
}

async function skillMetadata(directory: string, diagnostics: Diagnostic[], expectedName: string): Promise<boolean> {
  let text: string;
  try { text = await readFile(path.join(directory, 'SKILL.md'), 'utf8'); }
  catch { diagnostics.push(diagnostic('skill-invalid', 'Skill requires a readable SKILL.md.', directory)); return false; }
  const match = /^(?:\uFEFF)?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) { diagnostics.push(diagnostic('skill-invalid', 'SKILL.md requires YAML frontmatter with name and description.', directory)); return false; }
  let metadata: unknown;
  try {
    const document = parseDocument(match[1]!, { uniqueKeys: true, schema: 'core', strict: true });
    if (document.errors.length || document.warnings.length) throw new Error('Invalid frontmatter');
    metadata = document.toJS({ maxAliasCount: 0 }) as unknown;
  } catch { diagnostics.push(diagnostic('skill-invalid', 'SKILL.md frontmatter must be an unambiguous YAML object without aliases or duplicate fields.', directory)); return false; }
  if (!object(metadata)) { diagnostics.push(diagnostic('skill-invalid', 'SKILL.md frontmatter must be an object.', directory)); return false; }
  diagnostics.push(...secretDiagnostics(metadata, directory));
  let valid = true;
  const invalid = (message: string): void => { valid = false; diagnostics.push(diagnostic('skill-invalid', message, directory)); };
  if (typeof metadata.name !== 'string' || metadata.name.length > 64 || !skillName.test(metadata.name) || metadata.name !== expectedName) invalid('Skill name must match its directory and use 1–64 lowercase ASCII letters, digits, and single hyphens.');
  if (typeof metadata.description !== 'string' || !metadata.description.trim() || metadata.description.length > 1024) invalid('Skill description must be a nonempty string of at most 1024 characters.');
  if (Object.hasOwn(metadata, 'license') && typeof metadata.license !== 'string') invalid('Skill license must be a string.');
  if (Object.hasOwn(metadata, 'compatibility') && (typeof metadata.compatibility !== 'string' || !metadata.compatibility.trim() || metadata.compatibility.length > 500)) invalid('Skill compatibility must be a nonempty string of at most 500 characters.');
  if (Object.hasOwn(metadata, 'metadata') && (!object(metadata.metadata) || !Object.values(metadata.metadata).every(value => typeof value === 'string'))) invalid('Skill metadata must be an object with string values.');
  if (Object.hasOwn(metadata, 'allowed-tools') && typeof metadata['allowed-tools'] !== 'string') invalid('Experimental allowed-tools must be a string in the portable skill format.');
  const unknown = Object.keys(metadata).some(key => !['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools'].includes(key));
  const harnessMetadata = object(metadata.metadata) && Object.keys(metadata.metadata).some(key => /^(?:opencode\/|claude[\/-]|copilot[\/-]|pi[\/-]|openai[\/-]|codex[\/-]|gemini[\/-])/i.test(key));
  let sidecar = false;
  try { await lstat(path.join(directory, 'agents', 'openai.yaml')); sidecar = true; } catch (error) { if (!missing(error)) invalid('Skill native metadata sidecar could not be inspected.'); }
  const substitutions = /!`|\$ARGUMENTS\b|\$\d+\b|\$\{(?:CLAUDE_SKILL_DIR|CLAUDE_PROJECT_DIR)\}/.test(text);
  if (unknown || harnessMetadata || sidecar || substitutions || Object.hasOwn(metadata, 'allowed-tools')) diagnostics.push(diagnostic('skill-native-only', 'Skill retains harness-specific or experimental metadata/behavior; cross-harness projection is not assumed equivalent.', directory, 'warning'));
  return valid;
}

/** Deterministic directory discovery with explicit identity and name conflicts. */
export async function discoverSkills(roots: SkillRoot[], _context: Context): Promise<{ skills: Skill[]; diagnostics: Diagnostic[]; inputs: string[] }> {
  const skills: Skill[] = [];
  const diagnostics: Diagnostic[] = [];
  const inputs = new Set<string>();
  const identities = new Map<string, Skill>();
  const names = new Map<string, Skill>();
  type IgnoreLayer = { directory: string; matcher: ReturnType<typeof ignore> };
  for (const root of roots) {
    inputs.add(root.path);
    const safeBasename = (name: string): boolean => Boolean(name) && name !== '.' && name !== '..' && path.basename(name) === name && path.win32.basename(name) === name;
    if ([root.maxDepth, root.maxEntries, root.maxDirectories].some(limit => limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0))
      || root.ignoreFiles?.some(name => !safeBasename(name)) || root.ignoredDirectories?.some(name => !safeBasename(name))) {
      diagnostics.push(diagnostic('skill-invalid', 'Skill discovery policy has invalid traversal bounds or ignore filenames.', root.path));
      continue;
    }
    let entriesSeen = 0;
    const countedDirectories = new Set<string>();
    let directoryLimitReported = false;
    let entryLimitReported = false;
    const limitFinding = (): void => {
      if (!entryLimitReported) diagnostics.push(diagnostic('skill-discovery-limit', 'Skill discovery reached its native entry boundary; undiscovered resources remain at their source.', root.path, 'warning'));
      entryLimitReported = true;
    };
    const visited = new Set<string>();
    async function scan(directory: string, depth: number, ancestors: Set<string>, inherited: IgnoreLayer[]): Promise<void> {
      inputs.add(directory);
      let resolved: string;
      try {
        const info = await stat(directory);
        if (!info.isDirectory()) {
          diagnostics.push(diagnostic('skill-native-format', 'Standalone native skill files cannot be projected as portable skill directory trees.', directory, root.kind === 'canonical' ? 'error' : 'warning')); return;
        }
        resolved = await realpath(directory);
        inputs.add(resolved);
      } catch (error) {
        if (!missing(error) || depth > 0) diagnostics.push(diagnostic('skill-invalid', 'Skill discovery path is missing, unreadable, or cyclic.', directory));
        return;
      }
      if (ancestors.has(resolved)) { diagnostics.push(diagnostic('skill-unsafe-link', 'Skill discovery encountered a symbolic-link directory cycle.', directory)); return; }
      if (!countedDirectories.has(resolved)) {
        if (root.maxDirectories !== undefined && countedDirectories.size >= root.maxDirectories) {
          if (!directoryLimitReported) diagnostics.push(diagnostic('skill-discovery-limit', 'Skill discovery reached its native directory-count boundary; additional resources remain at their source.', directory, 'warning'));
          directoryLimitReported = true;
          return;
        }
        countedDirectories.add(resolved);
      }
      let hasSkill = false;
      try { hasSkill = (await stat(path.join(directory, 'SKILL.md'))).isFile(); }
      catch (error) { if (!missing(error)) { diagnostics.push(diagnostic('skill-invalid', 'Skill document could not be inspected.', directory)); return; } }
      if (hasSkill) {
        // A canonical collection is not itself a skill; its children are the identities.
        if (root.kind === 'canonical' && depth === 0) { diagnostics.push(diagnostic('skill-invalid', 'Canonical skills must be in named directories below skills/.', directory)); return; }
        inputs.add(path.join(directory, 'SKILL.md'));
        inputs.add(resolved);
        if (identities.has(resolved)) { diagnostics.push(diagnostic('skill-duplicate-identity', 'The same physical skill is discovered through multiple paths; it is inventoried only once.', directory, 'info')); return; }
        let hash: string | null;
        try { hash = await hashPath(resolved); }
        catch { diagnostics.push(diagnostic('skill-invalid', 'Complete skill tree could not be hashed.', directory)); return; }
        if (hash === null) { diagnostics.push(diagnostic('skill-invalid', 'Skill disappeared during discovery.', directory)); return; }
        const findings: Diagnostic[] = [];
        await validateTree(resolved, findings);
        if (findings.some(item => item.severity === 'error')) { diagnostics.push(...findings); return; }
        const valid = await skillMetadata(resolved, findings, path.basename(directory));
        diagnostics.push(...findings);
        if (!valid || findings.some(item => item.severity === 'error')) return;
        try {
          if (await realpath(directory) !== resolved || await hashPath(resolved) !== hash) {
            diagnostics.push(diagnostic('skill-concurrent-change', 'Skill changed while it was being read; retry discovery before synchronization.', directory)); return;
          }
        } catch { diagnostics.push(diagnostic('skill-concurrent-change', 'Skill changed or became unreadable during discovery.', directory)); return; }
        const skill: Skill = { id: path.basename(directory), path: directory, hash, realPath: resolved, nativeOnly: findings.some(item => item.code === 'skill-native-only'), diagnostics: findings };
        const prior = names.get(skill.id);
        if (prior) diagnostics.push(diagnostic('skill-duplicate-name', 'Distinct skill directories have the same name; resolve the ambiguity before synchronization.', directory));
        else names.set(skill.id, skill);
        identities.set(resolved, skill);
        skills.push(skill);
        return;
      }
      try {
        if (depth > 0 && (await lstat(directory)).isSymbolicLink() && !contained(await realpath(root.path), resolved)) {
          diagnostics.push(diagnostic('skill-unsafe-link', 'A symbolic-link collection escapes its declared discovery root.', directory)); return;
        }
      } catch { diagnostics.push(diagnostic('skill-invalid', 'Skill discovery directory changed while being inspected.', directory)); return; }
      if (root.kind === 'canonical' && depth > 0) { diagnostics.push(diagnostic('skill-invalid', 'Each canonical skill directory requires SKILL.md.', directory)); return; }
      if (depth > 0 && !root.recursive) return;
      if (visited.has(resolved)) return;
      visited.add(resolved);
      const next = new Set(ancestors).add(resolved);
      const layers = [...inherited];
      const matcher = ignore();
      for (const name of root.ignoreFiles ?? []) {
        const file = path.join(directory, name);
        inputs.add(file);
        try {
          if (!(await lstat(file)).isFile()) {
            diagnostics.push(diagnostic('skill-invalid', 'Discovery ignore files must be regular files, not symbolic links.', file)); return;
          }
          matcher.add(await readFile(file, 'utf8'));
        } catch (error) {
          if (!missing(error)) { diagnostics.push(diagnostic('skill-invalid', 'Discovery ignore file could not be read.', file)); return; }
        }
      }
      if (root.ignoreFiles?.length) layers.push({ directory, matcher });
      try {
        const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => compare(a.name, b.name));
        for (const entry of entries) {
          if (root.maxEntries !== undefined && entriesSeen >= root.maxEntries) { limitFinding(); break; }
          entriesSeen++;
          if (entry.name.startsWith('.')) continue;
          const child = path.join(directory, entry.name);
          let isDirectory = entry.isDirectory();
          if (entry.isSymbolicLink()) {
            try { isDirectory = (await stat(child)).isDirectory(); }
            catch { diagnostics.push(diagnostic('skill-unsafe-link', 'Discovery encountered a broken or cyclic symbolic link.', child)); continue; }
          }
          if (isDirectory && root.ignoredDirectories?.includes(entry.name)) continue;
          let ignored = false;
          for (const layer of layers) {
            const relative = path.relative(layer.directory, child).split(path.sep).join('/') + (isDirectory ? '/' : '');
            const result = layer.matcher.test(relative);
            if (result.ignored) ignored = true;
            else if (result.unignored) ignored = false;
          }
          if (ignored) continue;
          if (isDirectory) {
            if (root.maxDepth !== undefined && depth >= root.maxDepth) {
              diagnostics.push(diagnostic('skill-discovery-limit', 'Skill discovery reached its native directory-depth boundary; deeper resources remain at their source.', child, 'warning'));
              continue;
            }
            await scan(child, depth + 1, next, layers);
          }
          else if (root.kind !== 'canonical' && entry.name.endsWith('.md')) {
            inputs.add(child);
            diagnostics.push(diagnostic('skill-native-format', 'Standalone native Markdown is retained at its source; portable synchronization requires a complete skill directory.', child, 'warning'));
          }
        }
      } catch { diagnostics.push(diagnostic('skill-invalid', 'Skill discovery directory could not be read.', directory)); }
    }
    await scan(root.path, 0, new Set(), []);
  }
  return { skills, diagnostics, inputs: [...inputs].sort(compare) };
}
