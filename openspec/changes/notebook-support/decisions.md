# Explore: Notebook (.ipynb) support

Source: GH Issue #10 — "Currently, there's no way to support a .ipynb file."

## D1: What's actually broken today
- **Decision**: `.ipynb` has no entry in `byExtension` ([src/lsp.ts:12](src/lsp.ts:12)), so `languageForPath` returns `null`. The file opens in `FileEditorPane` as plain, unhighlighted text — the raw JSON of the notebook (cell arrays, base64 image outputs, metadata), not a notebook view.
- **Why**: Traced `languageForPath` → `FileEditorPane.buildExtensions` (src/FileEditorPane.tsx:565); no notebook-aware branch exists anywhere in the editor or tab system.
- **Source**: codebase (src/lsp.ts:12, src/FileEditorPane.tsx)

## D2: Scope is read/edit + execution
- **Decision**: v1 renders cells (markdown + code + outputs), supports per-cell edit + save-back to valid nbformat JSON, AND supports actually running a cell against a live kernel (execute, stream output, restart/interrupt) — not just a rendered viewer.
- **Why**: User chose this over the no-execution and view-only options; the reporter's "no way to support a .ipynb file" is read as wanting the notebook to actually work, not just look right.
- **Source**: user

## D3: Kernel comes from the user's own environment, not bundled
- **Decision**: Palisade shells out to the project's own Jupyter/Python (`jupyter kernel` / `ipykernel`) discovered on PATH — it does not bundle a Python runtime. Missing kernel surfaces as a warning (same pattern as missing executor/skill preflight), not a hard error.
- **Why**: A notebook is only useful running against the project's real venv/deps; a bundled generic Python can't import the user's packages, so bundling would solve the wrong problem. Matches the existing "discovered at runtime, not compiled in" pattern used for coding-agent executors ([CLAUDE.md](CLAUDE.md) — "Agents are discovered at runtime, not compiled in").
- **Source**: user

## D4: Transport is a thin Python driver over stdio, mirroring the ACP pattern
- **Decision**: Palisade spawns a small bundled Python script (one process per open notebook) that wraps `jupyter_client.KernelManager` and speaks JSON-lines to Rust over stdin/stdout. Rust never touches ZeroMQ directly.
- **Why**: Mirrors the existing `acp_client.rs`/`acp_events.rs` pattern already proven in this codebase — one driver process per session, JSON events emitted as an envelope. Reuses `jupyter_client`'s correct implementation of the real (ZeroMQ, HMAC-signed) wire protocol instead of reimplementing it in Rust.
- **Source**: user

## D5: Notebooks are a new "notebook" tab type
- **Decision**: Add a `notebook` tab type alongside `table`/`query`/`chain`/`spec`/`file` in `renderCenterTab` (App.tsx). Opening a `.ipynb` from the file tree or fuzzy-open palette routes to this tab instead of `FileEditorPane`.
- **Why**: Matches the established per-structured-type tab pattern exactly; keeps `FileEditorPane` (already CodeMirror/LSP/FIM-specific) from taking on an unrelated rendering model and kernel lifecycle.
- **Source**: user

## D6: Markdown cells render with the existing markdown renderer
- **Decision**: Markdown cell source renders with `@uiw/react-md-editor (`MDEditor.Markdown`)` + `rehype-sanitize`, already a project dependency (package.json:41,50).
- **Why**: Already installed; no reason to add a second markdown renderer for notebook cells.
- **Source**: codebase (package.json:41, package.json:50)

## D7: Code cells edit with a lightweight per-cell CodeMirror instance
- **Decision**: Each code cell gets its own small CodeMirror 6 `EditorView` (Python syntax highlighting only — no LSP, no FIM, no word-autocomplete wiring). Shift+Enter/Ctrl+Enter runs the cell.
- **Why**: CodeMirror is already the project's editor library (code-editor spec); a bare textarea would read as unfinished next to every other code surface in the app. LSP/FIM are file-editor concerns scoped to `FileEditorPane`, not needed for a first cut of cell editing.
- **Source**: user

## D8: Kernel spawns lazily, on first "Run cell"
- **Decision**: Opening a `.ipynb` only renders the file (cells + their saved outputs) — no process spawned. The Python driver + kernel spawn on the first cell run, with a "Starting kernel…" indicator during startup.
- **Why**: Matches the app's existing lazy-spawn shape (an agent session doesn't spawn a process until a message is sent) and avoids paying jupyter_client's multi-second startup cost as a surprise when someone just wants to skim outputs.
- **Source**: user

