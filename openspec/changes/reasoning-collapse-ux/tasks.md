## 1. Backend: elapsed-time tracking and persistence (riskiest — touches the event shape)

- [x] 1.1 Add `elapsed_secs: u64` to `ExecutorEvent::Reasoning` in executor.rs; update the `events_serialize_as_camel_case_for_the_frontend` test and any other exhaustive-match sites.
- [x] 1.2 In `run_bridge` (acp_client.rs), record `Instant::now()` when `think_buf` first becomes non-empty for a turn; compute `elapsed_secs` when the turn's complete `Reasoning` event is built.
- [x] 1.3 RED→GREEN: test that `persist()` now writes `Reasoning` events (role "tool", capped JSON) instead of discarding them — mirrors the existing `reasoning_is_not_persisted_but_text_and_tools_are` test, updated to assert the new behavior (rename it accordingly).
- [x] 1.4 Add a `Reasoning { text }` arm to `capped()`, capping `text` at `PERSIST_CAP` like `FileEdit`/`ToolResult`.
- [x] 1.5 RED→GREEN: test that a reasoning text longer than `PERSIST_CAP` is truncated without splitting a UTF-8 boundary, mirroring `capping_never_splits_a_utf8_code_point`.

## 2. Frontend: reasoning collapsible block

- [x] 2.1 Extract or generalize `ToolBlock`'s collapsible shell (EventView.tsx:102) so a reasoning block can reuse the same `Paper`/header/chevron pattern.
- [x] 2.2 Replace the `reasoning` case's `showThinking ? ... : null` branch with the new collapsible block, collapsed by default, header showing "Thought for {elapsed_secs}s", expandable to the full text.
- [ ] 2.3 Manual check: trigger a turn with reasoning and confirm the block appears collapsed immediately and stays collapsed (not removed) once the turn completes.

## 3. Frontend: remove dead global-toggle plumbing

- [x] 3.1 Delete `SHOW_THINKING_KEY` and the `showThinking` prop from `App.tsx`, `ChatSurface`'s props, and `EventView.tsx`'s `EventList` props.
- [x] 3.2 Sweep for any remaining reference to `showThinking`/`SHOW_THINKING_KEY` to confirm nothing is left half-wired.

## 4. Verification

- [x] 4.1 `cd src-tauri && cargo test` — full backend suite green, including updated/new persistence tests.
- [x] 4.2 `pnpm test` — full frontend suite green, including the new collapsible-block tests.
- [ ] 4.3 Manual run (run-palisade-code skill): start a turn that produces reasoning, confirm the collapsed "Thought for Ns" block appears, expand it, reload the app, and confirm the same block is still there in the same collapsed state per specs/chat-streaming/spec.md scenarios.
