# pi: skills and MCP servers

[Documentation overview](../README.md) · [Canonical source of truth](../source-of-truth.md)

## Identity and evidence baseline

Research date: **2026-10-20**. This document targets stock **`@earendil-works/pi-coding-agent` 1.3.0**, from [`earendil-works/pi`, tag `v1.3.0`](https://github.com/earendil-works/pi/tree/v1.3.0), not omp or historical badlogic snapshots. All pi source/doc links below are pinned to that tag. Stock pi now includes first-party MCP support; advice that it necessarily requires a third-party MCP extension is obsolete for this baseline.

Evidence categories:

- **Documented:** upstream v1.3.0 documentation describes the behavior.
- **Source-verified:** the corresponding tagged resolver, loader, validator, writer, or transport was inspected. This is not execution evidence.
- **CLI-observed:** preliminary Linux `pi --version` reported 1.3.0 and top-level help was inspected. No skill discovery or MCP session was exercised.
- **Unverified:** native Windows execution, link creation, server connections, OAuth, and bundled-runtime behavior were not tested. No packages were installed and no personal configuration was inspected.

MCP is a replaceable built-in extension. A third-party extension registering `/mcp` replaces the session integration: stock pi then does not read `mcp.json` or connect those servers in that session. `--no-mcp`, disabling `builtin:mcp`, or `--no-extensions` can also disable the built-in. Shell-level `pi mcp` commands always use the built-in implementation and do not load extensions. A synchronizer must report this capability mismatch, not declare success merely because it wrote a native file. [MCP documentation][mcp-doc]

## Paths, scopes, and environment resolution

Define:

- **H** = Node `os.homedir()`: on POSIX, `$HOME` when defined, otherwise the effective user's home; on native Windows, `USERPROFILE` when defined, otherwise the current user's profile directory. This is not an AppData resolver.
- **S** = `process.env.HOME || os.homedir()`, used specifically by package/resource discovery for shared `.agents` skills.
- **A** = `getAgentDir()`: nonempty `PI_CODING_AGENT_DIR`, with pi path normalization and leading `~` expansion using **H**; otherwise `H/.pi/agent`. The override denotes the **final agent directory**, not a parent to which `.pi/agent` is appended. Prefer an absolute override: the resolver itself does not make a relative override absolute.
- **P** = session/current working directory. Native `.pi` project discovery is rooted here, not automatically at the Git root.

This distinction matters on Windows: if a Unix-like launcher exports `HOME` different from `USERPROFILE`, shared skills use **S**, while the default native agent directory and MCP `~` expansion use **H**. Changing `PI_CODING_AGENT_DIR` relocates native user skills/settings/MCP, **not** shared `.agents/skills`. [Config resolver][config-source], [path utilities][paths-source], [package manager][package-source], [Node home resolver][node-home]

| Resource/scope | Project Unix | Project native Windows | User Unix default | User native Windows default | Format/override |
|---|---|---|---|---|---|
| Native skills | `P/.pi/skills/<name>/SKILL.md` | `P\.pi\skills\<name>\SKILL.md` | `H/.pi/agent/skills/<name>/SKILL.md` | `H\.pi\agent\skills\<name>\SKILL.md` | Markdown + YAML; user root follows **A** |
| Shared skills | `P/.agents/skills/<name>/SKILL.md` and eligible ancestors | `P\.agents\skills\<name>\SKILL.md` and eligible ancestors | `S/.agents/skills/<name>/SKILL.md` | `S\.agents\skills\<name>\SKILL.md` | Direct discovery; independent of **A** |
| Explicit skill paths | `P/.pi/settings.json`, `skills` array | `P\.pi\settings.json` | `A/settings.json` | `A\settings.json` | Paths resolve from the containing `.pi`/agent directory; CLI `--skill` paths resolve from **P** |
| MCP servers | `P/.pi/mcp.json` | `P\.pi\mcp.json` | `H/.pi/agent/mcp.json` | `H\.pi\agent\mcp.json` | Strict JSON, `mcpServers`; user path follows **A** |
| MCP OAuth state, not synchronized | None; credentials are user-local | Same | `A/mcp-auth.json` | `A\mcp-auth.json` | State, not server intent |
| Project trust state, not synchronized | Decision about canonical project paths | Same | `A/trust.json` | `A\trust.json` | State, not a portable approval |

The Windows defaults above use the actual **H** resolver, commonly `C:\Users\<user>`, not an assumed `%APPDATA%` substitution. **S** can differ. `.agents/mcp.json` is this project's canonical input, **not a native pi discovery path**. pi reads only the user and current-directory project MCP files described above; it does not scan ancestor `.pi/mcp.json` files. [Configuration][configuration-doc], [MCP loader][mcp-config]

WSL-running pi uses Linux home, paths, processes, permissions, and links. A separate native Windows pi process uses Windows resolution. Do not treat the two as one installation or silently share executable/path-valued MCP definitions.

## Skills

### Portable layout and metadata

Put the same complete directory under project `.agents/skills/` or user `S/.agents/skills/`:

```text
.agents/skills/review-notes/
├── SKILL.md
└── references/
    └── checklist.txt
```

`review-notes/SKILL.md`:

```markdown
---
name: review-notes
description: Review release notes for missing compatibility details. Use when preparing release documentation.
metadata:
  owner: documentation
---

# Review release notes

Read references/checklist.txt relative to this skill directory.
Identify missing migration instructions and platform limitations in the supplied release notes.
```

`review-notes/references/checklist.txt`:

```text
Check changed defaults, removed interfaces, migration steps, and platform-specific behavior.
```

The portable Agent Skills fields are `name`, `description`, `license`, `compatibility`, `metadata`, and experimental `allowed-tools`. Keep `name` equal to the directory name, lowercase alphanumeric/hyphen, at most 64 characters, and a nonempty description at most 1024 characters. pi is more permissive: it can fall back to the directory name, does not warn about a name/directory mismatch, and loads many invalid values with warnings. Missing/empty descriptions and malformed declared skills are not loaded. Do not preserve that leniency as canonical validity. [Agent Skills specification][skill-spec], [skills documentation][skills-doc], [skills parser][skills-source]

pi additionally implements `disable-model-invocation: true`: omit the skill from automatic prompt advertisement but allow explicit `/skill:review-notes`. The inspected generic specification does not list this field, although pi's skills documentation includes it in its table of specification fields. Treat this as a pi-supported extension unless another target explicitly supports it. `allowed-tools` is not an enforced permission boundary in the inspected pi parser: it extracts name, description, and `disable-model-invocation`, not an executable allowlist. Preserve other frontmatter but do not promise operational enforcement. [Skills parser][skills-source]

### Discovery, collisions, and links

Source-verified CLI/default-resource behavior:

1. Native project skills: **only `P/.pi/skills`**, not every ancestor's `.pi/skills`.
2. Shared project skills: scan `.agents/skills` from **P upward**, stopping at the closest directory containing `.git` (directory or worktree file), inclusive. Without a `.git` ancestor, continue to the filesystem root. The user shared root is filtered out of this project list and loaded separately as user scope.
3. Native user skills: `A/skills`; shared user skills: `S/.agents/skills`.
4. Settings can add files/directories and include/exclude patterns; package manifests can supply skills. Resource arrays are combined, not simply replaced by project settings.
5. Within a traversal, a directory containing `SKILL.md` is a skill root and recursion stops there. Dot-prefixed entries and `node_modules` are skipped; `.gitignore`, `.ignore`, and `.fdignore` encountered within the scanned tree affect discovery. Native pi roots also accept standalone root-level `.md` skills; shared discovery has different standalone-Markdown handling. Use directory/`SKILL.md` form only for portable synchronization.

[Package discovery implementation][package-source], [settings resources][settings-doc]

For **distinct same-name files**, first discovered wins and a collision diagnostic identifies winner and loser. The default package manager sorts resources in this order:

1. Project explicit settings paths.
2. Project auto-discovered paths: native `.pi/skills` first, then shared `.agents/skills` from nearest directory outward.
3. User explicit settings paths.
4. User auto-discovered paths: native `A/skills` before shared `S/.agents/skills`.
5. Package resources.

Temporary CLI package skill resources are prepended by the resource loader; explicit `--skill` paths are also supported. Avoid relying on ordering of names colliding within one discovered directory. This is pi's resource-specific policy, not a universal project-over-user rule. The exported low-level `loadSkills(includeDefaults: true)` helper has its own ordering; the stock default resource loader calls it with `includeDefaults: false` after constructing the ordered paths above. [Package precedence][package-source], [resource loader][resource-source], [skill collision implementation][skills-source]

Symbolic directory links and linked `SKILL.md` files are followed using `statSync`; broken links are skipped. Realpath canonicalization deduplicates the same physical skill loaded through two paths, silently, before treating it as a name conflict. Linking a whole skill directory preserves references/assets; linking only `SKILL.md` can break supporting-file lookup, because pi uses the discovered skill directory as the resource base. Do not create recursive link cycles. These are source observations, not Windows link tests. [Package discovery][package-source], [skills loader][skills-source], [path canonicalization][paths-source]

### Trust, activation, and native writer scope

Project `.pi` skills/settings and project/ancestor `.agents/skills` are trust-gated. User skills are not subject to this project gate. The default trust policy is `ask`; command-line `--approve`/`--no-approve` comes first, then an extension decision, then the closest saved canonical-path decision, then the global default. In noninteractive modes, unresolved `ask` skips protected project resources. Context/instruction-file loading is a separate mechanism and is not evidence that project skills were approved. Trust does not sandbox execution or make skills safe. [Security documentation][security-doc]

pi advertises skill name, description, and location; the model reads the full `SKILL.md` when relevant. `/skill:<name>` explicitly loads it and appends supplied arguments. `enableSkillCommands` controls interactive discovery, not manually entered invocation. `--no-skills` disables discovered/configured skills; explicit `--skill` still loads. `/reload` picks up edits. [Skills][skills-doc], [CLI resources][cli-doc]

There is no documented dedicated `pi skills install/link` command in this baseline. `pi install <source>` installs a **Pi package**, writing its declaration to `A/settings.json` by default or `P/.pi/settings.json` with `--local`/`-l`; it does not make `.agents/skills` the installation target. A local package is referenced without copying. Package-managed skills should remain package-managed unless explicitly adopted into canonical ownership. [Package documentation][packages-doc]

## MCP servers

### Native format and examples

`A/mcp.json` and trusted `P/.pi/mcp.json` use **strict JSON**, not JSONC. Minimal native user example, using a real public endpoint documented upstream (connection and sign-in not exercised):

```json
{
  "mcpServers": {
    "sentry": {
      "url": "https://mcp.sentry.dev/mcp"
    }
  }
}
```

Minimal native **project** `.pi/mcp.json`, Unix or Windows, using upstream's real filesystem-server command (package execution not verified):

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "cwd": "."
    }
  }
}
```

Here `.` means the **session working directory**, not the directory containing `mcp.json` or a guaranteed repository root. This filesystem server grants access to that selected directory; review the scope before enabling it. The same JSON can be placed at user scope, but then its effective directory changes with each session. [MCP documentation][mcp-doc], [transport construction][runtime-source]

Native capabilities and fields:

| Concern | pi 1.3.0 behavior |
|---|---|
| Envelope | `mcpServers` object keyed by server name; optional top-level `autoEnableCodemode` |
| Stdio | `command`, optional `args`, `env`, `cwd`; optional `type: "stdio"` |
| Remote | `url`, optional `headers`, `oauth`, user-only `auth`; `type: "http"` or `"streamable-http"` accepted, or omitted |
| Legacy SSE | Explicitly rejected; do not rewrite `/sse` to `/mcp` without server-specific evidence |
| Common options | `enabled` (default true), `timeout` in seconds (default 60), `description`, `exposure`, `toolExposure` |
| Exposure | `codemode` default; `deferred`, `direct`, `hidden`; native tool-pattern overrides have exact-name priority, then first matching wildcard |
| Names | Letters, digits, `_`, `-`; names differing only by hyphen/underscore conflict because they share a tool namespace |

Unknown/native fields must not be silently discarded by synchronization. A pi `enabled`/exposure-only project entry is a special override, not a complete independent server definition. [Schema/validation][server-source], [MCP config loader][mcp-config]

### Precedence and trust boundaries

The loader reads user first, then the trusted current-directory project file:

- A complete project entry with the **same exact server name** replaces the entire user entry; it is not a recursive merge of command/env/headers.
- A project entry with **none of `command`, `url`, or `type`** can override **only** `enabled`, `exposure`, and `toolExposure` of an existing same-name user server. It retains the user's credentials, environment, transport, and other fields. Extra keys or a missing base server are errors. `toolExposure` replaces that field rather than deep-merging its keys.
- A differently spelled name colliding after hyphen-to-underscore normalization is rejected rather than overriding.
- Project `autoEnableCodemode` overrides the user value.
- File-configured servers override extension registrations sharing their namespace.
- Invalid entries are reported and skipped; other valid entries can still connect.

Project MCP is loaded only after project trust. The built-in session automatically starts connections to enabled servers; merely reading a trusted stdio configuration can execute its command and secret-resolution commands. `hidden` controls tool reachability, not whether the enabled process connects. `enabled: false` is the native opt-out from connection. pi's security guide states that it does not request approval for every tool call; MCP exposure is not a sandbox. [MCP config][mcp-config], [MCP behavior][mcp-doc], [security][security-doc]

HTTP OAuth is available when there is no `Authorization` header and no provider `auth`. Native OAuth configuration includes registered-client and callback settings; credentials are stored in `A/mcp-auth.json`, keyed by server name and URL. Same name+URL across project/user files shares sign-in; different names for the same URL are separate. `auth: { "provider": "<provider>" }` reuses a pi login-provider token, is **user-file only**, and requires HTTPS except loopback. Project files cannot select a destination for a personal provider credential. Neither OAuth tokens, provider credentials, trust decisions, nor MCP logs belong in canonical synchronization. [MCP authentication][mcp-doc], [provider-auth validation][server-source], [scope enforcement][mcp-config]

### Secret references, argv, environment, and cwd

For `env` values, HTTP `headers` values, and `oauth.clientSecret`, pi resolves `${NAME}` (also `$NAME`) against the running pi process environment. Missing **or empty** variables fail resolution; `${NAME:-default}` is not a supported fallback expression. Non-command templates use `$$` for literal `$` and `$!` for literal `!`. A value beginning with `!` executes the entire remainder as a secret-producing shell command. This is executable configuration, not portable secret syntax. The MCP path uses the **uncached** throwing resolver, even though the general helper also exposes a cached variant. [Secret resolver][secret-source], [runtime usage][runtime-source]

For example, this **user** entry keeps the token outside JSON (the environment variable must already exist; no literal token is supplied):

```json
{
  "mcpServers": {
    "github": {
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": {
        "Authorization": "Bearer ${GITHUB_TOKEN}"
      }
    }
  }
}
```

The endpoint appears in pi's upstream MCP documentation; authentication, authorization, and account availability remain server-specific and were not exercised. Do not expand these references while importing, store resolved values, or reuse `${...}` semantics blindly across clients. The [canonical model](../source-of-truth.md) represents environment/path intent explicitly; pi's syntax is an output encoding. [MCP examples][mcp-doc]

Process semantics established by source:

- `command` is one executable; `args` is an argument vector, **not a shell command string**. Shell substitutions/pipelines are not generally interpreted.
- `cwd` defaults to `.` resolved against session **P**; an explicit relative `cwd` is also relative to **P**, including for a user-level definition. Do not rebase it to `A` or `.pi` during migration.
- `~`, `~/...`, and on Windows `~\...` expand using **H** in `command`, each argument, and `cwd`. Other relative arguments remain strings passed to the server, whose own semantics apply. URL, command, args, and cwd do not receive the env/header secret-template expansion.
- Stdio child processes inherit the full pi environment, with resolved `env` entries overlaid. These entries are resolved independently against the parent environment, not as a sequential shell export script.
- pi uses `cross-spawn` for MCP stdio. Native Windows `.cmd` shims are launched through its Windows handling; the source explicitly accounts for them. Do not mechanically wrap every command in `cmd /c` or rewrite every `npx` to `npx.cmd`.
- On Unix, stdio servers own process groups; shutdown closes stdin, then escalates group termination. On Windows, cleanup uses `taskkill /pid <pid> /T /F`, not POSIX process-group signals.
- `!command` is different: it uses shell execution, with a 10-second timeout. On Windows it tries pi's configured shell machinery and falls back to the default shell only when that machinery cannot execute. It has no server-cwd parameter, so do not assume it runs in the configured MCP child's `cwd`. Keep such commands as native-only overrides unless equivalence is established.

[Transport creation][runtime-source], [stdio implementation][stdio-source], [secret command implementation][secret-source]

### Native CLI write scope

`pi mcp add <name> ...` and `pi mcp remove <name>` write **user `A/mcp.json` by default**. `--local`/`-l` writes exactly `P/.pi/mcp.json`. Adding replaces the entry with that name in the selected file while preserving unrelated parsed content; it does not merge the old entry's native-only fields. The writer preserves indentation but serializes JSON. A local add can write before trust is granted and reports that the project file remains ignored. Do not treat successful writing as approval or connection validation. [CLI implementation][mcp-cli], [config writer][mcp-config]

Documented shell examples (not run here):

```text
pi mcp add sentry --url https://mcp.sentry.dev/mcp
pi mcp add filesystem --local -- npx -y @modelcontextprotocol/server-filesystem .
```

`pi mcp list` is **not a read-only parser check**: it connects enabled servers and can start processes or make network requests; it exits 1 for invalid entries or failed enabled connections. Its project-file decision in the tagged implementation comes from the saved `ProjectTrustStore`, unlike a session's full extension/default/one-time trust-resolution sequence. Do not assume a session-only `--approve` decision makes an independent shell command see project MCP. `login` and `logout` change local OAuth state. Interactive `/mcp` changes are saved to the defining/override file, and trusted project enable/disable can create a project-only user-server override. Run `/reload` after external edits in an existing session. [CLI trust and operations][mcp-cli], [interactive MCP][mcp-doc]

## Unix and native Windows implementation notes

- Prefer **direct shared skill discovery** on both platforms; it avoids link privileges entirely. Preserve native user root **A** independently from shared root **S**.
- Unix links must preserve the whole skill tree and executable bits on bundled scripts. A Bash-only script does not become a native Windows program by linking or copying it; retain `compatibility` and report incompatible runtime requirements.
- The pi loader follows symbolic skill links, but it does not provide a native link-creation command. On Windows, symbolic-link creation depends on privileges or Developer Mode with the unprivileged-creation flag. Do not promise every account/filesystem can create them. A per-skill directory junction is a possible adapter strategy, **not a pi-tested guarantee**; use directory materialization when link capability is unavailable or unverified. [Microsoft symbolic-link API][windows-links]
- Windows JSON paths require escaped backslashes, e.g. `"cwd": "C:\\work\\repo"`; keep `command` and each argument separate. Do not put PowerShell quoting characters inside JSON argv strings. pi's MCP home expansion is narrower than its general Windows shell-path normalizer; do not assume `/mnt/c/...` is rewritten in MCP entries. [Runtime][runtime-source], [general paths][paths-source]
- Bare executable resolution depends on the effective child environment/PATH and `cross-spawn`, not the user's interactive aliases. Keep executable selection platform-specific when needed. The `npx` example is source-documented, not proof that npm/Node is installed on a Windows host.
- Preserve secret references as text. JSON examples avoid differences between POSIX shell, PowerShell, and cmd escaping; a future CLI writer must encode for the invoking shell or bypass it with argv spawning.
- Keep WSL configuration and native Windows configuration independently scoped unless an explicit migration resolves every path/runtime difference. No blanket cross-OS filesystem-link compatibility is claimed.

## Migration and synchronization recommendation

These are **source-backed adapter recommendations**, not additional native pi behavior. See the [mishmash README](../../README.md) for the implemented CLI and limitations. Use the normalized intent and ownership rules in [source of truth](../source-of-truth.md); do not invent a second canonical schema here.

1. **Resolve actual roots before inventory.** Determine **P**, **H**, **S**, and **A** from the launch environment and resolver semantics, including `PI_CODING_AGENT_DIR`. Inventory only relevant skills/settings/server definitions, not credentials or unrelated user state. Check whether stock built-in MCP is replaced/disabled.
2. **Adopt skill directories without changing scope.** Map `P/.pi/skills/<name>` to `P/.agents/skills/<name>`; map `A/skills/<name>` to the agreed canonical user `<home>/.agents/skills/<name>`. Canonical Node home normally equals **S**, but can differ on Windows when `HOME` is set independently from `USERPROFILE`. Retain complete assets, references, permissions, metadata, and explicit compatibility requirements. Identify standalone native Markdown skills and convert each to a directory with matching canonical name rather than moving loose `.md` files unchanged.
3. **Prefer direct discovery when roots match; remove only adopted duplicates.** If canonical user home differs from **S**, explicitly configure its skill root in native user settings or bridge individual skills from a verified discovery root; do not relocate canonical data for other clients. Otherwise no `.pi/skills` bridge is needed. Native pi copies win their same-tier collisions and can silently keep old content active; retire only explicitly adopted copies after detecting conflicts. Leave unmanaged native entries intact. Intentional per-skill bridges can use realpath deduplication; materialize only when links/direct discovery cannot meet the environment or a native-only variant is required.
4. **Retain ancestor semantics.** Record the original shared ancestor directory and repository boundary. Do not flatten inherited ancestor skills into every project or assume running from a nested directory discovers repository-root `.pi/skills`. Report same-name/different-content conflicts rather than selecting a universal winner.
5. **Import MCP by scope, then render native JSON.** Map selected definitions from `A/mcp.json` into canonical user intent and `P/.pi/mcp.json` into canonical project intent. `.agents/mcp.json` remains project-owned canonical input, not pi-native discovery. Render/merge only managed entries back into those two native files, preserving unmanaged entries and native-only fields (`exposure`, ordered `toolExposure`, `description`, OAuth client settings, etc.). Never copy the whole agent directory or settings/auth/trust stores.
6. **Preserve special project overrides.** Keep pi's enabled/exposure-only override as adapter-specific intent associated with its user base. Do not materialize it as a credential-free independent server or inject user credentials into a project file. Complete project replacement remains replacement, not generic recursive merge.
7. **Translate semantic intent, not similar spelling.** Encode canonical Streamable HTTP as pi's accepted HTTP form; reject unsupported legacy SSE. Translate typed env references to `${NAME}` only in supported fields; preserve secret-producing commands as reviewed native-only overrides. Preserve session-relative cwd and server-relative argv semantics, or explicitly bind to an approved absolute/typed path. Resolve Windows executable and path incompatibilities rather than guessing shell wrappers.
8. **Do not whole-file-link MCP by default.** Although strict `mcpServers` resembles other clients, pi-specific override rules, exposure, OAuth/provider auth, and mutable `/mcp` writes make shared-file coupling unsafe. Generate native per-scope files with ownership-aware merging. Do not synchronize tokens, provider auth stores, sign-ins, trust grants, logs, or session state.
9. **Report outcomes separately.** Distinguish materialized intent, discoverability, project trust, MCP-extension capability, and actual runtime connectivity. Writing a file does not establish the remaining states. Any later connection check is an explicit execution/network action, not a harmless synchronization preflight.

## Uncertainties and verification limits

- Native Windows home/path decisions are source-backed plus Node API documentation; neither npm nor bundled-binary Windows behavior was run. The Node documentation explains the Node distribution's resolver; bundled alternative-runtime parity remains unverified.
- Windows directory symlinks, junctions, privilege detection, UNC/network paths, case-only name/path conflicts, and cross-volume links need platform acceptance coverage. The pi source follows links; that does not prove every Windows reparse-point arrangement behaves identically.
- No example MCP package was installed or executed, no public endpoint contacted, and no OAuth flow attempted. The examples are valid native shapes grounded in pi documentation, not connectivity guarantees.
- pi docs say relative stdio cwd is session-relative; tagged source confirms this. Relative command and argument meaning still depends on executable resolution and the server. No migration should infer a config-file-relative base.
- Generic Agent Skills metadata and pi's supported extension metadata are not identical. Preserve portable validity and native fields without claiming all targets enforce them.
- Third-party replacement MCP extensions can use unrelated schemas/paths. This document covers stock built-in behavior only; detect replacement instead of treating these native paths as authoritative for every pi installation.

## Primary sources

- [v1.3.0 configuration documentation][configuration-doc], [settings reference][settings-doc], [CLI reference][cli-doc], [package documentation][packages-doc].
- [v1.3.0 skills documentation][skills-doc], [skill parser/deduplication][skills-source], [resource loader][resource-source], [package discovery/precedence/shared-home resolver][package-source].
- [v1.3.0 MCP documentation][mcp-doc], [MCP scope/merge/writer implementation][mcp-config], [server schema/validation][server-source], [CLI writer/trust behavior][mcp-cli], [runtime/home/cwd construction][runtime-source], [stdio Windows/process/environment implementation][stdio-source], [secret references and shell resolver][secret-source].
- [v1.3.0 security/project-trust documentation][security-doc], [native agent-directory resolver][config-source], [general path normalization][paths-source].
- [Agent Skills specification][skill-spec], [Node `os.homedir()` contract][node-home], [Microsoft symbolic-link creation contract][windows-links].

[configuration-doc]: https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/docs/configuration.md
[settings-doc]: https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/docs/settings.md
[cli-doc]: https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/docs/cli.md
[packages-doc]: https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/docs/packages.md
[skills-doc]: https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/docs/skills.md
[skills-source]: https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/src/core/skills.ts
[resource-source]: https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/src/core/resource-loader.ts
[package-source]: https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/src/core/package-manager.ts
[mcp-doc]: https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/docs/mcp.md
[mcp-config]: https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/src/extensions/mcp/config.ts
[server-source]: https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/src/core/mcp-servers.ts
[mcp-cli]: https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/src/extensions/mcp/cli.ts
[runtime-source]: https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/src/extensions/mcp/runtime.ts
[stdio-source]: https://github.com/earendil-works/pi/blob/v1.3.0/packages/mcp/src/transports/stdio.ts
[secret-source]: https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/src/core/resolve-config-value.ts
[security-doc]: https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/docs/security.md
[config-source]: https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/src/config.ts
[paths-source]: https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/src/utils/paths.ts
[skill-spec]: https://agentskills.io/specification.md
[node-home]: https://nodejs.org/api/os.html#oshomedir
[windows-links]: https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createsymboliclinkw
