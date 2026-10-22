# GitHub Copilot CLI native resources

Primary references, consulted 2026-10-22:

- [GitHub: adding CLI agent skills](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills).
- [GitHub: adding CLI MCP servers](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers).
- [GitHub: CLI configuration directory](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference).
- [GitHub: CLI native transport types](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference#transport-types), including the `streamable-http` alias.
- [GitHub: MCP JSON fields](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/configure-mcp-servers#writing-a-json-configuration-for-mcp-servers), linked by the CLI MCP documentation; cloud-agent trust behavior is not used as CLI behavior.

## Locations and scope

| Resource | Discovered project roots | Discovered user roots | Chosen destination |
| --- | --- | --- | --- |
| Skills | `.github/skills`, `.claude/skills`, `.agents/skills` beneath the approved project | `<home>/.copilot/skills`, `<home>/.agents/skills` | `.github/skills` for project; `<home>/.copilot/skills` for user |
| MCP | `<project>/.mcp.json`, `<project>/.github/mcp.json` | `<home>/.copilot/mcp-config.json` | `.github/mcp.json` for project; `<home>/.copilot/mcp-config.json` for user |

Skill discovery reuses the shared metadata/tree reader and retains each exact source path, resolved skill path, description, logical scope and visibility. Compatibility skill roots alone do not mark Copilot detected. Its own `.copilot` directory or native `.github/skills`/`.github/mcp.json` locations provide presence evidence, never executable, trust, authentication or connection claims.

Source roots/configurations are resolved before source identity is formed; checked locations retain configured aliases. Common `.agents` directories use shared ownership plus the detecting agent association. `.claude/skills` retains its `claude-code` native owner and both Claude/Copilot associations; `.github/skills` and personal `.copilot/skills` retain Copilot ownership. Exact path/scope/visibility identity allows the inventory to merge provenance without manufacturing competing sources.

Native Copilot can search project MCP files from its working directory up to its Git root. `.mcp.json` takes precedence over `.github/mcp.json` in the same directory, nearer files take precedence over parents, and project definitions override user definitions. mishmash retains all definitions separately, including lower-precedence sources, instead of choosing an authority from native precedence. The adapter stays bounded to `Context.projectRoot`; it does not walk into unapproved ancestors. `COPILOT_HOME`, alternate CLI configuration directories, installed plugins, custom extra skill roots, credential stores and bundled GitHub MCP are outside these default-location adapters. It never reads actual process profile roots or starts Copilot. XDG roots do not relocate these native defaults.

GitHub describes `.mcp.json` as local/per-checkout but does not guarantee it is private or untracked. It is conservatively a shared project source, not an advertised private destination. There is no documented private-project skill/MCP destination, so that placement blocks. A source explicitly classified project-private cannot be published to project/user destinations. Project MCP loading is subject to Copilot folder trust; mishmash never grants that trust or changes permissions/settings files. A pre-existing `.mcp.json` can shadow a newly written `.github/mcp.json`; discovery exposes both registrations rather than promising activation.

## MCP formats and portability

User config uses a top-level `mcpServers` object. Current project configs accept either that wrapper or a bare server-name map. Existing project format is retained on selected edits; newly created files use `mcpServers`. Native `type` values `local` and `stdio` both mean stdio, while `http` and its documented `streamable-http` alias normalize to common HTTP transport; `sse` means legacy SSE. The complete original native entry, including `streamable-http` spelling, is retained for same-agent copies; unchecked aliases remain verbatim. Omitting type uses the local form, as allowed by native project examples. VS Code's `.vscode/mcp.json`/`servers` schema is not an alias and is not discovered.

Common portable fields are `command`, `args`, `env`, `url` and `headers`. Full same-native entries retain native fields such as `tools`, timeout values and secret placeholders. Tool availability lists are not permission approvals. Cross-agent conversion blocks non-portable tool restrictions, timeouts, dynamic substitutions and unknown execution-affecting fields rather than dropping them. The default all-tools list `['*']` is equivalent to native default availability. A foreign `cwd` cannot be represented through the documented common CLI fields and blocks conversion. Literal dollar-variable expressions from another client also block: Copilot's interpolation would change their meaning. Secrets are not resolved; no server, script, helper, registry command or authentication flow is run.

JSON/JSONC parsing uses the shared safe document reader and selected-path editor. It preserves unchecked entries, comments and unrelated wrapped-format settings. Invalid documents/maps/registration values and unsafe config paths (including root symlinks) produce blocking findings with no native values or parser excerpts. Diagnostic codes and paths do not contain commands, arguments, environment/header values or URLs.

Preparation is read-only and coalesces selected changes into one file intent, preserving the existing file mode; new files use `0600`. Each selected registration has exact before/after native-entry fingerprints and a slot ID over the physical resolved path and actual JSON locator (`['mcpServers', name]` or `[name]` for bare project documents). Unchanged entries return ownership evidence without bytes or mtime changes. The planner enforces ownership/collisions/drift, and the transaction engine performs only explicitly approved writes and backups.
