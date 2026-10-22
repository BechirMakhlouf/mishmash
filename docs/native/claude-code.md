# Claude Code native resources

Verified against Anthropic's primary documentation on 2026-10-22:

- [Skills: choose where skills load](https://code.claude.com/docs/en/skills#choose-where-skills-load).
- [MCP installation scopes and native JSON examples](https://code.claude.com/docs/en/mcp#mcp-installation-scopes).
- [MCP transports](https://code.claude.com/docs/en/mcp#installing-mcp-servers) and [environment expansion](https://code.claude.com/docs/en/mcp#environment-variable-expansion-in-mcpjson).

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

Selected same-agent entries preserve the entire native object, including native helper commands, timeouts, OAuth options and unknown extension fields. Helpers are never executed. A compatible cross-agent conversion carries only explicitly represented semantics; unknown/native execution fields, unsupported working directories, mixed-transport fields and ambiguous fallback transports block conversion. Gemini's bare `$VAR` and Windows `%VAR%` expansions also block conversion to Claude rather than silently changing their meaning. Values are never expanded, fetched, authenticated or printed in findings.

Cross-agent `${VAR}` references are accepted only for the verified Claude/Gemini pair; other source formats with unverified interpolation semantics block rather than turn a literal into an expansion.

Only selected server keys change. Unchecked registrations, unrelated settings and their comments remain in place through the shared JSONC reader/editor. Malformed/unsafe files and invalid registration shapes produce safe findings without configuration excerpts. Private entries cannot be promoted to a shared project file; project-private entries cannot become user-wide registrations. No native approval/trust record is changed.

Preparation is read-only: it returns encoded file edits, full-file snapshots and per-entry native before/after fingerprints. Slot identity is `fingerprintValue([snapshot.resolvedPath, 'mcp', JSON.stringify(nativePathArray)])`, where the path is `['mcpServers', name]` or `['projects', realProjectRoot, 'mcpServers', name]`. The target's display key remains the native server name. This distinguishes identically named local and user entries in one file. Ownership/collision enforcement belongs to the planner, not the adapter. Existing file modes are preserved; a new config is requested with mode `0600`.

Empty selections return no edits. Equal native entries still return their target fingerprints but no replacement bytes, including when the existing document has comments or no final newline. Neither discovery nor preparation creates directories, edits settings, runs servers/scripts/helpers or grants runtime trust.
