# OpenCode: skills and MCP servers

[Documentation index](../README.md) · [Canonical source of truth](../source-of-truth.md)

## Product and evidence baseline

OpenCode is the extensible coding agent maintained at [anomalyco/opencode](https://github.com/anomalyco/opencode), not the unrelated older projects with the same name. Research date: **2026-10-20**.

Two release baselines matter:

- **V1.19.3:** CLI-observed Linux executable version and help only; no skill discovery or MCP session was exercised. Source checked at [`v1.19.3`](https://github.com/anomalyco/opencode/tree/v1.19.3), commit `e3c4eb242585dcd77be1a867391b7c25fd47ce52`.
- **V2.1.0:** current release listed by the [changelog](https://opencode.ai/changelog#v2-1-0), released October 20. Source checked at [`v2.1.0`](https://github.com/anomalyco/opencode/tree/v2.1.0), commit `60c68d145a14127ce633e26aa5fdfb882a7baa6d`. Not installed or executed for this research.

The [V1 documentation](https://opencode.ai/docs/config) and [V2 documentation](https://opencode.ai/v2/docs/config) are live pages, not immutable release snapshots. Source-specific exceptions below take precedence over prose descriptions. **Native Windows, macOS, symlink discovery, package execution, MCP connectivity and OAuth were not runtime-tested.** Hooks and plugin APIs are outside this document's scope.

The native MCP formats are different: V1 uses `mcp.<id>` / `enabled`; V2 uses `mcp.servers.<id>` / `disabled`. They are not interchangeable schemas, but neither is it correct to say every cross-major config is rejected: these particular releases contain compatibility readers. Export the selected release's native form rather than relying on those readers.

## Paths, scope and relocation

Define `H = os.homedir()` and `C = XDG_CONFIG_HOME || H/.config`. These are resolver results, not shell expansion rules. V1.19.3 uses [`xdg-basedir@5.1.0`](https://github.com/sindresorhus/xdg-basedir/blob/v5.1.0/index.js), pinned in its [lockfile](https://github.com/anomalyco/opencode/blob/v1.19.3/bun.lock), and appends `opencode`. V2.1.0 implements the same calculation in [`global-roots.ts`](https://github.com/anomalyco/opencode/blob/v2.1.0/packages/util/src/global-roots.ts). Both use XDG paths **on native Windows too**; neither substitutes `%APPDATA%` for the config root.

The [`os.homedir()` API contract](https://nodejs.org/api/os.html#oshomedir) uses `HOME` on POSIX, otherwise the account home; on Windows it uses `USERPROFILE` when defined, otherwise the current user's profile directory. This documents the API the source calls; it is not a Windows runtime test of OpenCode's bundled runtime.

| Resource | Project, Unix notation | Project, native Windows notation | Unix user scope | Native Windows user scope | Format / version |
| --- | --- | --- | --- | --- | --- |
| Shared skills, directly read | `.agents/skills/<id>/SKILL.md` | `.agents\skills\<id>\SKILL.md` | `H/.agents/skills/<id>/SKILL.md` | `H\.agents\skills\<id>\SKILL.md` | Agent Skills Markdown; both versions |
| Native skills | `.opencode/skills/<id>/SKILL.md` | `.opencode\skills\<id>\SKILL.md` | `C/opencode/skills/<id>/SKILL.md` | `C\opencode\skills\<id>\SKILL.md` | Both; singular `skill/` also source-supported |
| Claude compatibility skills | `.claude/skills/<id>/SKILL.md` | `.claude\skills\<id>\SKILL.md` | `H/.claude/skills/<id>/SKILL.md` | `H\.claude\skills\<id>\SKILL.md` | Both; disable flags apply |
| Native MCP/config | `opencode.json` or `opencode.jsonc`; also `.opencode/opencode.json[c]` | `opencode.json[c]`; also `.opencode\opencode.json[c]` | `C/opencode/opencode.json[c]` | `C\opencode\opencode.json[c]` | JSON/JSONC; different V1/V2 MCP envelopes |
| Additional native skill sources | Configured paths; resolution below | Configured paths; resolution below | Configured paths | Configured paths | V1 `skills.paths` / `skills.urls`; V2 `skills` array |

`[c]` is notation for either filename, not a literal filename. With defaults, Linux/macOS user config is `~/.config/opencode`; a typical Windows profile produces `C:\Users\Alice\.config\opencode`, **not** `C:\Users\Alice\AppData\Roaming\opencode`. WSL runs the Linux resolver and has a separate home/config/environment from native Windows.

Overrides and cautions:

- `XDG_CONFIG_HOME` relocates the native config root; shared `H/.agents/skills` and compatibility `H/.claude/skills` remain home-based. Use an absolute XDG path in adapter output; do not invent an APPDATA fallback.
- V1 `OPENCODE_CONFIG_DIR` adds another config/resource directory after normal directories; it does **not** eliminate normal `Global.Path.config` reads or redirect the V1 MCP CLI's global writer. See [`paths.ts`](https://github.com/anomalyco/opencode/blob/v1.19.3/packages/opencode/src/config/paths.ts), [`config.ts`](https://github.com/anomalyco/opencode/blob/v1.19.3/packages/opencode/src/config/config.ts), and the writer below.
- V2 `OPENCODE_CONFIG_DIR` replaces the service's native global config directory; the CLI/server forwards this explicitly. See [`global.ts`](https://github.com/anomalyco/opencode/blob/v2.1.0/packages/util/src/global.ts) and [`server-process.ts`](https://github.com/anomalyco/opencode/blob/v2.1.0/packages/cli/src/server-process.ts). It does not relocate the separate home-based aliases.
- Both accept `OPENCODE_CONFIG` for an explicit config file and `OPENCODE_CONFIG_CONTENT` for inline config. These add layers; do not assume the MCP add command writes back to either one.
- `OPENCODE_TEST_HOME` is present in source as a home getter override, but XDG roots were already calculated using `os.homedir()`. It is a test facility, not a safe all-paths relocation mechanism.
- Administrative config sits outside user ownership: `/etc/opencode` on Linux, `/Library/Application Support/opencode` on macOS, and `%ProgramData%\opencode` on Windows. V2's resolver falls back to `C:\ProgramData` if `ProgramData` is absent. macOS managed preferences can override file settings. Do not adopt administrative configuration into a user's canonical store.

Sources: [V1 global resolver](https://github.com/anomalyco/opencode/blob/v1.19.3/packages/core/src/global.ts), [V1 config paths](https://github.com/anomalyco/opencode/blob/v1.19.3/packages/opencode/src/config/paths.ts), [V2 discovery](https://github.com/anomalyco/opencode/blob/v2.1.0/packages/core/src/config/discovery.ts), [V2 config docs](https://opencode.ai/v2/docs/config).

## Skills

### Portable directory form

Use the same complete directory in project `.agents/skills` or user `H/.agents/skills`:

```text
.agents/skills/release-review/
├── SKILL.md
├── references/
│   └── release-policy.md
└── scripts/
    └── inspect-release.mjs
```

`SKILL.md`:

```markdown
---
name: release-review
description: Review a proposed release against the repository release policy
license: MIT
metadata:
  audience: maintainers
---

Read references/release-policy.md, then inspect the proposed release changes.
Do not publish a release. Ask before running scripts/inspect-release.mjs.
```

This is the [Agent Skills directory format](https://agentskills.io/specification.md): keep `name` and directory basename aligned, use lowercase kebab-case, and retain scripts/references with the skill. The example's supporting filenames describe files that must accompany a real skill; discovery of `SKILL.md` does not automatically execute them or load their contents.

### V1.19.3 behavior

[V1 skill docs](https://opencode.ai/docs/skills) describe project walking from the current directory to the Git worktree, including native `.opencode`, `.claude` and `.agents` directories along the way, plus global sources. The [release implementation](https://github.com/anomalyco/opencode/blob/v1.19.3/packages/opencode/src/skill/index.ts) scans nested `**/SKILL.md`, including native singular `skill/`, rather than only one directory level. It also accepts `skills.paths` and `skills.urls`; local relative paths resolve against the active working directory, **not the containing config file**. `~/` expands using the global home getter.

The live docs require `name`, `description`, the name regex/directory match and a 1–1024-character description. At the checked tag, the loader's actual frontmatter guard requires a string `name`, permits an omitted description, and does not enforce those other constraints in this load path. Keep the stricter standard for portable output; do not mistake lenient runtime acceptance for portable validity.

**Collision key is frontmatter `name`.** Duplicate names log a warning and overwrite the same map entry. Loading is concurrent (`Effect.forEach(..., { concurrency: "unbounded" })`), so the tag does not provide a reliable cross-source winner for duplicate disk names. In particular, do not impose a generic project-over-user rule. Reject or explicitly resolve duplicate names before synchronization. The built-in skill is registered before disk loading, allowing a disk definition to replace it.

`OPENCODE_DISABLE_EXTERNAL_SKILLS` suppresses both `.claude` and `.agents` discovery. `OPENCODE_DISABLE_CLAUDE_CODE` or `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS` suppresses `.claude` skills without suppressing `.agents`. These flags are [source-verified](https://github.com/anomalyco/opencode/blob/v1.19.3/packages/opencode/src/effect/runtime-flags.ts). Thus shared discovery is native but conditional.

The V1 loader requests `symlink: true` in its glob scans. That is evidence of intended link following, not proof that every directory symlink, Windows junction, broken link or cycle behaves identically. Prefer direct `.agents` discovery over adding a second native alias.

### V2.1.0 behavior

[V2 skill docs](https://opencode.ai/v2/docs/skills) add root-level Markdown skills (`skills/review.md`) alongside directory skills. **The path determines the case-sensitive ID**; `name` is merely a display label. For `skills/teams/release-review/SKILL.md`, the ID is `release-review`. This differs materially from V1 frontmatter-name identity.

V2 permits optional frontmatter at runtime; a description is needed for model advertisement. It accepts standard `license` / `compatibility` fields without interpreting them. For interoperability, still emit the standard directory form with required name and description.

Documented normal source priority, low to high, is built-ins → global/ancestor `.claude` → global/ancestor `.agents` → native global skills → native project `.opencode` skills → explicit configured `skills` entries. Within a compatibility family, far ancestors precede near ones; `.agents` as a family comes after `.claude`. Later sources replace earlier definitions with the same ID. This means a **native global** skill can override a **shared project** skill: project scope alone is not a sufficient precedence rule. Administrative sources must also be accounted for rather than flattened into user configuration.

The tag's [config discovery](https://github.com/anomalyco/opencode/blob/v2.1.0/packages/core/src/config/discovery.ts) walks to the filesystem root without a Git-worktree stop, for direct configs and compatibility roots. The live skills page says “up to the project root”; source provides the more precise V2 boundary. Do not assume V1's Git boundary still applies.

The tag's [skill scanner](https://github.com/anomalyco/opencode/blob/v2.1.0/packages/core/src/config/plugin/skill-scan.ts) is bounded: at most six directory descents from a source, ignores hidden/ignored directory entries, follows symlink entries by `stat`, sorts returned paths, and stops descending once a directory's `SKILL.md` is found. Consequently “any depth” on the live page is not literally unbounded at this release. [Registration](https://github.com/anomalyco/opencode/blob/v2.1.0/packages/core/src/config/plugin/skill.ts) is sequential and later IDs replace earlier ones. [Compatibility registration](https://github.com/anomalyco/opencode/blob/v2.1.0/packages/core/src/config/plugin/compatibility.ts) resolves alias roots with `realPath`.

Additional V2 sources use `"skills": ["./team-skills", "~/shared-skills"]`, not V1's `{ "paths": [], "urls": [] }`. Relative paths remain working-directory-relative; arrays contribute across config layers. Remote catalogs exist, but they are not a replacement for a locally adopted canonical skill directory.

### Activation, permissions and writers

Skills are advertised as metadata and loaded on demand by the native skill tool, not automatically pasted in full into every prompt. V1 uses tool input `name`; V2 uses `id`. Access can be allow/ask/deny; denial hides the skill and rejects loading. V1 permissions use `permission.skill`; V2 uses ordered `permissions` rules with action `skill` and the ID as resource. Do not copy permission configuration across major versions.

Native-only metadata includes `metadata["opencode/autoinvoke"]` (hide from model auto-selection while retaining explicit loading). V1 additionally documents `metadata["opencode/slash"]`; do not assume V2 preserves that presentation behavior. V2 also accepts `disable-model-invocation`, with `opencode/autoinvoke` taking precedence. Preserve standard metadata as strings where possible, for example `opencode/autoinvoke: "false"`, rather than coercing all harness-specific metadata into universal semantics. Sources: [V1 skills](https://opencode.ai/docs/skills), [V2 skills](https://opencode.ai/v2/docs/skills), [V2 parser](https://github.com/anomalyco/opencode/blob/v2.1.0/packages/core/src/config/plugin/skill-file.ts).

Discovery is not evidence of trusted content. Loading permission does not grant permission to execute a skill's supporting scripts. No independent native skill-install CLI write contract was established here. Third-party installers may choose a native directory even though OpenCode's reader supports `.agents`; the proposed adapter should write canonical skills to `.agents/skills` directly, not infer its destination from an installer convention.

## Configuration hierarchy

### V1.19.3

The [tagged loader](https://github.com/anomalyco/opencode/blob/v1.19.3/packages/opencode/src/config/config.ts) deep-merges config objects. Broad precedence is organization `.well-known/opencode` defaults → user config → explicit `OPENCODE_CONFIG` → direct project configs → discovered `.opencode` directories / extra config directory → inline config → applicable organization/account and administrative settings; macOS managed preferences are last. Do not treat the filesystem-only view as proof of the effective configuration in a managed installation.

Details that affect an adapter:

- User legacy `config.json`, `opencode.json`, then `opencode.jsonc` are loaded in that order. Do not create or migrate legacy `config.json` as the preferred new output.
- Direct project configs are collected upward to the Git worktree and reversed, yielding ancestor-to-current merging; within a directory JSON precedes JSONC.
- Native `.opencode` directory enumeration is separately defined by [`paths.ts`](https://github.com/anomalyco/opencode/blob/v1.19.3/packages/opencode/src/config/paths.ts): global config first, project directories from near to far, home `.opencode`, then `OPENCODE_CONFIG_DIR`. This is not identical to direct config order.
- MCP objects deep-merge. A partial override can inherit fields from a lower layer. That does not mean a partial server definition is a valid standalone export.

### V2.1.0

The [V2 loader](https://github.com/anomalyco/opencode/blob/v2.1.0/packages/core/src/config.ts) retains ordered config documents rather than applying one universal recursive merge to everything. For normal settings: well-known defaults → native global → explicit file → direct ancestor-to-current files → ancestor-to-current `.opencode` directories → inline content → administrative settings. System configuration and macOS managed preferences outrank project/user values. In a directory JSON precedes JSONC.

All discovered `.opencode` config files outrank **all** direct config files, even a direct file nearer the working directory. The traversal reaches the filesystem root at this tag. Most importantly, the [MCP config consumer](https://github.com/anomalyco/opencode/blob/v2.1.0/packages/core/src/config/plugin/mcp.ts) selects the last **entire server object** per name; it does not deep-merge server fields. Every higher-priority override must repeat required fields. Default timeout fields are merged separately. Preserve provenance and scope during import rather than flattening the effective union.

## MCP: native formats and behavior

`.agents` support above is for skills. Neither version is shown natively reading mishmash's canonical `.agents/mcp.json`. Translate the [canonical MCP model](../source-of-truth.md) into the appropriate OpenCode config section; do not symlink the canonical MCP file into `opencode.json`.

### V1 native example

**Project file:** `<project>/opencode.json` (Windows `<project>\opencode.json`). This valid minimal document configures a documented real stdio fixture and public remote endpoint:

```json
{
  "mcp": {
    "everything": {
      "type": "local",
      "command": ["npx", "-y", "@modelcontextprotocol/server-everything"],
      "cwd": ".",
      "environment": { "LOG_LEVEL": "info" },
      "enabled": true
    },
    "context7": {
      "type": "remote",
      "url": "https://mcp.context7.com/mcp",
      "enabled": false
    }
  }
}
```

**User file:** `C/opencode/opencode.json` (Windows `C\opencode\opencode.json`, where `C` is the config-base variable defined above, not a drive letter). This is independent of the project example:

```json
{
  "mcp": {
    "context7": {
      "type": "remote",
      "url": "https://mcp.context7.com/mcp",
      "oauth": false,
      "headers": { "CONTEXT7_API_KEY": "{env:CONTEXT7_API_KEY}" }
    }
  }
}
```

Omitted `enabled` connects by default; `enabled: false` keeps a definition disabled. Stdio is `type: "local"` with an argv array, not a shell command string. Remote is `type: "remote"` with `url`. The [V1 runtime](https://github.com/anomalyco/opencode/blob/v1.19.3/packages/opencode/src/mcp/index.ts) tries Streamable HTTP then legacy SSE. A V1 `timeout` is a positive integer in milliseconds, not V2's timeout object. Sources: [V1 MCP docs](https://opencode.ai/docs/mcp-servers), [V1 MCP schema](https://github.com/anomalyco/opencode/blob/v1.19.3/packages/core/src/v1/config/mcp.ts).

### V2 native example

**Project file:** `<project>/opencode.json` (Windows `<project>\opencode.json`):

```json
{
  "mcp": {
    "servers": {
      "everything": {
        "type": "local",
        "command": ["npx", "-y", "@modelcontextprotocol/server-everything"],
        "cwd": ".",
        "environment": { "LOG_LEVEL": "info" },
        "disabled": false
      },
      "context7": {
        "type": "remote",
        "url": "https://mcp.context7.com/mcp",
        "disabled": true
      }
    }
  }
}
```

**User file:** `C/opencode/opencode.json` (Windows config-base `C\opencode\opencode.json`):

```json
{
  "mcp": {
    "servers": {
      "context7": {
        "type": "remote",
        "url": "https://mcp.context7.com/mcp",
        "oauth": false,
        "headers": { "CONTEXT7_API_KEY": "{env:CONTEXT7_API_KEY}" }
      }
    }
  }
}
```

Omitted `disabled` is false; enabled intent maps to `disabled: false`, **not** an `enabled` field under a V2 server. V2 remote transport is Streamable HTTP, not a legacy SSE endpoint. Its protocol option `legacy` describes an MCP protocol mode, not a promise of the old HTTP+SSE transport. V2 also has Code Mode and phase-specific timeout options that must remain adapter-native if the canonical model cannot express them. Sources: [V2 MCP docs](https://opencode.ai/v2/docs/mcp-servers), [V2 native envelope](https://github.com/anomalyco/opencode/blob/v2.1.0/packages/schema/src/config/mcp.ts), [V2 client](https://github.com/anomalyco/opencode/blob/v2.1.0/packages/core/src/mcp/client.ts).

The package command and Context7 endpoint are upstream examples, **not executed or connectivity-verified here**. The `npx` examples demonstrate upstream argv configuration, not verified native-Windows command resolution. Disabled examples intentionally do not connect automatically. API-key examples require the named environment variable and are not literal-credential examples.

### Environment, secret references and working directory

Both versions accept `environment` for stdio process variables and `headers` for remote request headers. They support `{env:NAME}` interpolation in config strings, including header values and OAuth settings. `$NAME`, `${NAME}`, `%NAME%` and PowerShell `$env:NAME` are not equivalent config expressions. Preserve a typed canonical environment reference and render this syntax only at export time.

Both support `{file:path}`: relative references resolve against the **config file's directory**, absolute paths remain absolute, and `~/` uses `os.homedir()`. Referenced contents are trimmed and inserted as escaped string content. This differs from MCP `cwd` resolution. Missing environment variables become empty strings. V1's [substitution helper](https://github.com/anomalyco/opencode/blob/v1.19.3/packages/opencode/src/config/variable.ts) defaults missing files to errors (with an explicit empty-on-missing mode available); V2 [substitution](https://github.com/anomalyco/opencode/blob/v2.1.0/packages/core/src/config/variable.ts) logs unreadable/missing references and substitutes empty. Do not treat an empty substituted credential as a successfully migrated secret. V2 also has JSON-escaping fallback for environment substitutions; do not assume V1 does the same for Windows paths.

For both checked runtimes, local server `cwd` is `path.resolve(activeWorkspaceDirectory, configuredCwd)` or the active workspace directory when omitted. It is **not relative to the file containing the setting**. User config can therefore intentionally launch a different per-project process. Command executable/argument paths must be preserved according to that process working directory and executable search semantics, not blindly rebased beside an exported config. V2 runs through the location's environment/spawner; remote-workspace environments must not be mistaken for the host. Sources: [V1 process creation](https://github.com/anomalyco/opencode/blob/v1.19.3/packages/opencode/src/mcp/index.ts), [V2 client cwd](https://github.com/anomalyco/opencode/blob/v2.1.0/packages/core/src/mcp/client.ts), [V2 stdio environment](https://github.com/anomalyco/opencode/blob/v2.1.0/packages/core/src/mcp/stdio.ts).

### OAuth, trust and CLI writer differences

Remote OAuth is enabled unless `oauth: false`; credentials are stored outside project configuration. V1 OAuth keys include `clientId`, `clientSecret`, `callbackPort`, `redirectUri`; V2 uses `client_id`, `client_secret`, `callback_port`, `redirect_uri`, plus additional capabilities such as `auth_server_metadata_url`. Callback defaults and supported registration methods differ: V1 schema documents port 19876 and `/mcp/oauth/callback`, while V2 supports available ephemeral ports and CIMD/DCR selection. Preserve explicit callback settings rather than assuming defaults mean the same thing. Never copy token/registration stores, OAuth sessions, approval state or secret file contents into canonical config. Sources: [V1 schema](https://github.com/anomalyco/opencode/blob/v1.19.3/packages/core/src/v1/config/mcp.ts), [V2 OAuth docs](https://opencode.ai/v2/docs/mcp-servers#oauth).

Configured servers connect automatically unless disabled; importing a project MCP definition can launch code or send authenticated requests. Skill permissions and MCP tool-use policies are not evidence of a universal pre-launch project-trust prompt. No such cross-version trust guarantee was established here. Stage imported definitions disabled until the user intentionally activates them, while retaining original enabled intent and recording this adoption decision separately; do not export an active server merely because its config file was discovered.

The checked [V1 CLI writer](https://github.com/anomalyco/opencode/blob/v1.19.3/packages/opencode/src/cli/cmd/mcp.ts) differs from [V2's writer](https://github.com/anomalyco/opencode/blob/v2.1.0/packages/cli/src/commands/handlers/mcp/add.ts):

| Concern | V1.19.3 | V2.1.0 |
| --- | --- | --- |
| Noninteractive add | Named `mcp add <name> --url ...` or command after `--` writes **global** config | Same style writes **current process directory's project config** by default |
| Scope selection | Interactive no-name flow offers project/global when in Git; otherwise global | `--global` selects global; default is project |
| Project writer base | Git worktree in interactive flow | `process.cwd()`, not ancestor search |
| Field written | `["mcp", name]` | `["mcp", "servers", name]` |
| Candidate preference | `opencode.json`, then `opencode.jsonc`; project also checks `.opencode` versions | `opencode.json`, then `opencode.jsonc`, then `.opencode` versions |
| Global root | `Global.Path.config` (XDG root, even when extra `OPENCODE_CONFIG_DIR` is configured) | Global service config root, honoring `OPENCODE_CONFIG_DIR` |

The V1 writer's comment claims JSONC preference, but its executable candidate array checks JSON first; use the code behavior. Both patch JSONC with `jsonc-parser`, preserving unrelated content/comments rather than serializing an effective merged config. Both support repeated `--env` / `--header` for the applicable transport; `cwd`, disabled state and advanced OAuth options need config editing. CLI add does not guarantee that the written file is the effective winner among all reader layers. Do not automate it without version/scope gating and knowledge of the actual target file.

## Unix and native Windows implementation notes

- Keep commands as executable-plus-argv arrays. Shell syntax (`&&`, pipes, variable expansion, quoted command lines) does not become portable merely by placing it in one array element. On Unix, directly executed scripts need an executable interpreter/permissions appropriate to the runtime.
- Windows JSON strings must escape backslashes, e.g. `"cwd": "C:\\work\\repo"`; an executable path containing spaces remains one array element. Preserve argument boundaries rather than adding shell quotes inside the executable value.
- Neither the upstream `npx` examples nor the inspected OpenCode call sites establish a universal native-Windows fix involving `npx.cmd` or `cmd /c`. V1 delegates to the MCP SDK stdio transport; V2 delegates to its environment spawner. `.cmd`/`.bat`, PATH/PATHEXT and interpreter resolution remain platform verification items. Do not inject shell wrappers as a generic conversion.
- Both skill implementations contain link-following logic, but that is not a cross-platform guarantee. Native Windows symlink creation can depend on privileges/Developer Mode; junctions have different semantics and do not replace arbitrary file links. Prefer shared direct discovery, otherwise materialize an owned skill directory when links are unavailable. Do not replace a user's real directory with a link.
- A changed `XDG_CONFIG_HOME` can move native settings without moving `.agents` skills. A changed home can move aliases without moving an explicitly set XDG root. Resolve both independently; preserve user/project scope and never mingle native Windows and WSL executable paths or credential environments.

## Adoption, migration and synchronization guidance

The following is source-backed adapter guidance, not a claim that OpenCode implements the canonical format. See the [mishmash README](../../README.md) for the implemented CLI and explicit major-version selection.

1. **Gate on exact installed major/version and retain provenance.** Distinguish a V1 CLI with a compatibility reader from V2 native behavior. Record each original file, scope, base directory and native section; do not import only a flattened effective config.
2. **Adopt complete skill directories** from `.opencode/skills`, `.opencode/skill`, `.claude/skills` or configured sources into project `.agents/skills/<id>` or user `H/.agents/skills/<id>`. Native `.agents` discovery normally makes extra links unnecessary. On V1, account for the external-skills disable flag. If shared discovery is disabled, use a deliberately owned per-skill native link or materialized directory, not a whole-config-directory link.
3. **Resolve skill identity before moving.** V1 identity is frontmatter `name`; V2 is path-derived ID. A mismatched name/directory, nested basename collision, flat Markdown skill with adjacent resources, or duplicate definition requires an explicit resolution. Never silently rename a skill or assume moving it preserves identity. Preserve supporting files and native metadata. Remove only adapter-owned obsolete aliases after a successful cutover so two definitions do not compete.
4. **Import MCP definitions into the canonical project/user store described in [source-of-truth](../source-of-truth.md).** It is project-owned intent, not a native `.agents` discovery contract. Map argv/environment/headers/cwd/transport/activation and retain OpenCode-only fields in native overrides. Keep credentials as references. No OAuth/trust/state synchronization.
5. **Generate one selected native envelope**, patching only managed server IDs in the selected JSON/JSONC file. Preserve unmanaged IDs, comments and native-only settings. V1 export uses direct `mcp.<id>` and `enabled`; V2 uses `mcp.servers.<id>` and the inverse `disabled`. Preserve scope; do not write a project definition globally because V1's named CLI add defaults there.
6. **Translate semantics, not just field names.** Map OAuth casing; preserve explicit callback configuration. V1 numeric per-server timeout maps to V2 `{startup, catalog, execution}` in OpenCode's [migration helper](https://github.com/anomalyco/opencode/blob/v2.1.0/packages/core/src/v1/config/migrate.ts). Distinct V2 phase timeouts, Code Mode/protocol options and legacy-SSE-only servers need explicit incompatibility reporting when exporting to a less capable target. Never drop them silently. Resolve canonical path references using the original config-file base for `{file:...}` but workspace base for `cwd` and relative skill sources.
7. **Do not trust compatibility conversion as a lossless migration.** V1.19.3's [V2 compatibility reader](https://github.com/anomalyco/opencode/blob/v1.19.3/packages/opencode/src/config/v2-compat.ts) lowers nested servers, reports conflicts and unsupported V2 options, and cannot represent every phase-specific timeout/Code Mode setting. V2.1.0's [normalizer](https://github.com/anomalyco/opencode/blob/v2.1.0/packages/core/src/config/normalize.ts) accepts legacy flat MCP entries and skills objects, but reports conflicts/malformed entries and omits enabled-only legacy MCP entries. Export complete native server objects; do not depend on an `enabled`-only overlay surviving V2's per-document normalization and whole-object selection. Preserve literal IDs such as `servers` carefully because envelope detection distinguishes them from an actual server of that name.

A V1/V2 shared config file is therefore a special compatibility case, not the default synchronization strategy. A target-aware adapter should produce the installed version's native syntax and surface conflicts before changing an existing multi-layer setup.

## Explicit verification limits

- Source verifies XDG/home resolution and the absence of an APPDATA substitution in these paths; no native-Windows execution validated the resulting installation, filesystem permissions or home fallback.
- V1 duplicate skill winners are not a stable documented/source-enforced ordering; collisions must be reported.
- V2 live docs' project-root/any-depth skill language differs from the checked filesystem-root traversal and bounded scanner; recheck release source when upgrading.
- Symlink/junction creation, cycles, packaging/executable permissions, native Windows npm launch behavior and WSL interoperability remain unexercised. Use direct shared discovery where possible rather than claiming universal link support.
- No installer, skill activation, server process, public endpoint or OAuth flow was run. No user configuration or credential store was inspected. An adapter still needs platform-specific acceptance checks before claiming these examples operate on Windows.
