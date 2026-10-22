# Pi native resources

Verified against the current upstream documentation and source on 2026-10-22, including [Pi revision `7c22a93`](https://github.com/earendil-works/pi/tree/7c22a93d0ed02092142fa63823e63d76aa4e2406). This is Pi's built-in support, not an extension installer or a third-party MCP configuration convention.

## Discovery and placement

| Resource | Project context | User context |
| --- | --- | --- |
| Native skills | `<project>/.pi/skills/` | `<home>/.pi/agent/skills/` |
| Shared skills | `<project>/.agents/skills/` | `<home>/.agents/skills/` |
| MCP configuration | `<project>/.pi/mcp.json` | `<home>/.pi/agent/mcp.json` |
| Configured skill paths | `<project>/.pi/settings.json` → `skills` | `<home>/.pi/agent/settings.json` → `skills` |

Pi's default agent directory is `~/.pi/agent`, not an XDG configuration directory. mishmash uses the explicit project/home roots in its approved context and does not read ambient `PI_CODING_AGENT_DIR`, launchers, package caches, SDK registrations, or runtime CLI overrides. A different existing source directory can be selected explicitly through shared source discovery. Native Pi directory/configuration presence detects Pi; `.agents/skills` by itself does not.

Project outputs are shared project resources. User outputs are private user resources. Pi documents no independent private-project skill/MCP destination, so that placement is blocked; private project sources cannot be published through a project or user Pi destination. Skill placement uses the native skill directory above and supports whole-directory copying or links through the planner.

Directory-form skills are scanned recursively, retaining separate same-name source instances instead of applying Pi's runtime precedence. The common skill reader supplies frontmatter descriptions and whole-tree snapshots, including assets and modes; unsafe nested links and malformed metadata produce safe findings. Existing root links resolve to their actual source path before source identity is assigned. Checked locations still disclose the native alias. Missing descriptions are rejected because Pi does not load declared skills without descriptions.

Literal local directory entries in `settings.json`'s `skills` array are also inspected. Project paths resolve from `.pi`; user paths resolve from `.pi/agent`; leading `~/` resolves using the approved home directory. Filter/glob entries are reported as requiring native resolution, never treated as literal directory names. Standalone Markdown skills are reported as unsupported whole-directory resources. Discovery inventories portable directory skills, not a claim that Pi currently loads or trusts them: it does not run Pi's ignore-filter/package resolver, follow package installation, evaluate extensions or claim activation. Native ancestor discovery outside the selected project context is not followed implicitly.

Primary references: [configuration paths](https://github.com/earendil-works/pi/blob/7c22a93d0ed02092142fa63823e63d76aa4e2406/packages/coding-agent/docs/configuration.md), [skills](https://github.com/earendil-works/pi/blob/7c22a93d0ed02092142fa63823e63d76aa4e2406/packages/coding-agent/docs/skills.md), [resource settings](https://github.com/earendil-works/pi/blob/7c22a93d0ed02092142fa63823e63d76aa4e2406/packages/coding-agent/docs/settings.md#resources), [native skill loader](https://github.com/earendil-works/pi/blob/7c22a93d0ed02092142fa63823e63d76aa4e2406/packages/coding-agent/src/core/skills.ts), [shared skill root resolution](https://github.com/earendil-works/pi/blob/7c22a93d0ed02092142fa63823e63d76aa4e2406/packages/coding-agent/src/core/package-manager.ts).

## Built-in MCP support

Current Pi **does support native MCP**. Its [MCP documentation](https://github.com/earendil-works/pi/blob/7c22a93d0ed02092142fa63823e63d76aa4e2406/packages/coding-agent/docs/mcp.md) and [native configuration reader](https://github.com/earendil-works/pi/blob/7c22a93d0ed02092142fa63823e63d76aa4e2406/packages/coding-agent/src/extensions/mcp/config.ts) verify the `mcpServers` object in strict-JSON `mcp.json` files:

- Stdio: `command` is one executable; `args`, `env`, and `cwd` are optional.
- Streamable HTTP: `url`, optional `headers`, OAuth configuration, and user-only provider authentication bindings.
- An optional `type` accepts `stdio`, `http`, or `streamable-http` as appropriate. Legacy `sse` is not supported.
- Native options include `enabled`, `timeout` (seconds), `description`, `exposure`, and `toolExposure`. Server names use letters, digits, `_`, and `-`; names differing only in hyphens/underscores share a tool namespace.
- `env`/`headers` can use `${NAME}` interpolation or whole-value `!command` helpers; these remain opaque and are never evaluated. Pi also expands leading `~/` in stdio command/arguments/cwd at runtime.

User and project definitions retain their own source, scope, snapshot and identity even when names match. A project entry containing only inherited-state overrides is reported, not fabricated into a standalone export of the user's credentials. Provider authentication bindings are rejected in project config, as Pi itself requires. Native MCP support may be disabled or replaced by an installed extension; filesystem discovery does not assert that it is enabled, connected, authenticated, or trusted.

## Selected edits and portability

`prepareMcpEdit` is read-only. It returns one encoded file edit for selected keys, preserving all unchecked servers and unrelated native settings. Existing file modes are retained; newly prepared secret-bearing configurations use mode `0600`. If selected native entry values are unchanged, it returns targets but no file edit, so formatting and mtime remain unchanged.

Project preparation also reads the user `mcp.json` before producing output. The [native loader](https://github.com/earendil-works/pi/blob/7c22a93d0ed02092142fa63823e63d76aa4e2406/packages/coding-agent/src/extensions/mcp/config.ts) loads user definitions before project definitions and rejects distinct names that share a namespace. Its [namespace function](https://github.com/earendil-works/pi/blob/7c22a93d0ed02092142fa63823e63d76aa4e2406/packages/coding-agent/src/core/mcp-servers.ts) replaces every `-` with `_` without case-folding. A selected project `foo-bar` therefore blocks when user `foo_bar` exists, including disabled user registrations. Exact-name project overrides remain supported, and case-sensitive distinct names remain distinct. An unreadable or malformed inherited user configuration blocks project preparation because its namespace cannot be established safely. No user registration, setting, byte or mode is changed by this check.

A same-Pi selected entry preserves the complete native object, including unknown fields and opaque credential references. Explicit authorization/approval-state fields are blocked rather than propagated. Cross-agent conversions support literal stdio command/arguments/environment/cwd and streamable-HTTP URL/headers. Unsupported native semantics, mixed transport fields, SSE, runtime expansion/helper semantics, exposure, enabled-state, timeout, OAuth/provider-specific settings and unknown fields block a lossy translation rather than being dropped. This intentionally does not implement the upstream migration guide's manual interpolation rewrites. Configuration-wide defaults remain destination-owned, not selected server resources.

Each target uses the native key path `['mcpServers', name]`. Its slot ID is `fingerprintValue([physicalConfigPath, 'mcp', JSON.stringify(nativePath)])`; before/after fingerprints cover that exact native server entry. The complete file snapshot is separately returned for stale-plan checks. Ownership/collision policy and actual writes belong to the planner/transaction engine. All diagnostics are static and location-oriented: no configuration excerpts, arguments, environment values, credential headers, authentication flows, subprocesses, MCP connections, or source writes occur here.

Behavioral coverage lives in `tests/agents/pi.test.ts` and uses disposable real project/home/XDG directories.
