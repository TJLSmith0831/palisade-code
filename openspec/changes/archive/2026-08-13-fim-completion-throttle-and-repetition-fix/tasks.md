## 1. Sampling parameters (riskiest — model behavior change)

- [x] 1.1 Write failing Rust test: `request_body` includes `repeat_penalty: 1.1` and `top_p: 0.95` (RED)
- [x] 1.2 Add `repeat_penalty` and `top_p` to `request_body()` in `completion.rs` (GREEN)
- [x] 1.3 Run `cargo test completion::` to verify the new test passes and no existing tests regress
- [x] 1.4 Live-verify: start the app, type a Python list with Enter, confirm no repetition cascade (manual check via run-floo-network skill)

## 2. Indentation preservation in clean_completion (test-driven, existing tests to update)

- [x] 2.1 Write failing Rust test: `clean_completion` preserves indentation on lines 2+ (RED — current code strips it)
- [x] 2.2 Update existing tests that assert indent stripping: `clean_completion_normalizes_indentation`, `clean_completion_handles_multiline_with_duplicates`, `clean_completion_handles_multiline_with_duplicates_no_space` — change expected values to preserve indent
- [x] 2.3 Remove the `trim_start()` loop on lines 2+ in `clean_completion()` (GREEN)
- [x] 2.4 Run `cargo test completion::` to verify all tests pass

## 3. Indentation preservation in clean_first_line (test-driven)

- [x] 3.1 Write failing Rust test: `clean_first_line` preserves leading whitespace when no duplicate keyword is found (RED — current code collapses via `split_whitespace().join()`)
- [x] 3.2 Update existing tests that assert first-line whitespace collapse (e.g., `clean_completion_preserves_normal_completion` if it expects indent stripping) — change expected values to preserve indent
- [x] 3.3 Remove the `split_whitespace().join(" ")` whitespace-collapse fallback in `clean_first_line()`, keep only the keyword-dedup regex path (GREEN)
- [x] 3.4 Run `cargo test completion::` to verify all tests pass

## 4. Debounce 150ms → 3000ms (trivial constant, test-driven)

- [x] 4.1 Update existing frontend test `typing schedules and shows a completion after the debounce` — change `advanceTimersByTimeAsync(200)` to `advanceTimersByTimeAsync(3100)` (RED — current debounce is 150ms so 200ms passes, but after changing to 3000ms the old 200ms wait will fail)
- [x] 4.2 Update `DEBOUNCE_MS` from `150` to `3000` in `GhostTextPlugin.ts` (GREEN)
- [x] 4.3 Update the `hitting Enter schedules and shows a completion after the debounce` test similarly — change `200` to `3100`
- [x] 4.4 Run `npx vitest run src/__tests__/GhostTextPlugin.test.ts` to verify all tests pass

## 5. AbortController wiring (small TS change, test-driven)

- [x] 5.1 Write failing frontend test: when a new keystroke aborts an in-flight request, the stale result is dropped and no ghost text is dispatched (RED — current code dispatches regardless of abort state)
- [x] 5.2 Add abort-check after `await api.completeCode(...)` and before the ghost text dispatch in `request()` (GREEN — note: captured controller locally since `this.controller` is replaced by subsequent requests; `this.controller?.signal.aborted` would check the wrong controller)
- [x] 5.3 Run `npx vitest run src/__tests__/GhostTextPlugin.test.ts` to verify all tests pass

## 6. Full verification

- [x] 6.1 Run `cd src-tauri && cargo test` — all Rust tests pass (265 passed)
- [x] 6.2 Run `pnpm test` — all frontend tests pass (688 passed, 55 files)
- [x] 6.3 Run `npx tsc --noEmit` — typecheck passes
- [x] 6.4 Live-verify via run-floo-network skill: type code, confirm 3s pause before suggestions, confirm no repetition on Enter, confirm indent is preserved in multi-line completions
