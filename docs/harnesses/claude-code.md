# Claude Code: skills and MCP servers

[Documentation index](../README.md) · [Canonical source and synchronization contract](../source-of-truth.md)

## Identity and evidence baseline

Claude Code is Anthropic's coding agent, not the Claude Desktop chat application's MCP client. This adapter targets the local Claude Code CLI; Desktop's Code tab is mentioned only where its documented behavior differs. Other resource types are outside this document's scope.

Research date: **2026-10-20**. The official repository's `main` changelog starts at **2.1.304**. The behavior below is supported by current first-party documentation and that published changelog, not by inspecting a complete open-source CLI implementation or exercising an installed release. Version-specific differences are identified where material. [R1][R2]

**Preliminary runtime baseline:** Claude was not verified. The local `claude` command is a wrapper invoking `mise use -g --quiet claude`; an earlier version check timed out, and mise resolved uninstalled 2.1.303. This research did not run that wrapper, install Claude, inspect local user configuration, or start skill discovery/MCP sessions. Native Windows was not tested. No command or package execution shown below was performed.

## Scope, paths, and configuration roots

`P` means the selected project root. `H` means the user's home directory. The default Unix home examples are `/home/alice` on Linux and `/Users/alice` on macOS. Windows defaults below are **documented explicitly**, not inferred from an AppData convention: the settings/directory docs resolve `~/.claude` to `%USERPROFILE%\.claude`, and the Windows uninstall instructions also identify `%USERPROFILE%\.claude.json`. [R3][R4][R5]

| Resource/scope | Project on Unix | Project on native Windows | User on Linux/macOS | User on native Windows | Format / override |
| --- | --- | --- | --- | --- | --- |
| Skills | `P/.claude/skills/<name>/SKILL.md` | `P\.claude\skills\<name>\SKILL.md` | `H/.claude/skills/<name>/SKILL.md` | `%USERPROFILE%\.claude\skills\<name>\SKILL.md` | Markdown with YAML frontmatter; user root follows `CLAUDE_CONFIG_DIR` |
| MCP, shared project | `P/.mcp.json` | `P\.mcp.json` | Not applicable | Not applicable | JSON: `mcpServers` map; **not** inside `.claude/` |
| MCP, user | Not applicable | Not applicable | `H/.claude.json` by default | `%USERPROFILE%\.claude.json` by default | JSON: top-level `mcpServers`; exact relocated filename is unresolved below |
| MCP, private project (`local`) | Project's entry in user state file | Project's entry in user state file | `H/.claude.json`, `projects[projectPath].mcpServers` | `%USERPROFILE%\.claude.json`, same logical nesting | JSON; this is the MCP writer's default scope, not `.claude/settings.local.json` |
| Settings affecting discovery/approval | `P/.claude/settings.json`; personal overrides in `P/.claude/settings.local.json` | `P\.claude\settings.json`; `P\.claude\settings.local.json` | `H/.claude/settings.json` | `%USERPROFILE%\.claude\settings.json` | JSON; user root follows `CLAUDE_CONFIG_DIR`; not the ordinary MCP server-definition store |
| mishmash canonical skills | `P/.agents/skills/<name>/` | `P\.agents\skills\<name>\` | `H/.agents/skills/<name>/` | `%USERPROFILE%\.agents\skills\<name>\` | Adapter input, **not documented Claude discovery** |

Path and scope claims: [R3][R4][R6][R7].

### `CLAUDE_CONFIG_DIR` and home resolution

The documented resolver contract is an explicit `CLAUDE_CONFIG_DIR` for the user configuration directory, otherwise `~/.claude`; on Windows the documented default is `%USERPROFILE%\.claude`. An override names the **final directory**, not a replacement home to which another `.claude` is appended. For example, `/srv/claude-work/skills/` or `D:\Profiles\claude-work\skills\` is the corresponding personal skill root. This does not rename project `.claude/` or `.mcp.json`. Use an absolute path in the environment launching Claude. Settings `env` values are copied literally: `~` and `$HOME` are not shell-expanded there, and project/local settings cannot set `CLAUDE_CONFIG_DIR`. [R3][R4][R8]

**Important unresolved boundary:** the current environment docs say settings/history/plugins relocate, but the MCP/settings pages continue to call the mixed state file `~/.claude.json`. The reviewed authoritative pages do not establish whether a custom root places that file inside the root, beside it with a derived name, or at another filename. Do not implement any of these guesses. Prefer Claude's scoped MCP writer with the intended profile environment, or require an explicitly established state-file path for import. `claude auth status` documents a `configDirectory` field since 2.1.268, but that identifies the directory, not an authoritative formula for this separate file. No such command was run here. [R6][R8][R9]

The internal priority among `HOME`, OS account records, and `USERPROFILE` when they disagree was not source-verified. `%APPDATA%`/`%LOCALAPPDATA%` are not documented defaults for these skill/MCP files. Do not move them there as a platform “fix.” WSL is a separate Linux execution environment with Linux home paths and executables; a native Windows configuration does not automatically become a WSL configuration. [R5]

## Skills

### Native layout and portable content

A complete minimal project skill is:

```text
project/
└── .claude/
    └── skills/
        └── review-change/
            └── SKILL.md
