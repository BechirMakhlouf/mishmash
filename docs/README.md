# mishmash documentation and harness research

Research baseline: **2026-10-20**. Scope: skills and MCP server definitions, at **project and user scopes**, on **Unix (Linux/macOS) and native Windows**. WSL is treated as a separate Linux environment. Hooks, instructions, custom subagents, and plugin installation are deferred.

The goal is to adopt existing setups into one `.agents`-first source of truth and make the same reviewed resources usable by multiple harnesses at once. mishmash implements the CLI/library described in the [project README](../README.md). These guides retain the upstream research baseline: native shared discovery, precedence, activation, and runtime behavior must not be inferred from successful file generation.

## Harness guides

Each guide includes an OS/scope path matrix, home/environment overrides, skill discovery and precedence, native MCP examples, reader-versus-writer paths, linking/process constraints, migration recommendations, sources, and verification limits.

| Guide | Evidence baseline | Direct canonical skill discovery at default roots | MCP projection boundary |
| --- | --- | --- | --- |
| [Claude Code](harnesses/claude-code.md) | Current first-party docs and 2.1.304 changelog; no verified local runtime | Neither scope; documented per-skill directory links into native `.claude/skills` | Project `.mcp.json`; user/private-project entries in a mixed state store, preferably changed by scoped native writers |
| [Codex](harnesses/codex.md) | Source pinned to `rust-v0.163.0` | Both scopes; Windows shared home uses the profile known-folder resolver independently of `CODEX_HOME` | TOML `[mcp_servers.<id>]`; native MCP add/remove write user config, not project config |
| [GitHub Copilot CLI](harnesses/github-copilot-cli.md) | Current GitHub Docs, release boundaries through 1.0.100, pinned `gh` utility source | Both scopes by default; custom config home disables default shared-user discovery | Project `.mcp.json` or `.github/mcp.json`; user `mcp-config.json`; `gh` is not another agent runtime |
| [pi](harnesses/pi.md) | Stock `@earendil-works/pi-coding-agent`, source pinned to v1.3.0 | Both scopes; project resources have trust requirements | Native user/project `mcp.json`; built-in MCP support, with native exposure/reference semantics |
| [OpenCode](harnesses/opencode.md) | Source/docs for V1.19.3 and V2.1.0, explicitly separated | Both scopes as compatibility locations | V1 `mcp.<id>` versus V2 `mcp.servers.<id>`; version-specific fields and compatibility behavior |
| [Gemini CLI](harnesses/gemini-cli.md) | Source pinned to v0.64.0; moving docs identified separately | Both scopes; user root follows Gemini's home resolver | `mcpServers` inside scoped `settings.json`; whole same-name server replacement, not recursive field merge |

“Direct discovery” means a native reader recognizes the relevant skills directory. It does not imply equal precedence, automatic trust, equivalent frontmatter permissions, Windows link support, or native discovery of `.agents/mcp.json`. The guides qualify custom roots and disabled-resource behavior.

## Closest standards and the source-of-truth decision

Read [Source of truth: skills and MCP servers](source-of-truth.md) for the complete decision, examples, scope rules, migration policy, and adapter boundary.

