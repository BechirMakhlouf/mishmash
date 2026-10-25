#!/usr/bin/env node
import { readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { log } from '@clack/prompts';
import { runInteractiveFlow } from './ui/flow.js';
import { sanitizeTerminalText } from './ui/render.js';
import type { Context } from './model.js';

const usage = `Usage: mishmash [--help | --version]

Discover agent skills and MCP registrations, choose their authoritative sources,
review destination changes, and synchronize only after explicit confirmation.

Options:
  --help      Show this help
  --version   Show the installed version`;

const logo = [
  '███    ███ ██ ███████ ██   ██ ███    ███  █████  ███████ ██   ██',
  '████  ████ ██ ██      ██   ██ ████  ████ ██   ██ ██      ██   ██',
  '██ ████ ██ ██ ███████ ███████ ██ ████ ██ ███████ ███████ ███████',
  '██  ██  ██ ██      ██ ██   ██ ██  ██  ██ ██   ██      ██ ██   ██',
  '██      ██ ██ ███████ ██   ██ ██      ██ ██   ██ ███████ ██   ██',
];

async function installedVersion(): Promise<string> {
  for (const path of ['../package.json', '../../package.json']) {
    try {
      const value = JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8')) as { version?: unknown };
      if (typeof value.version === 'string' && value.version.length > 0) return sanitizeTerminalText(value.version);
    } catch {
      // Try the package root relative to the source or built entry point.
    }
  }
  return 'unknown';
}

function createContext(): Context {
  const homeDir = resolve(homedir());
  return {
    projectRoot: resolve(process.cwd()),
    homeDir,
    configHome: resolve(process.env.XDG_CONFIG_HOME || join(homeDir, '.config')),
    stateHome: resolve(process.env.XDG_STATE_HOME || join(homeDir, '.local', 'state')),
  };
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write(`${usage}\n`);
    return;
  }
  if (args.length === 1 && args[0] === '--version') {
    process.stdout.write(`mishmash ${await installedVersion()}\n`);
    return;
  }
  if (args.length > 0) {
    process.stderr.write(`Unknown option.\n${usage}\n`);
    process.exitCode = 2;
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stdout.write(`${usage}\n`);
    return;
  }

  // A Clack plain message keeps the supplied artwork in normal scrollback without a prompt prefix.
  log.message(logo, { symbol: '', secondarySymbol: '', withGuide: false, spacing: 0 });

  const controller = new AbortController();
  const onInterrupt = (): void => { if (!controller.signal.aborted) controller.abort(new Error('Interrupted')); };
  const onTerminate = (): void => { if (!controller.signal.aborted) controller.abort(new Error('Terminated')); };
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);
  try {
    await runInteractiveFlow(createContext(), controller.signal, reason => controller.abort(reason));
  } finally {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
    if (controller.signal.aborted) process.exitCode = controller.signal.reason instanceof Error && controller.signal.reason.message === 'Terminated' ? 143 : 130;
  }
}

async function isCliEntry(): Promise<boolean> {
  if (!process.argv[1]) return false;
  let entryPath = resolve(process.argv[1]);
  try {
    entryPath = await realpath(entryPath);
  } catch {
    // Keep the absolute invocation path as a safe fallback.
  }
  return import.meta.url === pathToFileURL(entryPath).href;
}

if (await isCliEntry()) await main();
