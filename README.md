# mishmash

<img width="900" height="900" alt="image" src="https://github.com/user-attachments/assets/5fd46c1c-1e61-41ca-a1e0-fd6e0c963807" />

Sync skills and MCP configurations across your coding agents. Choose a source of truth, select destinations, and review every change before applying it.

Supports [Claude Code](docs/native/claude-code.md), [Codex](docs/native/codex.md), [GitHub Copilot CLI](docs/native/github-copilot-cli.md), [pi](docs/native/pi.md), [OpenCode](docs/native/opencode.md), and [Gemini CLI](docs/native/gemini-cli.md). Capabilities vary by agent; unsupported conversions are flagged, not silently changed.

## Get started

Requires **Node.js 22.20.0+** and an interactive terminal. Build from this checkout (not published to npm):

```sh
npm ci
npm run build
```

Then run it from the project you want to configure:

```sh
cd /path/to/project
node /path/to/mishmash/dist/src/cli.js
```

The guided flow discovers resources, asks which sources to use, and previews synchronization. CLI options: `--help`, `--version`.

## What to expect

- Keep editing your original sources. Skills are copied whole or linked where supported; copies need another sync after edits.
- Choose project or user destinations and remember source choices. Private sources stay out of shared preferences and shared/global destinations.
- Nothing is written without confirmation (defaults to **No**). Collisions, stale plans, and modified managed outputs block writes; unrelated settings stay untouched.
- Writes have backups and interruption recovery, but are not globally atomic. Follow recovery prompts and keep journals/backups until recovery completes.
- mishmash never launches agents, MCP servers, or scripts, and never changes authentication or trust.

Preferences live in `.mishmash/sources.json` or `$XDG_CONFIG_HOME/mishmash/` (default `~/.config/mishmash/`). Private backups and recovery journals live in `$XDG_STATE_HOME/mishmash/` (default `~/.local/state/mishmash/`).

## Development

`npm test` · `npm run typecheck` · `npm run build`

See [Architecture](ARCHITECTURE.md) and [Requirements](REQUIREMENTS.md) for details.

## License

[MIT](LICENSE) © 2026 Bechir Makhlouf