## D9: Kernel resolves from the notebook's own kernelspec metadata
- **Decision**: Read `metadata.kernelspec.name` from the notebook's nbformat JSON, resolve it against `jupyter kernelspec list`, and spawn that interpreter. If the named kernelspec isn't found, warn (non-fatal, same pattern as D3) and fall back to system `python3` on PATH.
- **Why**: Matches how Jupyter/VS Code already resolve kernels, so a notebook built against a named venv/conda kernel runs against the right interpreter instead of silently executing against the wrong one.
- **Source**: user

## D10: Output auto-saves to disk after each cell run
- **Decision**: On cell execution completion, Palisade writes the updated cell (source + new output + execution_count) back to the .ipynb file via the existing `write_file_content` IPC. No separate dirty/unsaved indicator for outputs — source edits still use explicit save.
- **Why**: Matches Jupyter's own autosave-on-run behavior; avoids outputs on screen silently diverging from what's on disk (which an agent or `git diff` would see).
- **Source**: user

## D11: v1 renders text, image/png, and error outputs — not text/html
- **Decision**: Cell output area renders stdout/stderr streams, plain-text `execute_result`, `image/png` (base64 → `<img>`), and error/traceback blocks. `text/html` outputs (styled DataFrame tables, rich reprs) fall back to their `text/plain` representation, which nbformat always includes alongside html — no HTML render path in v1.
- **Why**: Covers the dominant real-world case (plots via matplotlib emit PNG) without opening an HTML-injection surface or adding a second sanitized-render path beyond the markdown renderer already chosen in D6.
- **Source**: user

## D12: v1 supports full cell structural editing
- **Decision**: Add/delete cells, reorder (move up/down), and toggle cell type (code↔markdown) — not just editing existing cell source in place.
- **Why**: D2 already committed to "read/edit + execution"; in-place-only editing would be a strange middle ground that still requires an external editor for anything structural.
- **Source**: user

