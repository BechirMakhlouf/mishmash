# Source of truth: skills and MCP servers

[Documentation index](README.md)

Status: mishmash's canonical resource and safety contract, based on native harness research dated 2026-10-20. The [project README](../README.md) documents the implemented CLI and its supported options. Native harness behavior is documented separately in the [harness guides](README.md#harness-guides); successful synchronization of files does not prove native activation or connectivity. Hooks, instructions, custom subagents, and plugin installation are outside this phase.

## Decision

Use project `<project>/.agents/` and user `<home>/.agents/` as the authoritative resource roots. Store skills in the existing Agent Skills format. Store MCP server intent in a versioned, project-owned JSON document based on the widely used `mcpServers` envelope and explicit MCP transport names. Generate native MCP configuration through adapters; do not claim every harness reads `.agents/mcp.json`.

Prefer direct native discovery, then compatible per-resource links. Generate native representations when formats or semantics differ. A new harness with the same resource kinds should need an adapter, not changes throughout the synchronization core.

## What is actually standardized?

| Candidate | What it defines | Decision |
| --- | --- | --- |
| [Agent Skills specification](https://agentskills.io/specification) | `SKILL.md`, required metadata, directory layout, and supporting resources | Adopt directly. No new skill format. |
| `.agents/skills` discovery convention | A shared location recognized by several harnesses; exact roots, overrides, precedence, and trust remain harness-specific | Prefer it at both scopes, with adapter-aware discovery. It is not a universal configuration directory. |
| [MCP protocol](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports) | Communication, transports, lifecycle, and protocol behavior | Reuse transport concepts. Protocol support does not imply a shared client configuration file. |
| [Agent Plugins 1.0](https://agent-plugins.org/specification) and its [MCP schema](https://agent-plugins.org/schemas/1.0.0/mcp.schema.json) | A published portable package format containing skills and `mcp.json`, with explicit `stdio`, `streamable-http`, and legacy `sse` variants | Closest published MCP packaging baseline. Reuse its vocabulary and command/arguments separation, but do not mislabel a general user/project configuration as a conforming plugin. |
| [SEP-2633: standard client-side `mcp.json`](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2633) | A proposed general MCP client configuration format | The proposal was still open when checked. Track it; do not describe it as an adopted universal standard. |
| [Vercel skills registry](https://github.com/vercel-labs/skills/blob/main/docs/agents.md) | An existing cross-harness installer and directory registry | Evidence of ecosystem convergence, not authority for native harness paths or behavior. |

Agent Plugins is not sufficient as the entire canonical MCP contract: it constrains configured working directories to plugin/package-data locations, defines only `PLUGIN_ROOT`/`PLUGIN_DATA` expansion, and has no portable credential-reference or OAuth configuration fields. Its remote URLs/headers do not support arbitrary environment interpolation. Copying our richer intent into that schema would misrepresent its semantics. Package import/export can use its compatible subset explicitly; adopting a plugin installation system is not required here.

## Scope and filesystem roots

| Scope | Unix: Linux/macOS | Native Windows | Ownership |
| --- | --- | --- | --- |
| Project | `<project>/.agents/` | `<project>\.agents\` | Repository resources, normally version controlled |
| User | `<home>/.agents/` | `<home>\.agents\` | Personal resources; never implicitly written by a project operation |
| Project-private | `<home>/.agents/projects/<project-hash>/` | `<home>\.agents\projects\<project-hash>\` | Private Claude MCP definitions tied to one normalized absolute project identity; never repository or global-user resources |

For mishmash's Node.js implementation, `<home>` means `os.homedir()` unless explicitly supplied with `--home`: Unix uses `HOME` when defined, otherwise the operating-system home; Windows uses `USERPROFILE` when defined, otherwise the profile directory. It does not mean `%APPDATA%`. See [Node's home resolver](https://nodejs.org/api/os.html#oshomedir).

These are our canonical roots, not promises about every harness's relocated home. Gemini appends `.agents` under its `GEMINI_CLI_HOME` root; Copilot custom-home configuration can disable default shared-user skill discovery. Codex uses a Windows profile-known-folder resolver that can disagree with Node's `USERPROFILE`-based home. pi's shared user root explicitly prefers `HOME` even on Windows. Their adapters must connect the canonical root to the actual native reader or report the mismatch, not silently relocate canonical data. See the [Gemini](harnesses/gemini-cli.md), [Copilot](harnesses/github-copilot-cli.md), [Codex](harnesses/codex.md), and [pi](harnesses/pi.md) guides.

WSL is a Linux execution environment with its own home, executable resolution, and trust state. Do not treat a native Windows harness and a WSL harness as the same installation or automatically point them at one another's user data.

```text
.agents/
├── sync.json
├── skills/
│   └── code-review/
│       ├── SKILL.md
│       ├── scripts/
│       └── references/
├── mcp.json
└── overrides/
    └── <adapter-id>/
```

`sync.json` owns target selection and synchronization policy, not duplicated resource definitions. `skills/` owns complete skill directories. `mcp.json` owns portable server intent. `overrides/` owns explicitly target-specific additions. Machine-local output hashes, native absolute paths, ownership records, backups, and drift state must remain outside committed canonical resources.

Implemented local state lives at `<home>/.local/state/mishmash/<canonical-root-hash>/state.json`, with recoverable backups/recovery data alongside it, or in the explicit `--state-dir` location. Private project roots use the SHA-256 hash of the normalized absolute project path. Private skills and private projections to other adapters are unsupported and produce diagnostics rather than a scope change. `--home` isolates canonical/native/state roots and disables inherited native configuration-root overrides; use explicit `--claude-state-file` or `--codex-profile-home` when an established location requires one.

Adapter identifiers are registry keys rather than a closed enumeration of today's six products. This selection file prepares a project for all initial targets without installing any of them:

```json
{
  "version": 1,
  "targets": [
    "claude-code",
    "codex",
    "github-copilot-cli",
    "pi",
    "opencode",
    "gemini-cli"
  ]
}
```

The same layout applies independently at user scope. Scope follows the root; importing a user resource does not silently promote it into a shared project or vice versa.

## Skills: adopt the existing format

Canonical skill: `.agents/skills/<name>/SKILL.md`, with the entire directory retained. The user equivalent is `<home>/.agents/skills/<name>/SKILL.md`.

```markdown
---
name: code-review
description: Review code changes for correctness, security, and maintainability.
---

Read the changed code and its callers. Report concrete defects with file references.
Consult references/checklist.md when the task needs the full review checklist.
```

Use the conservative interoperable naming subset: 1–64 lowercase ASCII letters, digits, and single hyphens; no leading, trailing, or consecutive hyphens; `name` matches its directory. The standard also requires a non-empty `description` of at most 1024 characters. Its optional `license`, `compatibility`, and string-valued `metadata` fields can be preserved. `allowed-tools` is experimental and does not establish equivalent tool names or permission behavior across harnesses. [Specification](https://agentskills.io/specification)

Migration preserves scripts, references, assets, other supporting files, executable permissions where meaningful, and original metadata. Harness-only frontmatter or shell substitutions do not become portable merely because the Markdown moved. Retain them with a compatibility finding; use a target-specific projection instead of a link when necessary to avoid changing behavior. Do not strip fields silently.

Use native `.agents/skills` discovery where the effective configuration permits it. Otherwise expose individual compatible skill directories at the native location. Do not create redundant links into another discovery root when the same resource is already found; some harnesses can surface duplicates rather than deduplicating them.

Do not flatten user and project collisions into one generic overlay: Claude, Codex, and Copilot do not share one universal same-name skill rule. The relevant adapter must report the native effective result.

## MCP: a normalized intent, not a universal native file

The following is the application contract for `.agents/mcp.json`. `version: 1` is our document version, not an MCP protocol version. This is deliberately not marked with the Agent Plugins `$schema`, because the reference and path semantics below extend beyond that published schema. The canonical reader validates this application-owned model.

```json
{
  "version": 1,
  "mcpServers": {
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "cwd": { "base": "project", "path": "." }
    },
    "context7": {
      "type": "streamable-http",
      "url": "https://mcp.context7.com/mcp"
    }
  }
}
```

The filesystem package and public Context7 URL illustrate real native configuration patterns documented by the harness guides; neither needs to be launched during synchronization. The package example is not a version-pinning recommendation. Adding or resolving a server definition does not install or execute it.

### Canonical field semantics

| Field | Meaning |
| --- | --- |
| `mcpServers` | Map of stable server IDs to transport-specific intent. Scope is supplied by the canonical root. |
| `type` | `stdio`, `streamable-http`, or explicitly legacy `sse`. Supporting SSE is an adapter capability, not an automatic fallback from HTTP. |
| `command` | For stdio, exactly one executable token or path. Never an implicitly shell-split string. |
| `args` | For stdio, ordered literal strings. Preserve argument boundaries; do not guess which strings are paths or shell expressions. |
| `env` | For stdio, a map from environment names to literal strings or explicit environment references. |
| `cwd` | Optional stdio working directory object with a `base` (`project`, `home`, or `source`) and a relative `path`. `source` is the containing canonical `.agents` directory; `project` is valid only at project scope. Resolve on the destination platform. |
| `url` | For remote transports, an explicit endpoint URL. Do not embed credentials in it or infer transport solely from the URL. |
| `headers` | For remote transports, a map of header names to literal strings or explicit environment references. |

An environment reference is `{ "env": "VARIABLE_NAME" }`, not a magic string that every target is expected to expand. This illustrative private endpoint requires an environment variable containing the full Authorization header value; it is not a live example server:

```json
{
  "version": 1,
  "mcpServers": {
    "private-api": {
      "type": "streamable-http",
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": { "env": "PRIVATE_API_AUTHORIZATION" }
      }
    }
  }
}
```

Literal strings remain literal; the synchronizer must not execute `!commands`, expand shell expressions, or resolve secrets while importing, planning, or writing. Adapters encode explicit environment references using verified native runtime references. If a native reader cannot preserve a literal without interpreting it, report that incompatibility too. A target that cannot express a reference, a renamed stdio environment variable, or a working-directory intent must report the limitation rather than write a resolved secret or silently discard the field.

Omitted `cwd` retains the target's native default; it does not assert identical defaults across targets. Migration must record the source behavior and flag a different destination default before cutover. Session-dependent user-server working directories that cannot be represented by these static anchors stay in a native override with an explicit portability limitation. Arbitrary absolute machine paths also require a local/target-specific binding or a reported restriction; do not convert them by guessing.

Keep native-only server properties in an adapter-specific override, keyed by the same server ID. This includes unsupported transports, OAuth registration settings, startup timeouts, exposure controls, or native secret helper syntax. Preserve useful non-secret intent without pretending it is portable. An override that conflicts with an already projected canonical field must produce a conflict rather than silently win. Credentials and trust data are excluded even from overrides.

The concrete override file is `.agents/overrides/<adapter-id>/mcp.json`, with `{ "version": 1, "mcpServers": { "server-id": { ... } } }`. For example, a Codex override can retain `startup_timeout_sec` for an existing canonical server. Only actual native non-secret fields belong in that map. pi exposure-only project overlays remain native-only rather than being fabricated into self-contained canonical servers. OpenCode projection is selected with `--opencode-version 1|2` (default `2`); no native executable is launched to determine the major.

Tool allowlists/exclusions and hidden/per-tool exposure controls are not automatically portable. Preserve them for their source adapter and reject cross-target projection without an established equivalent mapping; warnings alone must not broaden reachable tools. Explicit native working directories that cannot be anchored faithfully remain native-only, rather than exporting a server with its `cwd` omitted.

### Native projections

| Adapter | Native MCP representation | Why a raw shared canonical file is insufficient |
| --- | --- | --- |
| [Claude Code](harnesses/claude-code.md) | Root `.mcp.json` for project; targeted `mcpServers` maps in default or explicitly located user `.claude.json` for user/private scope | Native `http`/`stdio` typing, client interpolation, user/local storage and trust differ from canonical intent. |
| [Codex](harnesses/codex.md) | TOML `[mcp_servers.<id>]` in user or trusted project config | Different format, environment forwarding/header-reference fields, config layers, and CLI writer scope. |
| [Copilot CLI](harnesses/github-copilot-cli.md) | User `mcp-config.json`; project `.mcp.json` or `.github/mcp.json` | Native local/remote typing, precedence, tools/options, environment syntax, and workspace trust. |
| [pi](harnesses/pi.md) | User/project `mcp.json` | Similar `mcpServers` envelope does not establish identical references, exposure, working directory, or trust behavior. |
| [OpenCode](harnesses/opencode.md) | V1 `mcp.<id>`; V2 `mcp.servers.<id>` | Native `local`/`remote` entries, command arrays, environment syntax and enablement differ; compatibility readers are version-dependent. |
| [Gemini CLI](harnesses/gemini-cli.md) | `mcpServers` inside scoped `settings.json` | Native settings merge, environment expansion, transport fields, and runtime state are distinct. |

A native projected file can be shared by two clients only after its entire envelope, field interpretation, scope, path bases, secret references, reader behavior, and write behavior are verified compatible. For example, both Claude and Copilot can use a project `.mcp.json`, but this does not make every option or server entry interchangeable. Never overwrite a shared file independently from two adapters: plan one merged native artifact and check every participating consumer.

## Linking policy: prefer sharing without changing behavior

| Condition | Materialization |
| --- | --- |
| Effective native reader already discovers the canonical resource | No extra artifact |
| Payload and loading semantics match, but reader expects another path | Per-resource symbolic link, after checking reader support |
| Native representation or semantics differ | Managed generated projection, preserving unmanaged entries |
| Links cannot be created or traversed reliably | Explicit tracked copy, with drift detection |
| Required behavior is not representable | Keep the source active, preserve native intent, and report incompatibility |

Prefer relative links between project-local resources. Never commit a project link into a developer's home directory. Do not link whole harness configuration directories or state-bearing files, and do not use hard links as a substitute for managed projections: a native atomic rewrite can detach one filename from a shared inode.

On Unix, preserve executable modes for bundled scripts and verify the target loader follows the selected kind of link. On Windows, symbolic-link creation depends on privileges, filesystem support, and API behavior; the unprivileged creation flag requires Developer Mode. A directory junction is not a portable relative symlink and must not be treated as a file-link replacement. Reader compatibility still needs evidence. [Windows API](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createsymboliclinkw)

Git can check out symlinks as ordinary text files when `core.symlinks=false`. A successful Unix checkout does not prove a Windows checkout or loader will work. Generated local links/copies may therefore be preferable to committing adapter links. [Git configuration](https://git-scm.com/docs/git-config#Documentation/git-config.txt-coresymlinks)

Native Windows, PowerShell, Unix shells, and WSL have different executable and quoting rules. Translate a verified native command/argv contract; do not add `cmd /c`, shell interpolation, or `npx.cmd` by string substitution without the target adapter's process-launch evidence. Use JSON escaping for backslashes when needed. Path comparison must account for the actual filesystem's case behavior and symlink identity; do not assume case sensitivity from the platform name alone.

## Migration and multi-harness adoption

1. **Discover separately from selecting targets.** Inventory both resource kinds in the requested scope, including native aliases and existing canonical roots. A repository may target harnesses not installed on the importing machine. Detection must not install or upgrade tools.
2. **Read without activation.** Parse configuration, inspect skill directories, and record provenance. Never run MCP commands, package installers, skill scripts, secret helpers, or authentication flows merely to discover a resource.
3. **Normalize without loss.** Preserve full skill directories and supported server intent. Keep unsupported native options explicitly scoped. Compare content and real paths, but consolidate only after confirming scope and semantic identity: identical bytes alone do not make two intentionally distinct resources equivalent.
4. **Resolve conflicts before mutation.** Same name/different content, scope changes, unknown relative-path bases, missing secret mappings, and conflicting native artifacts are visible findings. Do not use last-writer-wins or expand project access to make conversion appear successful.
5. **Plan canonical adoption and native projections together.** Show destinations, links, copies, targeted config edits, preserved unmanaged entries, and resources that remain native-only. Importing Claude/Copilot does not remove those targets when adding Codex/pi/OpenCode/Gemini.
6. **Apply only owned changes.** Recheck source hashes before mutation; use atomic per-file replacement where supported, with recoverable backups. A multi-file migration is not magically atomic. Preserve TOML/JSONC comments and unrelated fields where their native formats allow them; use supported native writers for state-bearing stores rather than copying whole files.
7. **Verify before cutover.** Confirm native discovery and intended MCP configuration in the actual target/version/platform. Only then remove superseded active definitions or replace source skill entries with links. Unresolved resources remain active at their original locations; no duplicate active managed registrations should remain after successful cutover.
8. **Detect drift.** Linked edits affect canonical content. Generated-file edits require an explicit import or conflict resolution. Repeating an unchanged migration/sync must produce no changes.

Native private-project definitions, such as Claude's `local` MCP map inside its user state file, must remain private to that project. Their physical location in a user file does not make them all-project user definitions, and importing them must not publish them into a shared repository. Retain the native definition or an explicit private local binding unless the user deliberately selects a scope change.

Never synchronize OAuth tokens, login credentials, trust approvals, allow-all policies, client sessions, caches, plugin install state, or resolved secret values. Native same-name precedence and trust requirements are adapter facts, not fields to erase from a migration report. A literal credential blocks portable cutover until a reference or supported local binding exists; it is not silently dropped.

## Adapter boundary and verification

The core owns resource identity/scope, canonical validation, ownership/provenance, planning, conflicts, and safe application. An adapter owns product/version/platform discovery; effective reader and writer locations; native parsing/rendering; precedence; skill-link behavior; transport/field/reference capabilities; and activation/trust requirements. Capability results must distinguish supported, translated, unsupported, and unknown, with reasons rather than a single boolean.

mishmash's filesystem tests and built-CLI smoke are separate from the native harness research. Earlier Linux help/version observations establish installed CLI identities and selected command contracts only. They do not prove skill discovery, live MCP startup, OAuth, or Windows behavior. The CI matrix exercises mishmash on Linux, macOS, and native Windows; it does not install or activate the six harnesses. The per-harness guides record source evidence and remaining native-runtime unknowns individually.
