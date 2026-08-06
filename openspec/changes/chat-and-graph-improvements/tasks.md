## 1. Graphify: install and verify the real CLI

- [x] 1.1 Run `uv tool install "graphifyy[watch]"` on this machine and
      confirm `graphify` resolves on PATH (`which graphify`)
- [x] 1.2 Run `graphify --help` and `graphify extract --help` against the
      installed binary and confirm the exact flag set still matches what
      D3/D15 (decisions.md) found, before changing any code

## 2. Graphify: fix CLI-shape bugs

- [x] 2.1 In `integrations.rs`, remove `--no-viz` from `graphify_args()`
      (not a real `extract` flag)
- [x] 2.2 Stop appending `--update` to `extract` for the incremental
      toggle; add a code path that invokes `graphify update <project-root>`
      instead of `extract` when incremental is selected (D24: no subpath —
      `update` has no `--out` override)
- [x] 2.3 Fix `graphify_query()`'s `path` subcommand to accept and pass
      two node-name positional arguments instead of one
- [x] 2.4 Update `GraphPane.tsx`'s query UI: show two input fields when
      `path` is selected instead of the single question field; disable
      the incremental checkbox whenever the scope field has a subpath
      (D24)
- [x] 2.5 Update the Rust unit tests in `integrations.rs` for the
      corrected arg construction (mirrors the existing
      `graphify_args_are_the_safe_keyless_shape_plus_toggles` test)
- [x] 2.6 D25: fix `--out` to pass the project root (not
      `<root>/graphify-out`) to `extract`, and chain a follow-up `graphify
      cluster-only <project-root> --no-viz` on successful extract to
      produce `GRAPH_REPORT.md` (which `extract` alone never writes);
      cover with tests

## 3. Graphify: always-on watch process

- [x] 3.1 Add a `Watcher` struct (spawn/terminate, `Drop`-based cleanup)
      mirroring `Session`'s shape (`executor.rs:397`) — lives in
      `integrations.rs`; owns its background thread entirely (spawn, mtime
      poll, crash detection) so `terminate()` never crosses threads
- [x] 3.2 Add `watch: Mutex<Option<Watcher>>` to `Harness`
      (`executor.rs:726`)
- [x] 3.3 Extend `switch_project` (and the startup last-project restore —
      both routes go through the same command, no separate hook needed)
      to terminate any existing watcher and spawn a new `graphify watch
      <project-root>` for the newly active project
- [x] 3.4 Poll `graph.json`'s mtime while the watcher is alive (done as
      part of `Watcher::spawn` in 3.1); on change, emit
      `app.emit("graphify-updated", project_hash)`. Skipped the redundant
      server-side `read_run` design.md mentioned — the frontend's
      `loadGraphify` call after receiving the event already does the real
      read; graphify's own atomic-rename writes mean there's nothing to
      gain from reading it twice
- [x] 3.5 Surface a missing `graphify` binary (persistent preflight
      warning) or a watcher spawn/crash (one-off `graphify-warning` event)
      as a non-blocking warning — backend half done; frontend listener is
      3.6/App.tsx
- [x] 3.6 `GraphPane.tsx`: add a `listen("graphify-updated", …)` effect
      that reloads via `api.loadGraphify` when the event's project
      matches the open project. Also wired `App.tsx`'s
      `listen("graphify-warning", …)` into the existing error banner (D26)
- [x] 3.7 Add Rust tests for watcher spawn/terminate lifecycle using a
      stand-in process (mirrors how `run_graphify`'s tests use
      `/usr/bin/false`/`/usr/bin/true`) — done as part of 3.1's TDD
      (`watcher_calls_on_update_when_graph_json_changes`,
      `watcher_calls_on_crash_when_the_process_exits_immediately`,
      `watcher_calls_on_crash_when_the_binary_does_not_exist`). `lib.rs`'s
      `start_watcher` itself has no direct test, matching this codebase's
      existing convention that thin Tauri-command wrappers are verified by
      driving the real app, not `cargo test`

## 4. Chat streaming: Claude `stream_event` parsing

- [x] 4.1 Add `TextDelta { text }` / `ReasoningDelta { text }` variants to
      `ExecutorEvent` (Rust) and mirror them in `api.ts`'s
      `ExecutorEvent` union
- [x] 4.2 Add a `stream_event` match arm to `parse_claude_line`, decoding
      `content_block_delta` → `text_delta`/`thinking_delta`
- [x] 4.3 D27: verified against the real `claude` CLI (two live turns,
      `--include-partial-messages`). Confirmed the envelope shape used in
      4.2 exactly:
      `{"type":"stream_event","event":{"type":"content_block_delta","delta":
      {"type":"text_delta"|"thinking_delta"|"signature_delta",...}}}`.
      **Caveat found:** in both captures, `thinking_delta.thinking` came
      through empty (just an `estimated_tokens` counter) — the model's
      readable thinking text may rarely/never stream for typical prompts in
      this configuration. Existing empty-content guard already handles
      this correctly; noted in decisions.md as an operational caveat, not
      a parsing bug.
- [x] 4.4 Add Rust unit tests for the new parsing, mirroring the existing
      `parse_claude_line` tests — built from the real captured envelope
      shape (D27), plus the existing wire-shape-pinning test extended for
      the two new variants

## 5. Chat streaming: frontend rendering