## D13: Non-goals — ipywidgets, remote kernels, notebook-aware diff/merge
- **Decision**: v1 explicitly excludes ipywidgets/interactive widget outputs (fall back to text/plain repr), remote/SSH kernels (local process spawn only, per D3/D9), and notebook-aware diff/merge UX (.ipynb diffs as raw JSON, same as today).
- **Why**: Each is a real scope expansion (widgets need a live kernel↔frontend comm channel; remote kernels need a different transport than D4's local stdio driver; diff/merge needs cell-aware rendering) that isn't required for "open, edit, and run a notebook."
- **Source**: user

## D14: v1 includes basic export (.py / HTML) via nbconvert
- **Decision**: Notebook tab gets an "Export…" action offering at least `.py` (`nbconvert --to script`) and HTML, using the same jupyter_client/nbconvert tooling already required for kernel execution.
- **Why**: Marginal cost given nbconvert typically ships alongside jupyter_client — not worth deferring as a separate feature.
- **Source**: user

## D15: Kernel process terminates on tab close, thread switch, or app quit
- **Decision**: `NotebookKernel` gets a `terminate()` mirroring `AcpSession::terminate()` (src-tauri/src/acp_client.rs:188), called on notebook tab close, thread switch, and app quit, plus a `Drop` impl as a backstop. "Restart kernel" explicitly kills and respawns.
- **Why**: Matches the existing session-process lifecycle (CLAUDE.md: a session closes when Palisade releases it idle) instead of accumulating orphaned kernel processes across opened-then-closed notebooks in a long-running session.
- **Source**: user

## D16: Notebook doc model lives in TypeScript, not Rust — amends D2/D7's Rust-owned NotebookDoc
- **Decision**: Amends design.md D2/D7. `NotebookDoc`/`Cell`/`Output` parsing, editing, and serialization live entirely in `src/notebook.ts`, reusing the existing generic `read_file_content`/`write_file_content` IPC commands. There is no `open_notebook`/`save_notebook` Rust command and no Rust-side `NotebookDoc` struct. Rust's `notebook.rs` is scoped to kernel process management only (`NotebookKernel`: spawn/execute/interrupt/restart/terminate) — it forwards driver events to the frontend and never holds or mutates notebook content itself. When a cell finishes executing, the frontend receives the output event, updates its own in-memory cell array, and persists via the existing `writeFileContent`.
- **Why**: `read_file_content`/`write_file_content` already do exactly what dedicated `open_notebook`/`save_notebook` commands would add — reusing them avoids duplicate parsing logic in two languages and a wider IPC surface for no behavior gain (ponytail: reuse before writing).
- **Source**: recommended-accepted

## D17: Running a cell auto-saves the whole notebook, not just that cell's output
- **Decision**: A consequence of D16 (whole-document save, no Rust-side per-cell merge): when a cell finishes executing, the frontend writes the entire current in-memory doc via `writeFileContent`, clearing the dirty indicator entirely — not just persisting that cell's output while leaving other pending edits dirty.
- **Why**: Simpler — one `writeFileContent` call, no separate "last saved vs. live" doc-tracking layer to maintain a distinction (output-only vs. full save) users likely don't care about.
- **Source**: user

## D18: NotebookId is `{project_hash}::{relative_path}`, not a generated id
- **Decision**: Amends design.md D2's "not the file path directly" note. The notebook id used to key the kernel registry is deterministically derived from `project_hash` + the notebook's relative path, not a randomly generated id. A notebook renamed while its kernel is running orphans that kernel (user has to restart it) — a corner deliberately cut rather than building rename-tracking across Rust and TypeScript for it.
- **Why**: Avoids threading a generated id through the frontend's tab state, `readFileContent`/`writeFileContent` calls, and every IPC command just to protect an edge case (renaming a file while its notebook tab is open and its kernel is live) that a "restart kernel" click already resolves.
- **Source**: recommended-accepted

## D19: Kernel restart uses the driver's own restart op, not Rust-level terminate+respawn
- **Decision**: Amends design.md D6. `NotebookKernel::restart()` sends a `{"op": "restart"}` request to the already-running driver (which calls `jupyter_client`'s `KernelManager.restart_kernel`) rather than killing and respawning the Rust-managed child process. Manually verified in task 2.2's driver test: execute → interrupt → restart → fresh execution_count numbering, confirming kernel state is actually discarded.
- **Why**: Cheaper (no process teardown/respawn, no re-resolving the kernelspec), already built and tested as part of the driver protocol, and satisfies the same spec-level contract ("previously defined variables/state no longer persist") either way.
- **Source**: recommended-accepted

## D20: Kernel cleanup drops "thread switch" — notebook tabs aren't thread-scoped
- **Decision**: Corrects design.md D6 and spec.md's kernel-lifecycle requirement. Tabs (`src/openTabs.ts`: file/spec/table/query/chain/preview) are project-level, not scoped to an agent thread the way `AcpSession`s are — there is no "switch away from the owning thread" event for a notebook tab to react to. Kernel cleanup triggers are just: tab close, and app quit.
- **Why**: The original wording copied `AcpSession`'s thread-scoped lifecycle without checking whether notebook tabs actually have that scoping — they don't (verified by reading `openTabs.ts`: tab state has no `thread_id` field). Stating a cleanup trigger that can't fire would leave a dead scenario in the spec.
- **Source**: codebase (src/openTabs.ts)

## D21: Notebooks reuse the existing "file" tab type — no new tab-type union member
- **Decision**: Amends design.md D1/D5. `.ipynb` opens as an ordinary `FileTab` (`src/openTabs.ts`) — clicking it in the file tree or `⌘P` goes through the same `selectFile`/`tabs.open` path every other file uses, no special-cased routing. `renderCenterTab` in `App.tsx` branches on the active file tab's extension: `.ipynb` renders `<NotebookTab>`, everything else renders `<FileEditorPane>`. `FileTab`'s existing `dirty` field is reused as-is for the notebook's own dirty tracking.
- **Why**: `FileTab` already carries everything a notebook tab needs (path, dirty, open/close/reopen/cycle semantics) — adding a parallel `NotebookTab` union member to `openTabs.ts` would duplicate that bookkeeping for a distinction that only matters at render time, not at the tab-management level. Reusing it is strictly less code for the same behavior, matching the codebase's own precedent (`FileEditorPane` already branches internally on `isMarkdownPath`/`isBinaryError` rather than being one component per file kind).
- **Source**: recommended-accepted
