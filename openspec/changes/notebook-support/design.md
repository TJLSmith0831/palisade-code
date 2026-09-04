## Context

See [proposal.md](proposal.md) for motivation. Relevant existing shapes this design builds on:

- **Tab types**: `renderCenterTab` in `App.tsx` switches on `tab.type` (`table`, `query`, `chain`, `spec`, `preview`, `file`) to pick a component. Adding `notebook` follows this exactly.
- **Extension routing**: `src/lsp.ts`'s `byExtension` map decides which language/server a file gets; it has no notion of "this extension gets a different tab entirely" — that routing currently lives at the file-open call sites (file tree click, `⌘P` selection), not in `lsp.ts`.
- **Process-driver pattern**: `src-tauri/src/acp_client.rs` spawns one child process per agent session, drives it over stdio, and emits `ExecutorEvent`s wrapped in an `Envelope { session_id, thread_id, event }` (`executor.rs:118,234`) to the frontend. `AcpSession::terminate()` (acp_client.rs:188) stops the process; a `Drop` impl backstops leaks.
- **Sidecar pattern**: `src-tauri/src/completion.rs`'s `CompletionServer` spawns `llama-server` once, globally, health-checks over HTTP. Different from the driver pattern (one process per *session*, not one global process) — this design follows the driver pattern, not the sidecar pattern, because each notebook needs its own kernel/interpreter, not a shared one.
- **IPC wiring**: every new Tauri command needs three edits — the `#[tauri::command]` fn, its name in `generate_handler!` (lib.rs:2455), and a wrapper in `src/api.ts` (CLAUDE.md gotcha).

## Goals / Non-Goals

**Goals:**
- Define the notebook process/data architecture: how a kernel gets spawned, how execution requests and output flow between Rust and the frontend, and how the notebook file's nbformat JSON maps to editable cell state.
- Define kernel resolution and lifecycle precisely enough to implement without further judgment calls.

**Non-Goals:**
- ipywidgets, remote/SSH kernels, notebook-aware diff/merge, `text/html` output rendering — see proposal's Non-Goals; no design content for these.
- Multi-notebook shared kernels — every open notebook gets its own kernel process; no session reuse across notebooks even if they share a kernelspec.

## Decisions

### D1. Notebooks render via extension branch in `renderCenterTab`, reusing the existing "file" tab
**Amended by decisions.md D21**: no new `notebook` tab-type union member. `.ipynb` opens as an ordinary `FileTab` — the file-tree click and `⌘P` selection handlers are unchanged. `renderCenterTab` in `App.tsx` branches on the active file tab's path: `.ipynb` renders `<NotebookTab>`, everything else keeps rendering `<FileEditorPane>`. `lsp.ts`'s `byExtension` map is untouched — notebooks don't get an LSP server or CodeMirror document language.

**Alternative considered**: teach `FileEditorPane` to switch its whole render tree for `.ipynb`. Rejected (see decisions.md D5) — `FileEditorPane` is already CodeMirror/LSP/FIM-specific; branching at `renderCenterTab` keeps the divergence at the same level `table`/`query`/`chain` already live at, without threading a new tab-type union member through `openTabs.ts` for what is, underneath, still just a file with a `dirty` flag.

### D2. Backend: one `NotebookKernel` per open notebook, driver-process pattern
New `src-tauri/src/notebook.rs`:

```rust
pub struct NotebookKernel {
    child: Mutex<Option<Child>>,     // the Python driver process
    path: PathBuf,                   // the .ipynb file this kernel belongs to
}
impl NotebookKernel {
    pub fn spawn(&self, python: &Path, kernelspec: Option<&str>) -> Res<()>;
    pub fn execute(&self, cell_id: &str, cell_source: &str) -> Res<()>; // fire-and-forget; results stream as events
    pub fn interrupt(&self);
    pub fn restart(&self, python: &Path, kernelspec: Option<&str>) -> Res<()>;
    pub fn terminate(&self);
}
```

