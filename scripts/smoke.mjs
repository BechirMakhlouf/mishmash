import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as TOML from 'smol-toml';

const repository = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(path.join(repository, 'package.json'), 'utf8'));
assert.equal(manifest.name, 'mishmash');
const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.mishmash;
assert.equal(typeof bin, 'string', 'the package must expose the mishmash CLI');
const cli = path.resolve(repository, bin);
assert.match(await readFile(cli, 'utf8'), /^#!.*node/, 'the built CLI needs a Node shebang');

const temporary = await mkdtemp(path.join(tmpdir(), 'mishmash-smoke-'));
const project = path.join(temporary, 'project with spaces');
const home = path.join(temporary, 'isolated home');
const nativeSkill = path.join(project, '.claude', 'skills', 'native-review');
const canonicalSkill = path.join(project, '.agents', 'skills', 'shared-review');
const environment = { ...process.env, HOME: home, USERPROFILE: home };
// Test fixture roots, not developer profiles, remain the only discovery inputs.
for (const key of Object.keys(environment)) {
  if (/^(CLAUDE_|CODEX_|COPILOT_|PI_CODING_AGENT_DIR$|OPENCODE_|GEMINI_CLI_|XDG_)/i.test(key)) {
    delete environment[key];
  }
}

async function put(relative, value) {
  const destination = path.join(project, relative);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
}

async function snapshot(directory) {
  const entries = [];
  async function visit(location, relative) {
    const stat = await lstat(location);
    if (stat.isSymbolicLink()) {
      entries.push([relative, 'link', await readlink(location)]);
    } else if (stat.isDirectory()) {
      entries.push([relative, 'directory', stat.mode & 0o777]);
      for (const entry of (await readdir(location)).sort()) {
        await visit(path.join(location, entry), path.join(relative, entry));
      }
    } else {
      entries.push([relative, 'file', stat.mode & 0o777, createHash('sha256').update(await readFile(location)).digest('hex')]);
    }
  }
  await visit(directory, '.');
  return entries;
}

function invoke(args, json = true) {
  const command = json ? [...args, '--scope', 'project', '--project', project, '--home', home, '--json'] : args;
  const result = spawnSync(process.execPath, [cli, ...command], {
    cwd: project,
    env: environment,
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
    shell: false,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, `CLI interrupted: ${result.signal}`);
  assert.equal(result.status, 0, `${command.join(' ')}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  if (!json) return result.stdout;
  const output = JSON.parse(result.stdout);
  assert.equal(output.version, 1);
  assert.equal(output.scope, 'project');
  assert.ok(Array.isArray(output.changes));
  assert.ok(Array.isArray(output.diagnostics));
  assert.deepEqual(output.diagnostics.filter((entry) => entry.severity === 'error'), []);
  return output;
}

async function readOnly(args) {
  const before = await snapshot(temporary);
  const output = invoke(args);
  assert.equal(output.applied, false);
  assert.deepEqual(await snapshot(temporary), before, `${args[0]} must not mutate the fixture`);
  return output;
}

const targets = ['--target', 'claude-code', '--target', 'codex'];
const skillText = (name) => `---\nname: ${name}\ndescription: Review changes using the bundled checklist.\n---\n\nRead references/checklist.txt. Do not execute scripts/check.mjs during discovery.\n`;
const nativeServer = { type: 'http', url: 'https://native.invalid/mcp' };
const sharedServer = { type: 'streamable-http', url: 'https://shared.invalid/mcp' };
const unmanagedServer = { url: 'https://unmanaged.invalid/mcp' };
const script = '#!/usr/bin/env node\nthrow new Error("skill scripts must not run during synchronization");\n';

try {
  await mkdir(home, { recursive: true });
  await mkdir(project, { recursive: true });
  await put('.agents/sync.json', { version: 1, targets: ['claude-code', 'codex'] });
  await put('.agents/mcp.json', { version: 1, mcpServers: { 'shared-docs': sharedServer } });
  await put('.agents/skills/shared-review/SKILL.md', skillText('shared-review'));
  await put('.agents/skills/shared-review/references/checklist.txt', 'Retain the canonical skill asset.\n');
  await put('.claude/skills/native-review/SKILL.md', skillText('native-review'));
  await put('.claude/skills/native-review/references/checklist.txt', 'Retain the complete imported directory.\n');
  await put('.claude/skills/native-review/scripts/check.mjs', script);
  await chmod(path.join(nativeSkill, 'scripts/check.mjs'), 0o755);
  await put('.mcp.json', { sentinel: { owner: 'not-mishmash' }, mcpServers: { 'native-docs': nativeServer } });
  await put('.codex/config.toml', '# Keep this unrelated comment.\nmodel = "unmanaged-model"\n\n[mcp_servers.unmanaged]\nurl = "https://unmanaged.invalid/mcp"\n');

  assert.match(invoke(['--help'], false), /mishmash/);
  assert.ok(invoke(['--version'], false).includes(manifest.version));

  const inventory = await readOnly(['inspect', '--from', 'claude-code']);
  assert.ok(inventory.inventory.skills.some((entry) => entry.id === 'native-review'));
  assert.ok(inventory.inventory.mcp.some((entry) => entry.id === 'native-docs'));

  const migration = await readOnly(['import', '--from', 'claude-code', ...targets]);
  assert.ok(migration.changes.length > 0, 'migration must propose observable changes');
  const imported = invoke(['import', '--from', 'claude-code', ...targets, '--apply']);
  assert.equal(imported.applied, true);
  assert.ok(imported.changes.length > 0);

  const adoptedSkill = path.join(project, '.agents', 'skills', 'native-review');
  assert.equal(await readFile(path.join(adoptedSkill, 'SKILL.md'), 'utf8'), skillText('native-review'));
  assert.equal(await readFile(path.join(adoptedSkill, 'references/checklist.txt'), 'utf8'), 'Retain the complete imported directory.\n');
  assert.equal(await readFile(path.join(adoptedSkill, 'scripts/check.mjs'), 'utf8'), script);
  if (process.platform !== 'win32') {
    assert.equal((await lstat(path.join(adoptedSkill, 'scripts/check.mjs'))).mode & 0o111, 0o111);
  }
  assert.equal(await readFile(path.join(nativeSkill, 'SKILL.md'), 'utf8'), skillText('native-review'));
  assert.equal(await readFile(path.join(canonicalSkill, 'references/checklist.txt'), 'utf8'), 'Retain the canonical skill asset.\n');

  const canonical = JSON.parse(await readFile(path.join(project, '.agents/mcp.json'), 'utf8'));
  assert.equal(canonical.mcpServers['native-docs'].url, nativeServer.url);
  assert.equal(canonical.mcpServers['shared-docs'].url, sharedServer.url);
  canonical.mcpServers['added-docs'] = { type: 'streamable-http', url: 'https://added.invalid/mcp' };
  await put('.agents/mcp.json', canonical);

  const plan = await readOnly(['plan', ...targets]);
  assert.ok(plan.changes.length > 0, 'editing canonical intent must create a plan');
  const drySync = await readOnly(['sync', ...targets]);
  assert.deepEqual(drySync.changes, plan.changes);
  const synchronized = invoke(['sync', ...targets, '--apply']);
  assert.equal(synchronized.applied, true);

  const claudeOutput = JSON.parse(await readFile(path.join(project, '.mcp.json'), 'utf8'));
  assert.deepEqual(claudeOutput.sentinel, { owner: 'not-mishmash' });
  assert.equal(claudeOutput.mcpServers['added-docs'].url, 'https://added.invalid/mcp');
  const codexText = await readFile(path.join(project, '.codex/config.toml'), 'utf8');
  assert.ok(codexText.includes('# Keep this unrelated comment.'));
  const codexOutput = TOML.parse(codexText);
  assert.equal(codexOutput.model, 'unmanaged-model');
  assert.equal(codexOutput.mcp_servers.unmanaged.url, unmanagedServer.url);
  for (const id of ['native-docs', 'shared-docs', 'added-docs']) {
    assert.equal(codexOutput.mcp_servers[id].url, canonical.mcpServers[id].url);
  }

  assert.deepEqual((await readOnly(['plan', ...targets])).changes, [], 'an unchanged plan must be empty');
  const beforeRepeat = await snapshot(temporary);
  const repeated = invoke(['sync', ...targets, '--apply']);
  assert.deepEqual(repeated.changes, [], 'the second sync must be unchanged');
  assert.deepEqual(await snapshot(temporary), beforeRepeat, 'unchanged sync must not rewrite files or state');
  console.log('mishmash built-CLI smoke passed: isolated migration, plan/apply, assets, unmanaged content, and unchanged sync.');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
