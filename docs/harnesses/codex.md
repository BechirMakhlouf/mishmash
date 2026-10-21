# Codex: skills and MCP servers

[Documentation overview](../README.md) · [Canonical source and adapter contract](../source-of-truth.md)

## Product and evidence baseline

Research date: **2026-10-20**. This page covers the OpenAI Codex CLI and its local configuration, not ChatGPT web's hosted plugin installation. The principal evidence is the [`rust-v0.163.0` release source](https://github.com/openai/codex/tree/rust-v0.163.0), commit `83086188ae0614bd882818ff1aa23f3194962012`. Current OpenAI documentation is supplementary, not a claim that every current documentation feature shipped in that release.

Preliminary Linux checks observed `codex-cli 0.163.0` and CLI help only. No skill-discovery session, MCP connection, package execution, link creation, or native Windows behavior was exercised. Statements below marked source-verified describe implementation inspection, not runtime tests. Hooks and resources other than skills and MCP server definitions are out of scope.

## Paths, scopes, and home resolution

Define **H** as `dirs::home_dir()`, and **C** as the resolved Codex home. The release pins `dirs` 6.0.0. On Linux/macOS, H comes from nonempty `HOME`, with a passwd-database fallback. On native Windows it comes from `SHGetKnownFolderPath(FOLDERID_Profile)`, typically `C:\Users\Alice`; **it is not an `APPDATA` directory or a blind `USERPROFILE` substitution**. These semantics are shared by Codex's default configuration home and its independent shared skill home. [Home resolver][home] · [Pinned dependencies][lock] · [dirs 6 contract][dirs]

C defaults to `H/.codex`. Nonempty `CODEX_HOME` replaces C and must name an existing directory; Codex canonicalizes it and errors for a missing path or non-directory. It does **not** relocate `H/.agents/skills`. Setting `HOME` on Windows is not a supported way to relocate that known-folder-based shared skill root. [Home resolver][home] · [Skill roots][roots]

