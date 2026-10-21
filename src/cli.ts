#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { createContext, createPlan, inspect } from './engine.js';
import { applyPlan } from './safety.js';
import type { Scope } from './types.js';

const help = `mishmash — safely synchronize skills and MCP server intent

Usage:
  mishmash inspect [--from ADAPTER|all] [options]
  mishmash import --from ADAPTER|all [--apply] [options]
  mishmash plan [options]
  mishmash sync [--apply] [options]

Options:
  --scope project|user|project-private   Default: project
  --project PATH                       Selected project (default: current directory)
  --home PATH                          Isolated home; ignores native environment overrides
  --target ADAPTER[,ADAPTER]            Repeatable; no harness installation required
  --state-dir PATH                     Private ownership/backups directory
  --opencode-version 1|2               Explicit native major (default: 2)
  --claude-state-file PATH             Established Claude mixed-state filename
  --codex-profile-home PATH            Codex profile-known-folder home, NOT CODEX_HOME
  --skill-mode auto|link|copy           Prefer links, auto falls back to tracked copies
  --apply                              Apply a valid import/sync plan explicitly
  --json                               Deterministic redacted machine-readable output
  --help                               Show help
  --version                            Show version

Inspect, plan and import/sync without --apply never mutate files or execute servers.
`;
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { process.stdout.write(help); return; }
  if (args.length === 1 && args[0] === '--version') {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    process.stdout.write(manifest.version + '\n'); return;
  }
  const command = args.shift();
  if (!command || !['inspect', 'import', 'plan', 'sync'].includes(command)) throw new Error('Expected inspect, import, plan or sync; use --help');
  const values = new Map<string, string[]>();
  const booleans = new Set<string>();
  const valueFlags = new Set(['--scope', '--project', '--home', '--from', '--target', '--state-dir', '--opencode-version', '--claude-state-file', '--codex-profile-home', '--skill-mode']);
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--help' && args.length === 1) { process.stdout.write(help); return; }
    if (flag === '--apply' || flag === '--json') { if (booleans.has(flag)) throw new Error(`Duplicate flag: ${flag}`); booleans.add(flag); continue; }
    if (!valueFlags.has(flag)) throw new Error(`Unsupported flag: ${flag}`);
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    if (flag !== '--target' && values.has(flag)) throw new Error(`Duplicate flag: ${flag}`);
    values.set(flag, [...(values.get(flag) ?? []), value]);
  }
  const one = (flag: string): string | undefined => values.get(flag)?.[0];
  if (booleans.has('--apply') && (command === 'inspect' || command === 'plan')) throw new Error('--apply is supported only for import or sync');
  if (values.has('--from') && command !== 'inspect' && command !== 'import') throw new Error('--from is supported only for inspect or import');
  if (command === 'inspect' && values.has('--target')) throw new Error('--target is not an inspect flag');
  if (command === 'import' && !one('--from')) throw new Error('Import requires --from');
  const scope = one('--scope') ?? 'project';
  if (!['project', 'user', 'project-private'].includes(scope)) throw new Error('Scope must be project, user or project-private');
  const version = one('--opencode-version') ?? '2';
  if (!['1', '2'].includes(version)) throw new Error('OpenCode version must be 1 or 2');
  const skillMode = one('--skill-mode') ?? 'auto';
  if (!['auto', 'link', 'copy'].includes(skillMode)) throw new Error('Skill mode must be auto, link or copy');
  const context = createContext({ scope: scope as Scope, project: one('--project'), home: one('--home'), stateDir: one('--state-dir'), opencodeVersion: Number(version) as 1 | 2,
    claudeStateFile: one('--claude-state-file'), codexHome: one('--codex-profile-home'), skillMode: skillMode as 'auto' | 'link' | 'copy' });
  const targets = values.get('--target')?.flatMap(value => value.split(',')).map(value => value.trim());
  if (targets?.some(value => !value)) throw new Error('Target identifiers cannot be empty');
  if (command === 'inspect') {
    const inspection = await inspect(context, one('--from') ?? 'all');
    const result = { ...inspection, command, changes: [], applied: false };
    print(result, booleans.has('--json'));
    if (inspection.diagnostics.some(item => item.severity === 'error')) process.exitCode = 1;
    return;
  }
  const plan = await createPlan(context, { command: command === 'import' ? 'import' : 'sync', from: one('--from'), targets });
  let applied = false;
  if (booleans.has('--apply') && !plan.diagnostics.some(item => item.severity === 'error')) {
    if (plan.operations.length) await applyPlan(plan);
    applied = true;
  }
  const result = { version: 1, command, scope, targets: plan.targets, changes: plan.operations.map(({ kind, path, reason }) => ({ kind, path, reason })), diagnostics: plan.diagnostics, applied };
  print(result, booleans.has('--json'));
  if (plan.diagnostics.some(item => item.severity === 'error')) process.exitCode = 1;
}
function print(result: { command: string; scope: string; changes: { kind: string; path: string; reason: string }[]; diagnostics: { severity: string; code: string; message: string; resource?: string }[]; applied: boolean; inventory?: { skills: unknown[]; mcp: unknown[] } }, json: boolean): void {
  if (json) { process.stdout.write(JSON.stringify(result, null, 2) + '\n'); return; }
  process.stdout.write(`${result.command} (${result.scope}): ${result.changes.length} change(s)${result.applied ? ', applied' : ', read-only'}\n`);
  if (result.inventory) process.stdout.write(`${result.inventory.skills.length} skill registration(s), ${result.inventory.mcp.length} MCP registration(s)\n`);
  for (const change of result.changes) process.stdout.write(`  ${change.kind} ${change.path} — ${change.reason}\n`);
  for (const item of result.diagnostics) process.stdout.write(`  ${item.severity} [${item.code}] ${item.message}${item.resource ? ` (${item.resource})` : ''}\n`);
}
main().catch(() => {
  // Never print parser/OS error payloads: they can include native credential values.
  const result = { version: 1, command: process.argv[2] ?? null, changes: [], applied: false, diagnostics: [{ code: 'operation-failed', severity: 'error', message: 'Operation failed: invalid input, unsafe configuration, stale plan, or filesystem failure. Check command options and private recovery state; use --help for supported syntax.' }] };
  if (process.argv.includes('--json')) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else process.stderr.write(result.diagnostics[0].message + '\n');
  process.exitCode = 1;
});
