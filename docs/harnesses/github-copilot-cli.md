# GitHub Copilot CLI: skills and MCP servers

[Documentation index](../README.md) · [Canonical source and synchronization contract](../source-of-truth.md)

## Product identity and evidence baseline

Research date: **2026-10-20**. This adapter targets the standalone `copilot` agent runtime, not VS Code Copilot, the Copilot cloud agent, or a separate `gh` runtime.

- **CLI-observed, Linux only:** standalone Copilot CLI **1.0.98** and GitHub CLI **2.100.0** (2026-09-04); version/help checks, not skill discovery or MCP execution.
- **Documented:** current GitHub Docs and CLI manuals linked below. These are moving documentation, not a version-pinned specification of the installed binary.
- **Release-backed:** the public Copilot changelog currently reaches **1.0.100** (2026-10-19). Relevant boundaries include 1.0.62 skill symlink loading, 1.0.66 relocated-home isolation, and 1.0.93 ignoring user settings left in `config.json`. These changes precede the observed 1.0.98. The 1.0.100 Windows process-start fixes and `--trust-folder` flag must not be attributed to 1.0.98. [Release history](https://github.com/github/copilot-cli/blob/main/changelog.md)
- **Source-verified utility, not runtime:** GitHub CLI skill placement was inspected at commit [`ed40e856ffecd31286733876c613a2d3745e12bd`](https://github.com/cli/cli/tree/ed40e856ffecd31286733876c613a2d3745e12bd), current trunk, not proven to match the observed `gh` release. The [public Copilot repository](https://github.com/github/copilot-cli) exposes release documentation, not the implementation needed to independently establish every resolver/spawn detail.
- **Not tested:** native Windows, macOS, WSL sessions, links, skill activation, or MCP connectivity. Examples below are documentation examples, not executed package installations.

### `gh`, `gh copilot`, and `gh skill` are different layers

`gh` is GitHub's general command-line client. Its configuration root is controlled by `GH_CONFIG_DIR`; documented defaults consider `XDG_CONFIG_HOME`, Windows `AppData/GitHub CLI`, then `$HOME/.config/gh`. That does **not** relocate Copilot's settings or MCP configuration. [GitHub CLI environment](https://cli.github.com/manual/gh_help_environment)

The current, preview [`gh copilot`](https://cli.github.com/manual/gh_copilot) command launches standalone Copilot from `PATH`, or downloads a managed copy if absent. Arguments can be separated with `--`. It is a launcher, not another resource-discovery adapter. The manual's rendered download example contains a documentation-build `/home/runner/...` path; do not treat that as a portable user path. Do not confuse this launcher with the historical `gh-copilot` extension's suggest/explain workflow.

The preview [`gh skill`](https://cli.github.com/manual/gh_skill) utility searches, installs, updates, and publishes skills for many hosts. It does not run the agent or configure MCP. Its writer paths differ from both native Copilot installation and runtime discovery; see the skills section.

## Paths, scopes, and root resolution

Notation: `P` is a project directory; `H` is the home directory recognized by Copilot; `C` is its native configuration root. GitHub documents the default as `$HOME/.copilot` and a typical Windows path as `C:\Users\YOUR-USER\.copilot`. **The exact native Windows home resolver and environment fallback order are not publicly established here**: the typical example is not a guarantee that blindly substituting `%USERPROFILE%` or `%APPDATA%` reproduces the runtime. Use an explicit configured root when certainty is required. [Configuration directory reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference)

`COPILOT_HOME` replaces the **entire** native `~/.copilot` directory, rather than adding a `.copilot` suffix. The deprecated `--config-dir` also selects a configuration root. `C` below means the selected directory, or default `H/.copilot`. Cache relocation is separate (`COPILOT_CACHE_HOME`) and irrelevant to resource export.

| Resource / scope | Unix path | Native Windows notation | Format / overrides |
| --- | --- | --- | --- |
| Project native skills | `P/.github/skills/<name>/SKILL.md` | `P\.github\skills\<name>\SKILL.md` | Directory + YAML-frontmatter Markdown |
| Project shared skills | `P/.agents/skills/<name>/SKILL.md` | `P\.agents\skills\<name>\SKILL.md` | Directly discovered; no Copilot bridge needed |
| Project compatibility skills | `P/.claude/skills/<name>/SKILL.md` | `P\.claude\skills\<name>\SKILL.md` | Also read by Copilot |
| User native skills | `C/skills/<name>/SKILL.md`, default `~/.copilot/skills/...` | `C\skills\<name>\SKILL.md`; typical default `C:\Users\YOUR-USER\.copilot\skills\...` | Native root follows `COPILOT_HOME` |
| User shared skills | `H/.agents/skills/<name>/SKILL.md` | `H\.agents\skills\<name>\SKILL.md` | Default-home discovery only; relocation caveat below |
| Extra skill roots | Explicit directories | Explicit native directories | `COPILOT_SKILLS_DIRS` is comma-separated; `skillDirectories` is a settings array |
| Project MCP | `P/.mcp.json`, `P/.github/mcp.json` | `P\.mcp.json`, `P\.github\mcp.json` | JSON; trusted workspace ancestor discovery |
| User MCP | `C/mcp-config.json`, default `~/.copilot/mcp-config.json` | `C\mcp-config.json`; typical default under `C:\Users\YOUR-USER\.copilot` | JSON `mcpServers` envelope |
| User settings, not MCP definitions | `C/settings.json` | `C\settings.json` | JSONC; includes skill roots and disabled-resource preferences |
| Internal state, not synchronization input | `C/config.json` | `C\config.json` | Managed authentication/plugin/trust state; user settings here are ignored |

Sources: [skills how-to](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills), [skill locations and environment variables](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference#skill-locations), [MCP discovery](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers#adding-per-repository-mcp-servers), [configuration directory](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference).

**Important relocation exception:** the 1.0.66 [release notes](https://github.com/github/copilot-cli/blob/main/changelog.md) explicitly say “COPILOT_HOME and --config-dir stop loading skills from ~/.agents/skills”. Do not assume user shared skills remain auto-discovered when either override is set. This is an isolation behavior, not evidence that a new shared root is derived from the override. An adapter can propose explicitly adding the canonical user skill directory through `skillDirectories` or `COPILOT_SKILLS_DIRS`; the exact explicit-directory behavior with a relocated home still needs runtime acceptance verification. Project `.agents/skills` support does not imply `.agents/mcp.json` discovery.

WSL runs use Linux home paths and Linux executables. A Windows Copilot process and a WSL Copilot process are separate targets even if they access the same checkout.

## Skills

### Portable directory and metadata

A complete minimal skill needs only the directory and `SKILL.md`; optional supporting resources must travel with it. The same tree works at project `.agents/skills` or default-home user `H/.agents/skills`:

```text
.agents/skills/review-api/
└── SKILL.md
```

`SKILL.md`:

```markdown
---
name: review-api
description: Review API contract changes. Use when reviewing endpoint, request, or response compatibility.
---

Compare the changed API against its existing callers and documented contract.
Identify breaking request or response changes and explain each affected caller.
Ask before running commands or contacting an external service.
```

Use the [Agent Skills specification](https://agentskills.io/specification.md) naming subset: lowercase letters/numbers/hyphens, matching directory name, plus required `description`. Copilot's reference allows a broader native name alphabet, including namespaced names; these are not automatically portable. `license`, `compatibility`, and `metadata` are standard optional fields, although complete Copilot handling of every standard optional field was not source-verified.

Copilot also documents `argument-hint`, `user-invocable`, and `disable-model-invocation`. Preserve these as native behavior rather than assuming other harnesses understand them. `allowed-tools` exists experimentally in the standard, but Copilot uses its own tool identifiers, string/list syntax, and permission semantics; it is not a portable permission grant. Omit automatic tool grants in shared examples. [Frontmatter reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference#skill-frontmatter-fields)

### Discovery, collisions, activation, and trust

The documented location priority is **first found wins for duplicate skill names**:

1. Project `.github/skills`.
2. Project `.agents/skills`.
3. Project `.claude/skills`.
4. Parent `.github/skills` for monorepo inheritance.
5. User native `C/skills`.
6. User `H/.agents/skills`, subject to the relocation exception.
7. Plugin skills.
8. `COPILOT_SKILLS_DIRS` custom roots.
9. `.github/skills` under explicitly added directories (`--add-dir`, `/add-dir`, or SDK additional directories).
10. Built-in skills; remote organization/enterprise projections also participate in name-based resolution.

This is the table in the [current command reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference#skill-locations), not an independently inspected runtime algorithm. It explicitly identifies **parent `.github/skills`**, not an all-ancestor `.agents/skills` or `.claude/skills` walk. Its exact parent-walk stop condition, non-Git behavior, ordering of configured `skillDirectories` versus other custom roots, and remote/local tie details remain unestablished. Do not borrow MCP's Git-root boundary for skills. Two plugins can retain qualified invocation names even when a bare name collides.

Copilot chooses skills by description, or users invoke `/review-api`. `/skills reload` refreshes discovery and `/skills info` reports location. `disabledSkills` suppresses loading by name; `ignoredSkillsLocations` excludes directories and descendants. Added roots are a trust decision and their skills have project-skill trust. Skill discovery is not permission to execute scripts: review instructions and executable resources, and avoid `allowed-tools: shell`/`bash` grants unless intentionally trusted. The docs establish a folder-trust gate for **project MCP**, but do not justify assuming identical gating for every skill source. [Skills usage and security warning](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills)

Release 1.0.62 explicitly added loading skills from symlinked directories outside the configured root, and later release notes mention deduplicating symlinked scan roots. This supports per-skill link bridges where necessary, not an unconditional claim that every Windows link/junction or out-of-root permission configuration works. Direct `.agents/skills` discovery is simpler and preferred.

### Reader paths versus installation writer paths

| Utility | Documented/source-backed write behavior | Consequence |
| --- | --- | --- |
| `copilot skill add FILE` or URL | Copies content into personal native skills by default | Does not default to the shared user root; importing one file does not prove adjacent assets were copied |
| `copilot skill add --project FILE` or URL | Copies into project `.github/skills` | This is higher-priority than project `.agents/skills` |
| `copilot skill add DIRECTORY` | Registers a custom skill source instead of copying it | Preserve directory registration separately; do not describe it as installation into `.agents` |
| `gh skill install --agent github-copilot --scope project` | Current utility source selects Git root `.agents/skills` | Different from native Copilot's project writer |
| `gh skill install --agent github-copilot --scope user` | Current utility source selects home `.copilot/skills` | Does **not** honor `COPILOT_HOME` in the inspected resolver |
| `gh skill install --dir DIRECTORY` | Explicit placement overrides host/scope placement | Can target canonical skills deliberately; resolve native absolute path first |

The `gh` installer copies local skills rather than symlinking them and adds source-tracking frontmatter for updates. Preserve tracking metadata during adoption; avoid competing `gh skill update` and synchronizer ownership of the same materialized directory. Its default scope is project, whereas `copilot skill add` defaults to user. Sources: [native skill writer](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference#managing-skills-non-interactively), [`gh skill install`](https://cli.github.com/manual/gh_skill_install), [host registry and `InstallDir`](https://github.com/cli/cli/blob/ed40e856ffecd31286733876c613a2d3745e12bd/internal/skills/registry/registry.go), [`ResolveHomeDir` uses `os.UserHomeDir`](https://github.com/cli/cli/blob/ed40e856ffecd31286733876c613a2d3745e12bd/internal/skills/installer/installer.go). This utility source does not establish Copilot runtime home resolution.

## MCP servers

### Native format and examples

Use the explicit `mcpServers` envelope for both scopes. Project files also accept a bare top-level server-name map, but normalizing to an envelope avoids ambiguity. `.vscode/mcp.json` is **not read**; its `servers` envelope is incompatible. [MCP configuration how-to](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers)

**Project example:** `P/.mcp.json` on Unix, `P\.mcp.json` on native Windows. This is the documented public Context7 endpoint; provider availability, terms, authentication, and actual connection were not tested.

```json
{
  "mcpServers": {
    "context7": {
      "type": "http",
      "url": "https://mcp.context7.com/mcp",
      "tools": ["*"]
    }
  }
}
```

**User example:** `C/mcp-config.json` on Unix, `C\mcp-config.json` on native Windows. This uses the real Playwright MCP package from GitHub's documentation; the package is not installed or executed by this guide. The shown `npx` command is the documented example, **not a verified native Windows launcher spelling**.

```json
{
  "mcpServers": {
    "playwright": {
      "type": "stdio",
      "command": "npx",
      "args": ["@playwright/mcp@latest"],
      "env": {},
      "tools": ["*"]
    }
  }
}
```

Do not silently run the package during import. Resolve and approve a host-specific executable before enabling stdio on Windows, or use the remote example when appropriate. Reproducible deployments should choose an explicitly reviewed package version rather than treating `@latest` as a stable pin.

The same envelope can be used in `.github/mcp.json` for committed repository definitions or in user configuration for global definitions. No user/project nesting exists inside this envelope; scope comes from the file location.

### Transports, environment, paths, and native-only fields

Copilot documents:

- `stdio` and `local` as equivalent subprocess transports; `command`, `args`, and `tools` are required in the command reference. Generate all three even though some how-to project snippets omit `tools`.
- `http` for Streamable HTTP; `streamable-http` is an accepted alias normalized to `http`.
- `sse` for legacy HTTP+SSE, still supported but not equivalent to Streamable HTTP. Preserve it as a distinct compatibility requirement when exporting to a harness without SSE.
- `tools: ["*"]` exposes all server tools; preserve an existing explicit allowlist or empty list rather than broadening access.
- `env` values support `$VAR`, `${VAR}`, and `${VAR:-default}`; remote `headers` support variable expansion. For example, a non-secret literal configuration fragment is `"headers": {"CONTEXT7_API_KEY": "${CONTEXT7_API_KEY}"}`. Provision the value locally, not in canonical files. These are Copilot expansion expressions, not PowerShell `%VAR%`/`$env:VAR` syntax. Escaping/literal-dollar edge cases were not established.
- The how-to says `PATH` is automatically inherited and other server environment variables must be configured. Older release notes additionally describe referenced environment variables in `command`, `args`, or `cwd` being included automatically. Do not assume a stdio process receives the entire parent environment, or that token redaction is a portable secret store.
- `cwd` sets server working directory; release notes confirm it is respected and support `~` expansion. The default working directory and base for **relative** `cwd`, executable paths, and path arguments were not conclusively established. Do not rebase them to the config file's directory merely because the JSON file moved.
- Native fields include `timeout`, `deferTools`, `disableToolCache`, `slowConnectionThresholdMs`, `filterMapping`, OAuth configuration, and `oidc`. Preserve native-only fields without implying every target has equivalent behavior. Static OAuth client identifiers/scopes are configuration; client secrets, registration results, access/refresh tokens, and trust decisions are not portable synchronization data.

Sources: [transport and field reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference#transport-types), [remote fields](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference#remote-server-configuration-fields), [release history](https://github.com/github/copilot-cli/blob/main/changelog.md). The directory reference identifies `mcp-secrets/` and `mcp-oauth-config/` as local fallback storage; it does not establish a portable secret-placeholder syntax. Do not reinterpret native stored placeholders as ordinary environment variable expressions.

### Discovery, merge precedence, trust, and writers

Within a Git repository Copilot searches from the current working directory upward to the Git root. At each level it reads `.mcp.json` and `.github/mcp.json`; `.mcp.json` wins at the same directory, and definitions nearer the current directory win over ancestors on the same server name. Non-conflicting servers merge. Workspace definitions beat user `mcp-config.json`. Current documented overall precedence is:

1. `--additional-mcp-config`.
2. Plugin-provided servers.
3. Trusted workspace files, with the distance/name rules above.
4. User `C/mcp-config.json`.

This is not a universal project-over-user policy across all harnesses or all resource categories. Malformed workspace files are skipped; invalid individual entries are skipped while valid siblings continue, with warnings. Non-Git discovery boundaries are not established by the cited Git-repository description. [Discovery how-to](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers#adding-per-repository-mcp-servers), [loading priority](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference#mcp-server-loading-priority)

Project MCP files are skipped in untrusted directories. In prompt mode trusted-directory configurations load; untrusted workspace MCP is skipped by default, with an explicit opt-in through `GITHUB_COPILOT_PROMPT_MODE_WORKSPACE_MCP=true`. Do not set this automatically during synchronization. Version 1.0.100 adds one-session `--trust-folder`; that is later than the observed 1.0.98. Tool permission checks, remote authentication, enterprise allowlists, and resource discovery are separate controls. Enterprise MCP allowlist failure can block connections even when a local definition is valid. [Trust and enterprise policy](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference#mcp-server-trust-levels)

`copilot mcp add` writes **user** `C/mcp-config.json`; it is not a project writer. `copilot mcp remove` removes user entries, while workspace entries must be edited in their originating files. Do not mistake `copilot config --repo` (repository settings) for MCP creation. Inspecting an effective merged server also does not identify a safe write destination unless its source is retained. [MCP subcommands](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference#managing-mcp-servers-non-interactively)

## Unix and native Windows implementation notes

- **Executable launch:** keep `command` and `args` separate, not one shell command string. Shell expansion, pipes, redirections, and quoting are not implied by JSON argv fields. The exact Copilot Windows spawn resolver and treatment of `.cmd`/`.bat` launchers were not verified; do not automatically rewrite `npx` to `npx.cmd` or insert `cmd /c`. Select a supported executable/provider configuration through platform-specific acceptance checks. The 1.0.100 changelog's Windows process-snapshot startup fix is evidence that subprocess behavior is release-sensitive, not evidence that 1.0.98 was tested.
- **Paths in JSON:** backslashes need escaping (`"C:\\src\\repo"`). Never copy Unix absolute paths, WSL `/mnt/c/...` paths, or shell `~` expansion assumptions into native Windows configuration. Use explicit absolute `cwd` only when its intended semantics are known; otherwise flag unresolved path interpretation.
- **Links:** direct shared skill discovery avoids privilege and reparse-point problems. Windows unprivileged symbolic-link creation requires Developer Mode and the appropriate API flag; otherwise suitable privileges are needed. Junction behavior is not proven identical to Copilot skill symlink loading. Materialize a skill directory where a verified link cannot be created/read; do not silently replace a user's directory with a link. [Windows symbolic-link API](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createsymboliclinkw)
- **Permissions and scripts:** preserve Unix executable bits for skill scripts; Windows requires an appropriate interpreter/runtime, not a POSIX executable bit. This is another reason to copy the full skill tree and retain platform requirements instead of only `SKILL.md`. No Bash installation or generic shell wrapper is implied.
- **Root relocation:** use explicit resolved paths for `COPILOT_HOME`, canonical shared roots, and extra roots. `GH_CONFIG_DIR` is independent. Do not copy all native state to a shared directory as a way to relocate only skills/MCP.

## Import, synchronization, and cutover guidance

These are **source-backed adapter recommendations**, not claims that Copilot itself implements a synchronization tool. See the [mishmash README](../../README.md) for the implemented CLI and limitations. The canonical model is defined in [source-of-truth](../source-of-truth.md); `.agents/mcp.json` is mishmash input, not native Copilot MCP discovery.

1. **Inventory by origin and scope.** Import project `.github/skills`, `.claude/skills`, `.agents/skills` and discovered inherited roots as distinct origins. Import user `C/skills`, eligible `H/.agents/skills`, and registered custom roots separately. Record enabled/disabled status, resolved names, duplicate winners, plugin ownership, source-tracking metadata, and paths without promoting user resources into project scope. Do not flatten inherited monorepo directories into one root.
2. **Adopt skills into canonical trees.** Copy the full owned skill directory to project `.agents/skills/<name>` or user `H/.agents/skills/<name>` (native Windows `H\.agents\skills\<name>`), preserving assets and permissions. If already canonical, leave it in place. Review same-name, case-folding, and content conflicts explicitly. A project `.github/skills` copy shadows canonical `.agents/skills`; a user native `C/skills` copy similarly shadows shared user skills. After approved adoption, remove only obsolete managed duplicates, not unrelated user entries. Do not leave an old higher-priority copy that masks the new source.
3. **Prefer native discovery, then bridges.** Default-home Copilot can consume canonical skills directly at both scopes. With `COPILOT_HOME`/`--config-dir`, explicitly configure the canonical user root and verify discovery rather than relying on default shared discovery. Use per-skill links only when a necessary target cannot discover the canonical location and link behavior is verified; materialize otherwise. Cross-harness consumers that discover `.agents` can read the same tree; a Claude-specific bridge belongs in that adapter. Preserve native permission/activation metadata or report incompatibility instead of treating automatic tool grants as portable.
4. **Import MCP definitions, not effective state.** Parse each project source file and user `C/mcp-config.json` into the normalized canonical project/user MCP inputs. Retain source-file ancestry and precedence rather than exporting the winning merged map globally. Preserve unmanaged native entries and native-only fields; keep plugin-contributed and built-in servers outside file ownership. A VS Code import must explicitly convert `servers` to `mcpServers` **and** review variables, inputs, authentication, and fields; changing only the envelope does not prove semantic compatibility.
5. **Generate native MCP files.** Emit managed project entries into an agreed `.mcp.json` or `.github/mcp.json`, and user entries into `C/mcp-config.json`. Merge only owned server entries with existing content; report name conflicts before replacement. Do not symlink the whole file unless all entries and future writers have one owner and identical semantics. Preserve nesting/discovery placement for subprojects. Resolve relative paths according to demonstrated source semantics before moving them; unknown base directories are migration conflicts, not a license to guess.
6. **Keep credentials and trust local.** Store portable environment-variable requirements/references, not values. Do not synchronize `config.json`, `permissions-config.json`, `mcp-secrets/`, `mcp-oauth-config/`, tokens, credential-store contents, or folder approvals. Preserve relevant local disabled-resource preferences without exporting permission decisions. Remote servers must authenticate on the target machine; project MCP still requires its native trust decision.
7. **Clean cutover, not parallel competing ownership.** Once reviewed canonical content and native projection are ready, retire only superseded managed sources and point future installation/update ownership at canonical roots. Keep unrelated native resources untouched. Do not remove project configuration merely because a user entry currently wins elsewhere, and do not assume copying a server definition makes transports, commands, secret references, or approval policies compatible across harnesses.

## Explicit uncertainties and verification limits

- Runtime Copilot implementation was not publicly source-inspected; documented resolver behavior is not equivalent to source-verified behavior. Native Windows home fallback order, `.cmd` execution, junction traversal, and skill ancestor stop conditions remain unresolved.
- Default shared user skills are documented, but relocation isolation is established by release notes; the generic skills path table omits that caveat. Treat the more specific release-backed exception as a compatibility constraint.
- Relative MCP working-directory/argument semantics, the complete expansion surface and escaping behavior, and native stored secret-placeholder grammar need targeted verification before lossless path/secret translation.
- The MCP how-to and command reference differ in whether sample configurations include `tools`; this guide emits it explicitly. Other moving documentation can get ahead of the observed release.
- `gh skill` placement is source-backed for the pinned current-trunk commit, not exercised behavior of local `gh` 2.100.0. Its failure to honor `COPILOT_HOME` must not be silently attributed to the Copilot runtime itself.
- No package execution, actual server connection, skill reload, trust prompt, Windows command, or symlink behavior was tested. Future acceptance checks should cover both scopes, nested repository launch directories, default/relocated homes, collisions, unmanaged-entry retention, and Unix/native-Windows process/link behavior separately.
