# Gemini CLI: skills and MCP servers

[Documentation index](../README.md) · [Canonical source of truth](../source-of-truth.md)

## Identity and evidence baseline

Research date: **2026-10-20**. This adapter targets Google's `@google/gemini-cli`, executable `gemini`, with implementation evidence pinned to **v0.64.0**, commit `4a0749aceac5643e6f85a36d7420314d85e13b52`. Preliminary Linux checks observed version `0.64.0` and CLI help only; skill discovery, server connections and installation were **not runtime-tested**. Native Windows was not executed. Current website documentation is separately identified where it disagrees with the tag. This is not an Antigravity CLI adapter. [S1]

**Integration summary:** Gemini directly discovers project and user `.agents/skills`; MCP definitions still require native `.gemini/settings.json` generation. `.agents/mcp.json` is mishmash's canonical input, **not** a Gemini discovery path. The normalized model and ownership rules belong to [source-of-truth](../source-of-truth.md).

## Paths, scopes and home resolution

Let `P` be the workspace directory supplied to Gemini, normally its launch working directory. Let `H` be Gemini's `homedir()` result: a nonempty `GEMINI_CLI_HOME`, otherwise Node `os.homedir()`. Node uses `HOME` on Unix, falling back to the effective user's home; native Windows uses `USERPROFILE`, falling back to the current user's profile directory. This is **not** an `APPDATA`/XDG config resolver. [S2][S3]

| Resource | Project: Unix / native Windows | User: Linux and macOS | User: native Windows | Format / override |
| --- | --- | --- | --- | --- |
| Shared skills, directly read | `P/.agents/skills/<name>/SKILL.md` / `P\.agents\skills\<name>\SKILL.md` | `H/.agents/skills/<name>/SKILL.md`, normally `~/.agents/skills/...` | `H\.agents\skills\<name>\SKILL.md`, normally `%USERPROFILE%\.agents\skills\...` | Directory and Markdown/YAML; `GEMINI_CLI_HOME` changes `H` |
| Native skills, directly read | `P/.gemini/skills/<name>/SKILL.md` / `P\.gemini\skills\<name>\SKILL.md` | `H/.gemini/skills/<name>/SKILL.md` | `H\.gemini\skills\<name>\SKILL.md` | Same skill format; `GEMINI_CLI_HOME` changes `H` |
| Native skill install/link destination | `P/.gemini/skills/<name>` / `P\.gemini\skills\<name>` | `H/.gemini/skills/<name>` | `H\.gemini\skills\<name>` | `--scope workspace` vs `--scope user` (default) |
| Settings, including MCP | `P/.gemini/settings.json` / `P\.gemini\settings.json` | `H/.gemini/settings.json` | `H\.gemini\settings.json` | JSON with comments accepted; no verified `.jsonc` filename alias |

**`GEMINI_CLI_HOME` replaces the HOME root, not the `.gemini` directory.** For example, `/srv/gemini-home` selects `/srv/gemini-home/.gemini/settings.json` **and** `/srv/gemini-home/.agents/skills`. Setting it to `/srv/gemini-home/.gemini` would produce a second `.gemini` component. Windows `D:\GeminiHome` similarly selects `D:\GeminiHome\.gemini\settings.json` and `D:\GeminiHome\.agents\skills`. Source returns the override verbatim; use an absolute root rather than depending on launch-directory resolution. The shared skill root therefore relocates together with the native root; it does not independently stay under the OS home. [S2]

For completeness, lower-precedence system defaults and higher-precedence system overrides affect MCP merging: Linux `/etc/gemini-cli/{system-defaults,settings}.json`; macOS `/Library/Application Support/GeminiCli/{system-defaults,settings}.json`; native Windows `C:\ProgramData\gemini-cli\{system-defaults,settings}.json`. `GEMINI_CLI_SYSTEM_SETTINGS_PATH` overrides the settings file; absent a separate `GEMINI_CLI_SYSTEM_DEFAULTS_PATH`, defaults use `system-defaults.json` beside that resolved system settings file. These are administrative layers, not synchronization output targets. [S4]