Registry: `Mutex<HashMap<NotebookId, Arc<NotebookKernel>>>` keyed by an id derived from the tab (mirrors how `AcpSession`s are tracked per session id). **Amended by decisions.md D18**: `NotebookId` is `"{project_hash}::{relative_path}"`, not a generated id — simpler, at the cost of orphaning the kernel on a rename-while-open (user restarts it).

**Amended by decisions.md D16**: Rust owns no `NotebookDoc` and has no `open_notebook`/`save_notebook` commands — the frontend reads/parses/writes notebook JSON directly via the existing `read_file_content`/`write_file_content` commands (see D7 below). The frontend extracts `metadata.kernelspec.name` from the parsed doc and passes just that string down; Rust still does the actual resolution (`jupyter kernelspec list`, D4 below) since that's a subprocess call, not doc ownership. Kernels are managed by IPC commands scoped purely to process/execution control (new, registered in `generate_handler!`):
- `run_notebook_cell(notebook_id, kernelspec_name, cell_id, source)` — spawns the kernel first if not already running (resolving `kernelspec_name` per D4 if so), then sends the execute request; results arrive as events, not as this call's return value (execution can outlive a request/response round trip).
- `interrupt_notebook_kernel(notebook_id)`, `restart_notebook_kernel(notebook_id, kernelspec_name)`.
- `export_notebook(path, kernelspec_name, format)` — `"script" | "html"`.

Each command is a 3-edit addition per the CLAUDE.md gotcha (command fn, `generate_handler!`, `src/api.ts` wrapper) ×4.

### D3. Driver process: bundled Python script, JSON-lines over stdio
`NotebookKernel::spawn` runs `python <bundled driver.py path> --kernelspec <name-or-empty>`, mirroring `AcpSpawn`'s child-process setup in `acp_client.rs`. The driver:
- Uses `jupyter_client.KernelManager` to start/own the actual kernel (which itself talks ZeroMQ — the driver absorbs that, Rust never does).
- Reads one-line JSON requests from stdin (`{"op": "execute", "cell_id": "...", "source": "..."}`, `{"op": "interrupt"}`, `{"op": "restart"}`).
- Writes one-line JSON events to stdout, forwarded to the frontend as `NotebookEvent`s wrapped in the same `Envelope{session_id, thread_id, event}` shape `ExecutorEvent` already uses — `session_id` here is the notebook's kernel-session id. Event variants: `Started`, `Stream{cell_id, stream, text}`, `ExecuteResult{cell_id, data}` (text/plain, image/png), `Error{cell_id, ename, evalue, traceback}`, `ExecuteReply{cell_id, execution_count}` (execution complete — triggers D5's auto-save), `Restarted`, `Crashed{message}`.
- Internally, **one thread does all shell- and iopub-channel I/O** (send and recv, both channels) via a `zmq.Poller` event loop — pyzmq sockets aren't safe to share across threads, and an initial two-threads-per-channel design (one pumping iopub, a separate one both sending `execute()` and pumping shell replies) hit exactly that: a send/recv race on the shell channel silently dropped stream/execute_result output most of the time (confirmed by live-testing task 3.3 against a real kernel — `Started`/`ExecuteReply` arrived, but the print/result never did). Only stdin reading runs on a second thread, since it never touches a zmq socket — it just queues requests for the event-loop thread to send.

