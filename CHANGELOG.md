# Changelog

## 0.1.0

Initial implementation of **mishmash**, a Node.js 22.20+ TypeScript CLI/library for skills and MCP server definitions.

### Added

- `inspect`, `import`, `plan`, and `sync` commands, explicit mutation with `--apply`, and redacted machine-readable output.
- Registry-based Claude Code, Codex, GitHub Copilot CLI, pi, OpenCode V1/V2, and Gemini CLI adapters, with project/user resource roots and explicit native capability diagnostics.
- `.agents` canonical skills, versioned MCP and target-selection documents, non-secret adapter overrides, whole-skill asset preservation, direct discovery, per-resource links, and tracked materialization.
- Project-private Claude MCP resources kept outside shared project/global user definitions; unsupported private projections do not change scope.
- Ownership/drift tracking, input preconditions, unmanaged-content preservation, private recovery backups, and rollback handling for application failures.
- Secret-reference translation without resolving credentials, executing helpers, granting trust, installing harnesses, or starting MCP servers during synchronization.
- Permanent filesystem/CLI behavior tests and a built-CLI subprocess smoke covering isolated native adoption, canonical edits, plan/apply, retained assets/unmanaged configuration, and unchanged repetition.
- CI coverage configured for Ubuntu, Windows, and macOS on Node 22.20.0 and 24; manual workflow dispatch supported.
- Public usage, development, adapter-extension, safety, and native-evidence documentation.

### Fixed

- Validate native credential references after normalization, retaining environment/header references through projection and reimport without resolving credentials.
- Reconcile TOML inline maps, dotted keys, and table declarations using syntax-aware edits; preserve multiline strings and unrelated settings.
- Reject cross-target loss of native tool restrictions or unanchorable working directories, and protect account-managed skill destinations.
- Preserve untouched ownership baselines, detect selected-output drift even on otherwise unchanged plans, and allow intentional canonical edits before a later import.
- Require relocatable contained skill-asset links and update YAML parsing to a patched release.
- Preserve own prototype-named resource keys throughout JSON/JSONC/TOML handling, reject ambiguous duplicate native JSON keys, and replace a TOML parser that mutated inherited built-in objects.
- Resolve temporary fixture paths to physical identities on macOS and Windows; remove a Unix-only symlink separator assertion while retaining containment, payload, hashing, and cutover coverage.

### Scope

Hooks, instructions, custom subagents, plugin installation, live MCP connectivity, authentication, and trust management are not synchronized. Native harness behavior remains version/platform-specific; generating configuration is not proof of activation. This release does not select a repository license or imply an npm-registry publication.
