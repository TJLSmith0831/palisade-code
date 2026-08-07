## 1. Groundwork

- [x] 1.1 Apply `/ponytail:ponytail` discipline throughout this change: reuse the existing `Modal`/`bar` union pattern for the new-thread picker rather than inventing a new one, reuse `setThreadMode`/`createThread` as-is, no speculative abstraction for a single shell-toggle boolean, shortest diff that satisfies each spec scenario.
- [x] 1.2 Read `src/App.tsx`, `src/App.css`, `src/api.ts`, and `src/__tests__/App.test.tsx` end to end before editing — trace how `chatTab`/`rightTab` state and the existing thread-selection flow work today, per CLAUDE.md "read before writing."
- [x] 1.3 Confirm current test suite is green (`npx vitest run` and `npx tsc --noEmit`) before making changes, so later failures are attributable to this change.

## 2. Workspace shell toggle (TDD)

- [x] 2.1 Write a failing test asserting a "Vibe | Editor" toggle renders in the top chrome, immediately after the traffic-light region, with one option active by default.
- [x] 2.2 Write a failing test asserting selecting "Editor" switches the rendered shell (e.g. the Editor-shell's file-tree/editor-tabs markup appears, the Vibe-shell's Edited-Files column does not) while the active project/thread selection is preserved.
- [x] 2.3 Write a failing test asserting switching shells does not call `api.setThreadMode` or otherwise change the active thread's `currentMode`.
- [x] 2.4 Write a failing test asserting the Vibe shell renders no Codebase Map control anywhere.
- [x] 2.5 Implement a `centerShell: "vibe" | "editor"` state var in `App.tsx` and the toggle UI/CSS to make 2.1–2.4 pass, reusing the existing `.ds-icon-btn`/pill-toggle visual language from DESIGN.md rather than a new component family. Default is `"editor"` (not `"vibe"`) — the spec only requires one option marked active on launch, and defaulting to today's layout meant zero churn for the ~40 pre-existing tests written against it.

## 3. Inline new-thread Vibe/Spec picker (TDD)

- [x] 3.1 Write a failing test asserting "+ New Thread" no longer calls `api.createThread` immediately, and instead renders an inline picker with "Vibe" and "Spec" cards in the chat surface.
- [x] 3.2 Write a failing test asserting picking "Vibe" calls `api.createThread` then `api.setThreadMode(..., "go")`, and the resulting thread becomes active.
- [x] 3.3 Write a failing test asserting picking "Spec" does the same with `"spec"`.
- [x] 3.4 Write a failing test asserting the composer's existing Spec/Go toggle still works, unchanged, on a thread created via the picker.
- [x] 3.5 Implement a shared `ChatSurface` component (mounted in both shells) whose `newThreadPicker` prop renders the two-card picker inline in place of the thread view. Deviates from this task's original wording: the picker is a plain `newThreadPicker: boolean` state, not a `bar.kind: "newThread"` Modal variant — the `new-thread-mode-picker` spec explicitly requires inline rendering, not a modal dialog, so the `bar` union's overlay mechanism was the wrong fit; "one shared component, two mount points" (design.md Decision 2) is preserved via `ChatSurface` itself.
- [x] 3.6 Remove the standalone `/propose` button from the chat header in both shells; verify `/propose` still works as a composer slash command (existing `onSend` special-case) via a regression test.

## 4. Vibe shell layout

- [x] 4.1 Write a failing test asserting the Vibe shell's chat renders as the main/primary column (not a tab).
- [x] 4.2 Write a failing test asserting an "Edited Files" column exists showing diff/turn-history content and any files opened from the tree.
- [x] 4.3 Write a failing test asserting the file tree in the Vibe shell renders inside a collapsed-by-default disclosure in the right rail.
- [x] 4.4 Implement the layout to satisfy 4.1–4.3, reusing `DiffPane`/`EventList`/`FileTree` as-is — this is a placement change, not a rewrite of those components. Files opened from the tree are shown via a lightweight `vibeFileTab: "changes" | "file"` toggle reusing the existing `selectedFile`/`FileEditorPane` state rather than a multi-tab open-files array — no spec requirement demanded true multi-file tabs, and this keeps the diff small.

