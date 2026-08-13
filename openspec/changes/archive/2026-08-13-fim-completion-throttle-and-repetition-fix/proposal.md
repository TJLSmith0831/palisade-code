## Why

The FIM autocomplete fires 150ms after typing pauses (D14), which impacts the user's ability to code — the model interrupts mid-thought with low-quality suggestions on every micro-pause. Separately, pressing Enter after a Python list triggers a repetition cascade where the model generates the same line 10+ times with broken indentation. Both issues stem from decisions that were never made: the 150ms debounce was tuned for perceived speed, not for the 0.8B model's quality; and the sampling parameters, indentation handling, and abort wiring were ungoverned implementation additions with no decision log entries.

## What Changes

- **Debounce 150ms → 3000ms**: Pure trailing-edge debounce. Suggestions fire only after 3 seconds of no typing, giving the user space to code without interruption. Supersedes D14.
- **Add `repeat_penalty: 1.1` and `top_p: 0.95` to the completion request**: Breaks the greedy-decoding repetition trap that causes the model to generate the same line indefinitely. Temperature stays 0.0 (deterministic output).
- **Stop stripping indentation in `clean_completion`/`clean_first_line`**: Remove the `trim_start()` loop on lines 2+ and the `split_whitespace().join(" ")` whitespace-collapse in `clean_first_line`. The keyword-dedup regex (for `from from` / `importimport`) stays. Indentation passes through untouched, matching Continue.dev's approach.
- **Wire the AbortController to the completion request**: Check `this.controller.signal.aborted` after the `await api.completeCode(...)` resolves, before dispatching the ghost text effect. Stale requests are dropped client-side; no new IPC command.
- **Update `n_predict` spec from 32 → 128**: Resolves a spec/code divergence. D13 said 32 tokens but the code shipped 128. The code value is correct; the spec is updated to match.
- **Update existing Rust tests that assert indent stripping**: Tests like `clean_completion_normalizes_indentation` encode the old (wrong) behavior. They will be updated to assert indent preservation, following TDD vertical slices.

## Capabilities

### New Capabilities

_None — no new capabilities are introduced._

### Modified Capabilities

- `fim-completion`: Debounce timing changes from 150ms to 3000ms; sampling parameters (repeat_penalty, top_p) are added to the request; `clean_completion` behavior changes from stripping indentation to preserving it; abort-check behavior is added for stale in-flight requests; n_predict spec value corrected from 32 to 128.

## Impact

- **`src/completion/GhostTextPlugin.ts`**: `DEBOUNCE_MS` constant (150 → 3000), `request()` method gains abort-check after `await`.
- **`src-tauri/src/completion.rs`**: `request_body()` gains `repeat_penalty` and `top_p` fields; `clean_completion()` removes `trim_start()` loop; `clean_first_line()` removes `split_whitespace().join(" ")` collapse.
- **`src/__tests__/GhostTextPlugin.test.ts`**: Debounce-timing tests updated for 3000ms; abort-check test added.
- **`src-tauri/src/completion.rs` tests**: Indent-stripping assertions updated to indent-preservation; sampling-param test added.
- **`openspec/specs/fim-completion/spec.md`**: Debounce scenario updated (150ms → 3000ms); n_predict updated (32 → 128); new sampling-params requirement; clean_completion behavior updated; abort-check scenario added.
- No new dependencies. No new IPC commands. No UI changes.