- [x] 5.1/5.2 Implemented as a pure fold instead of ref-based append —
      `live` (`App.tsx`) still just appends every raw event unchanged;
      `EventView.tsx`'s new `mergeDeltas()` folds `textDelta`/
      `reasoningDelta` onto the last matching in-progress item at render
      time, and lets the matching complete `text`/`reasoning` event
      replace the accumulation. Same observable behavior design.md
      described, no mutable index-tracking refs needed — simpler and more
      idiomatic than the ref-based sketch, so no decisions.md entry (not
      a scope/behavior change, just a "how")
- [x] 5.3 Added `showThinking` boolean state seeded from `localStorage`
      (`floo:showThinking`) with a topbar toggle control (reuses the
      existing `.toggle` class from `GraphPane.tsx`)
- [x] 5.4 `EventView.tsx`: `EventList` takes a `showThinking` prop; off
      renders nothing for `reasoning` items, on renders inline
      (`.reasoning-inline`, dimmed/italic via the existing `--dim` token)
      with no per-message click-to-expand — the old collapsible
      `Reasoning` component is gone
- [x] 5.5 Confirmed by inspection: `ToolBlock`/`toolCall`/`toolResult`
      handling in `EventView.tsx` is untouched, and `mergeDeltas` passes
      non-delta/non-text/non-reasoning events through unchanged — no code
      path shared with the delta-merge logic. Live re-confirmation folded
      into the section 8 verification pass rather than restarting the dev
      app again here

## 6. Thread deletion: backend

- [x] 6.1 Add `store::delete_thread(home, hash, id)` removing both
      `meta_path` and `log_path`, tolerating an already-absent log file
- [x] 6.2 Add a `delete_thread` Tauri command in `lib.rs`; check
      `Harness.session` for a busy match on `thread_id` and refuse
      before touching disk
- [x] 6.3 Add Rust unit tests: delete removes both files (done in 6.1's
      TDD pass — `deleting_a_thread_removes_both_files_and_drops_it_from_
      the_list`, `deleting_an_already_deleted_thread_is_not_an_error`,
      `deleting_one_thread_leaves_others_untouched`). The busy-guard lives
      in `lib.rs`'s `delete_thread` command (6.2), which — matching this
      codebase's convention — has no direct `cargo test` coverage; verified
      live in section 8

## 7. Thread deletion: frontend

- [x] 7.1 `api.ts`: add a `deleteThread` invoke wrapper
- [x] 7.2 Thread list in `App.tsx`: add a delete action per row, routed
      through the existing command-bar overlay pattern as a confirm step —
      extended `bar`'s type to a `kind: "input" | "confirm"` union so the
      one overlay mechanism now covers both cases
- [x] 7.3 On confirmed delete: call `api.deleteThread`, re-list threads,
      and apply the `found[0] ?? null` fallback when the deleted thread
      was the open one (matches `selectProject`'s existing logic)

## 8. Verification

- [x] 8.1 `cd src-tauri && cargo test` — full backend suite passes (64/64)
- [x] 8.2 `pnpm build` — typecheck passes, bundle succeeds (pre-existing
      chunk-size warning, unrelated to this change, left as-is)
- [x] 8.3 Drove the real running app via the Tauri MCP. Confirmed live:
      - **Watcher crash path**: opening the pre-existing "Fifty Days"
        project (whose root doesn't exist on disk) showed the
        `graphify-warning` banner ("graphify watch exited unexpectedly")
        — the crash-detection path fires correctly on a real failure.
      - **Watcher happy path**: added floo-network's own repo as a
        project; `ps aux` confirmed a real `graphify watch
        /Users/.../floo-network` process running.
      - **Silent auto-refresh**: created and then deleted a throwaway
        `.ts` file in `src/` — both edits triggered a real incremental
        rebuild (confirmed via `graphify-out/` timestamps) and the Graph
        pane updated its node/edge counts with zero manual clicks, no
        chat injection.
      - **Real streaming**: sent a chat message with "show thinking"
        enabled; the response rendered progressively in one growing
        bubble (screenshotted mid-stream, cut off mid-word), then
        settled to the complete persisted text on turn completion.
      - **Thread deletion**: confirm dialog appears and Cancel leaves the
        thread untouched; Delete removes it and files are gone from disk
        (`~/.floo-network/projects/<hash>/threads/`); deleting the only
        thread falls back to the empty state; deleting one of two falls
        back to the remaining thread (D22, both scenarios).
      - **Busy-guard**: confirmed refused (exact error message) when
        `delete_thread` was called immediately after `send_message` while
        `executor_status` reported `busy: true` for that thread. (First
        attempt raced two separate tool-call round-trips against a
        quick-finishing turn and appeared to succeed — not a floo-network
        bug, a test-timing issue; the tightened retry confirmed the guard
        works.)
      Not separately re-verified live: the `path`-query two-field UI and
      the incremental-disabled-on-subpath checkbox (D24) — both covered
      by `tsc` and code inspection only, lower risk than what was
      verified above.
- [x] 8.4 Updated `FOLLOW-UPS.md`: marked item #5 (Graphify shell-out
      unverified) DONE with what closed it; added `mergeDeltas` to item
      #8's test-coverage candidate list; added item #9 for the two
      not-live-verified pieces (D3's path-query UI, D24's incremental
      checkbox) and the D27 thinking-content caveat