## 5. Editor shell + collapsible Threads & Codebase Map rail (TDD)

- [x] 5.1 Write a failing test asserting the Editor shell renders the file tree on the left and Editor/Diff tabs in the center (the pre-existing tab-bar structure).
- [x] 5.2 Write a failing test asserting the right rail's Threads & Codebase Map disclosure is collapsed by default and chat (messages + composer) fills the remaining rail height when it is collapsed.
- [x] 5.3 Write a failing test asserting: open disclosure (1 click) → click a thread row (1 click) selects that thread AND collapses the disclosure again — assert via 2 `fireEvent.click` calls, per design.md Decision 5's testable-click-count approach.
- [x] 5.4 Write a failing test asserting: open disclosure (1 click) → click the Codebase Map tab (1 click) renders `GraphPane` — 2 clicks.
- [x] 5.5 Write a failing test (can live in the shell-toggle suite) asserting: from the Vibe shell, switching to Editor (1 click) → open disclosure (1 click) → Codebase Map tab (1 click) renders `GraphPane` — 3 clicks total, satisfying the spec's cross-shell scenario.
- [x] 5.6 Implement the collapsible disclosure (single boolean, reusing the Vibe shell's File Explorer disclosure pattern from 4.3 rather than a new component) to make 5.1–5.5 pass. Both disclosures share one `.ds-rail-disclosure`/`.ds-rail-disclosure-body` CSS pair — no duplicated component, just the same class names applied to each shell's own toggle button.

## 6. Executor/model/bypass menu (TDD)

- [x] 6.1 Write a failing test asserting a top-chrome control shows the current `preflight().selected` executor and opens a menu on click.
- [x] 6.2 Write a failing test asserting the executor row in the menu has no clickable/selectable affordance (read-only), per the detection-not-config constraint.
- [x] 6.3 Write a failing test asserting the model list is user-selectable and the chosen model persists to `localStorage` and is reflected on menu reopen (mirror the existing `floo:theme` persistence pattern).
- [x] 6.4 Write a failing test asserting the bypass-permissions toggle defaults off, flips to a visually-distinct on state, and persists across menu close/reopen.
- [x] 6.5 Implement the menu to satisfy 6.1–6.4. Label the model control's `title`/tooltip to make clear it's a stored preference not yet wired to executor invocation (design.md Risk on this), plus an in-menu `.hint` line saying the same. Bypass-on uses the existing `--warn` semantic token (elevated-risk state) rather than a new color.

## 7. Verification and polish

- [x] 7.1 Run the full suite (`npx vitest run`) and `npx tsc --noEmit`; fix any regressions in existing tests touched by the shell/thread-list refactor (e.g. tests that assumed the old single-shell layout). 189/189 passing, clean typecheck.
- [x] 7.2 Run `openspec validate --changes vibe-editor-shell-redesign --strict` and confirm it passes. Passes.
- [x] 7.3 Manually verify in the running app (not just tests): Vibe↔Editor toggle, new-thread picker in both shells, disclosure collapse/expand + auto-collapse on thread pick, executor/model/bypass menu, and the removed `/propose` button's slash-command replacement. Verified live via the Tauri MCP bridge (`pnpm start` + `mcp__tauri__*`), including a real backend round-trip (thread creation, mode switch). **Found and fixed a real bug**: the executor/model/bypass menu's entire CSS block had gone missing from `App.css` (lost to a concurrent write earlier in the session, unrelated to any deliberate edit) — the menu rendered unpositioned and clipped at the window's top edge. Re-added the block; verified fixed via screenshot, with menu selection (Opus 5) and close-on-select confirmed working.
- [x] 7.4 Run the appropriate `/impeccable` polish prompt over the implemented UI as a final quality pass before considering this change ready to ship. Verified live: checked stored critique snapshot (stale — pre-dated this session's restructure, superseded); confirmed the "2px accent left rail" side-tab pattern is earned by DESIGN.md's own documented language, not a stray default; checked new-thread-picker centering (correct — initial visual read was thrown off by screenshot scaling, not a real bug); confirmed bypass-on state reads as elevated-risk via the existing `--warn` token rather than a new color; confirmed graceful behavior down to 900px window width; confirmed no leftover debug artifacts or orphaned classes from the refactor. No further changes needed.
