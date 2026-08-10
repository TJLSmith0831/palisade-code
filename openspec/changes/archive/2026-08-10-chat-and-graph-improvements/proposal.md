## Why

Three friction points hit using floo-network as a daily driver: Graphify
requires a manual click and errors out because the real binary isn't
installed under the assumed name; chat doesn't stream and buries reasoning
and tool activity behind per-message clicks; there's no way to delete
finished or unwanted threads. Fixing them now, while the harness is still
small and single-user, keeps daily use friction-free.

## What Changes

- Install the real `graphify` (PyPI `graphifyy[watch]` via `uv tool
  install`) and fix `graphify_args()`'s CLI-shape bugs: the "incremental"
  toggle currently sends the nonexistent `extract --update` (incremental
  rescanning is the separate `graphify update <path>` subcommand); the
  always-appended `--no-viz` isn't a real `extract` flag either (harmless
  no-op, removed for correctness); the `path` query needs two node-name
  arguments, not the single free-text question field it gets today.
- Add a supervised `graphify watch` background process per open project,
  auto-starting on project open/switch (no manual toggle), following the
  same spawn/track/terminate shape `executor::Session` already uses for
  `claude`/`codex`. It silently refreshes the Graph pane via a push event
  when `graph.json` changes on disk — no chat injection on auto-rebuild.
  Manual "Run Graphify" is unchanged and keeps injecting a summary into
  the active thread.
- Add real incremental text streaming for Claude turns: parse the
  `stream_event`/`content_block_delta` lines the CLI already emits
  (`--include-partial-messages` is already passed) but that
  `parse_claude_line()` currently silently drops, and append the deltas
  onto the active message instead of only rendering complete blocks.
  Codex turns stay block-level (no verified delta-level event schema
  exists for Codex) but continue rendering as soon as each block
  completes, with no artificial delay.
- Add a global "show thinking" toggle (topbar). When on, reasoning text
  streams inline (dimmed) alongside the answer; when off, no reasoning
  renders at all — the per-message reasoning disclosure widget goes away
  entirely, replaced by the single global toggle. Tool-call blocks are
  unchanged: still collapsed-by-default with click-to-expand, only the
  live "running…"/done status line needs to genuinely track progress in
  real time.
- Add thread deletion: a delete action per thread in the sidebar, gated
  behind a custom confirm overlay (native `confirm()` no-ops in Tauri's
  WKWebView, so this reuses the existing rename command-bar pattern) and
  blocked while that thread has an executor turn in flight (reusing
  `Session::is_busy()`). Deleting the currently-open thread falls back to
  the next remaining thread in the list, or the empty "create a thread to
  get started" state if none remain.

## Capabilities

### New Capabilities
- `graphify-integration`: Correct CLI-argument construction for
  `graphify extract`/`update`/`query`/`path`, plus an auto-starting
  `graphify watch` background process per open project that keeps the
  Graph pane current without a manual run.
- `chat-streaming`: Incremental text/reasoning streaming for Claude turns
  via `stream_event` parsing, plus a global show/hide toggle for
  reasoning display.
- `thread-deletion`: Permanently delete a thread, with confirmation and a
  guard against deleting a thread with an in-flight executor turn.

### Modified Capabilities
None — this is floo-network's first OpenSpec change; no prior specs exist
in `openspec/specs/` to modify.

## Impact

- `src-tauri/src/integrations.rs`: fix `graphify_args()`'s flag
  construction; add a `graphify watch` process supervisor and the plumbing
  to emit a pane-refresh event on rebuild.
- `src-tauri/src/lib.rs`: new Tauri commands (`delete_thread`, watch
  lifecycle hooks); extend the preflight warning surface to cover a
  missing `graphify` binary the same way it covers missing
  `claude`/`codex`/`openspec`.
- `src-tauri/src/executor.rs`: new `parse_claude_line()` match arm for
  `stream_event`; new `ExecutorEvent` variant(s) for incremental
  text/reasoning deltas.
- `src-tauri/src/store.rs`: new `delete_thread()`.
- `src/GraphPane.tsx`, `src/GraphView.tsx`: react to a push event instead
  of only refreshing after a manual run.
- `src/EventView.tsx`, `src/App.tsx`: streaming-aware rendering (append
  deltas to the active message), global thinking toggle in the topbar,
  delete-thread UI plus confirm overlay in the thread list.
- `src/api.ts`: new invoke wrappers and `ExecutorEvent` delta variants
  mirrored from Rust.
- New machine dependency: the `graphify` binary (`uv tool install
  "graphifyy[watch]"`), not bundled — same class of external dependency
  as `claude`/`codex`/`openspec`, surfaced the same way in preflight.
