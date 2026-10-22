# mishmash

<img width="900" height="900" alt="image" src="https://github.com/user-attachments/assets/5fd46c1c-1e61-41ca-a1e0-fd6e0c963807" />

One reviewed set of **skills and MCP server definitions**, projected into multiple coding-agent harnesses without treating their configuration formats as interchangeable.

mishmash is a TypeScript/Node.js CLI and library for adopting existing native resources into `.agents`, reviewing a migration plan, and synchronizing selected targets. Initial adapter IDs:

| Harness | Adapter ID | MCP output |
| --- | --- | --- |
| Claude Code | `claude-code` | Project `.mcp.json`; scoped maps in user `.claude.json` |
| Codex | `codex` | `.codex/config.toml` |
| GitHub Copilot CLI | `github-copilot-cli` | Project `.mcp.json`; user `.copilot/mcp-config.json` |
| pi | `pi` | Project `.pi/mcp.json`; user `.pi/agent/mcp.json` |
| OpenCode | `opencode` | Version-specific `opencode.json` / existing JSONC |
| Gemini CLI | `gemini-cli` | `.gemini/settings.json` |

These are default locations; harness home overrides and reader capabilities matter. Skills use native `.agents/skills` discovery where compatible, otherwise individual links or tracked copies. Hooks, instructions, custom subagents, and plugin installation are not synchronized.

## Install and develop

Requires **Node.js 22.20.0 or newer** and npm. No npm-registry release is assumed; install from the public source repository:

```sh
git clone https://github.com/BechirMakhlouf/mishmash.git
cd mishmash
npm ci
npm run build
node dist/cli.js --help
```

To install the built package as a local CLI:

```sh
npm pack
npm install --global ./mishmash-0.1.0.tgz
mishmash --version
mishmash --help
```

The development checks are:

```sh
npm run typecheck
npm run build
npm test
npm run smoke
```

CI runs those commands after `npm ci` on Ubuntu, macOS, and Windows with Node 22.20.0 and 24. Tests and smoke use disposable configuration roots; no native harness installation or MCP connectivity is required. A green mishmash test run does not establish authentication, trust, or native harness activation.

## Inspect, migrate, synchronize

Run from the repository whose resources you want to manage, or supply `--project PATH`. `--scope project` is the default; the examples spell it out deliberately.

```sh
# Read only: inventory native Claude resources and existing canonical content.
mishmash inspect --from claude-code --scope project --project .

# Read only: review adoption plus projections, keeping Claude while adding Codex.
mishmash import --from claude-code --scope project --project . --target claude-code --target codex

# Apply the same migration explicitly.
mishmash import --from claude-code --scope project --project . --target claude-code --target codex --apply

# Edit the canonical resources, then review and apply the next projection.
mishmash plan --scope project --project .
mishmash sync --scope project --project . --apply

# Machine-readable inventory and plan.
mishmash inspect --from all --scope project --project . --json
mishmash plan --scope project --project . --target codex --json
```

`inspect`, `plan`, and `import`/`sync` without `--apply` do not write. Unsupported inputs and conflicts produce nonzero diagnostics; resolve findings before applying. Targets need not have installed executables: mishmash translates files, not installations. Repeated synchronization of unchanged inputs is a no-op. `--target` accepts repeated IDs or a comma-separated list; retained targets are stored in `sync.json`.

All commands accept `--scope project|user|project-private`, `--project PATH`, `--home PATH`, and `--json`. `inspect`/`import` accept `--from ADAPTER|all`; `plan`/`import`/`sync` accept `--target ID`.

Additional context options:

