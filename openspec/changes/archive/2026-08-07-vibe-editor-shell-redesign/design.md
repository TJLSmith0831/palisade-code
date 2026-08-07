## Context

See proposal.md - Why. Today `src/App.tsx` renders a single workspace shell: chat is merged inline into the right Threads panel (from an earlier, since-reverted pass), the right rail has no way to reach Codebase Map without scrolling past a growing thread list, and there is no UI control anywhere for executor/model selection or permission-bypass. `src/api.ts`'s `Mode` type (`"spec" | "go"`) and `setThreadMode` are unchanged by this design — every new interaction routes through them. CLAUDE.md states "Executor selection is by detection, not config," which this design treats as binding.

## Goals / Non-Goals

**Goals:**
- Two switchable shells (Vibe, Editor) sharing one `App.tsx` state tree — no route change, no remount of `project`/`thread` state.
- Editor shell's right rail keeps Threads + Codebase Map reachable within the proposal's 3-click budget without permanently costing chat its height.
- New-thread creation always goes through the inline Vibe/Spec picker, in both shells, reusing one component.

**Non-Goals:**
- No backend/Rust changes (per proposal Impact). Model selection is a client-side preference only in this change — it is not yet threaded into the executor invocation. Making model selection functionally affect which model the executor CLI runs is future work; this change ships the control and stores the preference, nothing more.
- No change to `Mode`, `setThreadMode`, `createThread`, or any other `api.ts` signature.
- No change to executor auto-detection (`api.preflight`); the executor row in the new menu is a read-only reflection of `preflight().selected`, never a settable value.
- Terminal placement, Diff pane internals, and Codebase Map's own rendering (GraphPane) are unchanged — only where Codebase Map is *reachable from* changes.

## Decisions

**1. Shell state lives in `App.tsx`, not a route.**
A single `centerShell: "vibe" | "editor"` state var (name deliberately distinct from the existing `Mode` type to avoid confusion with thread mode) drives which JSX tree renders. Alternative considered: two separate top-level routes/views with their own mounted component trees — rejected because it would force `project`/`thread`/`messages` state to either duplicate or lift further, and the two shells need to share the exact same active thread when switching (per the `workspace-shell-toggle` spec's requirement that switching preserves the active thread).

**2. New-thread picker is one shared component, rendered in two places.**
Both shells' "+ New Thread" flow renders the same `NewThreadPicker` (two cards, `onPick(mode: Mode)`), differing only in where it mounts (replacing the Vibe shell's chat column vs. the Editor shell's chat-in-rail area). This mirrors the `Modal`/`bar` reuse pattern already established in the codebase (see CLAUDE.md "Reuse before writing") rather than building shell-specific pickers.

**3. Threads & Codebase Map disclosure is a single collapsed-by-default `<details>`-style toggle, not two independent toggles.**
Alternative considered: keep Threads and Codebase Map as always-visible separate sections (today's Vibe-shell pattern, extended). Rejected per the proposal's explicit ask — the whole point of this capability is that chat, not the list, owns the rail's height by default. A single disclosure also makes the "collapses automatically on thread pick" requirement trivial to implement (one boolean flips).

**4. Executor is display-only; model and bypass are the only user-settable controls in the new menu.**
Resolved during spec-writing (see `executor-model-switcher/spec.md`) after finding this proposal's first draft conflicted with CLAUDE.md's "detection, not config" rule for executor selection. Model and bypass carry no such constraint — CLAUDE.md is silent on them — so they remain user-selectable, persisted client-side (`localStorage`, mirroring the existing `floo:theme`/`floo:terminalPlacement` pattern already in `App.tsx`).

**5. The 3-click budget is a testable interaction count, not a subjective feel.**
Each spec scenario in `editor-collapsible-rail` names the exact click sequence (e.g., "open disclosure (1) + select thread (1) = 2"). Tests assert this directly via `fireEvent.click` call counts in the TDD task breakdown, rather than relying on visual review alone.

## Risks / Trade-offs

- **[Risk]** Collapsing the Editor shell's disclosure on every thread pick could feel abrupt to a user who wants to compare two threads' titles while chatting. → **Mitigation**: this matches an explicit proposal requirement (reachability over persistent visibility); revisit only if user feedback says otherwise post-ship.
- **[Risk]** A model picker that doesn't yet affect executor behavior could read as broken/decorative once discovered. → **Mitigation**: tasks.md includes a task to label the control clearly (e.g., a `title`/tooltip noting "model selection" scope) rather than implying it's already wired end-to-end; this is called out explicitly as a Non-Goal above so it isn't silently forgotten.
- **[Risk]** Two shells sharing one state tree risks the Vibe shell's Edited-Files-column state (open file tabs) leaking into the Editor shell or vice versa. → **Mitigation**: file-tab state stays scoped to the Vibe shell's own component subtree, not lifted to `App.tsx`; the Editor shell's file tree opens files directly into the existing `FileEditorPane`/`selectedFile` state, unaffected by Vibe-shell tab state.

## Migration Plan

Purely additive/UI — no data migration. Existing threads and their `currentMode` are read as-is; no schema change. Ship behind no flag (small enough diff, per CLAUDE.md's "shortest working diff" and no third mode/schema risk). Rollback is a plain revert of the `App.tsx`/`App.css` diff.