- **Skills:** adopt the [Agent Skills specification](https://agentskills.io/specification) unchanged. Canonical resources are whole directories at project `.agents/skills/<name>/` and user `<home>/.agents/skills/<name>/`.
- **MCP:** the protocol does not make every client's configuration interchangeable. [Agent Plugins 1.0](https://agent-plugins.org/specification) is the closest published portable packaging baseline; general client configuration [SEP-2633](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2633) remains a proposal. mishmash's canonical MCP input uses a common `mcpServers` envelope and explicit transport names, with application-owned environment/path references rather than falsely claiming universal native schema support.
- **Target output:** a shared location is used directly when possible. Compatible skill payloads can be linked. TOML/JSON/JSONC envelopes, client interpolation, process/cwd semantics, and trust boundaries require native projections or explicit incompatibility findings.

The canonical MCP format is mishmash's application contract, not a published ecosystem standard. A raw file must not be linked into another client merely because both use JSON or a `mcpServers` key.

## Cross-platform findings that affect the adapter design

### Roots are not interchangeable

- Claude explicitly documents Windows `%USERPROFILE%\.claude` and `%USERPROFILE%\.claude.json`, but the latter's relocation under `CLAUDE_CONFIG_DIR` remains unresolved.
- Codex uses Rust's Windows profile-known-folder resolver for its shared user skill root; `CODEX_HOME` relocates native config/legacy skills, not that shared root.
- Copilot's release notes exclude default shared user skills when `COPILOT_HOME` or `--config-dir` is set. Native Copilot installation, `gh skill` installation, and runtime discovery have different destinations.
- pi's native user root follows `PI_CODING_AGENT_DIR` or Node's home resolver, while shared user skills use `HOME || os.homedir()`. On native Windows, an exported `HOME` can therefore disagree with the canonical `USERPROFILE`-based root.
- OpenCode's native Windows config root is XDG-style, normally `<home>\.config\opencode`, not an assumed `%APPDATA%\opencode`.
- `GEMINI_CLI_HOME` replaces Gemini's home root. Gemini appends both `.gemini` and `.agents`; it is not the final `.gemini` directory.

These findings are sourced in the corresponding guides. Resolve actual roots before planning imports or links; do not create two authoritative user trees when a harness's resolver differs from the canonical resolver.

### Reader, writer, and effective view are different contracts

A CLI installer can write a legacy/native skills directory while the runtime also recognizes `.agents/skills`. An MCP add command can write only user config while the runtime reads trusted project layers. Reading a merged effective server map loses source ownership unless provenance is retained. Import and export must therefore know both paths and precedence, not only the envelope.

There is no universal same-name resolution rule: Claude can prefer personal skills, Codex can retain distinct same-name skills, and other clients can replace entries according to directory/scope priority. MCP merge behavior also differs between recursive TOML tables and whole-entry replacement. Preserve scope and origins before resolving conflicts.

### Links are capabilities, not an OS-wide guarantee

Prefer direct discovery over unnecessary links. For bridge locations, share the whole skill directory so relative assets remain available. Verify that the specific native reader follows the chosen link type. Windows symbolic links, directory junctions, privilege settings, Git checkout behavior, UNC paths, and filesystem case behavior are separate concerns. A source-backed loader rule is not a Windows runtime test.

Do not link state-bearing files or whole harness configuration directories. When a native output contains unrelated user settings, update only owned entries and preserve the native format. A shared project `.mcp.json` consumed by Claude and Copilot must be planned as one artifact with both consumers checked, not overwritten independently by two adapters.

## Migration safety contract

- Inventory existing Claude/Copilot/Codex/pi/OpenCode/Gemini resources in the requested scope without starting servers, installing packages, or running secret helpers.
- Adopt full skill resources and non-secret MCP intent. Recognize existing canonical resources and aliases; report conflicting names/content/path semantics.
- Keep discovered sources separate from desired targets: a Claude/Copilot-only repository can retain those consumers and add other harness projections without their executables being installed.
- Preserve native-only fields, unmanaged entries, and each harness's activation requirements. Never convert a project operation into an implicit user-scope write.
- Cut over only verified managed replacements. Keep unresolved originals active, prevent duplicate active managed registrations after successful cutover, and make repeated unchanged synchronization a no-op.
- Keep credentials, OAuth state, trust approvals, sessions, caches, and resolved secrets local. Environment references must remain references through translation.

## Evidence and verification limits

Evidence is distinguished as **documented**, **source-verified**, **CLI-observed**, or **unknown**. Moving docs and release-tag source can disagree; the guides record material discrepancies instead of resolving them by assumption. Native Windows paths supported by source/docs are not labeled runtime-tested.

The preliminary Linux observations were version/help surfaces for Codex, Copilot, GitHub CLI, pi, OpenCode, and Gemini. Claude's version probe encountered an auto-installing local `mise` wrapper and timed out; no installed Claude version or Claude behavior was verified. These observations did not exercise skill activation, live MCP startup, OAuth, trust prompts, or a native Windows environment.

**Historical research checks (2026-10-20):** the original eight research documents passed local file/heading-link, Markdown-table, JSON/TOML/YAML-example, and portable skill-frontmatter checks. This is not a claim that the implementation or later documentation edits were verified by that pass. External references were consulted during research; this was not a batch live-URL availability check. Shell examples and third-party packages were not executed.

The historical documentation checks above are not runtime verification of the implementation. The repository's tests and built-CLI smoke exercise disposable filesystem configurations without installing harnesses, starting MCP servers, resolving secrets, or changing personal configuration. The OS/Node CI matrix exercises mishmash itself; upstream activation, authentication, trust prompts, and native loader behavior retain the per-guide evidence limits.
