# Gemini CLI native resources

Verified on 2026-10-22 against these primary sources:

- [Agent Skills: discovery tiers and aliases](https://geminicli.com/docs/cli/skills/#discovery-tiers).
- [Configuration: settings files](https://geminicli.com/docs/reference/configuration/#settings-files).
- [MCP configuration properties](https://geminicli.com/docs/tools/mcp-server/#configuration-properties).
- Current upstream [`MCPServerConfig`](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/config/config.ts) and [transport selection](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/tools/mcp-client.ts).
- Gemini's [environment resolver](https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/utils/envVarResolver.ts), contrasted with Claude's [credential-variable suppression](https://code.claude.com/docs/en/mcp#credential-variables-that-read-as-empty) and [HTTP-to-SSE fallback](https://code.claude.com/docs/en/mcp#option-2-add-a-remote-sse-server).

## Locations and scope

Roots are taken only from the approved `Context`.

| Resource | Project, shared | User, private |
| --- | --- | --- |
| Native skills | `<project>/.gemini/skills/<name>/SKILL.md` | `<home>/.gemini/skills/<name>/SKILL.md` |
| Documented shared skill alias | `<project>/.agents/skills/<name>/SKILL.md` | `<home>/.agents/skills/<name>/SKILL.md` |
| MCP | `<project>/.gemini/settings.json` → `mcpServers[name]` | `<home>/.gemini/settings.json` → `mcpServers[name]` |

There is no documented private-project skill or MCP placement. Both are rejected rather than inventing `.local` files, a hidden skill tree or user-wide substitutes. Project-private resources from another agent cannot be published into either advertised Gemini MCP destination. User-private resources cannot be published into a shared project configuration.

Native skill sources identify Gemini; shared aliases identify the shared directory and associate Gemini as a consumer. Native and shared same-name skills retain both provenances: Gemini's runtime alias precedence does not choose mishmash's authority. Shared aliases alone do not mark Gemini detected. Detection requires `.gemini` directory/config evidence and says nothing about executable installation, connection, trust or authentication. All checked roots, including absent ones, are returned.

Existing source roots and configuration paths are resolved physically before assigning source identity; checked locations retain the configured aliases. Retargeting a skill-root alias changes the discovered source identity, so it cannot silently relocate remembered authority.

Discovery is bounded to the approved project/home roots. System-managed settings, built-in/extension skills, temporary session flags, environment overrides and arbitrary ancestor/nested directories are outside this adapter's discovery and placement boundary. It never reads or resolves `.env` files or credential stores.

## Transport formats and compatibility

The public MCP guide documents `command` for stdio, `httpUrl` for Streamable HTTP and `url` for SSE. Current upstream source additionally supports explicit `url` plus `type: "http"`/`"sse"`, deprecates `httpUrl`, and auto-detects HTTP with SSE fallback when `url` has no type. That guide/source discrepancy is not resolved by guessing a transport:

- `httpUrl` and explicit `url`/`type` entries have known transport semantics.
- Untyped `url` entries remain discoverable and are preserved for same-agent synchronization, with `transport-auto-detection` listed as an unsupported conversion semantic. The common model's `http` projection is not a promise of fixed transport, and cross-agent conversion is blocked.
- Compatible fixed-HTTP output uses the still-supported and documented `httpUrl`; SSE output uses `url` with explicit `type: "sse"` to avoid changing transport under current upstream behavior. Claude HTTP and its `streamable-http` alias are not fixed HTTP: Claude 2.1.265+ falls back to SSE, so their cross-agent conversion is blocked. The adapter does not guess that Gemini's auto-detection has exactly equivalent fallback behavior. Native Claude HTTP entries remain preserved by their own adapter.
- Conflicting endpoint fields, native `tcp`/unknown execution fields, trust, timeouts, tool filters, OAuth/provider configuration and other unrepresented semantics are not silently dropped during conversion. Unsupported transports produce safe findings.

Stdio's common fields are `command`, optional `args`, string-valued `env` and `cwd`. Remote transports support a string endpoint and string-valued `headers`. A complete selected Gemini native object is preserved on compatible same-agent edits, including provider/helper-related settings; no executable, helper, credential or authentication flow is invoked. Native `trust: true` bypasses tool confirmations, so any changed selected entry carrying it is blocked with `MCP_TRUST_ESCALATION` rather than granting trust or silently dropping the field. An existing byte-equivalent native trusted entry remains a no-op. Unrelated destination trust flags remain untouched. Cross-agent conversions neither add trust flags nor resolve environment expressions. Native expressions remain literal configuration values.

All cross-agent inputs containing `${VAR}`, `${VAR:-default}`, bare `$VAR` or `%VAR%` forms block rather than change interpolation or credential behavior. In particular, Claude substitutes empty strings for covered credentials in remote URL/header references, even with a default, while Gemini's resolver reads environment values. The adapter conservatively rejects every Claude braced variable rather than expose a credential or attempt environment/secret resolution. Same-agent Gemini references remain literal, unchanged configuration data. Findings contain no expressions, credential values, URLs or configuration bodies.

Preparation edits only selected `mcpServers` keys using the shared JSONC reader/editor, preserving unchecked registrations, unrelated settings and their comments. It blocks malformed/unsafe documents and emits findings without raw configuration or credential values. Existing global MCP allow/exclude/trust settings are not rewritten, and discovery does not claim a listed registration is active.

Returned edits contain a whole-file precondition and per-key fingerprints of the exact native entry. The slot protocol is `fingerprintValue([snapshot.resolvedPath, 'mcp', JSON.stringify(['mcpServers', name])])`; literal dots or slashes in a server key are not interpreted as path components. Parent-directory aliases resolve to a physical slot, while unsafe config-file links are blocked by the shared reader. New configs use mode `0600`; existing modes are retained.

Discovery and preparation do not mutate anything. Empty selections return no edits; identical native values return target fingerprints with no file replacement, preserving even an absent final newline. The planner owns collisions, privacy review and ownership enforcement; only the separately confirmed filesystem transaction can write returned bytes.
