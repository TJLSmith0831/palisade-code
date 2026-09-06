## Why

`.ipynb` files have no handling today: `.ipynb` isn't in `lsp.ts`'s extension map, so opening one falls through to `FileEditorPane` as unhighlighted plain text — the raw notebook JSON (cell arrays, base64 image blobs, metadata), not a usable notebook. Reported as [GH Issue #10](https://github.com/TJLSmith0831/palisade-code/issues/10).

## What Changes

- Add a `notebook` tab type (alongside `table`/`query`/`chain`/`spec`/`file`) that renders `.ipynb` files as cells instead of raw JSON; `.ipynb` opened from the file tree or `⌘P` routes here instead of `FileEditorPane`.
- Render markdown cells with the existing `@uiw/react-markdown-preview` renderer, and code cells with a lightweight per-cell CodeMirror 6 instance (syntax highlighting only, no LSP/FIM).
- Support full structural editing: add/delete/reorder cells, toggle cell type, edit cell source, explicit save.
- Support live execution: run a cell against a real Jupyter kernel, with streamed text/image/error output, cell restart/interrupt, and kernel restart.
- Kernel resolution: read the notebook's own `metadata.kernelspec.name`, resolve it via `jupyter kernelspec list` on the user's PATH (no bundled Python runtime); missing kernelspec warns and falls back to system `python3`.
- New Rust↔Python transport: a bundled Python driver process (one per open notebook, spawned lazily on first cell run) wraps `jupyter_client.KernelManager` and speaks JSON-lines to Rust over stdio, mirroring the existing ACP driver pattern (`acp_client.rs`/`acp_events.rs`).
- Output auto-saves to disk after each cell run (source edits still require explicit save).
- Kernel + driver process terminate on tab close, thread switch, or app quit — mirrors `AcpSession::terminate()`.
- Basic export action (`.py` via `nbconvert --to script`, and HTML).
- **Non-goals**: ipywidgets/interactive widget outputs, remote/SSH kernels, notebook-aware diff/merge UX, `text/html` output rendering.

## Capabilities

### New Capabilities
- `notebook-editor`: View, structurally edit, and execute `.ipynb` notebooks against a live Jupyter kernel resolved from the notebook's own kernelspec, with cell-level output rendering (text/image/error) and export.

### Modified Capabilities
(none — `file-navigation`'s requirements stay generic ("the editor opens that file"); which tab type a given extension opens in is an implementation detail covered in `notebook-editor`'s design, not a change to file-navigation's contract.)

## Impact

- **Frontend**: new `NotebookTab` component + per-cell `CodeMirror` editors; `src/lsp.ts` extension map; `renderCenterTab` in `App.tsx`; tab-open routing (file tree click, `⌘P` selection); `src/api.ts` gains notebook IPC wrappers.
- **Backend**: new `src-tauri/src/notebook.rs` (or similar) managing `NotebookKernel` sessions — spawn/terminate the bundled Python driver, IPC commands for cell execution/save/export, event envelope emission mirroring `ExecutorEvent`.
- **New bundled asset**: a Python driver script (wraps `jupyter_client`), analogous to the existing `llama-server` sidecar but spawned per-notebook rather than once globally.
- **New runtime dependency (user's environment)**: `jupyter_client` (and `nbconvert` for export) must be importable by the resolved kernel's Python — checked via the same non-fatal preflight-warning pattern used for missing executors.
- **Dependencies**: no new frontend npm packages (CodeMirror and the markdown renderer are already installed).