| Option | Contract |
| --- | --- |
| `--opencode-version 1\|2` | Select the native OpenCode major; default `2`. Never inferred by running a launcher. |
| `--claude-state-file PATH` | Explicit mixed MCP state-file location; required when a relocated Claude profile's state path is not established. |
| `--codex-profile-home PATH` | Explicit verified Codex profile-home location when its known-folder resolver differs from the canonical home; not the native `CODEX_HOME` config-root override. |
| `--skill-mode auto\|link\|copy` | Default `auto`: prefer direct discovery, then compatible links with tracked copy fallback. `copy` requests materialization. |
| `--state-dir PATH` | Place ownership state and recovery data in an explicit private local directory. |

For example, target an OpenCode V1 profile with `mishmash plan --scope project --target opencode --opencode-version 1`. Leave the version at `2` for the V2 `mcp.servers` envelope.

`--json` returns `{ version: 1, command, scope, targets, changes, diagnostics, applied }`. Each change contains `kind`, `path`, and `reason`, never file bodies. Diagnostics contain `code`, `severity`, `message`, and optional `adapter`, `resource`, and `path`. `inspect` additionally returns `inventory.skills` and `inventory.mcp` with resource IDs and provenance. Exit status, not merely the presence of output, indicates success.

### Scopes and privacy

| Scope | Canonical root | Meaning |
| --- | --- | --- |
| `project` | `<project>/.agents/` | Shared project resources, suitable for review and version control after checking content |
| `user` | `<home>/.agents/` | Personal, all-project resources; selected explicitly |
| `project-private` | `<home>/.agents/projects/<project-hash>/` | Private Claude MCP resources for one project, never shared project/global user definitions; private skills are unsupported |

```sh
mishmash inspect --from all --scope user
mishmash import --from claude-code --scope user --target claude-code --apply
mishmash inspect --from claude-code --scope project-private --project .
mishmash import --from claude-code --scope project-private --project . --target claude-code --apply
```

Claude's native MCP `local` means **project-private**, despite living in a user file. pi's `--local` means ordinary project scope. An MCP transport called `local` means a subprocess, not a filesystem scope. Unsupported private projections are reported rather than moved into public project or global user configuration. Project operations do not implicitly write user configuration.

For automation, pass **both** `--home PATH` and `--project PATH` to isolate native discovery, canonical roots, and local ownership state from your real configuration. Do not point these at a live profile when experimenting.

Without `--state-dir`, local ownership records live at `<home>/.local/state/mishmash/<canonical-root-hash>/state.json`, with private backups/recovery data alongside state. Keep this machine-local data out of source control; do not copy it between machines to manufacture ownership. An explicit `--home` disables inherited native configuration-root overrides; native profile paths can still be selected deliberately with supported explicit options.

## Canonical files

```text
.agents/
  sync.json
  skills/
    review-change/
      SKILL.md
      references/
      scripts/
  mcp.json
  overrides/
```

A whole skill directory is the unit of adoption: instructions, metadata, assets, references, and scripts remain together. Keep the skill directory name equal to its frontmatter `name`. Executable modes are retained where the filesystem supports them; scripts are never executed during import or sync.

Canonical JSON is strict: comments, trailing commas, and duplicate keys are rejected. Canonical JSON files and adapter override directories cannot be symlinks. Skill root aliases are deduplicated by real path; contained relative asset links are retained, while broken, cyclic, absolute, or escaping links are rejected. Standalone native Markdown skills remain native with a diagnostic rather than being converted into guessed resource directories. Unknown/harness-specific frontmatter, experimental `allowed-tools`, and `agents/openai.yaml` are retained as native-only compatibility findings, not assumed portable behavior.

Example `.agents/sync.json`:

```json
{
  "version": 1,
  "targets": ["claude-code", "codex", "gemini-cli"]
}
```

Example `.agents/mcp.json`:

```json
{
  "version": 1,
  "mcpServers": {
    "documentation": {
      "type": "streamable-http",
      "url": "https://developers.openai.com/mcp"
    }
  }
}
```

