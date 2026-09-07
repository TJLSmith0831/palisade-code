# Handoff: Astra Phase 2 UI/UX audit

**Branch:** `codex/astra-pass` (started at `3cb9f6d`)

## Current worktree

Terra's Phase 1 changes are present and uncommitted in `src/App.css`,
`src/App.tsx`, `src/EventView.tsx`, `src/SettingsPanel.tsx`,
`src/main.tsx`, `src/hooks/useAppShell.ts`, `src/projectSettings.ts`, and
their focused tests. Do not discard them. I added an uncommitted failing
regression test in `src/__tests__/FileEditorPane.test.tsx`.

## Live-audit results

The audit used Tauri MCP against the current debug build at 1440x900 and
900x600. Native computer use could only target an installed build with the
same bundle id, so I switched wholesale to MCP. Computed colors were resolved
through Canvas 2D; the Model picker normal text measured 15.39:1--16.73:1.

Terra's dark Mantine surfaces, two-line onboarding rows, narrow spec primer,
terminal badge, project-settings guarded writes, and notebook fallback were
observed in the current dev build. A malformed `broken.ipynb` opened as text;
after inserting valid notebook JSON, saving, reopening, adding a cell, running
it, saving, and reopening, it returned to notebook mode.

The live spec flow was exercised with **Claude Agent + Sonnet**. It reached
the primer and displayed the requested worktree/permissions/model controls,
then stopped at the agent boundary with `OAuth session expired and could not
be refreshed`. Do not troubleshoot authentication. Queue delivery and
agent-completed flows remain incomplete for that reason.

The New Project and Clone Repository native folder picker are blocked in this
environment: submitting the clone URL opened `NSOpenPanel`, the bridge wedged,
and the debug app panicked with `unexpected NULL returned from +[NSOpenPanel
openPanel]`. Document this environment-bound native-picker reproduction rather
than expanding scope unless it reproduces outside automation.

Panels exercised at both sizes: Explorer/tree, file search, source control and
commit box, workspace/recent projects/new window action, specs, verify/run and
debug panes, MCP, database empty state, chains/canvas empty state, history,
terminal tabs, Tests, Problems, Settings, editor tabs/save/breakpoint gutter,
notebook recovery and run. Graph, live database queries, populated review/stage
diffs, generated specs, and agent-dependent queues were shallow or unavailable
because the disposable audit project has no corresponding data and the agent
cannot authenticate.

## Contained fixes in progress

1. **Notebook recovery leaves a stale dirty tab marker.** In
`FileEditorPane` save success calls the parent `onSave` before React propagates
`setDirty(false)`. The parent rerenders `NotebookTab`, whose old dirty report
can overwrite the cleared tab state. A focused failing test now captures this:
`reports a clean tab before a save callback can replace the editor`.
Fix by reporting `onDirtyChange(path, false)` immediately before calling
`onSave`, then retain the existing state update.
2. **Notebook cell icon actions lack accessible names.** Add `aria-label`s for
run, move up/down, cell type menu, and delete. This is contained in
`src/NotebookTab.tsx`.

## Exact next steps

1. Apply the two fixes above; run the focused FileEditorPane and NotebookTab
tests, then typecheck.
2. Rewrite section 4 of `HANDOFF-ui-ux-pass.md` to retain only real remaining
work, including the native picker automation limitation and agent OAuth
boundary, plus shallow data-dependent panels.
3. Run the requested full gate once: `pnpm test && npx tsc --noEmit && (cd
src-tauri && cargo test)`. If the stated terminal PTY test flakes, rerun it
once only.
4. Read `HANDOFF-package-sh.md`, run `./package.sh`, and stop packaging only
at the explicitly known updater signing-passphrase failure; otherwise fix
build failures in scope.
5. Create exactly one final commit containing Terra's work, the two fixes,
handoff cleanup, and packaging fixes. Do not open a PR.
