import type { NativeAdapter } from './contract.js';
import { claudeCodeAdapter } from './claude-code.js';
import { codexAdapter } from './codex.js';
import { geminiCliAdapter } from './gemini-cli.js';
import { githubCopilotCliAdapter } from './github-copilot-cli.js';
import { opencodeAdapter } from './opencode.js';
import { piAdapter } from './pi.js';

export const nativeAdapters: readonly NativeAdapter[] = [
  claudeCodeAdapter,
  codexAdapter,
  githubCopilotCliAdapter,
  piAdapter,
  opencodeAdapter,
  geminiCliAdapter,
];