A private endpoint can instead use `"headers": { "Authorization": { "env": "DOCUMENTATION_AUTHORIZATION" } }`. This references a variable containing the **complete header value**; mishmash does not read or substitute it. Literal strings and `{ "env": "NAME" }` references are different values. Only supported native reference syntax is generated; unrepresentable fields produce findings, not secret expansion.

Non-secret target-specific server properties are stored at `.agents/overrides/<adapter-id>/mcp.json`. For example, `.agents/overrides/codex/mcp.json` can contain `{ "version": 1, "mcpServers": { "documentation": { "startup_timeout_sec": 30 } } }`. Conflicting overrides cannot silently replace projected canonical fields. Credentials and trust grants are excluded from overrides too. pi exposure-only project overlays remain native-only; they are not synthesized into independent portable servers.

Native tool allowlists, exclusions, and hidden-tool exposure stay with their source adapter. Cross-target projection is blocked when no equivalent policy mapping exists; a target-specific override is not a portable permission model. Account-managed skill names such as Claude's `synced` and `anthropic-skills` cannot be used as managed projection destinations.

The format is mishmash's application contract, **not** a universally discovered MCP file or an Agent Plugins schema claim. See [source of truth](docs/source-of-truth.md) for stdio argv, typed working directories, legacy SSE, target overrides, and migration invariants.

## Safety and compatibility

- Inventory and planning do not start MCP servers, run skill scripts or secret helpers, install/upgrade harnesses, log in, or grant trust. Starting a harness later may execute its configured servers; review the plan and configuration first.
- Credentials, literal authorization values, OAuth state, userinfo URLs, trust decisions, allow-all policies, sessions, and caches are not portable resources. A literal secret requires an explicit reference/binding before migration; do not commit it or paste it into a bug report. JSON diagnostics are redacted, but canonical skill content is still your responsibility to review.
- Native unrelated settings and unmanaged resources remain outside ownership. Known-invalid plans are rejected before writing; hashes/preconditions detect concurrent edits and drift. Application uses per-file replacement and private recovery backups, not a claim of filesystem-wide atomicity. There is no broad force-overwrite escape hatch.
- Native environment/header references are validated after adapter normalization, not mistaken for literal credentials. TOML updates use syntax-aware ranges for tables, dotted keys, inline maps, and multiline strings; unrelated configuration is retained. A shared native file with incompatible reader envelopes produces a conflict rather than losing one reader's inventory.
- Apply serializes writers with a per-state process lock and retains private transaction journals/originals under `<state-directory>/backups/txn-<uuid>/`. A later apply attempts pending-transaction rollback before proceeding. Recovery refuses to overwrite subsequently edited outputs; preserve the journal/backups and resolve the reported conflict instead of deleting state. Hash/link checks are protections against accidental drift and unsafe paths, not a sandbox against a hostile process racing filesystem operations with OS-level access.
- Skill-source aliases authenticate both the link and resolved tree. Unselected outputs keep their previous ownership hashes; post-install concurrent edits retain pending recovery evidence rather than being adopted as new baselines.
- MCP configuration is generated, not whole-file-linked. Claude and Copilot can share a project `.mcp.json` only when their entries are compatible; it is planned as one artifact.
- Same names do not imply the same effective resource across harnesses. Native precedence, project trust, disabled extensions, inherited roots, and version-specific options can change availability. Unsupported native semantics are findings, not silently discarded options.
- Linux, macOS, and native Windows are supported execution environments for mishmash. Native harness runtime behavior is documented separately in the [harness guides](docs/README.md). Windows symlinks may require Developer Mode/privileges; tracked copies are used where links cannot be created. Git's `core.symlinks=false`, junctions, case behavior, and executable permissions are not interchangeable Unix semantics.
- WSL is a separate Linux environment, not the same native Windows harness/profile. No automatic shell wrapping, `npx.cmd` rewriting, path rebasing between operating systems, or cross-OS script compatibility is promised.

### Adapter-specific limits

