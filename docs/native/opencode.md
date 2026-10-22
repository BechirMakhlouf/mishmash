# OpenCode native resources

Verified on 2026-10-22 against the [official skill documentation](https://opencode.ai/docs/skills/), [configuration documentation](https://opencode.ai/docs/config/), [MCP documentation](https://opencode.ai/docs/mcp-servers/), [published schema](https://opencode.ai/config.json), and [upstream revision `c93aaae`](https://github.com/anomalyco/opencode/tree/c93aaae37157d785f76a8e9a9243a6560e286468). Documentation still illustrates the legacy flat MCP map; current source and schema also support the nested server map described below.

## Discovery and placement

| Resource | Project context | User context |
| --- | --- | --- |
| Native skills | `<project>/.opencode/skills/` | `<configHome>/opencode/skills/` |
| Claude-compatible skills | `<project>/.claude/skills/` | `<home>/.claude/skills/` |
| Shared skills | `<project>/.agents/skills/` | `<home>/.agents/skills/` |
| Standard MCP config | `<project>/opencode.json` or `opencode.jsonc` | `<configHome>/opencode/opencode.json` or `opencode.jsonc` |
| Project-directory config | `<project>/.opencode/opencode.json` or `opencode.jsonc` | — |

`configHome` is the explicitly approved XDG configuration root, not a hard-coded `~/.config`. Native singular `skill/` directories are also inspected because OpenCode still supports that compatibility spelling. Portable skill destinations always use plural `skills/`.

Literal configured local `skills` arrays and legacy `skills.paths` directories are discovered; `~/` uses the approved home, and relative configured directories use the selected project workspace, matching the current loader. Remote skill URLs and runtime-interpolated paths are reported without fetching or expanding them. Standalone Markdown files are reported as unsupported whole-directory resources. Native default directories are scanned recursively to the current loader's depth limit of six, skipping hidden/dependency directories. Source directory aliases resolve before identity is assigned; checked locations retain the alias. Each directory-form skill uses the shared frontmatter/tree reader, retaining descriptions, assets, executable modes, safe contained links, and independent same-name provenance.

Project placement is shared; user placement is private user-wide. No native independent private-project destination is advertised. Unsupported private placement and publication of private project resources are blocked rather than inventing a layout. Whole-directory copying and linking are planner features. Native OpenCode filesystem/configuration presence detects OpenCode; `.agents` or Claude-compatible resources alone do not imply installation or activation.

The adapter stays within the explicit project/home/config context. It does not inspect ancestor projects outside that context, ambient `OPENCODE_CONFIG*` variables, system-managed configurations, provider remote defaults, network resources, downloaded skill caches or installed packages. Discovery does not evaluate trust, permissions, resource filters or runtime activation. Additional existing source directories may be supplied explicitly through shared discovery.

Primary source details: [config discovery](https://github.com/anomalyco/opencode/blob/c93aaae37157d785f76a8e9a9243a6560e286468/packages/core/src/config/discovery.ts), [skill source resolution](https://github.com/anomalyco/opencode/blob/c93aaae37157d785f76a8e9a9243a6560e286468/packages/core/src/config/plugin/skill.ts), [recursive skill scan](https://github.com/anomalyco/opencode/blob/c93aaae37157d785f76a8e9a9243a6560e286468/packages/core/src/config/plugin/skill-scan.ts).

## Native MCP formats

Both standard JSON and JSONC are read using the shared safe parser and edited using targeted JSONC changes; comments, unrelated settings and unchecked registrations survive.

The [documented legacy schema](https://github.com/anomalyco/opencode/blob/c93aaae37157d785f76a8e9a9243a6560e286468/packages/core/src/v1/config/mcp.ts) uses `mcp[name]`:

- Local: `type: 'local'`, `command: [executable, ...arguments]`, optional `environment`, `cwd`, `enabled`, `timeout` (milliseconds).
- Remote: `type: 'remote'`, `url`, optional `headers`, `enabled`, `oauth`, `timeout`.

The [current schema](https://github.com/anomalyco/opencode/blob/c93aaae37157d785f76a8e9a9243a6560e286468/packages/schema/src/mcp.ts) uses `mcp.servers[name]`:

- Local/remote command, environment, URL, headers and cwd keep the same core shapes.
- `disabled` replaces `enabled`; `codemode`, `protocol` and per-phase timeout objects are supported.
- OAuth keys use names such as `client_id`, `client_secret`, `callback_port`, `redirect_uri`, and `auth_server_metadata_url`.
- `mcp.timeout` contains configuration-wide timeout defaults, not a server registration.

The current [normalizer](https://github.com/anomalyco/opencode/blob/c93aaae37157d785f76a8e9a9243a6560e286468/packages/core/src/config/normalize.ts) accepts both representations; it also accepts bare-number timeout shorthand in current entries. Discovery preserves the exact selected native object and native key locator instead of normalizing its contents. Same-name legacy/current entries remain separate resource IDs with a blocking ambiguity finding. Enabled-only legacy overrides are reported, not exported as invented standalone definitions. A legacy server literally named `servers` or `timeout` is distinguished by its native `type`.

The current [MCP client](https://github.com/anomalyco/opencode/blob/c93aaae37157d785f76a8e9a9243a6560e286468/packages/core/src/mcp/client.ts) uses stdio and streamable HTTP, not legacy SSE. The adapter therefore advertises only `stdio` and `http`; a URL is not guessed to be an SSE endpoint based on its spelling. No MCP network connection, OAuth flow, credential helper or command execution occurs during discovery or edit preparation. OpenCode runtime `{env:NAME}` and `{file:path}` substitutions remain opaque; referenced files and environment variables are not read.

## Selected edits and portability

For the selected placement, preparation targets the highest-precedence existing standard file: project-root JSON, then JSONC, then project `.opencode` JSON, then JSONC. User JSONC follows user JSON. If none exists, it prepares `opencode.json` at the project root or user config directory. Lower-precedence files remain unchanged; a higher-precedence generated registration may shadow an inherited registration but does not delete or merge its source.

Same-native entries keep their original flat/nested schema and complete object, including unknown fields, timeout/OAuth settings and opaque substitutions. A selected update whose existing destination slot uses the other schema blocks rather than silently migrating or stripping fields. Explicit native approval/authorization-state fields cannot be propagated. Native `enabled`/`disabled` availability controls are preserved as configuration, not reported as trust or authenticated state.

Relative `{file:path}` substitutions are an exception to opaque same-native relocation. The [current substitution implementation](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/config/variable.ts) resolves them from the configuration file's directory, not the project workspace. Moving a selected entry from project config to user config can therefore select a different credential file. Preparation recursively inspects reference syntax only, including nested native fields and arrays, and blocks the move unless both lexical and resolved configuration-parent paths remain identical. An unchanged file or sibling JSON/JSONC config in that same parent retains the opaque reference. Absolute and home-relative references do not acquire a new configuration-directory base. Referenced contents are never read, embedded, or exposed in findings.

Cross-agent conversion supports literal stdio command/arguments/environment/cwd and HTTP URL/headers. Existing current slots/maps receive current entries; otherwise the documented flat map is used. Unknown or unsupported execution semantics, mixed transport fields, SSE, runtime substitutions/helpers, native timeout/enablement/OAuth/filter options block lossy translation. Configuration-wide defaults remain destination-owned. New prepared configurations use mode `0600`; existing modes are retained.

Only selected keys change in a single coherent prepared file edit. Before producing edits or per-entry fingerprints, preparation checks the complete selected native path set for identical, ancestor or descendant slots. For example, a flat legacy server named `servers` cannot coexist in a selected batch with `mcp.servers.foo`; either selection order blocks instead of overwriting a whole map. Equal native values return per-key targets without returning file bytes, preserving formatting and mtimes. Each slot ID is `fingerprintValue([physicalConfigPath, 'mcp', JSON.stringify(nativePath)])`, where `nativePath` is exactly `['mcp', name]` or `['mcp', 'servers', name]`. Before/after fingerprints cover the native entry, not the full document; complete-file snapshots separately support stale-plan checks. The planner owns collision/ownership policy and the transaction engine owns actual writes.

Prepared target paths retain the configured native config alias even when unchanged values produce no file edit. The planner can therefore snapshot linked `.opencode` parents as preconditions. Physical paths still determine slot IDs and canonical discovered source locations; aliases do not create independent ownership slots.

Malformed input and unsupported semantics produce static location-oriented findings, never parser excerpts or credential-bearing values. Real-filesystem tests in `tests/agents/opencode.test.ts` exercise discovery, scope/provenance, both schemas, selected edits, no-op preparation, safe diagnostics and read-only/no-execution behavior.