**Alternative considered**: raw ZeroMQ wire protocol directly in Rust — rejected in decisions.md D4 (reimplements a spec `jupyter_client` already implements correctly, for no behavior gain given D3 in decisions.md already requires the user's own Python/Jupyter to be present anyway).

### D4. Kernel resolution
On first `run_notebook_cell` for a notebook:
1. Parse the notebook's `metadata.kernelspec.name` (may be absent).
2. Run `jupyter kernelspec list --json` (via the resolved `jupyter` on PATH) and look for a match.
3. Found → pass that kernelspec's `argv`/interpreter to the driver. Not found (name present but unmatched, or absent) → emit a non-fatal `KernelWarning` event (surfaced as a toast/banner, same pattern as executor preflight warnings) and fall back to `python3` on PATH.
4. Neither the named kernelspec nor `python3` resolve → `run_notebook_cell` returns an error surfaced in the notebook UI (spec's "no usable kernel" scenario); no process spawned.

### D5. Output persistence
On `ExecuteReply` (cell finished), the frontend (not Rust — amended by D16) updates that cell's output array + execution_count in its in-memory `NotebookDoc` and immediately calls `writeFileContent` with the full serialized doc — **amended by decisions.md D17**: this clears the dirty indicator entirely, i.e. running a cell also persists any other pending unsaved source/structure edits in the notebook, not just that cell's output. There is no separate "last saved vs. live" doc layer; whole-document save (D7) means output-triggered save and explicit save are the same operation.

### D6. Kernel lifecycle
`NotebookKernel::terminate()` is called from:
- Tab close (`tabs.closeNotebook`, frontend, triggers an IPC call).
- App quit (`RunEvent::Exit`, lib.rs:2592 — same event `release_idle_sessions` already hooks for agent sessions).
- `Drop for NotebookKernel` as a backstop, mirroring `AcpSession`'s `Drop` (acp_client.rs:203).

**Amended by decisions.md D20**: no "thread switch" trigger — tabs (`openTabs.ts`) are project-level, not thread-scoped, unlike `AcpSession`. There is no thread-switch event for a notebook tab to react to.

**Amended by decisions.md D19**: restart uses the driver's own `restart` op (`jupyter_client`'s `restart_kernel`, in-place) rather than `terminate()` + `spawn()` of the Rust-managed child process — cheaper, already built and tested, same spec-level guarantee (state discarded).

### D7. Cell/document model
`NotebookDoc` is a thin typed wrapper over nbformat v4 JSON — `{cells: Cell[], metadata: {...}, nbformat, nbformat_minor}`, `Cell = {id, cell_type: "code"|"markdown", source: string, outputs?: Output[], execution_count?: number}`. Structural edits (add/delete/reorder/type-toggle) mutate this array frontend-side; `save_notebook` sends the whole document back rather than a diff — simplest correct approach given nbformat has no natural patch format and notebooks are small text files.

## Risks / Trade-offs

- **[Risk]** A crashed/hung Python driver leaves a notebook unable to execute until restart. → `NotebookKernel::spawn` health-checks similarly to `CompletionServer::spawn`'s health check pattern (wait for a `Started` event with a timeout); a `Crashed` event from the driver surfaces a clear "kernel crashed, restart?" state rather than a silent hang.
- **[Risk]** Large image outputs (base64 PNG) bloat the notebook JSON and IPC payloads. → Accepted; this is inherent to nbformat itself (Jupyter has the same characteristic), not something this design should solve.
- **[Risk]** Users without `jupyter`/`jupyter_client` installed get a notebook that opens but can't execute. → D4's non-fatal warning path plus a clear inline message in the spec's "no usable kernel" scenario; matches the existing non-fatal preflight pattern for missing executors (never silently fails, never blocks opening the file).
- **[Trade-off]** Whole-document save (D7) instead of granular cell patches is simpler but means concurrent external edits to the same `.ipynb` (e.g. an agent editing it via the terminal while the tab is open) can be clobbered on next save. → Same trade-off `FileEditorPane` already accepts for plain files; no new exposure.

## Migration Plan

Purely additive — no existing behavior changes, no data migration. `.ipynb` files previously opened as plain text in `FileEditorPane`; if the notebook tab fails to load for any reason (unparseable nbformat JSON, corrupt file), fall back to opening it in `FileEditorPane` as before rather than showing an error state with no escape hatch.

## Open Questions

- Exact `NotebookEvent` JSON field names/shape for the driver↔Rust protocol — an implementation detail that doesn't change the spec's behavior contract or the task breakdown; can be finalized during D3's implementation.