- **Claude:** a relocated `CLAUDE_CONFIG_DIR` does not establish the separate mixed-state filename; user/private MCP operations require `--claude-state-file` in that case. Explicit portable stdio `cwd` is unsupported rather than emitted as an invented native field.
- **Codex:** native Windows profile-home resolution must be established with `--codex-profile-home` when needed; native `CODEX_HOME` remains a separate existing absolute config root. Stdio environment references can forward the same variable name, not rename it. Token-only `bearer_token_env_var` cannot become a full Authorization-header reference without changing semantics; it remains a native portability limitation. Canonical full-header references use native `env_http_headers`.
- **Copilot:** relocated `COPILOT_HOME` disables default shared-user skill discovery; individual native bridges are needed. Extra configured skill directories retain their provenance; an ignored canonical directory is not treated as successful discovery.
- **pi:** exposure-only project overlays depend on a user server and remain native-only. A disabled/replaced built-in MCP extension can make generated MCP configuration inactive. Session-relative or unanchored user cwd semantics are not guessed into portable anchors.
- **OpenCode:** choose V1 or V2 explicitly when the default V2 is inappropriate. V1 HTTP-to-SSE fallback does not express forced legacy SSE; V2 does not support legacy SSE. Native enabled/disabled fields are version-specific and must not silently enable a disabled resource on another target.
- **Gemini:** untyped remote `url` negotiation must be resolved to explicit HTTP/SSE intent before portable adoption. Deprecated `httpUrl` is recognized, but conflicting dual URL fields are not silently reconciled.

Exact supported references remain references. Compound, file-backed, fallback, or otherwise unrepresentable native interpolation blocks portable cutover; interpolation-looking literals are rejected where the destination would interpret them. Unsupported cwd bases and unresolved relative native paths retain their source rather than being rebased by guesswork.

## Library and adapters

The package exports the synchronization core and adapter contracts for embedding. An adapter owns native path resolution, discovery, parsing/rendering, resource precedence, and capability diagnostics; the core owns canonical validation, scope, identity, ownership, planning, and safe application.

```js
import { createContext, inspect, createPlan, applyPlan } from 'mishmash';

const context = createContext({ scope: 'project', project: process.cwd() });
const inventory = await inspect(context, 'claude-code');
const plan = await createPlan(context, {
  command: 'import',
  from: 'claude-code',
  targets: ['claude-code', 'codex'],
});
// Review inventory and plan.diagnostics before explicitly opting into mutation.
if (!plan.diagnostics.some(({ severity }) => severity === 'error')) {
  await applyPlan(plan);
}
```

Library plans contain internal operations and file content, unlike redacted CLI JSON. Treat them as sensitive local data; do not publish raw plans or native configuration in logs. `createPlan` does not write. Only call `applyPlan` after application-specific review/consent; the example's explicit call is the mutation boundary.

Implement the exported `Adapter` interface in a dedicated adapter module: `id`, `resolve(context)`, `decode(entry, context)`, and `encode(server, override, context)`. Register it with `registerAdapter(adapter)` before calling the engine; the exported `adapters` map holds registrations. Native parsing and patching uses the core's document handling; adapters describe native files, map paths, skill roots, and supported translations.

To add a harness, follow the existing adapter registration and shared context/type patterns rather than introducing a product switch in the core. Supply deterministic path resolution for project/user/private scopes, preserve non-secret native-only fields and unmanaged content, and explicitly reject unknown transport/reference/cwd semantics. Add disposable filesystem tests for import, projection, conflicts, drift, read-only commands, and unchanged repetition; include Windows path behavior. Do not probe launchers that may install tools. See the [adapter boundary](docs/source-of-truth.md#adapter-boundary-and-verification) and [native research](docs/README.md).

## Project status

See [CHANGELOG.md](CHANGELOG.md) for the initial implementation and [docs/](docs/README.md) for upstream evidence and limitations. Public GitHub availability is not an npm-registry publication or an implied open-source license grant; no license has been selected for this repository.
