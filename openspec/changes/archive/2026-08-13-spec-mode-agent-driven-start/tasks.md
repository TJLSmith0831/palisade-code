## 1. ThreadMeta spec_type field + backward compat (Rust, riskiest first)

- [x] 1.1 Write failing Rust test: `ThreadMeta` serializes and deserializes with `spec_type: Some("Feature")` (RED)
- [x] 1.2 Write failing Rust test: a thread record JSON without a `spec_type` field deserializes with `spec_type: None` (backward compat) (RED)
- [x] 1.3 Add `spec_type: Option<String>` field with `#[serde(default)]` to `ThreadMeta` in `store.rs` (GREEN)
- [x] 1.4 Run `cargo test store::` to verify both tests pass and no existing tests regress

## 2. spec_mode IPC command gains spec_type parameter (Rust)

- [x] 2.1 Write failing Rust test: `spec_mode_initial_prompt` returns a prompt with the spec_type as the body (not the literal "grill-explore") when no open change exists (RED)
- [x] 2.2 Write failing Rust test: `spec_mode_initial_prompt` returns `None` when an open change exists, even if spec_type is provided (silently ignored, D10) (RED)
- [x] 2.3 Add `spec_type: String` parameter to `spec_mode` command; update `spec_mode_initial_prompt` to accept and use it (GREEN)
- [x] 2.4 Add `spec_type` to the `generate_handler!` registry entry for `spec_mode` in `lib.rs`
- [x] 2.5 Run `cargo test spec_mode` to verify new tests pass and no existing tests regress

## 3. Spec type persistence on thread (Rust)

- [x] 3.1 Write failing Rust test: `set_thread_mode` with spec type stores `spec_type` on the thread (RED)
- [x] 3.2 Write failing Rust test: reading a thread with stored `spec_type` returns the value (RED)
- [x] 3.3 Add `spec_type` storage to `set_thread_mode` (or a new `set_spec_type` helper) in `store.rs`; update `spec_mode` to persist the spec type (GREEN)
- [x] 3.4 Run `cargo test store::` to verify persistence tests pass

## 4. Handoff re-injection (Rust)

- [x] 4.1 Write failing Rust test: on agent handoff with stored `spec_type` and no open change, the new session's first turn body is the stored spec type (RED)
- [x] 4.2 Write failing Rust test: on same-agent restart (no handoff), no additional framing turn is injected (RED)
- [x] 4.3 Update `ensure_session` handoff path in `lib.rs` to re-inject `spec_type` when conditions are met (GREEN)
- [x] 4.4 Run `cargo test ensure_session` or `cargo test handoff` to verify re-injection tests pass

## 5. TypeScript API wrapper (TS)

- [x] 5.1 Write failing TS test: `api.specMode` accepts and passes a `specType` parameter (RED)
- [x] 5.2 Update `specMode` in `src/api.ts` to accept and pass `specType` (GREEN)
- [x] 5.3 Run `npx vitest run src/__tests__/api.test.ts` (or equivalent) to verify

## 6. Deferred thread creation for Go mode (TS)

- [x] 6.1 Write failing TS test: picking "Go" from the Vibe/Spec picker does NOT call `api.createThread`; it shows an empty composer in go mode (RED)
- [x] 6.2 Write failing TS test: sending the first message in the go-mode empty composer calls `api.createThread` + `api.setThreadMode("go")` + sends the message (RED)
- [x] 6.3 Update `onPickMode` in `App.tsx` to defer go-mode thread creation; add empty-composer state and first-send handler (GREEN)
- [x] 6.4 Run the relevant TS test file to verify

**Correction (D23, 2026-08-13):** the original 6.3 implementation actually called `api.createThread` immediately in `onPickMode`'s "go" branch — the RED tests above were never truly red against that code (they asserted immediate creation, matching the bug, not D20). Live dogfood testing caught the divergence from D20. Re-fixed: `onPickMode("go")` now only sets `pendingMode = "go"`; `onSend` lazily creates the thread + calls `setThreadMode("go")` on the first send when there's no thread yet. Both tests above were rewritten to assert deferred creation; a new test (`sending the first message in the go-mode empty composer creates the thread, sets go mode, and sends`) covers the send-time creation path.

## 7. Spec-type framing menu UI (TS)

