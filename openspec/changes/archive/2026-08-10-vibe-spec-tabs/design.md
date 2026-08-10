## Context

See `proposal.md - Why`. The Vibe shell (`src/App.tsx`, `centerShell === "vibe"`) currently shows one active file at a time in its files column, with a tab strip that only marks the active file. The right sidebar lists Threads and a collapsible File Explorer, but has no spec surface. The Editor shell has a read-only `SpecPane` inside a right-rail disclosure. `api.listSpecChanges`, `api.showSpecChange`, `api.validateSpecChanges`, and the verification APIs already exist.

## Goals / Non-Goals

**Goals:**

- Surface OpenSpec changes in the Vibe shell without leaving the chat-first layout.
- Open a spec as a first-class tab in the existing files-column tab strip, alongside code files and diff.
- Render the change's artifacts (proposal, design, spec, tasks, verify) inside a single spec tab without writing to `openspec/changes/`.
- Reuse the existing tab-state, spec, and verification API machinery.

**Non-Goals:**

- No changes to the Editor shell's `SpecPane` or right-rail disclosure.
- No editing of spec artifacts in the Vibe UI. Markdown source editing remains the file tree's job.
- No new backend IPC commands. All data comes from existing `openspec` CLI wrappers and verification APIs.
- No persistent state across Vibe ↔ Editor shell switches. Spec tabs reset the same way file tabs do.

## Decisions

**1. Extend `openTabs.ts` to support spec tabs, or model them separately?**

- **Decision:** Extend `OpenTab` with a union discriminator: `type: "file" | "spec"`, where `path` is the file path and `specName` is the change name.
- **Why:** The tab strip already handles selection, closing, and keyboard cycling. Adding a second parallel list for spec tabs would duplicate that logic. A union keeps `tabs`, `activePath`, and `activeTab` polymorphic and lets `TabBar` render both file and spec tabs from one list.
- **Alternative considered:** Keep a separate `specTabs` state in `App.tsx`. Rejected because `useOpenTabs` already owns the semantics for "which tab is active and what closes next," and file/spec tabs behave identically for selection and closing.

**2. How does a spec tab render?**

- **Decision:** Introduce a `SpecChangeTab` component that takes `projectHash` and `specName` and renders `api.showSpecChange` output with inner `Tabs` for Proposal/Design/Spec/Tasks/Verify.
- **Why:** `FileEditorPane` is a live CodeMirror saveable editor; a spec tab is a read-only structured view. Rendering them with the same component would overload `FileEditorPane` and risk implying spec files are editable.
- **Alternative considered:** Open each artifact as a separate `FileEditorPane` loading the raw `.md`. Rejected because `CLAUDE.md` says Floo never writes a spec file; presenting them as editor tabs would look like any other editable file.

**3. Where does the Vibe files column decide what to render?**

- **Decision:** `App.tsx` switches on `activeTab.type` in the Vibe files area: `type === "file"` renders `FileEditorPane`/`DiffPane`; `type === "spec"` renders `SpecChangeTab`.
- **Why:** The Vibe shell already does conditional rendering for diff vs. file. A spec tab is another conditional surface.

**4. What does the right sidebar Specs section render?**

- **Decision:** A new `VibeSpecLauncher` component that calls `api.listSpecChanges` and `api.validateSpecChanges`, shows name/status/mini progress, and on click calls the same `open` function that spec tabs use.
- **Why:** This is the same data `SpecPane` already fetches, but in a compact launcher form. It reuses `SpecPane`'s caching pattern (per-project, invalidated on `fs-changed` events under `openspec/`).

**5. How is the linked-change chip wired?**

- **Decision:** The chat header chip in `ChatSurface` gets an `onClick` that calls the same `openSpecTab(specName)` helper used by the launcher.
- **Why:** The chip already has the name via `thread.openSpecChangeName`; opening the linked spec should be the same path as opening it from the sidebar.

**6. Where is the verify pin stored?**

- **Decision:** A `verifyPins: Record<string, string[]>` map in `.project-settings.json` under the project's settings.
- **Why:** `.project-settings.json` is machine-local, gitignored, and already managed by `settings.rs`. It persists without touching `openspec/changes/` files and without adding a new backend data store.
- **Alternative considered:** Store the pin in thread/session metadata. Rejected because the pin is a project-level user preference, not tied to one conversation.

**7. How are verify commands presented?**

- **Decision:** The Verify tab renders the full `VerifyPane`-style list of configured commands and latest runs. The Tasks tab, if `verifyPins[specName]` exists, shows one primary "Run verify" button using the first pinned command.
- **Why:** Keeps the project-level verification truth in one place while giving the most relevant command one-click access from the task list.

## Risks / Trade-offs

- **[Risk]** Adding `type` to `OpenTab` ripples into `TabBar.tsx`, `__tests__/openTabs.test.ts`, `__tests__/TabBar.test.tsx`, and the session save/restore path. Any test that assumes every `OpenTab` has a `path` string will fail.
  - **Mitigation:** Keep the `path` field for file tabs; `specName` only on spec tabs. Update `basename` in `TabBar.tsx` to handle both: `tab.type === "spec" ? tab.specName : basename(tab.path)`. Add tests for mixed tab lists.

- **[Risk]** `App.tsx` is already large (~1.7k lines). Adding `SpecChangeTab` and `VibeSpecLauncher` inline would bloat it further.
  - **Mitigation:** Put `SpecChangeTab` in `src/SpecChangeTab.tsx` and `VibeSpecLauncher` in `src/VibeSpecLauncher.tsx`. Import and wire them in `App.tsx`.

- **[Risk]** The Vibe shell currently shows only the active file; adding a tab strip with multiple open tabs may confuse users who relied on the "+N more — open Editor" pattern.
  - **Mitigation:** Keep the tab strip overflow behavior and the "open in Editor" escape hatch for the file list. The change is additive; users who prefer the old single-file view can still have only one file open.

- **[Risk]** `showSpecChange` returns raw `unknown`; rendering it requires a structured representation that `openspec` may not yet provide.
  - **Mitigation:** If `openspec show --json` does not yet exist or does not include the parsed artifacts, the first task is to extend the `openspec` CLI (or parse the markdown on the frontend) and the design should not assume a stable schema today. Call this out as the riskiest task.

- **[Risk]** `.project-settings.json` is per-machine. A verify pin set on one laptop is not available on another.
  - **Mitigation:** This is consistent with the file's existing purpose (local settings, gitignored). Document that verify pins are personal UI state, not project config.

## Migration Plan

Purely additive UI change. No data migration. Existing Editor shell `SpecPane` is untouched. Vibe users gain a new sidebar section and a new tab type. Backward-compatible: if a project has no `verifyPins`, the Tasks tab simply shows no primary verify button.

## Open Questions

(none — resolved by D11: `openspec show --json` returns only spec deltas, so artifacts are read as `.md` files via `readFileContent` and rendered with `MDEditor.Markdown`.)
