## Context

Backend state today: `Harness` (`executor.rs:726`) is the one Tauri-managed
state struct, holding `Mutex<Option<Session>>` for the single executor
process active app-wide. `Session` (`executor.rs:397`) supervises spawn,
`is_busy()` via `Arc<AtomicBool>`, and guarantees cleanup via `Drop::drop
→ terminate()`. The frontend receives backend events through Tauri's
`listen`/`emit` (`"executor-event"`, `"thread-updated"` in `App.tsx`).

Graphify today is only one-shot `Command::new(bin).output()` calls in
`integrations.rs` — no supervised long-lived process exists for it
anywhere in the codebase. Threads are two flat files per thread
(`<id>.meta.json`, `<id>.jsonl`) under a per-project directory;
`list_threads()` enumerates them by scanning for `*.meta.json`, so there's
no separate index to keep in sync. Exactly one project is "active" in the
frontend at a time (`App.tsx`'s `project` state) — see proposal.md for
motivation.

## Goals / Non-Goals

**Goals:**
- Exactly one `graphify watch` process runs at a time, scoped to whichever
  project is currently active; switching projects replaces it, never
  stacks it.
- Claude's already-emitted `stream_event` lines drive real incremental
  rendering without changing what's persisted to the JSONL log.
- Thread deletion is a filesystem operation gated by the existing
  single-flight busy guard, with no new index to maintain.

**Non-Goals:**
- Watching multiple projects concurrently (only the active one).
- Codex streaming (D18) — Codex stays block-level.
- Soft-delete/undo/trash for threads (D21) — hard delete only.
- Any change to tool-call collapse UX (D20).
- A per-project watch on/off toggle (D16) — always on, no setting.

## Decisions

### `graphify watch` supervision mirrors `executor::Session`
A new lightweight struct (e.g. `Watcher` in a new `watcher.rs`, or added to
`integrations.rs`) holds the spawned `Child` and the `project_hash` it's
scoped to, with the same `Drop`-based `terminate()` guarantee `Session`
already has. Stored as a new `Mutex<Option<Watcher>>` field on `Harness`,
alongside `session`.

**Alternative considered**: reuse `Session` itself for the watcher.
Rejected — `Session` models a per-thread, per-turn executor conversation
(`session_id`, `--resume`, busy-per-turn semantics) that doesn't fit a
project-scoped process with no turns; forcing it in would entangle two
unrelated lifecycles.

### Project-switch is the watcher's lifecycle hook
The existing `switch_project` Tauri command (and the startup
last-project restore in `App.tsx`) is extended: after switching,
terminate any existing `Watcher` and spawn a new one for the new project
root. No new lifecycle event needed — project switching already goes
through one chokepoint.

### Pane refresh via a push event, not polling
Rather than parsing `graphify watch`'s stdout (format could drift across
graphify versions — see Risks), the backend watches `graph.json`'s mtime
directly while the child is alive and emits `app.emit("graphify-updated",
project_hash)` on change, reusing `integrations::read_run` to reload it
server-side first. `GraphPane.tsx` adds a `listen("graphify-updated", …)`
effect mirroring the existing `listen("thread-updated", …)` pattern in
`App.tsx`, re-calling `api.loadGraphify` when the event matches the open
project.

**Alternative considered**: frontend polls `load_graphify` every few
seconds. Rejected — wasteful, and inconsistent with the push-event
architecture already used everywhere else in this app.

### Claude `stream_event` parsing adds delta variants, not new persistence
`ExecutorEvent` gains `TextDelta { text }` / `ReasoningDelta { text }`.
`parse_claude_line` gets a new arm for `type == "stream_event"`, reading
`/event/type == "content_block_delta"` and then `/event/delta/type`
(`text_delta` → append to text, `thinking_delta` → append to reasoning).
The existing complete `Text`/`Reasoning` events (already emitted when the
containing `assistant` block finishes) remain the sole thing persisted to
the JSONL log — deltas are a live-rendering signal only.

**Alternative considered**: persist every delta. Rejected — would bloat
the log with dozens of tiny fragments per message for no benefit, since
the authoritative complete block arrives immediately after.

### Frontend appends deltas onto the in-progress item instead of pushing new ones
`App.tsx`'s `live` array (currently strictly append-one-item-per-event)
needs an "append to last" path: a `TextDelta`/`ReasoningDelta` concatenates
onto the last `live` item if it's the same in-progress kind, else starts a
new one. When the matching complete event arrives, it replaces the
in-progress accumulation (guards against any drift between accumulated
deltas and the authoritative final text).

### Global thinking toggle is client-side, localStorage-backed
New `showThinking` boolean state in `App.tsx`, seeded from `localStorage`
(new key, mirroring the existing `lastThreadKey`-per-project pattern) and
written on toggle (D23). When off, reasoning items render nothing at all
in `EventView`; when on, they render inline via the same delta-append
mechanism as regular text — no backend involvement, since reasoning is
already delivered to the frontend regardless of the toggle.

### Thread deletion: two-file removal behind the existing busy guard
`store::delete_thread(home, hash, id)` removes both `meta_path` and
`log_path` (tolerating an already-absent log file, since the file always
exists once a thread is created but deletion should be idempotent). New
`delete_thread` Tauri command checks `Harness.session`: if a `Session`
exists, `is_busy()`, and its `thread_id` matches the target, refuse with
an error before touching disk. Frontend adds a delete action per
thread-list row, reusing the existing command-bar overlay pattern for
confirmation, then re-lists threads and falls back using the same
`found[0] ?? null` logic `selectProject` already applies (D22).

## Risks / Trade-offs

- [Risk] `graphify watch`'s stdout format could change across graphify
  versions if depended on → **Mitigation**: the pane-refresh design
  watches `graph.json`'s mtime directly instead of parsing stdout.
- [Risk] A long-lived child process per project switch adds another
  process floo-network must reliably clean up (zombies on crash) →
  **Mitigation**: reuses the exact `Drop`-based termination pattern
  `Session` already has, which survives panics.
- [Risk] `graphify watch` can be CPU/memory-heavy on very large repos
  (it uses a polling observer on macOS by graphify's own design) →
  **Mitigation**: outside floo-network's control; the graphify-integration
  spec's "surface as warning, not blocking" requirement means a
  struggling or crashed watcher degrades gracefully instead of breaking
  the app.
- [Risk] Claude's `stream_event` schema could differ from what's assumed
  here, the same class of surprise FOLLOW-UPS.md #4 already documents for
  Codex → **Mitigation**: unlike Codex, this machine has a real,
  authenticated `claude` CLI to verify against directly — confirm the
  exact delta shape against a live run before calling this done, same
  discipline already applied elsewhere in this codebase.
- [Risk] Deleting a thread while a stale reference to it exists elsewhere
  in the UI (e.g. an in-flight refresh) → **Mitigation**: `is_busy()`
  guards the only state-corrupting case (mid-turn deletion); `list_threads`
  is scan-based with no separate index, so a stale reference simply fails
  to find the file on next read rather than corrupting shared state.

## Migration Plan

No data migration and no deployed service — this is a desktop app, so the
next build simply ships the new behavior. One new machine-level
dependency: `graphify` (`uv tool install "graphifyy[watch]"`) must be
installed for the graphify-integration requirements to be met; its
absence is a non-blocking warning per that spec, not a build or install
failure for floo-network itself.

## Open Questions

None — every technical unknown surfaced while drafting this design was
either resolved by a decision above (or D1–D23 in decisions.md), or is a
pure implementation micro-detail (exact struct/field names) appropriate
for tasks.md rather than a spec- or approach-changing unknown.