The [canonical user root](../source-of-truth.md#scope-and-filesystem-roots) uses Node's `os.homedir()`, whose Windows API contract checks `USERPROFILE` before its profile fallback. It can differ from Codex's known-folder result under an overridden environment. Treat direct discovery as conditional on matching roots; otherwise bridge individual skills from a verified Codex discovery root to the agreed canonical root, or materialize them. Do not move shared canonical data merely to match `CODEX_HOME` or assume two home APIs agree. [Node home resolver](https://nodejs.org/api/os.html#oshomedir)

| Resource / scope | Linux and macOS | Native Windows | Format / override |
| --- | --- | --- | --- |
| Shared project skills | `<project>/.agents/skills/<name>/SKILL.md` | `<project>\.agents\skills\<name>\SKILL.md` | Agent Skills Markdown/YAML; ancestor discovery below |
| Native project skills, also read in this release | `<project>/.codex/skills/<name>/SKILL.md` | `<project>\.codex\skills\<name>\SKILL.md` | Roots supplied by discovered project config layers |
| Shared user skill discovery | `H/.agents/skills/<name>/SKILL.md` | `H\.agents\skills\<name>\SKILL.md` | Independent of `CODEX_HOME`; compare against the canonical home resolver |
| Legacy native user skills, still read | `C/skills/<name>/SKILL.md` | `C\skills\<name>\SKILL.md` | `CODEX_HOME` relocates this root; source calls it deprecated |
| Project MCP/config | `<project>/.codex/config.toml` | `<project>\.codex\config.toml` | TOML; trusted project layers only |
| User MCP/config | `C/config.toml`, normally `~/.codex/config.toml` | `C\config.toml`, normally `H\.codex\config.toml` | TOML; `CODEX_HOME` override |
| Selected user profile overlay | `C/<name>.config.toml` | `C\<name>.config.toml` | Additional user layer when selected; not the CLI MCP writer destination |

Sources: [root construction][roots], [configuration loader][loader], [home resolver][home]. A project `.agents/mcp.json` is **not** a Codex-discovered MCP configuration path; it is mishmash's canonical synchronization input described in the [source-of-truth contract](../source-of-truth.md).

WSL uses Linux home, filesystem, executables, and paths. A native Windows profile and a WSL Linux home must be treated as separate targets even when both can access the same checkout. Do not copy Linux command paths into native Windows TOML or assume one `CODEX_HOME` serves both environments.

### Project hierarchy and trust

Source-verified discovery finds the nearest configured project-root marker walking upward from the working directory; the default marker is `.git`. It reads `.codex/config.toml` from the project root through CWD, inclusive, in increasing precedence: **closer-to-CWD layers override ancestor layers**. With no marker, or an empty marker list, the discovery boundary falls back to CWD; this is not an unlimited filesystem-root search. Root-marker settings come from applicable non-project configuration. [Loader, `discover_project_layers`][loader] · [Root markers][markers]

Untrusted project configuration layers are recorded with a disabled reason and excluded from effective configuration. Trust is looked up in non-project configuration, including directory/project/repository keys; a project cannot trust itself through its own file. Do not create or synchronize trust decisions to make a generated server start. The source additionally sanitizes selected security-sensitive project settings; MCP tables are supported in trusted project config, not an exemption from organization requirements. [Loader, trust context and project sanitization][loader]

The ordinary order is system/cloud → user → selected user profile → trusted project layers → session overrides. Legacy managed configuration can outrank even session overrides, and managed requirements can constrain which servers are enabled. Tables merge recursively; scalars and arrays replace lower values. Thus two same-ID MCP tables can combine fields, not necessarily replace the entire server. A transport change can accidentally retain incompatible lower-layer keys. Inspect origins and report such conflicts instead of applying a universal project-wins replacement rule. [Layering contract][layers] · [Merge implementation][merge] · [MCP validation][mcp-types]

## Skills

### Portable skill and Codex-native metadata

Use a complete skill directory, not an isolated copied Markdown file:

```text
.agents/
  skills/
    review-changes/
      SKILL.md
      references/
        checklist.txt
      agents/
        openai.yaml
```

`.agents/skills/review-changes/SKILL.md`:

```markdown
---
name: review-changes
description: Review a proposed change for correctness and compatibility when the user asks for a code review.
---

Read the proposed change and its surrounding code.
Use references/checklist.txt as the review checklist.
Report concrete defects with file locations; distinguish evidence from inference.
```

`.agents/skills/review-changes/references/checklist.txt`:

```text
Check changed behavior, compatibility, failure paths, and missing coverage.
```

The standard requires `name` and `description`; keep the name equal to the containing directory name and preserve supporting files. Optional standard metadata includes `license`, `compatibility`, and `metadata`. `agents/openai.yaml` is a **Codex/OpenAI extension**, not portable Agent Skills frontmatter. A valid optional file is:

```yaml
interface:
  display_name: "Review changes"
  short_description: "Review correctness and compatibility"
policy:
  allow_implicit_invocation: false
```

This makes invocation explicit-only; `$review-changes` remains available. Native metadata can also describe presentation assets and MCP dependencies. A skill dependency declaration is not a universal MCP configuration file and must not silently become a shared server registration. Preserve this sidecar as native metadata when migrating. [Agent Skills specification][skill-spec] · [OpenAI skill authoring documentation][skills-doc] · [Release metadata loading][metadata]

### Discovery, duplicates, links, and activation

- Shared repository discovery scans `.agents/skills` at each directory from the detected project root to CWD. Starting at a repository root does not discover a child directory's separate `.agents/skills`; starting in that child includes both ancestor and child roots. With no detected marker, only CWD contributes a shared repository root. The user `H/.agents/skills` root is added independently. The release also reads legacy `C/skills` and native `.codex/skills` roots. [Root construction][roots]
- The shared repository scan is separate from the enabled project-config merge: it does not test a project layer's trusted/disabled flag. Native `.codex/skills` roots use `all_layers_high_to_low`, likewise not just effective enabled layers. **Do not assume untrusted project MCP config being disabled prevents local skill discovery.** Skills are instructions, not an execution sandbox; review their content and scripts before adoption. This is a source-level distinction, not an observed untrusted session. [Root construction][roots] · [Host loading][host]
- Normal roots are scanned recursively, skip hidden subdirectories below the skill root, and have traversal limits (depth 6, 2,000 directories and 20,000 entries per root in this release). Put portable skills immediately below `skills/` rather than depending on deep nesting. [Discovery][discovery] · [Loader constants][skill-loader]
- **Same-name skills coexist** rather than merging by name or being universally overridden by project scope. The release deduplicates canonical `SKILL.md` paths, then sorts by scope/name/path; two distinct paths with the same name can remain in selectors. An alias to the same canonical file can deduplicate, but copying the same content to a different path does not. Preserve identity/path and surface ambiguity during migration. [Merge implementation][skill-merge] · [Documented duplicate behavior][skills-doc]
- User/repository/admin directory symlinks are followed, and discovered file paths are canonicalized where possible; bundled system roots use a different symlink policy. Link the **whole skill directory** so references and assets remain usable. This is source-verified generic traversal plus documented symlink support, not proof that every Windows junction/reparse-point setup works. [Host loading][host] · [Discovery][discovery] · [Skills documentation][skills-doc]
- Codex initially exposes skill metadata, then reads the full instructions when selected. Explicit `$name`/`/skills` selection and implicit description matching are documented. `policy.allow_implicit_invocation: false` disables the latter. Native per-path disabling uses `[[skills.config]]`, for example in user `C/config.toml`:

  ```toml
  [[skills.config]]
  path = "/home/alice/.agents/skills/review-changes/SKILL.md"
  enabled = false
  ```

  Native Windows equivalent path syntax is `path = 'C:\Users\Alice\.agents\skills\review-changes\SKILL.md'`. These are illustrative absolute paths, not environment expansion syntax. Preserve path-based controls and rebase them deliberately if a skill moves. [Skills documentation][skills-doc]

### Installer write path is not the preferred shared reader path

The bundled `skill-installer` helper defaults to `$CODEX_HOME/skills`, or Python's expanded `~/.codex/skills` when the variable is absent. Its `--dest` option chooses another skill root. It refuses an already-existing destination. This is a bundled skill's Python installer, **not** a general `codex skills install` CLI contract. Python home expansion is not the Rust known-folder resolver; do not infer identical behavior under unusual Windows environment relocation. The helper's download/copy validation also rejects unsupported skill symlinks, even though the reader follows locally installed skill directory links. [Release installer source][installer]

For synchronization, adopt reviewed installer output into the agreed canonical `<home>/.agents/skills/<name>`. When that home equals H, Codex discovers it directly; otherwise use a verified per-skill bridge or materialization at a Codex discovery root. Do not maintain two independent authoritative copies simply because the installer defaults to the legacy root.

## MCP server configuration

### Native envelopes and examples

Servers are TOML tables named **`[mcp_servers.<id>]`** inside a native Codex config file. There is no JSON `mcpServers` envelope and no separate automatically read `.agents` MCP file. The release validates stdio versus HTTP fields: `command` selects stdio; `url` selects Streamable HTTP. Mixed transport keys are rejected. A generic legacy SSE configuration cannot be translated just by relabeling its transport as HTTP. [MCP schema/validation][mcp-types] · [Official MCP guide][mcp-doc]

**User scope**, `C/config.toml`, with the real public OpenAI documentation MCP endpoint:

```toml
[mcp_servers.openaiDeveloperDocs]
url = "https://developers.openai.com/mcp"
```

**Project scope**, `<project>/.codex/config.toml`, stdio using the real Context7 command documented by OpenAI:

```toml
[mcp_servers.context7]
command = "npx"
args = ["-y", "@upstash/context7-mcp"]
```

Both examples are native TOML, not commands exercised in this investigation. The stdio example downloads/executes third-party package code when actually started; review and pin a suitable package version before controlled deployment. The same envelope is valid in either scope, subject to trusted project loading. Endpoint and command provenance: [OpenAI skills dependency example][skills-doc] and [MCP configuration guide][mcp-doc].

Optional **stdio** fields, in a user or project server table:

```toml
[mcp_servers.context7]
command = "npx"
args = ["-y", "@upstash/context7-mcp"]
env_vars = ["CONTEXT7_API_KEY"]
env = { LOG_LEVEL = "warn" }
```

`env` contains literal values; `env_vars` names values to forward from the environment. The release also accepts `{ name = "NAME", source = "local" }` entries, and `source = "remote"` for executor-backed stdio only. Do not translate another harness's `${env:NAME}` or `${NAME}` template into a literal Codex environment value and expect interpolation. There is no general shell interpolation of `command`, argv, or TOML strings in the inspected local launcher. The environment builder selects core/explicit variables and filters protected non-inheritable names; it is not a promise to copy every parent environment value. [MCP types][mcp-types] · [Environment builder][mcp-env] · [Launcher][launcher]

For an HTTP server that requires a token, this **illustrative, non-production** table shows environment references without embedding secrets:

```toml
[mcp_servers.privateDocs]
url = "https://mcp.example.com/mcp"
bearer_token_env_var = "PRIVATE_DOCS_TOKEN"
env_http_headers = { "X-Tenant" = "PRIVATE_DOCS_TENANT" }
```

`bearer_token_env_var` names the variable, not its value; `env_http_headers` maps header names to environment-variable names. Static non-secret headers use `http_headers`. Plain `bearer_token` is rejected by release validation; do not generate it. `http_headers_helper` is a native local command facility and should remain a reviewed native-only field, not an automatically portable secret provider. HTTP configuration cannot carry stdio `cwd`, `args`, `env`, or `env_vars`. [MCP validation][mcp-types] · [HTTP/environment documentation][mcp-doc]

Other native controls include `enabled`, `required`, startup/tool timeouts, `enabled_tools`, `disabled_tools`, per-tool approval settings and OAuth options. Preserve unmodeled native fields instead of discarding them during serialization. Do not synchronize OAuth tokens, client secrets, keyring state, login state, approval grants, or trust records. `codex mcp login <id>` initiates a separate OAuth workflow; server registration alone is not authorization. Organization requirements may disable a configured server. [Native schema][mcp-types] · [CLI implementation][mcp-cli]

### CLI writer scope

`codex mcp add <id> -- <command> <args...>` and `codex mcp add <id> --url <url>` write **user** `C/config.toml`. The inspected add path loads the global user MCP map and calls `ConfigEditsBuilder::new(codex_home).replace_mcp_servers(...)`; remove does the same. `AddArgs` contains no project/scope selector. A selected user profile or project file is not this writer's destination, and changing CWD does not make the writer project-local. `list`/`get` load effective configuration and therefore can show a different merged view from the map add/remove edits. [Release CLI implementation][mcp-cli]

A future adapter should edit targeted project TOML tables when project scope is requested, not call the user-only writer and claim project installation. For user writes, preserve unrelated entries and native fields; the CLI's replace-map operation is not a general lossless migration API for arbitrary unknown fields.

### Process executable, cwd, and OS semantics

The local stdio launcher constructs an executable plus a separate argv vector; it does not evaluate a POSIX shell or PowerShell command string. `command = "npx -y ..."` is therefore wrong: use `command = "npx"` with `args`. Do not add generic `cmd /c` wrappers as a synchronization policy. [Launcher][launcher]

On Unix the program resolver returns the program unchanged, relying on normal PATH/shebang execution. Scripts executed directly still need an appropriate interpreter/shebang and executable permissions. On native Windows the release explicitly uses `which::which_in` with the constructed environment's case-insensitive PATH lookup and launch cwd to resolve extensions such as `.cmd`/`.bat` through Windows resolution. The source includes Windows test cases for `.cmd` resolution. This supports leaving the documented `command = "npx"` form intact in generated Windows config, provided the native installation is available on PATH; it does not require blindly converting every command to `npx.cmd` or a shell wrapper. These tests were read, not run here. [Platform resolver][resolver]

`cwd` is a raw `LegacyAppPathString`, not one of the loader's `AbsolutePathBuf` fields. Local startup passes it through as a `PathBuf` to `current_dir`; if omitted, it uses the runtime context's caller-supplied `local_process_cwd`. It is **not automatically resolved relative to the directory containing `config.toml`**. A relative explicit cwd is left to local process/OS semantics, not rebased to `.codex`; relative arguments are interpreted by the launched server. Do not assume a session working-directory selection and the orchestrator process cwd are identical in every client. Prefer explicit absolute local cwd and absolute script/resource arguments in generated machine-local config whenever canonical data is project-relative. [MCP client routing][client] · [Launcher][launcher] · [Raw path representation][path-string] · [Loader path normalization][loader] · [Runtime context][runtime]

For example, if a server needs a known project directory, add **one host-specific** cwd to its existing table:

```toml
# Unix machine-local generation:
cwd = "/home/alice/work/widget"
```

```toml
# Native Windows machine-local generation (literal TOML string):
cwd = 'C:\work\widget'
```

These are field fragments, not standalone server registrations. TOML single-quoted literal strings avoid backslash escapes; a basic double-quoted string would need `"C:\\work\\widget"`. Neither `$HOME` nor `%USERPROFILE%` in such a string is a cross-platform path template. Any JSON transport/intermediate representation needs its own JSON escaping separately.

## Synchronization and migration recommendation

The following is **source-backed adapter guidance**, not an existing Codex synchronization feature. The [mishmash README](../../README.md) describes the implemented CLI and its limitations; this research does not prove native activation:

1. **Inventory by scope and provenance.** Project inputs are discovered `.agents/skills`, legacy `.codex/skills`, and relevant `.codex/config.toml` layers. User inputs are H's shared skills, C's legacy skills, and the MCP tables in C's config/profile layers. Preserve the directory of origin, server-ID/key origins, and native-only metadata. Do not scan auth/state stores or silently adopt organization-managed resources.
2. **Use direct shared skill discovery when roots match.** Adopt a reviewed project skill into `<project>/.agents/skills/<name>` and a user skill into the agreed canonical `<home>/.agents/skills/<name>`. Copy the whole directory including resources and `agents/openai.yaml`; apply the home-resolver caveat above if canonical home differs from H. Once ownership and conflicts are resolved, remove only the old managed duplicate; leave unrelated native entries untouched. Do not deduplicate by name or content alone because distinct same-name skills legitimately coexist.
3. **Avoid unnecessary Codex skill bridges.** No `.codex/skills` link is needed for canonical `.agents/skills`. When retaining a native path is required for another consumer or deliberate path identity, a per-skill directory symlink can point to canonical content on platforms supporting it. Check canonical identity and path-based disabled controls rather than assuming aliases are separate skills. On Windows, direct discovery/materialization avoids needing link privileges altogether.
4. **Generate MCP native tables, not configuration-file links.** Adopt non-secret MCP definitions into the normalized project/user source described in [source-of-truth](../source-of-truth.md). Emit only owned `[mcp_servers.<id>]` tables into trusted project `.codex/config.toml` or user C's `config.toml`, preserving other settings, unmanaged servers, and native-only fields. Do not symlink the entire native config to canonical JSON or copy the state-bearing Codex home wholesale.
5. **Resolve portability deliberately.** Render OS-specific executable/argv/cwd choices; retain environment-variable references rather than resolved secrets. Resolve canonical project-relative paths using the normalized model, then emit absolute machine-local paths when needed for Codex's local launcher. A checked-in shared config should avoid embedding one developer's absolute home. Report unresolved platform executables or unsupported transport/auth/helper semantics rather than generating a fake equivalent.
6. **Respect native layering.** Preserve user/project scope and intentional nested-project placement. Detect same-ID collisions and mixed lower-layer transport keys before writing. A generated project table must not silently absorb a user server's secret/auth/native fields. Do not create trust records, OAuth credentials, or approval policy to bypass activation gates.

Windows directory-symlink creation can require the appropriate privilege/elevation, or Developer Mode with the unprivileged-create flag; do not assume an unelevated process can create one. Junction creation and traversal are a separate filesystem capability, not proven by the generic Codex symlink policy. Materialization is the fallback when the requested link kind cannot be created or its target semantics are unsuitable; preserve unmanaged destinations and report conflicts rather than overwrite them. [Windows symbolic-link API][windows-links]

## Verification limits and remaining uncertainties

- Native Windows executable resolution is source-backed, including upstream test code, but no native Windows MCP startup, known-folder relocation, symlink, junction, UNC path, or permission scenario was executed here.
- Shared and native project skill discovery's separation from config trust is established from the root-construction code, not a runtime proof of selector visibility or model activation in every client.
- Current documentation can evolve beyond 0.163.0. In particular, do not infer that documentation's every newer remote-executor setting belongs to this release: the release schema has `environment_id`; this page recommends ordinary local stdio/HTTP only. Remote executor path/cwd semantics must remain environment-specific rather than being guessed from local behavior.
- Local stdio cwd behavior is established at the launcher boundary; no blanket equivalence between CLI, IDE, desktop, remote orchestration, and process startup CWD was verified. The adapter should render explicit local paths when ambiguity matters.
- No example package or endpoint was executed. The preliminary version/help baseline does not verify discovery, trust prompts, authentication, connections, generated-file parsing, or link support.

## Primary sources

Release links below are pinned to `rust-v0.163.0` unless explicitly identified as live documentation.

[home]: https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/utils/home-dir/src/lib.rs
[lock]: https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/Cargo.lock
[dirs]: https://docs.rs/dirs/6.0.0/dirs/fn.home_dir.html
[roots]: https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/ext/skills/src/host_roots.rs
[loader]: https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/config/src/loader/mod.rs
[markers]: https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/config/src/project_root_markers.rs
[layers]: https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/config/src/loader/README.md
[merge]: https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/config/src/merge.rs
[skills-doc]: https://developers.openai.com/codex/skills
[skill-spec]: https://agentskills.io/specification.md
[metadata]: https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/ext/skills/src/loader/metadata.rs
[host]: https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/ext/skills/src/loader/host.rs
[discovery]: https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/ext/skills/src/loader/discovery.rs
[skill-loader]: https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/ext/skills/src/loader/mod.rs
[skill-merge]: https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/ext/skills/src/loader/host_merge.rs
[installer]: https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/skills/src/assets/samples/skill-installer/scripts/install-skill-from-github.py
[mcp-types]: https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/config/src/mcp_types.rs
[mcp-doc]: https://developers.openai.com/codex/mcp
[mcp-env]: https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/rmcp-client/src/utils.rs
[mcp-cli]: https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/cli/src/mcp_cmd.rs
[launcher]: https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/rmcp-client/src/stdio_server_launcher.rs
[resolver]: https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/rmcp-client/src/program_resolver.rs
[client]: https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/codex-mcp/src/rmcp_client.rs
[path-string]: https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/utils/path-uri/src/api_path_string.rs
[runtime]: https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/codex-mcp/src/runtime.rs
[windows-links]: https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createsymboliclinkw
