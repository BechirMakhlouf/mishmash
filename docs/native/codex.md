# Codex native resources

Primary references, consulted 2026-10-22:

- [OpenAI: agent skills](https://developers.openai.com/codex/skills) (currently redirects to [Build skills](https://learn.chatgpt.com/docs/build-skills)).
- [OpenAI: Codex MCP](https://developers.openai.com/codex/mcp) (currently redirects to [Model Context Protocol](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)).
- [OpenAI: configuration reference](https://developers.openai.com/codex/config-reference).

## Locations and scope

| Resource | Project | User |
| --- | --- | --- |
| Skills | `<project>/.agents/skills/<skill>/SKILL.md` | `<home>/.agents/skills/<skill>/SKILL.md` |
| MCP | `<project>/.codex/config.toml` | `<home>/.codex/config.toml` |

These are both discovery roots and supported destinations. Codex follows skill-directory links; mishmash reads the complete skill tree through the shared safe skill reader and retains the actual resolved skill path alongside its native source provenance. Merely finding a shared `.agents/skills` root does not mark Codex detected: its own `.codex` directory/configuration is presence evidence, not proof of an installation, trust, authentication or an active connection.

Existing source roots/configurations are resolved before source identity is formed; checked locations retain their configured aliases. Common `.agents` roots use shared ownership with Codex in their agent associations, allowing cross-adapter discovery to deduplicate the same source. Retargeting a root link changes source identity instead of silently relocating remembered authority.

Native Codex also searches `.agents/skills` between its working directory and repository root, supports `/etc/codex/skills`, bundled/system skills, plugins and `CODEX_HOME`. This adapter deliberately reads only the supplied `Context.projectRoot` and `Context.homeDir` default locations. It does not walk outside that approved project, read administrator/bundled/plugin roots, infer a different native home from process environment, or read authentication stores. Additional approved skill sources can be supplied through the shared discovery layer. XDG configuration paths do not relocate Codex's native defaults.

There is no documented private-project skill/MCP destination. `private-project` is therefore unsupported, not silently mapped to a shared project file or a global user registration. Project configurations are logically shared; user configurations are personal. Native project MCP loading requires Codex trust, which mishmash neither grants nor checks.

## MCP representation and safe edits

Codex registers servers under `[mcp_servers.<name>]`, not `mcpServers`, `servers`, or a mishmash compatibility schema. Native transports are **stdio** (`command`, optional `args`, `env`, `cwd`) and **Streamable HTTP** (`url`, optional `http_headers`). Legacy SSE cannot be represented and blocks conversion.

Discovery retains the exact selected native object and records other fields as non-portable semantics. This includes environment forwarding, environment-derived bearer/HTTP headers, OAuth client configuration, credential/header helpers, execution environments, timeouts, enable/required flags and tool policies. These are preserved for same-native registrations, except explicit tool approval policy (`default_tools_approval_mode` or per-tool `approval_mode`), which blocks synchronization rather than authorizing a destination. No helper, command, login, MCP server or skill script is ever executed. Credentials stay in the native entry/approved file intent, never in findings or ownership receipts.

Cross-agent conversion accepts only common literal transport fields and no unsupported execution semantics. It does not translate tool restrictions, dynamic secret substitution, auth state, remote execution or timeout policy by dropping fields. Authentication configuration alone is not authenticated session state; copying a supported registration does not log in or grant trust.

The TOML editor parses the original TOML 1.0 syntax, locates only selected registrations by syntax tree paths, and replaces their expressions/headers. It handles quoted/dotted keys, regular/nested tables and inline tables without parsing and stringifying the whole configuration. Unchecked registrations, unrelated settings, multiline strings, dates, array-of-table syntax, comments and whitespace outside selected expressions remain verbatim. Selected syntax may be normalized; comments outside its replaced expressions remain. Invalid documents, unsafe config paths (including root symlinks), invalid registration values and unsupported conversions return safe blocking findings without parser excerpts or configuration bodies.

Preparation is read-only. It returns at most one coherent file intent with the original full-file snapshot and existing mode (new files use `0600`). Each selected registration returns exact before/after entry fingerprints and a slot ID over the resolved physical file path plus `JSON.stringify(['mcp_servers', name])`. Unchanged entries still return ownership evidence but no file edit. The planner owns collisions and drift checks; the transaction engine, not the adapter, owns approved writes and backups.
