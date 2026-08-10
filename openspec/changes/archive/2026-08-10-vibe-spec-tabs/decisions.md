# Explore: Vibe Shell — Specs as Editor Tabs

**Topic:** Bring OpenSpec changes into the Vibe shell as first-class editor tabs, mirroring how files/diffs already live in the files column and how Devin Desktop opens agent artifacts as tabs.

**Started:** 2026-08-09

## Context

The Vibe shell (`src/App.tsx`, `centerShell === "vibe"`) is chat-first. Code/diff surfaces live in the files column. The Editor shell has a `SpecPane` tab inside a collapsible right-rail disclosure. The user wants the same spec reachability in Vibe without switching shells.

A first mockup put specs in a right-sidebar disclosure as a large focused card + compact list. After seeing Kiro (sidebar specs overview + `requirements/design/tasks.md` artifacts) and Devin Desktop Agent mode (codemaps/PRs/files open as rounded-pill editor tabs), the direction pivoted: specs should open as tabs in the file column. A second mockup was built and accepted visually.

This exploration asks: is that the right scope and shape to build?

## Decisions

<!-- Entries appended as things settle. Format:
## D<n>: <the question, one line>
- **Decision**: <what was settled>
- **Why**: <one sentence>
- **Source**: user | codebase (<path:line>) | recommended-accepted
-->

## D1: What is the spec unit that opens as a tab?

- **Decision**: An OpenSpec change opens as one tab. The change's artifacts (`proposal.md`, `design.md`, `spec.md`, `tasks.md`) are rendered inside that tab via inner tabs, not as separate top-level tabs.
- **Why**: One change is the natural unit of work and linking; inner artifact tabs avoid tab explosion while keeping all spec content reachable from the Vibe shell.
- **Source**: user (mockup review)

## D2: Where does the spec list/launcher live in Vibe?

- **Decision**: A compact "Specs" list lives in the right sidebar below Threads and above File Explorer, replacing the current `SpecPane` surface.
- **Why**: The Vibe shell's chat column must stay primary; the right sidebar is already a launcher (project, threads, file explorer); specs fit there as a navigational list.
- **Source**: user (mockup review)

## D3: What clicking a spec does

- **Decision**: Clicking a spec in the sidebar, or the linked-change chip in the chat header, opens that spec as a tab in the files column and focuses it.
- **Why**: Mirrors Devin Desktop's behavior (codemaps/files/PRs open as editor tabs) and keeps the user in the Vibe shell while reading artifacts.
- **Source**: user (mockup review)

## D4: Should the spec tab be read-only or editable?

- **Decision**: The spec tab is a **read-only structured view** rendered from `openspec show --json` (or equivalent). It does not open `proposal.md`/`design.md`/`tasks.md` as raw CodeMirror tabs for editing.
- **Why**: `CLAUDE.md` explicitly says OpenSpec is authoritative and Floo "never writes a spec file" (`openspec/changes/...` files are written by the grill flow and the agent, not by a UI save action); a read-only surface honors that rule, while the user can still edit the underlying `.md` files directly via the file tree if needed.
- **Source**: `CLAUDE.md` line "OpenSpec is authoritative for specs"

## D5: What is the relationship between the existing `SpecPane` in Editor shell and the new Vibe spec tabs?

- **Decision**: Keep the existing Editor shell `SpecPane` unchanged and add the new tabbed spec surface only in the Vibe shell.
- **Why**: The user selected the Vibe-only option; this avoids touching the existing `editor-collapsible-rail` spec and its 3-click reachability guarantees, and lets the Vibe shell experiment with the Devin-style tab pattern without forcing a breaking Editor change.
- **Source**: user

## D6: Do spec tabs persist across Vibe ↔ Editor shell switches?

- **Decision**: Spec tabs reset when leaving the Vibe shell, matching the current Vibe file-tab behavior. The active file/spec is not lifted to `App.tsx` or `session.ts`.
- **Why**: The user selected consistency with file tabs; this keeps the Vibe shell's state local and avoids a one-off lift for spec tabs. If persistence becomes painful later, it can be lifted for _all_ Vibe tabs at once.
- **Source**: user

## D7: How are verify commands shown and invoked inside the spec tab?

- **Decision**: The Verify tab shows the project-wide verify command list (same as `VerifyPane`). Additionally, the user can pin one or more verify commands to the Tasks tab as a "Verify this change" action.
- **Why**: The user selected the hybrid option; it keeps the honest project-level verify surface while making the most relevant verify action reachable from the task list without switching inner tabs.
- **Source**: user

## D8: Where is the verify pin stored?

- **Decision**: The pin lives in `.project-settings.json` as a `verifyPins` map keyed by spec change name (e.g., `{ "add-vibe-spec-surface": ["typecheck", "vitest"] }`).
- **Why**: It persists across sessions, doesn't require writing spec files (respecting the OpenSpec authority rule), and the existing `settings.rs` already manages `.project-settings.json` as machine-local config.
- **Source**: user

## D9: How is the pinned verify command presented in the Tasks tab?

- **Decision**: One primary "Run verify" button at the top of the Tasks tab, using the first pinned command. Additional pinned commands remain reachable inside the Verify tab.
- **Why**: The user selected a single primary action; it keeps the Tasks tab focused on the task list while giving the most relevant verify command one-click access.
- **Source**: user

## D10: What is the new capability name?

- **Decision**: The new capability is `vibe-spec-tabs`, matching the change name.
- **Why**: It is kebab-case, identifies the Vibe shell and the tab behavior, and aligns with the existing capability naming convention in `openspec/specs/`.
- **Source**: recommended-accepted

## D11: How are spec artifacts (proposal/design/tasks/verify) rendered when `openspec show --json` only returns spec deltas?

- **Decision**: Read the artifact `.md` files directly from disk via `api.readFileContent(projectHash, "openspec/changes/<name>/<artifact>.md")` and render them read-only with `MDEditor.Markdown` (the existing pattern from `GraphPane`). No `openspec` CLI extension and no frontend markdown parser spike needed beyond the already-installed `@uiw/react-md-editor`.
- **Why**: `openspec show --json` returns only `{id, title, root, deltaCount, deltas}` — the spec requirements, not the planning artifacts. The artifacts already live as files under `openspec/changes/<name>/`, `readFileContent` is an existing IPC command that resolves relative paths against the project root, and `MDEditor.Markdown` is already used in `GraphPane` for read-only markdown rendering. This is the shortest path that reuses existing machinery without writing a new CLI subcommand or a custom parser.
- **Source**: codebase (`src-tauri/src/executor.rs:1047`, `src/GraphPane.tsx:4`, `src/api.ts:385`) — resolves the Open Question in `design.md`.

## Open questions

(none — exploration is change-shaped)