```

`.claude/skills/review-change/SKILL.md`:

```markdown
---
name: review-change
description: Review a proposed code change for correctness and compatibility when the user requests a review.
---

Read the changed code and its callers. Identify concrete correctness and
compatibility risks, cite affected paths, and distinguish evidence from inference.
Do not modify files unless the user requests changes.
```

For a personal skill, put the same complete directory at `H/.claude/skills/review-change/`, `%USERPROFILE%\.claude\skills\review-change\`, or `<CLAUDE_CONFIG_DIR>/skills/review-change/`. Supporting `references/`, `scripts/`, and `assets/` stay with that directory; linking only `SKILL.md` can break those resources. [R4][R7][R10]

The Agent Skills specification requires `name` and `description`, a name matching its parent directory, and lowercase name syntax. Standard optional frontmatter is `license`, `compatibility`, `metadata`, and experimental `allowed-tools`. Claude's native loader is more permissive: its docs make all fields optional and can derive name/description. For shared canonical content, obey the stricter standard rather than relying on that permissiveness. `allowed-tools` is standard syntax but Claude tool names and approval semantics are not portable. [R7][R10]

Claude-specific metadata includes `disable-model-invocation`, `user-invocable`, `argument-hint`, `arguments`, `when_to_use`, `context: fork`, `agent`, `model`, `effort`, `paths`, and `shell`. Its `$ARGUMENTS`/positional substitutions, `${CLAUDE_SKILL_DIR}`, `${CLAUDE_PROJECT_DIR}`, and dynamic shell injection are also native behavior, not a cross-harness execution contract. Preserve native-only content on import; flag it as nonportable or materialize a Claude-specific variant rather than silently stripping behavior. [R7]

### Discovery, collisions, and activation

Current documented behavior is more specific than “project overrides user”: [R7]

- Personal skills load across local projects; project skills load from the starting directory's `.claude/skills/` and its parents **up to the repository root**. A worktree bounds traversal at its own root; since 2.1.277 a worktree with no root `.claude/skills` can fall back to the main checkout's project skills.
- A nested `.claude/skills/` below the launch directory is loaded when Claude first reads/edits a file there, not necessarily at startup. The skill remains available thereafter. A root `deploy` and nested `apps/web` `deploy` can both load: `/deploy` selects the root one and `/apps/web:deploy` the nested one.
- Across enterprise, personal, and project locations, **enterprise > personal > project** for the same directory/file name. A skill wins over the older `.claude/commands/` file of the same name. Plugin skills have a namespace rather than simply replacing these.
- `--add-dir`/`/add-dir` discovers that directory's `.claude/skills/`; `permissions.additionalDirectories` grants access but does **not** discover skills. Explicit added-directory discovery is different from unrestricted ancestor traversal.
- By default both the user (`/review-change`) and Claude can invoke a skill. `disable-model-invocation: true` makes it user-only; `user-invocable: false` hides/disables direct user invocation while allowing model invocation. Description metadata is available before the body is activated.
- There is no blanket workspace-trust gate to assume for ordinary skill content: the docs specifically warn that a project skill's `allowed-tools` applies even in an untrusted `-p` run. Review imported skills before exposure. Managed `strictPluginOnlyCustomization: ["skills"]`, safe mode, bare mode, disabled commands, and setting-source choices can prevent ordinary discovery. [R7][R9][R11]
- `synced` and `anthropic-skills` names are reserved. Claude owns account-downloaded `skills/synced/` and can replace those files. They are not ordinary user-authored canonical skills. Personal local files do not by themselves appear in Cowork/cloud sessions. [R7]

Current docs describe live `SKILL.md` change detection in watched personal/project/additional roots; creating a root that did not exist at session startup needs `/reload-skills`. Do not promise that editing a symlink target is watched identically on every filesystem. [R7]

### `.agents` bridge and installation write paths

The reviewed official skill locations do **not** document direct discovery of project `.agents/skills` or user `H/.agents/skills`. Claude's documented interoperability mechanism is that each `<skill-name>` entry under enterprise/personal/project `.claude/skills` may be a **directory symlink** to a skill elsewhere. The loader reads the target's `SKILL.md` and deduplicates multiple links to the same target. This does not prove support for an entire `.claude` directory link, for MCP discovery under `.agents`, or for Windows junction behavior. [R7]

Recommended mapping:

```text
P/.claude/skills/review-change -> ../../.agents/skills/review-change
H/.claude/skills/review-change -> ../../.agents/skills/review-change
```

Those are Unix relative symlink targets resolved from the link's parent directory. With an overridden user root, compute the relative target again or use an absolute target; the second line no longer applies literally. A symlink at each skill directory leaves unmanaged native skills intact. Materialize a full skill directory when links are unsupported or native-only content needs a separate representation.

The documented ordinary installation path is creating the skill directory/file at its discovery location; the CLI reference does not establish a generic `claude skills install` writer. The generated `/run-skill-generator`/`/verify` recipes write project `.claude/skills/`, and account syncing writes its reserved personal subtree. Do not mistake third-party installers choosing `.agents` plus bridge links for native Claude `.agents` discovery. [R7][R9]

## MCP servers

### Exact native envelopes and examples

Project shared configuration is **`P/.mcp.json`**, with the server map under `mcpServers`. The following is valid native JSON using the official docs' real Notion remote endpoint and documented Notion stdio package. It is an example configuration, not an executed installation; the stdio variant needs Node/npm and a separately provisioned `NOTION_TOKEN`. Choose one variant in an actual setup to avoid connecting the same service twice. [R4][R6]

```json
{
  "mcpServers": {
    "notion-remote": {
      "type": "http",
      "url": "https://mcp.notion.com/mcp"
    },
    "notion-local-process": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@notionhq/notion-mcp-server"],
      "env": {
        "NOTION_TOKEN": "${NOTION_TOKEN}"
      }
    }
  }
}
```

Native Windows uses the same project `.mcp.json` envelope. The remote entry requires no Unix executable and is the simplest cross-OS example. The stdio entry above follows the published package example, not an independently verified Windows executable-resolution guarantee.

**User scope** has the same top-level `mcpServers` envelope in default `H/.claude.json` / `%USERPROFILE%\.claude.json`. This minimal JSON shows its server-definition subtree, **not a replacement for an existing state file**:

```json
{
  "mcpServers": {
    "notion": {
      "type": "http",
      "url": "https://mcp.notion.com/mcp"
    }
  }
}
```

**Private project/local scope** nests that map in `projects[projectPath]` inside the same user state file. A Unix shape is:

```json
{
  "projects": {
    "/home/alice/work/project": {
      "mcpServers": {
        "notion": {
          "type": "http",
          "url": "https://mcp.notion.com/mcp"
        }
      }
    }
  }
}
```

On Windows a JSON path string such as `"C:\\Users\\Alice\\work\\project"` needs escaped backslashes. That illustrates JSON encoding only: the exact normalized project key is owned by Claude's writer and was not established here. Never synthesize a new trust/project-state key merely by rewriting separators. [R6]

### Transports, interpolation, and execution semantics

- `stdio`: `command`, separate `args` array, optional `env`; no transport `type` means stdio. Do not combine executable and arguments into one string. CLI server arguments follow `--`, after which Claude's add command leaves them untouched. A JSON argv array is not a shell pipeline. [R6]
- Remote HTTP: `"type": "http"`, `url`, optional `headers`; current docs accept `"streamable-http"` as an alias. A URL without `type` is **not** inferred as HTTP and is rejected/skipped as a malformed stdio entry. [R6]
- Legacy SSE: `"type": "sse"`; deprecated. Since 2.1.265 an HTTP connection can fall back to SSE. WebSocket: `"type": "ws"`, `url` and headers; configure through JSON/`add-json`, not `mcp add --transport ws`. WebSocket has no OAuth support; HTTP/SSE support native authentication flows. In-process `sdk` servers cannot be registered by these on-disk files. [R6]
- Interpolation supports `${VAR}` and `${VAR:-default}` in `command`, `args`, `env`, remote `url`, and `headers`. The section is titled for `.mcp.json`, while the stdio discussion explicitly also describes expansion for local/user entries in `.claude.json`. Preserve reference strings instead of expanding secrets into generated files. Missing ordinary variables without a default warn and remain literal; some protected credential variables in remote URLs/headers instead become empty, with their defaults ignored. Do not reuse `ANTHROPIC_API_KEY` as an MCP secret reference and assume it will be forwarded. [R6]
- Claude supplies `CLAUDE_PROJECT_DIR` **to the spawned stdio server**, as its stable project root. It is not automatically in the parent's interpolation environment; `${CLAUDE_PROJECT_DIR}` in a native config's `args` needs an existing parent variable or a default. MCP roots represent the launch directory plus allowed added directories and may change; that is not the same as this stable project root. [R6]
- The reviewed docs do **not** establish a general stdio `cwd` field or a complete rule for resolving every relative command/argument across scopes. Do not invent one, or assume the directory containing `.mcp.json` anchors all arguments. Record existing relative-path dependencies during import and use established absolute paths when materializing machine-local commands. A user server promoted across projects can change behavior if its command depends on the launch directory.
- `headersHelper` is a different native feature: a **shell command**, run at connection/reconnection, that emits a JSON string map; it times out after 10 seconds and overrides matching static headers. Since 2.1.238, project/local helpers run from their declaring project and user helpers from the config directory. Project/local helpers require explicit trust of that project even in `-p`/SDK runs; project-supplied helpers also have credential-like environment variables removed. Do not translate a helper into generic argv or infer its documented working directory applies to stdio servers. [R6]

### Merge, approvals, authentication, and writer scope

For the ordinary CLI, same-name MCP definitions select **local > project > user**, using the entire winning server entry, not a field merge. Plugin servers and claude.ai connectors rank below those, with endpoint-based duplicate handling; managed-provided servers rank above them. This ordering is different from skill precedence. The Desktop Code tab has a documented exception when same-name user/project **stdio** definitions exist: it uses the user definition. [R6]

Interactive sessions request project `.mcp.json` server approval. That is not a universal safety boundary: current `-p`, SDK, and cloud sessions can load them without the interactive approval prompt. Committed project settings cannot preapprove their own servers in an untrusted workspace. Disabled-server rules, managed policy, `--setting-sources`, and `--strict-mcp-config` can restrict what actually loads. Do not migrate approvals, trust state, OAuth tokens, account connectors, or managed policy as canonical server definitions. Review stdio commands and remote endpoints before exposure. [R6][R11]

Prefer the native CLI writer for user/local entries because `.claude.json` is a **mixed state file** containing preferences, sign-in-related state, per-project state/trust, and MCP entries. The settings docs say users do not need to edit this file; that is not a prohibition on every hand edit, but it is a strong reason not to replace or link it wholesale. Actual login credentials also have platform-specific storage, separate from ordinary server definitions. [R3][R4][R12]

Documented commands below are examples only. Each line uses arguments valid as written in Bash/Zsh **and PowerShell**; no Unix line continuations or secret values are required:

```text
claude mcp add --scope project --transport http notion https://mcp.notion.com/mcp
claude mcp add --scope user --transport http notion https://mcp.notion.com/mcp
claude mcp add --scope local --transport http notion https://mcp.notion.com/mcp
```

`project` creates/updates `.mcp.json`; `user` updates the user map; `local` updates the current project's private map. **Omitting `--scope` means `local`, not user or project.** `add-json` takes one server object, not an `mcpServers` wrapper. A future adapter should invoke the resolved native CLI executable with an argument array, explicit scope, intended working directory, and the same profile environment the session will use; do not interpolate JSON or secrets into a shell command line. [R6]

Since **2.1.283**, user/local `mcp add`, `add-json`, and `remove` read the state file back to confirm persistence. They distinguish a confirmed change, `was not saved/removed`, and `may not have been saved/removed` when read-back fails. Earlier releases could report success without persistence. An `Added ...` message means config was written, **not that the server connected**. This is a reason to version-gate native-writer assumptions, not to promise a general transaction protocol or concurrency guarantee. `mcp list`/`get` can health-check/connect servers, so they are not equivalent to a side-effect-free config parser. [R6][R13]

## Unix and native Windows implementation notes

- **Links:** Unix directory symlinks are documented for individual skills; the target and its resources must remain readable. Executable scripts need the appropriate execute permission/interpreter on Unix. Keep Windows-native executable/script variants distinct rather than assuming a Bash script runs in PowerShell.
- **Windows link creation:** Windows directory symlinks may require the relevant privilege/elevation, or Developer Mode together with the unprivileged-create flag. Node's `junction` target is absolute and applies to directories on NTFS. A junction can be an adapter choice, but Claude's docs do not separately guarantee junction discovery, deduplication, or target-watcher behavior. Use materialization when the link capability is unavailable; never silently replace an existing unrelated directory. [R14][R15]
- **Commands:** do not prescribe `cmd /c` or change every `npx` to `npx.cmd` merely because the destination is Windows. The official 2.1.119 changelog removed the false-positive “Windows requires 'cmd /c' wrapper” MCP warning. Exact current `npx`/`.cmd` resolution was not source-verified here. Preserve a working imported command or use an explicitly established native executable path; select per-platform launch details in the adapter. [R1]
- **Shell boundaries:** a stdio `command` plus `args` is not the same thing as `headersHelper` or skill shell injection. Preserve quoting only at the layer where it belongs. For JSON, write `"C:\\Tools\\server.exe"`, not an unescaped `C:\Tools\server.exe`. No shell expands `~`, `%USERPROFILE%`, or `$HOME` in ordinary JSON path strings merely because that shell was used to launch Claude.
- **Native CLI invocation:** an adapter must resolve the real `claude` binary, not assume that a local alias/wrapper is harmless. In this workstation the wrapper is not usable evidence for installed Claude behavior. For a native Windows `.exe`, pass argv directly; handling an npm `.cmd` shim is a separate launcher problem, not a reason to shell-wrap every MCP server.
- **Server shutdown differs:** current docs describe Unix `SIGINT`, then `SIGTERM` after 100 ms and `SIGKILL` after a further 400 ms; Windows first closes stdio-server stdin, then ends the process tree if it is still running after 300 ms. The Windows grace period requires 2.1.296; earlier Windows versions ended the tree immediately. Native servers should not assume Unix signals on Windows. [R6]
- **Relocation/WSL:** resolve the actual profile environment before computing skill links or selecting the CLI writer. Do not synchronize native Windows absolute paths into WSL as if `/mnt/c/...` made process execution semantics equivalent. Default and relocated profiles are separate adoption targets. [R5][R8]

## Migration and synchronization recommendation

The following is **source-backed adapter guidance**, not a native Claude feature or a promise that every native option is portable. See the [mishmash README](../../README.md) for CLI behavior and limitations; canonical schemas and ownership rules are defined in [source-of-truth](../source-of-truth.md).

1. **Inventory without flattening scope.** Identify the selected project/user roots, any `CLAUDE_CONFIG_DIR`, native skill directories, shared `.mcp.json`, and explicitly established user/local MCP state locations. Keep local/private-project MCP entries distinct from both shared project and all-project user entries. Do not read arbitrary authentication stores just to find MCP definitions.
2. **Adopt authored skills as whole resources.** Copy/import project `.claude/skills/<name>/` to `P/.agents/skills/<name>/`; import personal authored skills to `H/.agents/skills/<name>/` (proposed Windows equivalent `%USERPROFILE%\.agents\skills\<name>\`). Retain supporting files, permissions, and native-only frontmatter/body semantics. Exclude Claude-owned `synced`, trash, plugins, and caches from ordinary adoption. Report same-name differences instead of overwriting either side.
3. **Expose only managed skills.** After preserving an original for recovery and resolving collisions, replace that skill's native directory with a per-skill link to its canonical directory. Keep `.claude/skills/` itself native so unmanaged entries and Claude account-managed content remain independent. Use materialized directories where needed on Windows or for native variants; record link/materialization ownership. A personal same-name skill can continue to mask a project skill after migration: report that rather than silently renaming content.
4. **Import MCP server records, not files.** Extract `mcpServers` from project `.mcp.json`, the user map, and each selected `projects[path].mcpServers` map. Map into the canonical project/user model with private-project provenance retained. Preserve remote types, `headersHelper`, OAuth registration options, `alwaysLoad`, timeouts, and other native-only configuration as native metadata where the canonical model cannot express them. Secret reference expressions remain references; literal secrets require a separate explicit secret-handling decision, never automatic publication.
5. **Generate or write native MCP output.** For shared project scope, merge owned server entries into root `.mcp.json` and preserve unmanaged servers and unrelated native fields. For user/private-project scope, prefer an explicit-scope native writer on a supported version with the selected profile environment. Do not replace the mixed state file; if its import location cannot be established under a custom profile, report that exact prerequisite rather than searching user state broadly or guessing a path.
6. **Resolve semantic conflicts before cutover.** Report incompatible transport support in other harnesses, the reverse skill/MCP precedence rules, project-key identity, helpers that require a different shell/trust/cwd, and commands depending on relative paths or OS-specific programs. Do not add a guessed stdio `cwd` field to manufacture equivalence. Preserve unmanaged native entries and native-only fields, and stop on an owned/unmanaged name collision.
7. **Retire only the replaced definitions.** Once canonical content and native projections are accepted, remove only obsolete owned duplicates so the same resource does not retain two competing authors. Do not copy/synchronize trust acceptance, per-project usage state, credentials, OAuth tokens, or account synchronization caches. Re-authentication and approval remain local to each harness/profile. The future integration owner should exercise discovery, collision behavior, writer persistence, and Windows link/process behavior in isolated fixtures; none was exercised by this research.

### Why whole-config linking is not a clean cutover

| Exact mismatch | Consequence |
| --- | --- |
| Claude reads `.claude/skills`, not the canonical `.agents/skills` discovery root | Bridge individual compatible skill directories; linking one generic config file cannot expose them |
| Project MCP is root `.mcp.json`, not `.claude/settings.json`; user/local MCP is in `.claude.json` | A linked settings file misses MCP, while replacing state loses unrelated data |
| `.claude.json` mixes mutable app/trust/project state and server definitions | Never link it to canonical MCP JSON or another harness's settings; allow the native owner to write its state |
| Native `mcpServers` envelope, transport discriminators, helpers, and interpolation differ from other clients | JSON syntax similarity alone does not establish schema or execution equivalence |
| Skills select personal over project; MCP selects local over project over user | A universal merge order changes which resource actually runs |
| User root relocation and mixed state-file relocation are not the same established path contract | Guessing `<CLAUDE_CONFIG_DIR>/.claude.json` or its sibling can read/write the wrong profile |
| Linked content can still contain Claude tool grants, model/subagent controls, shell injection, or OS-specific commands | A filesystem link shares bytes, not semantics or trust; preserve native variants or report incompatibility |

## Uncertainties and verification limits

- The default Windows roots are documented; the complete implementation-level home resolver and the `.claude.json` filename under `CLAUDE_CONFIG_DIR` were not established. No assumed AppData or derived sibling path is presented as fact.
- General stdio cwd/relative-command behavior, Windows `.cmd` executable resolution, Windows per-skill symlink/junction discovery, and live changes through linked targets remain untested/unverified implementation details. The documented helper cwd is not substituted for these missing rules.
- Current web docs and `main` release notes can move independently of older installed clients. 2.1.304 is an upstream evidence baseline, not an installed/tested version here. Server authentication, package availability, skill execution, and native writer success were not exercised.
- Skill/MCP policy, account-synced resources, and Desktop's exception can change effective availability independently of files. These are reported boundaries, not resources this adapter should synchronize.

## Primary sources

- **[R1]** [Official Claude Code changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md): 2.1.304 baseline; 2.1.119 Windows wrapper-warning removal and later platform fixes.
- **[R2]** [Official Claude Code repository](https://github.com/anthropics/claude-code): product identity and published release/documentation repository; not a complete reviewed CLI implementation.
- **[R3]** [Settings files and precedence](https://code.claude.com/docs/en/settings#where-settings-live): settings locations, explicit Windows root, separate self-written `.claude.json`.
- **[R4]** [Explore the `.claude` directory](https://code.claude.com/docs/en/claude-directory): file ownership, state/MCP separation, skills and Windows path explanation.
- **[R5]** [Advanced setup](https://code.claude.com/docs/en/setup#remove-configuration-files): explicit native Windows `.claude` and `.claude.json` defaults; [Windows/WSL setup](https://code.claude.com/docs/en/setup#set-up-on-windows).
- **[R6]** [MCP reference](https://code.claude.com/docs/en/mcp): [scopes](https://code.claude.com/docs/en/mcp#mcp-installation-scopes), [interpolation](https://code.claude.com/docs/en/mcp#environment-variable-expansion-in-mcp-json), transports, CLI writer, server processes, precedence, trust, and authentication helpers.
- **[R7]** [Skills reference](https://code.claude.com/docs/en/skills): [locations/symlinks](https://code.claude.com/docs/en/skills#where-skills-live), [ancestor/nested discovery](https://code.claude.com/docs/en/skills#discovery-from-parent-and-nested-directories), [collision rules](https://code.claude.com/docs/en/skills#resolve-skills-that-share-a-name), metadata, invocation, and native writers.
- **[R8]** [Environment variables](https://code.claude.com/docs/en/env-vars): `CLAUDE_CONFIG_DIR`, literal settings `env` values, configuration-root relocation restrictions.
- **[R9]** [CLI reference](https://code.claude.com/docs/en/cli-reference): native writer entry points, discovery flags, `auth status`'s `configDirectory`, safe/bare modes.
- **[R10]** [Agent Skills specification](https://agentskills.io/specification.md): required portable metadata, skill-directory contents, relative supporting resources.
- **[R11]** [Settings reference: plugin-only customization](https://code.claude.com/docs/en/settings-reference#strictpluginonlycustomization): policy restrictions for skills and MCP.
- **[R12]** [Authentication and credential management](https://code.claude.com/docs/en/authentication#credential-management): Linux/Windows credential files, macOS Keychain/fallback, profile relocation; not portable MCP configuration.
- **[R13]** [MCP persistence errors](https://code.claude.com/docs/en/errors#mcp-server-was-not-saved-or-removed) and [unconfirmed writes](https://code.claude.com/docs/en/errors#mcp-server-may-not-have-been-saved-or-removed): read-back behavior since 2.1.283.
- **[R14]** [Microsoft `CreateSymbolicLinkW`](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createsymboliclinkw): directory symlink and unprivileged-create/Developer Mode requirements.
- **[R15]** [Node `fs.symlink`](https://nodejs.org/api/fs.html#fssymlinktarget-path-type-callback): Windows link types and absolute directory-junction targets; these filesystem rules do not independently prove Claude loader behavior.
