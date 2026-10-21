import { claudeCode } from './adapters/claude-code.js';
import { codex } from './adapters/codex.js';
import { githubCopilotCli } from './adapters/github-copilot-cli.js';
import { pi } from './adapters/pi.js';
import { opencode } from './adapters/opencode.js';
import { geminiCli } from './adapters/gemini-cli.js';
import type { Adapter } from './types.js';
export const adapters = new Map<string, Adapter>([claudeCode, codex, githubCopilotCli, pi, opencode, geminiCli].map(adapter => [adapter.id, adapter]));
export function registerAdapter(adapter: Adapter): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(adapter.id)) throw new Error('Invalid adapter identifier');
  if (adapters.has(adapter.id)) throw new Error(`Adapter already registered: ${adapter.id}`);
  adapters.set(adapter.id, adapter);
}