Settings load from the supplied workspace directory, not an ancestor walk. When the workspace resolves to `H`, Gemini avoids loading the same user settings again as a workspace layer. Skill discovery also uses the specific workspace's two skill roots; the inspected manager does not walk ancestor projects or scan every added directory. Do not transfer `GEMINI.md` ancestor behavior to skills/MCP. WSL uses the Linux process, home resolver and paths, separately from native Windows. [S2][S4][S5]

## Skills

### Portable layout and metadata

Use the same directory at project `P/.agents/skills/review-changes/` or user `H/.agents/skills/review-changes/` (Windows: `P\.agents\skills\review-changes\` or `H\.agents\skills\review-changes\`):

```text
review-changes/
├── SKILL.md
├── references/
│   └── checklist.txt
└── assets/
    └── review-template.txt
```

Complete `SKILL.md`:

```markdown
---
name: review-changes
description: Review a proposed code change for correctness and regressions. Use when asked for a change review.
license: Apache-2.0
metadata:
  owner: engineering
---

# Review changes

1. Read the proposed change and its surrounding code.
2. Apply the checks in references/checklist.txt.
3. Present findings using assets/review-template.txt.
4. Explain any platform assumptions; do not execute bundled code without approval.
```

For this example, `references/checklist.txt` can contain `Check behavior changes, error paths, and regression coverage.` and `assets/review-template.txt` can contain `Finding: ...; evidence: ...; impact: ...`. The supporting files are ordinary skill resources, not Gemini settings.

The Agent Skills standard requires nonempty `name` and `description`, a name matching the directory, and portable lowercase alphanumeric/hyphen naming. Optional standard fields include `license`, `compatibility`, `metadata`, and experimental `allowed-tools`. Gemini v0.64.0 actually extracts only **name and description** into its skill definition; it does not establish enforcement of `allowed-tools` or other optional metadata. Its parser is more permissive than the standard and sanitizes `:`, slash, backslash and other Windows-invalid filename characters to `-`. Preserve original metadata, but do not rely on permissive parsing or silent name changes when migrating across harnesses. Disabled/built-in/extension flags are Gemini runtime/settings data, not portable frontmatter. [S6][S7]

### Discovery, precedence and activation

The loader checks `SKILL.md` and `*/SKILL.md` under each configured root, not arbitrary nested skill collections. A canonical root should contain one directory per skill, with the full supporting tree kept together. [S7]

The source loads from low to high precedence:

1. Built-in skills.
2. Active extension skills.
3. User `.gemini/skills`.
4. User `.agents/skills`.
5. Trusted workspace `.gemini/skills`.
6. Trusted workspace `.agents/skills`.

A later skill replaces an earlier skill with the **same name**, with conflict warnings; `.agents` wins over `.gemini` within the same tier. This is not a reason to keep duplicate authoritative copies. Merge keys are case-sensitive, while later skill lookup/disable checks are case-insensitive: avoid names differing only by case, especially on Windows. Ordering of duplicate names within one directory's glob results is not a stable precedence contract. [S5][S7]

Workspace skills are skipped unless the folder is trusted; user skills are still discovered. `skills.enabled` defaults to `true`; `skills.disabled` is a union-merged list of disabled names, and administrative controls may disable skills. Discovery exposes metadata; activation uses `activate_skill`, normally requests consent for non-built-ins subject to the active approval policy, injects the skill body/folder structure, and adds the skill directory to allowed workspace file access. Direct discovery does not itself grant permission to execute all bundled scripts. [S5][S8][S9]

### Native installation and linking are separate from shared discovery

`gemini skills install` copies a local, Git, or `.skill` archive source into **`.gemini/skills/<parsed-name>`**, not `.agents/skills`. `gemini skills link` creates one directory link per discovered skill at the same native destination. Both use scope `user` by default or `workspace` explicitly, request consent, and can remove/replace an existing same-name native destination. Installation is a copy, not a live shared-source relationship. [S10]

Examples below are usage examples, **not commands run during research**. The source is a local skill library outside Gemini's discovery roots; it must already contain the example skill above.

Unix shell:

```sh
gemini skills link ./skill-library/review-changes --scope workspace
gemini skills install ./skill-library/review-changes --scope user
```

Native Windows PowerShell:

```powershell
gemini skills link '.\skill-library\review-changes' --scope workspace
gemini skills install '.\skill-library\review-changes' --scope user
```

The link implementation uses `fs.symlink(..., 'dir')` on Unix and **`'junction'` on Windows**, explicitly to avoid directory-symlink elevation/Developer Mode requirements. It resolves the source to an absolute local path before creating the link. Filesystem restrictions can still fail; this is source evidence, not a Windows execution result. A portable shared `.agents/skills` deployment needs **no Gemini-specific link**. Do not run native install/link onto a source that is already the same native destination; these writers overwrite destinations. Arbitrary network-filesystem/UNC junction behavior was not established. [S10]

## MCP configuration

### Envelope, format and scope

MCP lives under **top-level `mcpServers`**, alongside other Gemini settings. The separate top-level `mcp` object controls global filtering/settings; it is not the server-definition envelope. Project settings override user settings only when trusted, and system overrides can override both. `mcpServers` uses a **shallow map merge**: different server names accumulate, but a higher-precedence same-name entry replaces the **whole server definition**, not individual fields. Preserve complete entries when overriding. [S4][S9]

`settings.json` is read with `JSON.parse(stripJsonComments(content))`: `//` and block comments work, but v0.64.0's pinned `strip-json-comments` 3.1.1 does not provide trailing-comma removal. Treat this as JSON-with-comments, **not unrestricted JSONC**; emit strict JSON unless preserving an existing file's comments. The native writer uses a comment-preserving JSON editor. Do not rename the file to `settings.jsonc`. [S4][S11]

Minimal project stdio example: **`P/.gemini/settings.json`** (Windows `P\.gemini\settings.json`). This uses the real GitHub MCP server's documented native-binary interface; the binary must already be installed and discoverable on PATH, and the caller must supply the referenced secret in the environment. No binary/package execution was verified. [S12]

```json
{
  "mcpServers": {
    "github-local": {
      "command": "github-mcp-server",
      "args": ["stdio"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_MCP_PAT}"
      },
      "trust": false
    }
  }
}
```

Minimal user remote example: **`H/.gemini/settings.json`** (Windows `H\.gemini\settings.json`). This is GitHub's real hosted endpoint, translated to the v0.64.0 preferred HTTP fields; it requires authentication and is not an anonymous working-server claim. Do not persist expanded token values. [S12][S13]

```json
{
  "mcpServers": {
    "github-remote": {
      "url": "https://api.githubcopilot.com/mcp/",
      "type": "http",
      "headers": {
        "Authorization": "Bearer ${GITHUB_MCP_PAT}"
      },
      "trust": false
    }
  }
}
```

For a Windows native binary outside PATH, a server entry can use `"command": "C:\\Tools\\GitHub MCP\\github-mcp-server.exe"`; Unix might use `"command": "/opt/github-mcp-server/github-mcp-server"`. These paths are illustrative deployment locations, not asserted installations. Supply `args` separately; do not add shell quotes inside `command`. On Unix the binary needs executable permission; copying a skill does not make its scripts cross-platform.

### Transport and native-only fields

| Transport | Preferred v0.64.0 fields | Important semantics |
| --- | --- | --- |
| stdio | `command`, optional `args: string[]`, `env: object`, `cwd: string` | Spawned subprocess, protocol on stdin/stdout; no `type: "stdio"` needed |
| Streamable HTTP | `url`, `type: "http"`, optional `headers` | Preferred explicit remote form |
| Legacy SSE | `url`, `type: "sse"`, optional `headers` | Still implemented; do not rewrite it as HTTP without checking the server |
| Deprecated HTTP form | `httpUrl`, optional `headers` | Still read; `httpUrl` wins if both URL fields exist; migrate to `url` plus `type: "http"` |
| Auto-selection | `url` without `type` | Tries HTTP first, with SSE fallback on connection failures under the source's conditions; not "always SSE" |

A syntactically complete SSE entry is `{"mcpServers":{"legacy":{"url":"https://mcp.example.com/sse","type":"sse"}}}`. The `example.com` endpoint is **illustrative only**, not a usable server. Do not configure command and remote URLs together; URL transport wins in the inspected implementation. The `tcp` field exists in the config type, but the examined transport factory only creates stdio/HTTP/SSE; do not advertise WebSocket/TCP transport based on that unused-looking field. [S13]

Common native fields include `timeout` (milliseconds; connection/request default 600,000), `trust`, `description`, `includeTools`, and `excludeTools`; exclusions take priority. `trust: true` bypasses server tool-call confirmations and is **not** workspace trust. Remote auth configuration includes `oauth`, `authProviderType` (`dynamic_discovery`, `google_credentials`, `service_account_impersonation`), `targetAudience`, and `targetServiceAccount`. Preserve these as native-only settings where the canonical model cannot express their semantics; do not translate them into generic bearer credentials. Native MCP enable/disable state and global allow/exclude controls are also not equivalent to deleting a server. [S9][S13][S14]

### Environment expansion, secrets and working directory

There are two source-verified expansion stages, not a shell:

- Settings loading recursively resolves string values containing `$NAME`, `${NAME}`, and `${NAME:-fallback}`. Undefined names without a fallback remain placeholders at this stage. This applies beyond `env`, including URL, command, args and cwd strings. The generic settings resolver does **not** implement Windows `%NAME%` syntax. [S4][S15]
- When building MCP transports, explicit `env` values and HTTP headers are expanded again against a **sanitized** process/extension environment. This stage supports `$NAME`/`${NAME}` on all platforms and `%NAME%` on native Windows only; missing names become empty strings. Sensitive inherited variables are filtered, explicit dangerous execution overrides such as `NODE_OPTIONS` are blocked, and the SDK also merges a safe default environment. It is incorrect to promise that MCP receives the complete parent environment unchanged. [S13][S16][S17]

Prefer `${NAME}` in generated configuration on both OSes. The examples reference a secret supplied by the caller before Gemini starts, so the ordinary settings expansion resolves it first. Do not assume every missing-variable expression or `%SECRET%` will survive sanitization, and never expand secrets into synchronized files. `.env` discovery/loading has its own trust and exclusion rules; do not synchronize those files or assume a project's `.env` is always loaded. [S4][S15][S16]

Gemini passes `cwd` directly to the SDK without rebasing it to the settings file directory. The pinned SDK passes it unchanged to `cross-spawn`; omitted cwd uses the parent's working directory. A relative cwd is therefore launch-directory-relative, **not** relative to `.gemini/` or the user settings directory. Relative script/file arguments are interpreted by the child program from its cwd. Command lookup uses PATH/platform executable resolution rather than a shell command string. An adapter must record this provenance before moving a definition between scopes or machines; use a known absolute cwd or explicitly preserve project-relative execution semantics rather than changing the base silently. [S13][S17][S18]

### Trust, precedence and CLI writer

**Documentation discrepancy:** the tag's trusted-folders guide says trust is disabled by default, but the v0.64.0 settings schema sets `security.folderTrust.enabled: true`, and `isFolderTrustEnabled` independently falls back to `true`. Treat the implementation as the release baseline: a folder without a trust decision is not automatically trusted. Untrusted workspace settings are excluded from the effective merge; project skills are not discovered; the MCP manager declines to start configured servers, including user-defined servers. Reading/writing a config entry is not proof that a server is allowed to run. Do not turn off trust to make synchronization appear successful. [S4][S5][S9][S19]

The default MCP writer scope is **project**, unlike the skills writers' default **user** scope. `gemini mcp add --scope user` writes user settings; `--scope project` writes the current workspace settings. The writer replaces a same-name entry and supports `--transport stdio|http|sse`, repeated `--env`, `--header`, timeout, trust, description and tool filters. Its inspected CLI does not expose a cwd option, although the settings format supports cwd. Its `--env` parsing splits on `=` without preserving additional `=` characters; use structured config editing for such values and other fields not representable by the CLI. [S20]

An illustrative native writer command works with either Unix shell or PowerShell syntax as written (it stores the real URL but does not authenticate or test the connection):

```text
gemini mcp add --scope user --transport http github-remote https://api.githubcopilot.com/mcp/
```

Do not use the writer as a lossless round-trip API for existing native-only fields. The adapter should reconcile managed server entries into the chosen settings file while preserving unrelated top-level settings, unmanaged servers, comments and unresolved environment references.

## Unix and native Windows materialization

- **argv, not shell source:** the pinned MCP SDK 1.23.0 uses `cross-spawn` with `shell: false`. Unix does not interpret pipelines, redirects or shell variable assignments in a `command`. Native Windows is more nuanced: locked `cross-spawn` 7.0.6 resolves commands, handles shebangs/PATH/PATHEXT, and invokes `cmd.exe /d /s /c` internally for non-`.exe`/`.com` commands with escaping, including npm `.cmd` shims. Thus generic advice to add `cmd /c` or replace every `npx` with `npx.cmd` is not established as necessary here. Preserve executable/argv structure; do not add an extra shell wrapper by default. PowerShell functions and aliases are not executable resolution contracts. [S11][S17][S18]
- **JSON encoding:** Windows backslashes must be escaped (`"C:\\work\\project"`). Spaces belong in the path string, not embedded shell quotes. Keep executable resolution platform-specific; Unix absolute binaries/scripts are not Windows executable paths.
- **Links:** native skill linking deliberately uses Windows directory junctions rather than requiring privileged symlinks. Prefer Gemini's direct shared-root discovery anyway; do not link all of `.gemini` to canonical content because it contains settings, identity and runtime state as well as skills. Junction/symlink target availability, ACLs, network volumes and case collisions remain platform constraints. [S2][S10]
- **Relocation:** `GEMINI_CLI_HOME` changes both native settings and shared skill roots. If the canonical user root remains under Node's OS home while Gemini is relocated, direct user discovery no longer reaches it; either align roots intentionally or create per-skill native links/materialized copies under the relocated Gemini home. Do not silently move canonical data for other harnesses.
- **WSL:** resolve a separate Linux profile and Linux executable paths; do not reuse native Windows junctions, `%USERPROFILE%` paths or `.exe` launch assumptions as though the processes shared one filesystem/command environment.

## Migration and synchronization recommendation

The following is **source-backed adapter guidance**, not an existing Gemini synchronization feature. See the [mishmash README](../../README.md) for the implemented CLI and limitations; file generation does not establish native activation:

1. **Inventory each scope separately.** Discover `P/.gemini/skills`, `P/.agents/skills`, `H/.gemini/skills`, `H/.agents/skills`, plus the selected scope's native settings `mcpServers`. Resolve `H` with the exact resolver above. Account for system overrides and trust when explaining what is effective, without adopting administrative configuration or stored trust decisions.
2. **Adopt skills as whole directories.** Map project native `P/.gemini/skills/<name>` to canonical `P/.agents/skills/<name>`; map user native `H/.gemini/skills/<name>` to canonical user `.agents/skills/<name>` under the agreed canonical home. Copy supporting assets, metadata, executable modes where meaningful, and relative references together. Compare contents and link targets before moving anything. Report `.agents`-wins conflicts, sanitized-name collisions and case-only collisions instead of silently choosing a winner.
3. **Prefer direct skill discovery.** Once the canonical directory is at a Gemini-discovered shared root, no native copy/link is necessary. Remove only explicitly adopted obsolete native duplicates after a deliberate cutover; never delete unmanaged skills. Where root relocation prevents direct discovery, use per-skill directory symlinks on Unix or the native Windows junction behavior, or materialize copies when links are unsupported. Track ownership so native install/link overwrites do not destroy canonical data.
4. **Import MCP definitions, not entire settings files.** Record source scope and execution base, convert supported transport/command/argv/env-reference/header/cwd information into the normalized model, and retain native-only auth/tool filtering/timeout fields as harness-specific data. Exclude credential values, OAuth tokens and trust/approval state. Materialize the selected entries back into that scope's `.gemini/settings.json`; `.agents/mcp.json` alone has no effect on Gemini.
5. **Reconcile without semantic changes.** Preserve unmanaged servers and unrelated settings; emit complete same-name server entries because Gemini's map merge is shallow. Convert deprecated `httpUrl` to explicit HTTP only after resolving dual-field conflicts. Preserve explicit SSE, report automatic-transport ambiguity, and resolve relative cwd/command arguments from their original launch context before relocating them. Do not flatten project and user entries into one scope.
6. **Report runtime prerequisites separately.** A correctly materialized project may still be untrusted, an environment reference may be unavailable, and an executable may not exist on the target OS. Do not synchronize secrets, trust files, OAuth caches, account files, histories or the whole `.gemini` directory to bypass these boundaries. Discovery/connection/activation acceptance requires a separately approved runtime exercise on each target platform.

## Explicit limits and unresolved behavior

- All Windows claims above are pinned-source/dependency or Node documentation evidence, **not native Windows testing**. Junction behavior on UNC/network filesystems, nonstandard ACLs, and npm-shim quoting edge cases remain unexercised.
- Duplicate names inside one discovery root have no verified stable ordering contract. Case-sensitive merge versus case-insensitive lookup makes case-only duplicates unsuitable for portable materialization.
- Agent Skills optional metadata is preserved for portability, not promised to affect Gemini permissions. Bundled Unix scripts still need a Windows-capable alternative or a documented compatibility constraint.
- Current MCP docs still describe `url` as SSE and `httpUrl` as HTTP; the tag's transport factory and native writer prefer `url` with explicit `type`. Current GitHub installation docs also retain `httpUrl`; examples here intentionally use the pinned implementation's preferred form. [S12][S13][S14]
- The trusted-folders guide's disabled-by-default statement conflicts with source defaults. No skill discovery, trust prompt, MCP launch or authentication flow was exercised to resolve discrepancies by runtime observation.

## Primary sources

- **[S1]** [Gemini CLI v0.64.0 source tree](https://github.com/google-gemini/gemini-cli/tree/v0.64.0), [tag tree/commit metadata](https://api.github.com/repos/google-gemini/gemini-cli/git/trees/v0.64.0).
- **[S2]** v0.64.0 [`utils/paths.ts`: `homedir`](https://github.com/google-gemini/gemini-cli/blob/v0.64.0/packages/core/src/utils/paths.ts), [`config/storage.ts`: shared/native/user/workspace paths](https://github.com/google-gemini/gemini-cli/blob/v0.64.0/packages/core/src/config/storage.ts).
- **[S3]** [Node `os.homedir()` documentation](https://nodejs.org/api/os.html#oshomedir).
- **[S4]** v0.64.0 [`config/settings.ts`: loading, scopes, trust and precedence](https://github.com/google-gemini/gemini-cli/blob/v0.64.0/packages/cli/src/config/settings.ts); [current configuration docs](https://geminicli.com/docs/reference/configuration/).
- **[S5]** v0.64.0 [`skillManager.ts`: roots, trust and name precedence](https://github.com/google-gemini/gemini-cli/blob/v0.64.0/packages/core/src/skills/skillManager.ts); [current skills docs](https://geminicli.com/docs/cli/skills/).
- **[S6]** [Agent Skills specification](https://agentskills.io/specification.md).
- **[S7]** v0.64.0 [`skillLoader.ts`: parsing and directory depth](https://github.com/google-gemini/gemini-cli/blob/v0.64.0/packages/core/src/skills/skillLoader.ts).
- **[S8]** v0.64.0 [`activate-skill.ts`: consent and directory access](https://github.com/google-gemini/gemini-cli/blob/v0.64.0/packages/core/src/tools/activate-skill.ts).
- **[S9]** v0.64.0 [`settingsSchema.ts`: shallow MCP map, trust/skills defaults and controls](https://github.com/google-gemini/gemini-cli/blob/v0.64.0/packages/cli/src/config/settingsSchema.ts), [`deepMerge.ts`](https://github.com/google-gemini/gemini-cli/blob/v0.64.0/packages/cli/src/utils/deepMerge.ts).
- **[S10]** v0.64.0 [`skillUtils.ts`: install, overwrite, link and Windows junctions](https://github.com/google-gemini/gemini-cli/blob/v0.64.0/packages/cli/src/utils/skillUtils.ts), [`skills/link.ts`: scope/consent](https://github.com/google-gemini/gemini-cli/blob/v0.64.0/packages/cli/src/commands/skills/link.ts).
- **[S11]** v0.64.0 [`package-lock.json`: exact SDK, cross-spawn and comment-stripper versions](https://github.com/google-gemini/gemini-cli/blob/v0.64.0/package-lock.json), [`commentJson.ts`: native writer](https://github.com/google-gemini/gemini-cli/blob/v0.64.0/packages/cli/src/utils/commentJson.ts).
- **[S12]** [GitHub MCP server's official Gemini installation guide](https://github.com/github/github-mcp-server/blob/main/docs/installation-guides/install-gemini-cli.md) (current main, not Gemini v0.64.0).
- **[S13]** v0.64.0 [`mcp-client.ts`: transport priority/fallback, env, headers and cwd](https://github.com/google-gemini/gemini-cli/blob/v0.64.0/packages/core/src/tools/mcp-client.ts), [`config.ts`: `MCPServerConfig`](https://github.com/google-gemini/gemini-cli/blob/v0.64.0/packages/core/src/config/config.ts).
- **[S14]** [Current Gemini MCP docs](https://geminicli.com/docs/tools/mcp-server/).
- **[S15]** v0.64.0 [`envVarResolver.ts`: general settings interpolation](https://github.com/google-gemini/gemini-cli/blob/v0.64.0/packages/cli/src/utils/envVarResolver.ts).
- **[S16]** v0.64.0 [`envExpansion.ts`: MCP expansion](https://github.com/google-gemini/gemini-cli/blob/v0.64.0/packages/core/src/utils/envExpansion.ts), [`environmentSanitization.ts`: inherited environment and blocked overrides](https://github.com/google-gemini/gemini-cli/blob/v0.64.0/packages/core/src/services/environmentSanitization.ts).
- **[S17]** [Published pinned MCP SDK 1.23.0 stdio implementation](https://unpkg.com/@modelcontextprotocol/sdk@1.23.0/dist/esm/client/stdio.js), [registry provenance/version metadata](https://registry.npmjs.org/@modelcontextprotocol/sdk/1.23.0).
- **[S18]** [Pinned cross-spawn 7.0.6 Windows parser](https://unpkg.com/cross-spawn@7.0.6/lib/parse.js), [command resolver](https://unpkg.com/cross-spawn@7.0.6/lib/util/resolveCommand.js), [Node child-process semantics](https://nodejs.org/api/child_process.html#child_processspawncommand-args-options).
- **[S19]** v0.64.0 [`trusted-folders.md`: conflicting default](https://github.com/google-gemini/gemini-cli/blob/v0.64.0/docs/cli/trusted-folders.md), [`trustedFolders.ts`: enabled fallback](https://github.com/google-gemini/gemini-cli/blob/v0.64.0/packages/cli/src/config/trustedFolders.ts), [`trust.ts`: decisions](https://github.com/google-gemini/gemini-cli/blob/v0.64.0/packages/core/src/utils/trust.ts), [`mcp-client-manager.ts`: connection gate](https://github.com/google-gemini/gemini-cli/blob/v0.64.0/packages/core/src/tools/mcp-client-manager.ts).
- **[S20]** v0.64.0 [`commands/mcp/add.ts`: writer fields, scope, replacement and env parser](https://github.com/google-gemini/gemini-cli/blob/v0.64.0/packages/cli/src/commands/mcp/add.ts).
