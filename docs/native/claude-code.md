# Claude Code native resources

Verified against Anthropic's primary documentation on 2026-10-22:

- [Skills: choose where skills load](https://code.claude.com/docs/en/skills#choose-where-skills-load).
- [MCP installation scopes and native JSON examples](https://code.claude.com/docs/en/mcp#mcp-installation-scopes).
- [MCP transports](https://code.claude.com/docs/en/mcp#installing-mcp-servers) and [environment expansion](https://code.claude.com/docs/en/mcp#environment-variable-expansion-in-mcpjson).
- [HTTP-to-SSE fallback](https://code.claude.com/docs/en/mcp#option-2-add-a-remote-sse-server), [credential-variable suppression](https://code.claude.com/docs/en/mcp#credential-variables-that-read-as-empty), and [reserved server names](https://code.claude.com/docs/en/mcp#configuration-warnings).

## Locations and scope

All roots come from the approved `Context`, not the executing process's profile.

| Resource | Project, shared | Project, private | User, private |
| --- | --- | --- | --- |
| Skills | `<project>/.claude/skills/<name>/SKILL.md` | Unsupported | `<home>/.claude/skills/<name>/SKILL.md` |
| MCP | `<project>/.mcp.json` → `mcpServers[name]` | `<home>/.claude.json` → `projects[realProjectRoot].mcpServers[name]` | `<home>/.claude.json` → `mcpServers[name]` |

Claude calls private-project MCP **local scope**. It is not `.claude/settings.local.json`: that file configures general settings, not local MCP registrations. The adapter uses the real project-root path for the project key, including when the selected project is a directory alias. User and local registrations keep distinct provenance even though their physical file is the same. Other projects' entries remain untouched.

The documented Claude skill locations do not include an automatic `.agents/skills` alias. Shared sources can be selected separately by mishmash discovery; they are not evidence that Claude is present or a reason to claim Claude already loads that directory. The adapter does not invent a private skill directory. Skill destinations are native `.claude/skills` roots; directories, assets and supported symlinks are read through the common skill reader.

Discovery reports every checked native skill/config location and `.claude` presence directory. Detection means agent-specific filesystem evidence, never an executable, active connection, trust or authentication. It does not recursively search nested repositories, parent directories, installed plugins, synced cloud skills, enterprise-managed paths, or launcher-specific extra directories. Process environment overrides such as `CLAUDE_CONFIG_DIR` are not consulted; this API has explicit context roots only.

Existing source roots and configuration paths are resolved to physical edit locations before source identity is created. Checked locations retain the configured aliases. Retargeting a skill-root alias therefore produces a different discovered source identity rather than silently moving remembered authority.

## MCP editing and conversion

Supported transports are stdio (`command`, optional `args`/`env`), HTTP (`type: "http"`, `url`, optional `headers`) and SSE (`type: "sse"`). Native `streamable-http` is recognized as HTTP. A missing type means stdio, not guessed HTTP. WebSocket and SDK-host transports cannot be represented by the common model and produce a safe finding instead of being misclassified.

Claude HTTP (including the `streamable-http` alias) tries HTTP then falls back to SSE on Claude Code 2.1.265 or later. Its `http` projection therefore carries `transport-auto-detection` in `unsupportedFields`: copying it to a fixed-HTTP schema such as Gemini's `httpUrl` is blocked, not silently narrowed. Fixed-HTTP definitions from another agent are also blocked when targeting Claude, which would add fallback. Same-agent native HTTP synchronization remains supported and retains the full original entry.

Selected same-agent entries preserve the entire native object, including native helper commands, timeouts, OAuth options and unknown extension fields. Helpers are never executed. A compatible cross-agent conversion carries only explicitly represented semantics; unknown/native execution fields, unsupported working directories, mixed-transport fields and ambiguous fallback transports block conversion. Gemini's bare `$VAR` and Windows `%VAR%` expansions also block conversion to Claude rather than silently changing their meaning. Values are never expanded, fetched, authenticated or printed in findings.

Cross-agent `${VAR}` and `${VAR:-default}` references are blocked, including between Claude and Gemini. Claude intentionally substitutes an empty string for covered credentials in remote URLs/headers (including `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `AWS_BEARER_TOKEN_BEDROCK`, `HTTPS_PROXY`, and `NPM_TOKEN`) and ignores their defaults; Gemini's resolver instead reads its environment. No variable whitelist can prove equivalent behavior here without resolving secrets, so every Claude braced reference is marked with unsupported `environment-expansion` semantics. Native same-agent references remain unexpanded and unchanged; diagnostics never include expressions or values.

Only selected server keys change. Unchecked registrations, unrelated settings and their comments remain in place through the shared JSONC reader/editor. Malformed/unsafe files and invalid registration shapes produce safe findings without configuration excerpts. Private entries cannot be promoted to a shared project file; project-private entries cannot become user-wide registrations. No native approval/trust record is changed.

Claude's reserved MCP names (`workspace`, `claude-in-chrome`, `computer-use`, `Claude Preview`, and `Claude Browser`) are rejected during discovery and for every Claude target placement with a blocking `RESERVED_MCP_NAME` finding. Claude skips these registrations at load time. Rename the authoritative registration instead of preparing an ineffective file edit; existing unchecked settings are not removed.

Preparation is read-only: it returns encoded file edits, full-file snapshots and per-entry native before/after fingerprints. Slot identity is `fingerprintValue([snapshot.resolvedPath, 'mcp', JSON.stringify(nativePathArray)])`, where the path is `['mcpServers', name]` or `['projects', realProjectRoot, 'mcpServers', name]`. The target's display key remains the native server name. This distinguishes identically named local and user entries in one file. Ownership/collision enforcement belongs to the planner, not the adapter. Existing file modes are preserved; a new config is requested with mode `0600`.

Empty selections return no edits. Equal native entries still return their target fingerprints but no replacement bytes, including when the existing document has comments or no final newline. Neither discovery nor preparation creates directories, edits settings, runs servers/scripts/helpers or grants runtime trust.
