# mishmash: Clack rewrite requirements

## Status and reset boundary

- Branch: `feat/clack-rewrite`.
- This change records the requirements and removes the previous implementation. It does not implement the replacement app.
- Keep Git history and this document. Remove the old source, tests, documentation, package/build configuration, CI, installed dependencies, generated output, and package archives from the working tree.
- The previous README, including its image, remains in Git history. It is not a reason to carry the rejected application into the rewrite.
- Build the replacement from these requirements, not by reskinning the Ink workbench or copying its interaction model.

## Product direction

mishmash helps a developer discover coding-agent resources, choose which source is authoritative, and synchronize selected resources to selected agents and locations.

The experience must be a polished, keyboard-driven terminal application in the style of `npx skills`: an inline CLI with ready-made pickers and prompts. It must not be a full-screen dashboard, alternate-screen workbench, or custom terminal UI framework. Here, “TUI” means the interactive terminal experience, not a requirement to take over the entire terminal.

Skills discovery and source-of-truth selection are the central interaction. Do not lead with internal configuration terminology or require users to understand the old canonical-file model before choosing resources.

## Required stack

- Use TypeScript and Node.js. Preserve the supported Node.js baseline of 22.20 or newer unless a deliberate compatibility decision is recorded.
- Use [`@clack/prompts`](https://github.com/bombshell-dev/clack) for ready-to-use selection, multiselection, confirmation, loading, cancellation, and completion UI.
- Use Clack's opinionated components rather than rebuilding checkboxes, key handling, scrolling, focus management, or spinners.
- Do not use Ink, React, or a custom terminal renderer.
- Use Vitest for automated tests of core logic: discovery, source-of-truth selection, conflict handling, planning, and filesystem synchronization. Use disposable project/home directories and assert real filesystem outcomes.
- Do not add terminal automation libraries or build a custom PTY harness for the initial rewrite. Verify Clack interactions with manual terminal smoke checks for now.
- Keep presentation separate from discovery, source selection, planning, and filesystem application. Prefer small direct modules, not a generic UI framework.

## Interaction reference and visual direction

- Reference: [`vercel-labs/skills`](https://github.com/vercel-labs/skills), especially its interactive skill and agent selection flow.
- Adopt the interaction quality, not its product branding, telemetry, or unrelated installation features.
- Use the terminal's font and background and Clack's standard styling. Use color to distinguish focus, selection, loading, success, warning, and failure; retain meaningful text when color is disabled.
- Keep output compact and left-aligned. One active question at a time; completed answers remain in normal terminal scrollback.
- No decorative dashboard chrome, repeated project/home banners, permanent step trail, large blank panels, or duplicated status messages.
- Show the next useful choice and its consequences, not a wall of implementation details.
- Do not ask irrelevant questions: for example, a run selecting only MCP servers must not ask how to link skill directories.

## Required user journey

### 1. Discover resources

- The normal interactive entry point starts discovery without requiring a memorized subcommand or a set of flags.
- Show a Clack loading animation while discovery is genuinely running. Stop it with a useful detected-resource summary before presenting the picker.
- Discover existing skills and MCP definitions in the selected project/user context, including native agent directories and existing shared directories.
- Initial agent coverage: Claude Code, Codex, GitHub Copilot CLI, pi, OpenCode, and Gemini CLI. Detect configuration/filesystem presence without running or installing agent launchers.
- Show which agents, source directories, skills, and MCP registrations were actually found. Distinguish detected agents from other supported destinations.
- Each skill choice includes its name, a useful description when available, source agent/directory, and scope. Details must be accessible without dumping every full path into every option label.
- Distinguish project resources from user resources; do not silently flatten inherited user resources into a project.
- Never run MCP servers, skill scripts, credential helpers, or authentication flows during discovery.
- Empty discovery explains which locations were checked and lets the user change context or provide an existing source directory. It must not leave an empty picker with no useful next action.
- Invalid/unreadable sources produce actionable findings, not silent disappearance or raw credential-bearing errors.

### 2. Choose the source of truth

- Explicitly ask which detected source should be authoritative. Do not assume the first detected agent, newest file, or `.agents` directory is correct.
- Allow the user to choose a detected native source or an existing shared source directory. A native source does not silently become a different authoritative directory just because the old app used `.agents`.
- Make the chosen source and its exact location visible in the confirmation summary. State where the user should edit resources after synchronization.
- Selecting an agent as the source is distinct from selecting agents as destinations.
- Retain provenance when the same skill/server appears in more than one source.
- When the same name has different contents or intent, present an explicit source choice or block the conflicting selection. No last-writer-wins and no automatic merge of divergent skill directories.
- If resources are selected from multiple sources, each resource's authority must be unambiguous. Selecting all sources must not silently resolve conflicts.
- Remember the approved source selection in the chosen project/user configuration so later runs can present it accurately for review. Do not silently rewrite that selection.
- The storage format and source-to-destination strategy must be documented during implementation; the old canonical schema is not a compatibility constraint.

### 3. Pick what to synchronize

- Use a Clack multiselect picker for individually selecting detected skills. Use a clearly separate group or prompt for MCP server definitions.
- Support keyboard navigation, visible focus, selected/unselected state, and selection counts using the library's conventions.
- Make long lists usable through library-supported filtering/search and bounded option display. Do not implement a second bespoke picker to achieve this.
- Preserve selections while filtering; selecting/clearing filtered results must not unexpectedly change hidden choices.
- Allow backing out or cancelling without filesystem mutation.
- Reject advancing with no selected resources using a clear prompt-level explanation.
- Unchecked resources remain untouched. The UI must not imply that an unchecked skill becomes inaccessible to an agent that already discovers its directory.
- Preserve whole skill directories, including assets, references, and executable modes where supported. Do not reduce a skill to its `SKILL.md` text.
- Never promise portability for unsupported native metadata or MCP semantics. Report the limitation before apply.

### 4. Pick destinations and placement

- Use a Clack picker for destination agents, with detected agents distinguished from other supported agents.
- Let users choose project-local or user-wide placement explicitly. Keep private project resources private; do not publish them into a shared project or global user scope.
- Show the resolved destination paths and their scope before applying changes.
- Ask about link/copy behavior only when relevant to the selected skills/destinations; explain whether edits remain connected to the authoritative source or require another sync.
- Do not invent arbitrary output layouts. Respect the destination agent's supported paths and discovery/configuration semantics.
- Do not force the old app's target-retention model or compatibility aliases into the rewrite. Any required retained destination must be explained and visible rather than silently added.
- Do not infer that an installed executable means a resource is active, trusted, authenticated, or connected.

### 5. Review, confirm, apply

- Before writing, show a concise summary of authoritative source(s), selected resources/counts, destination agents, placement paths, and link/copy/generated-config behavior.
- Distinguish planned additions, updates, links, copies, and removals; make conflicts and warnings visible. Provide access to full paths/details without returning to a dashboard.
- Nothing mutates before explicit confirmation. The confirmation's default must not write.
- Blocking errors prevent apply. There is no force-overwrite escape hatch for unsafe collisions or drift.
- Preserve unmanaged native settings and unchecked resources. Recheck source/destination state before mutation so stale reviews cannot overwrite concurrent edits.
- Applying uses recoverable backups and safe per-file replacement. Do not claim filesystem-wide atomicity.
- Use Clack's spinner/task UI for real work. No artificial delays, fake progress percentages, or incessant frame-by-frame log output.
- Completion reports synchronized resources/destinations, unchanged/skipped items where relevant, and backup/recovery information when files changed.
- A repeated run with unchanged inputs is a no-op and reports that clearly.
- Synchronization does not start agent processes or MCP servers and does not grant trust.

## Terminal and cancellation behavior

- Use normal terminal scrollback. Restore cursor visibility and input state on success, cancellation, and failure.
- Follow Clack's keyboard/cancellation conventions; do not advertise keys the selected prompt does not support.
- Before apply, cancellation exits without writes and says so. During a write transaction, cancellation must settle or recover safely and must not falsely report “no writes.”
- Loading animations stop correctly on success, error, and cancellation, with no orphaned intervals or hanging process.
- Work at both 60×20 and 100×30 terminal sizes; long paths and resource lists must not hide the active choice or confirmation.
- Support terminals with disabled color and use accessible text labels in addition to symbols.
- A non-TTY invocation must not hang waiting for prompts or crash trying to enable raw mode. Show help or require explicit noninteractive inputs; keep any machine-readable output free of prompt/animation control sequences.
- Sanitize filesystem-derived names and paths before terminal rendering; never emit credential/configuration bodies in diagnostics or test artifacts.

## Required automated core coverage

Use Vitest to test core modules independently of Clack prompts. Exercise real files in disposable project/home directories; do not read or modify developer profiles.

- Discovery returns the correct skill names, descriptions, source paths, agent identities, and scopes from fixtures.
- Choosing a source of truth uses its actual content, not another same-named source or an automatically preferred shared directory.
- Divergent same-name sources require an explicit selection or produce a blocking conflict; unchecked resources are never silently merged into selected resources.
- Approved source selections persist correctly and are read back without silently changing authority.
- Resource filtering/selection preserves checked IDs and does not change hidden choices unexpectedly.
- Synchronizing a subset of skills/MCP servers preserves unchecked resources and unrelated native settings.
- Project/user/private placement resolves the correct paths and writes only within the approved scope.
- Discovery and planning are read-only and never execute agent launchers, MCP servers, skill scripts, or credential helpers.
- Rejected confirmation or cancellation before apply results in no writes; cancellation/failure during apply preserves or recovers filesystem state safely.
- Blocking findings, stale plans, unmanaged collisions, and owned-output drift prevent unsafe writes.
- Successful application preserves complete skill assets and supported executable modes, with recoverable backups for changed files.
- Repeating an unchanged operation does not rewrite files or create new backups.
- Errors and diagnostics do not expose credentials or configuration bodies.

Test behavior and filesystem boundaries, not exact wording, prompt wiring, component internals, or mocks that merely echo selected values. Do not claim platform coverage that has not been exercised.

## Manual terminal smoke checks

Run the actual Clack CLI before declaring the replacement complete. Check detected-resource presentation, source selection, multiselect/filtering, destination placement, safe-default confirmation, cancellation, loading cleanup, and success/error output. Check 60×20 and 100×30 terminals and piped invocation. These are manual checks for now, not a requirement to introduce terminal test infrastructure.

## Future testing option

Consider [`@microsoft/tui-test`](https://github.com/microsoft/tui-test) later if automated terminal interaction coverage becomes necessary. It is not part of the initial stack, must not be installed for this rewrite, and is not a completion gate.

## Scope limits

- This remains a skills/MCP synchronization tool, not an agent installer, package marketplace, chat client, authentication manager, or trust manager.
- Do not add hooks, instructions, custom subagents, plugin installation, telemetry, automatic upgrades, or background services as part of this rewrite.
- Do not carry forward the old CLI's command/API/configuration surface merely for backward compatibility. Choose the smallest command surface that serves this documented flow.
- No placeholder app, demo-only spinner, fake inventory, or scaffold is a completed implementation. The next implementation must complete the real discovery → authority → selection → placement → review → apply journey.

## Completion gate for the replacement

The replacement is ready only after the documented journey works in the actual terminal, the Vitest core suite passes, filesystem safety behavior is verified, and usage documentation describes the real commands and source-of-truth semantics. Automated terminal tests are deferred; manual CLI smoke checks are sufficient for the interactive layer for now. The current branch-reset deliverable is this requirements document and an otherwise empty application working tree—not a running Clack app.