- [x] 7.1 Write failing TS test: picking "Spec" from the Vibe/Spec picker shows a spec-type card row (Feature/Bugfix/Other) instead of creating a thread (RED)
- [x] 7.2 Write failing TS test: the three cards render with Mantine components and the correct copy (D14) (RED)
- [x] 7.3 Write failing TS test: the Back button returns to the Vibe/Spec picker (RED)
- [x] 7.4 Add `specTypePicker` state and the inline Mantine card row to `App.tsx`; wire the Back button (GREEN)
- [x] 7.5 Run the relevant TS test file to verify

## 8. Spec-type selection → agent start (TS)

- [x] 8.1 Write failing TS test: picking "Feature" calls `api.createThread` + `api.specMode(id, "Feature")` and fires the agent (RED)
- [x] 8.2 Write failing TS test: picking "Bugfix" calls `api.createThread` + `api.specMode(id, "Bugfix")` (RED)
- [x] 8.3 Wire Feature and Bugfix card clicks to the deferred-creation + `specMode` flow (GREEN)
- [x] 8.4 Run the relevant TS test file to verify

## 9. "Other" text input (TS)

- [x] 9.1 Write failing TS test: picking "Other" reveals a Mantine `TextInput` with the placeholder "Describe what you'd like to spec out..." (RED)
- [x] 9.2 Write failing TS test: submitting non-empty text calls `api.createThread` + `api.specMode(id, text)` (RED)
- [x] 9.3 Write failing TS test: empty/whitespace submission is disabled (no call) (RED)
- [x] 9.4 Write failing TS test: the "or pick a different type" link hides the TextInput and shows the cards again (RED)
- [x] 9.5 Add the "Other" TextInput, empty-submit prevention, and escape link to `App.tsx` (GREEN)
- [x] 9.6 Run the relevant TS test file to verify

## 10. Composer toggle path (TS)

- [x] 10.1 Write failing TS test: toggling an existing thread to spec mode with no open change shows the framing menu (RED)
- [x] 10.2 Write failing TS test: toggling to spec mode with a stored `spec_type` and no open change does NOT show the framing menu — it reuses the stored spec type (RED)
- [x] 10.3 Write failing TS test: toggling to spec mode with an open change does NOT show the framing menu (RED)
- [x] 10.4 Update `onSpec` in `App.tsx` to show the framing menu or reuse stored spec type based on thread state (GREEN)
- [x] 10.5 Run the relevant TS test file to verify

## 11. Agent-driven explore → propose transition (Rust)

- [x] 11.1 Write failing Rust test: when an `ExecutorEvent::Text` contains `[READY_TO_PROPOSE]`, the marker is stripped from the text and the `propose` IPC command is auto-fired (RED)
- [x] 11.2 Write failing Rust test: when an `ExecutorEvent::Text` does NOT contain the marker, no auto-fire occurs (RED)
- [x] 11.3 Add marker detection to the `ExecutorEvent::Text` arm of the event handler in `lib.rs`; strip the marker and fire `propose` (GREEN)
- [x] 11.4 Amend the bundled grill-explore skill's Exit section to instruct the agent to emit `[READY_TO_PROPOSE]` when exploration is change-shaped
- [x] 11.5 Run `cargo test` to verify marker detection tests pass

## 12. Remove "Proceed to propose" button (TS)

- [x] 12.1 Write failing TS test: the "Proceed to propose" button is NOT rendered when `stage === "exploring"` (RED)
- [x] 12.2 Remove the "Proceed to propose" button block from `App.tsx` (GREEN)
- [x] 12.3 Run the relevant TS test file to verify

## 13. Full verification

- [x] 13.1 Run `cd src-tauri && cargo test` — all Rust tests pass
- [x] 13.2 Run `pnpm test` — all frontend tests pass
- [x] 13.3 Run `npx tsc --noEmit` — typecheck passes
- [x] 13.4 Live-verify via run-floo-network skill (2026-08-13, OpenCode + Devin executors — no Claude credits spent): pick Spec, see framing menu, pick Feature, confirm agent speaks first with structured framing (confirmed with Devin); pick Go, see empty composer, type message, confirm thread appears on send (confirmed via persisted `ThreadMeta` — no file written until send); back out of framing menu, confirm no orphan thread (confirmed); confirm no "Proceed to propose" button during exploring (confirmed via grep, button block removed); confirm `[READY_TO_PROPOSE]` marker detection is wired end-to-end (confirmed via grep — skill, backend const, strip logic, tests all present; not exercised through a full live explore→propose cycle to avoid burning agent turns). Also caught and fixed two bugs not on this list: D23 (Go-mode immediate creation, see group 6 correction) and D24 (framing-menu executor/model picks silently dropped or misdirected to the wrong thread) — see decisions.md.
