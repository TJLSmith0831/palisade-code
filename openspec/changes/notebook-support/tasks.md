## 1. Notebook document model (foundation, no kernel yet) — amended by decisions.md D16

- [x] 1.1 Define `NotebookDoc`/`Cell`/`Output` TypeScript types + `parseNotebook(json)`/`serializeNotebook(doc)` in `src/notebook.ts`, matching nbformat v4 JSON (design.md D7, amended D16). No Rust doc struct.
- [ ] 1.2 `NotebookTab` loads a notebook via the existing `readFileContent` + `parseNotebook`. Malformed/unparseable JSON falls back to opening the file in `FileEditorPane` instead of erroring (design.md Migration Plan).
- [ ] 1.3 Save path: `serializeNotebook(doc)` + the existing `writeFileContent`. No new IPC command.
- [x] 1.4 (removed — no new Rust commands for open/save; nothing to register.)
- [x] 1.5 Frontend unit test (vitest): round-trip a real `.ipynb` fixture (code cell, markdown cell, existing PNG output) through `parseNotebook` → `serializeNotebook` and assert structurally equal.

## 2. Python driver process (riskiest piece — build and prove standalone first)

- [x] 2.1 Write the bundled driver script: wraps `jupyter_client.KernelManager`, reads JSON-line requests (`execute`, `interrupt`, `restart`) from stdin, writes JSON-line events (`Started`, `Stream`, `ExecuteResult`, `Error`, `ExecuteReply`, `Crashed`) to stdout (design.md D3).
- [x] 2.2 Manually verify the driver standalone (no Rust involved yet): pipe a hand-written `execute` request into it against a real local kernel, confirm the expected event sequence comes back on stdout.
- [x] 2.3 Add the driver script to the app bundle's resource path (packaging — see AGENTS.md for how sidecar-adjacent assets are currently bundled).

## 3. Rust kernel management + execution IPC

- [x] 3.1 Implement `NotebookKernel` (spawn/execute/interrupt/restart/terminate) per design.md D2, plus a `Drop` impl backstop mirroring `AcpSession` (acp_client.rs:203).
- [x] 3.2 Implement kernel resolution (design.md D4): read `metadata.kernelspec.name`, run `jupyter kernelspec list --json`, match-or-fallback-to-`python3`-with-warning, or error if neither resolves.
- [x] 3.3 `run_notebook_cell(notebook_id, cell_id, source)` IPC command: lazy-spawns the kernel via 3.2 if not running, then sends the execute request; forwards driver events to the frontend as `NotebookEvent`s in an `Envelope` (mirrors `ExecutorEvent`/`Envelope` in executor.rs:118,234).
- [x] 3.4 `interrupt_notebook_kernel` / `restart_notebook_kernel` IPC commands.
- [ ] 3.5 On `ExecuteReply` (frontend, not Rust), update the in-memory doc's cell output/execution_count and immediately call `writeFileContent` with the full serialized doc (design.md D5, amended D17) — this also clears the dirty indicator for any other pending unsaved edits, since save is whole-document.
- [x] 3.6 Kernel process cleanup wired into tab-close and app-quit hooks (design.md D6, amended D20 — no thread-switch trigger, notebook tabs aren't thread-scoped).
- [x] 3.7 Register all new commands in `generate_handler!` + `src/api.ts` wrappers.
- [x] 3.8 Rust unit tests: kernel resolution logic (named kernelspec found / not found / no python3 either) with a faked `jupyter kernelspec list` output; `NotebookKernel` state transitions without spawning a real process (mock the child).

## 4. Frontend: notebook tab and routing

- [ ] 4.1 Branch `renderCenterTab` in `App.tsx` on the active file tab's extension: `.ipynb` renders `<NotebookTab>`, otherwise `<FileEditorPane>` as today (design.md D1, amended D21 — no new tab-type union member).
- [x] 4.2 (removed — amended D21: `.ipynb` opens as an ordinary file tab through the existing `selectFile`/`tabs.open` path, no special-cased routing needed.)
- [ ] 4.3 Manual check: open a `.ipynb` from the file tree and from `⌘P`, confirm it renders as cells (spec: "Notebook files render as cells, not raw text").

## 5. Frontend: cell rendering and structural editing

- [ ] 5.1 Markdown cells render via the existing `@uiw/react-md-editor (`MDEditor.Markdown`)` + `rehype-sanitize` setup.
- [ ] 5.2 Code cells render via a per-cell CodeMirror 6 `EditorView` with Python syntax highlighting (no LSP/FIM wiring).
- [ ] 5.3 Add/delete/reorder/type-toggle controls per cell and at the notebook level; mutate the in-memory `NotebookDoc` cell array.
- [ ] 5.4 Explicit save (⌘S / Save button) calls `serializeNotebook` + `writeFileContent`; dirty indicator tracks unsaved source/structure edits, matching `FileEditorPane`'s existing pattern.
- [ ] 5.5 Frontend tests (vitest): cell add/delete/reorder/type-toggle mutate state correctly; dirty indicator sets/clears around save.

## 6. Frontend: execution UX

- [ ] 6.1 Run-cell action (button + Shift+Enter/Ctrl+Enter) calls `run_notebook_cell`; shows a "starting kernel…" state on the notebook's first run.
- [ ] 6.2 Render streamed output under each cell as events arrive: text/stream, image/png (as `<img>`), error/traceback (visually distinguished), fallback plain-text for unsupported types.
- [ ] 6.3 Interrupt and restart-kernel controls wired to their IPC commands; restart clears the "kernel has state" assumption in the UI (e.g. a subtle indicator that variables reset).
- [ ] 6.4 Kernel-missing / kernelspec-not-found warning surfaces as a non-blocking banner/toast, matching the existing executor-preflight warning pattern.
- [ ] 6.5 Frontend tests: output rendering for each type (text/image/error/unsupported-fallback) given mocked event sequences.

## 7. Export

- [ ] 7.1 `export_notebook(notebook_id, format)` IPC command: shells out to `nbconvert` (via the resolved kernel's Python) for `"script"` and `"html"`.
- [ ] 7.2 Frontend "Export…" action offering the two formats, saves the result to disk (reusing the existing save-file-dialog pattern if one exists, else a sibling-file default path).
- [ ] 7.3 Rust test: export command construction (args passed to `nbconvert`) without requiring a real Python install in CI — assert the invocation shape, skip actual execution if `nbconvert` isn't present.

## 8. End-to-end verification

- [ ] 8.1 Full gate: `pnpm test`, `npx tsc --noEmit`, `cd src-tauri && cargo test`.
- [ ] 8.2 Manual pass against the `run-palisade-code` skill: open a real notebook with a matching local kernelspec, edit a markdown cell, add a code cell, run it, confirm output (including a plot) renders and persists to disk after reopening the file.
- [ ] 8.3 Manual pass with no matching kernelspec and with no Python/Jupyter on PATH at all, confirming the two distinct warning/error paths from design.md D4 both surface correctly and don't crash the app.
