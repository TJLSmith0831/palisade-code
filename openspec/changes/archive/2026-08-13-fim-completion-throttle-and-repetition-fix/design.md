## Context

The FIM completion pipeline (see proposal.md for motivation) currently has five ungoverned behaviors causing user-visible problems: a 150ms debounce that interrupts coding flow, greedy decoding (temp=0, no repeat_penalty) that triggers repetition traps in the 0.8B model, indentation stripping in `clean_completion`/`clean_first_line` that misaligns multi-line completions, and an AbortController that's never wired to the invoke call. The existing `fim-completion` spec (D14) codified 150ms and 32 n_predict, but the code shipped 128 n_predict — a divergence that was never reconciled.

## Goals / Non-Goals

**Goals:**
- Stop the autocomplete from interrupting the user mid-thought (3s debounce)
- Break the repetition trap that causes the model to generate the same line 10+ times
- Preserve indentation in multi-line completions so ghost text aligns with the user's code
- Drop stale completion results when the user types past the in-flight request

**Non-Goals:**
- No model swap (Qwen3.5-0.8B stays; a larger model would reduce repetition but bloats the bundle)
- No new IPC command (server-side cancellation is out of scope; the 3s debounce already reduces request frequency)
- No UI changes (settings panel, keybinding config, and ghost text rendering are unchanged)
- No streaming completions (batch generation stays)
- No `top_k` (redundant with `top_p` for this model size)

## Decisions

### D4: Sampling parameters — repeat_penalty (1.1) + top_p (0.95), temp stays 0

**Chosen**: Add `repeat_penalty: 1.1` and `top_p: 0.95` to the llama-server request body. Temperature remains 0.0 (greedy/argmax).

**Why**: `repeat_penalty` directly breaks the greedy-decoding repetition trap — the primary cause of the repeated lines. When the model has generated `"look up documentation for a programming language",` and that sequence becomes the highest-probability next token, `repeat_penalty: 1.1` discounts the probability of tokens already in the recent context, forcing the model to explore alternatives. `top_p: 0.95` (nucleus sampling) is a second guard: if the probability mass concentrates on the repeated token, nucleus filtering excludes the tail. Temperature stays 0 so the same context produces the same suggestion (deterministic output is important for a coding tool where users expect consistency).

**Alternatives considered**:
- *repeat_penalty only*: Rejected by user in favor of adding top_p as a second guard.
- *repeat_penalty + top_p + temp 0.1*: Rejected — temperature introduces non-determinism that makes suggestions feel inconsistent.
- *repeat_penalty + top_k + top_p*: Rejected — top_k is redundant with top_p for a 0.8B model with a small vocabulary.

### D6: Indentation — keep keyword-dedup, drop indent stripping

**Chosen**: Keep the keyword-dedup regex in `clean_completion`/`clean_first_line` (handles `from from` / `importimport` mid-completion). Remove the `trim_start()` loop on lines 2+ and the `split_whitespace().join(" ")` whitespace-collapse in `clean_first_line`.

**Why**: Research on Continue.dev (the reference open-source autocomplete tool) confirms that post-processing should separate dedup from indent normalization, and only perform the former. The keyword-dedup regex solves a real problem that `stripStarterOverlap` (TS-side) can't catch — it only handles the first word, not mid-completion duplicates. The indent stripping was never needed for dedup and directly causes the misaligned lines in the bug report.

**Alternatives considered**:
- *Remove clean_completion entirely*: Rejected — would re-introduce the duplicate-keyword bug that the tests confirm the regex fixes.
- *Conditional indent stripping (only on whitespace-only lines)*: Rejected — adds complexity for no benefit; Continue.dev doesn't do this.

### D7: AbortController — client-side abort check, no new IPC

**Chosen**: Check `this.controller.signal.aborted` after `await api.completeCode(...)` resolves, before dispatching the ghost text effect. No new IPC command.

**Why**: Tauri's `invoke` doesn't accept an AbortSignal, so true server-side cancellation requires a new `cancel_completion` IPC command with Rust-side polling. That's scope creep for a latent issue — the 3s debounce already reduces request frequency dramatically, so wasted compute from uncancelled stale requests is minimal. The existing cursor-position check at `GhostTextPlugin.ts:314` already drops stale results for cursor moves; the abort check extends the same pattern to the "new keystroke cancels in-flight" case.

**Alternatives considered**:
- *Server-side cancel IPC*: Rejected — adds a new IPC command (three-edit pattern) and Rust-side polling for minimal compute savings.
- *AbortSignal race wrapper*: Rejected — same effect as client-side check but adds a wrapper abstraction for no benefit.

### D1: Throttle — pure debounce 3000ms

**Chosen**: Pure trailing-edge debounce at 3000ms. Replaces D14's 150ms.

**Why**: A throttle (first suggestion after 3s, then at most one per 3s while typing) would fire mid-keystroke with stale context on a model prone to repetition. "3 seconds before it makes its suggestion" reads as a trailing-edge pause. Pure debounce is the simplest change — one constant.

**Alternatives considered**:
- *Throttle + trailing debounce*: Rejected — fires mid-keystroke with stale context; more complex for worse behavior on this model.

## Risks / Trade-offs

- **[repeat_penalty too high suppresses legitimate repetition]** → 1.1 is mild (llama.cpp default range is 1.0-1.3). If it over-corrects (e.g., suppresses repeated `"` in a string list), telemetry will show fewer accepted completions and the value can be tuned down. The 3s debounce gives the user time to evaluate each suggestion individually.
- **[3s debounce feels slow to users who liked the speed]** → This is the intended trade-off. The user explicitly requested 3s because the speed was impacting their ability to code. If a future user wants faster suggestions, the constant is a single value to tune.
- **[Stale requests still consume compute on the Rust side]** → The abort check is client-side only; the Rust task runs to completion. With the 3s debounce, request frequency drops by ~20x (from every 150ms pause to every 3s pause), so wasted compute is minimal. True server-side cancellation is a future change if compute waste becomes measurable.
- **[Existing tests that assert indent stripping will break]** → These tests encode the old (wrong) behavior. They will be updated to assert indent preservation following TDD vertical slices. The test names and structure stay valid; only the expected values change.
- **[top_p: 0.95 with temp=0 may have no effect]** → With greedy decoding (temp=0, argmax), top_p filtering only matters if the top token's probability is >0.95, which is rare. It's a harmless guard that activates only when the model is highly confident (the exact scenario where repetition traps form). No risk of changing behavior in normal cases.
