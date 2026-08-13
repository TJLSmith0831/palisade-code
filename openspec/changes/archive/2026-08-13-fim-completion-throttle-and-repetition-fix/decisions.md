# Decision Log — fim-completion-throttle-and-repetition-fix

## D1: Throttle style — pure debounce vs throttle+trailing

- **Decision**: Pure trailing-edge debounce at 1250ms (replaces D14's 150ms). Suggestion fires only after 1.25s of no typing. Amended from 3000ms after live tuning: 3s felt too sluggish in practice, 1250ms gives enough space to finish a thought without the model feeling absent.
- **Why**: A throttle on a 0.8B model prone to repetition would fire mid-keystroke with stale context. Pure debounce is the simplest change — one constant. The initial 3000ms was tuned down to 1250ms after the user dogfooded the change: 3s was too long between suggestion and the user's typing flow, 1250ms is the sweet spot.
- **Source**: user (confirmed pure debounce over throttle+trailing; amended value from 3000ms → 1250ms after live tuning)

## D3: Scope — all five root causes in scope

- **Decision**: This change fixes all five diagnosed issues: (1) 150ms→3000ms debounce, (2) add repeat_penalty/sampling params to break repetition traps, (3) stop `clean_completion` stripping indent from lines 2+, (4) stop `clean_first_line` stripping indent from line 1, (5) wire AbortController to `completeCode` so stale requests are actually cancelled.
- **Why**: User chose all five. The AbortController no-op is a latent correctness issue (stale requests hold the completion_server mutex), and fixing it alongside the throttle change is cheap since both touch the request lifecycle.
- **Source**: user

## D2: D14 supersession — 150ms was wrong for this model

- **Decision**: D14 (150ms debounce based on "human typing pause 200-300ms") is superseded. The 150ms window was tuned for perceived responsiveness, not for the 0.8B model's repetition tendency. 3000ms gives the user space to code without the model interrupting mid-thought.
- **Why**: User reports the speed impacts their ability to code. The original reasoning (200-300ms human pause) was about not feeling laggy, but the result is the model fires on every micro-pause, generating low-quality suggestions that disrupt flow.
- **Source**: user

## D4: Sampling fix — repeat_penalty (1.1) + top_p (0.95), temp stays 0

- **Decision**: Add `repeat_penalty: 1.1` and `top_p: 0.95` to the request body. Keep `temperature: 0.0` (greedy/argmax). Do not add `top_k`.
- **Why**: `repeat_penalty` directly breaks the greedy-decoding repetition trap (the primary cause of the repeated lines). `top_p: 0.95` adds nucleus sampling as a second guard — if the model's probability mass concentrates on the repeated token, nucleus filtering excludes the tail. Temperature stays 0 so output remains deterministic for the same context (important for a coding tool). `top_k` is redundant with `top_p` for this model size.
- **Source**: user (chose repeat_penalty + top_p over repeat_penalty-only)

## D5: repeat_penalty value — 1.1

- **Decision**: Use `repeat_penalty: 1.1` (llama.cpp default is 1.0 = no penalty; 1.1 is a mild, standard value).
- **Why**: 1.1 is the most common llama.cpp default for general text generation. Too high (1.3+) would suppress legitimate repetition (e.g., repeated `"` in a string list). Too low (1.05) might not break the trap. 1.1 is the safe starting point; tunable via telemetry if it over-corrects.
- **Source**: recommended-accepted

## D6: Indent fix — keep keyword-dedup, drop indent stripping

- **Decision**: Keep the keyword-dedup regex in `clean_completion`/`clean_first_line` (handles `from from` / `importimport` / `import import` mid-completion). Remove the `trim_start()` loop on lines 2+ in `clean_completion` and the `split_whitespace().join(" ")` whitespace-collapse in `clean_first_line`. Indentation passes through untouched.
- **Why**: Research confirms Continue.dev (the reference open-source autocomplete tool) uses sampling params server-side + post-processing client-side but does NOT strip indentation. The keyword-dedup regex solves a real problem that `stripStarterOverlap` (TS-side) can't catch — it only handles the first word, not mid-completion duplicates. The indent stripping was never needed for dedup and directly causes the misaligned lines in the bug report. Removing it matches the reference implementation.
- **Source**: user (confirmed after web research on Continue.dev and llama.cpp approaches)

## D7: AbortController — client-side abort check, no new IPC

- **Decision**: Wire the existing `AbortController` by checking `this.controller.signal.aborted` after the `await api.completeCode(...)` resolves, before dispatching the ghost text effect. No new IPC command. The Rust-side task still runs to completion, but the result is dropped if aborted.
- **Why**: Tauri's `invoke` doesn't accept an AbortSignal, so true server-side cancellation requires a new `cancel_completion` IPC command with Rust-side polling — scope creep for a latent issue. The existing cursor-position check at `GhostTextPlugin.ts:314` already does this for cursor moves; wiring the AbortController extends the same pattern to the "new keystroke cancels in-flight" case. The 3-second debounce (D1) already reduces request frequency dramatically, so wasted compute from uncancelled stale requests is minimal.
- **Source**: user (confirmed client-side abort check over server-side cancel IPC)

## D8: n_predict — keep 128, update spec to match code

- **Decision**: Keep `DEFAULT_N_PREDICT = 128`. Update the `fim-completion` spec (D13 said 32) to match the code (128). This resolves the spec/code divergence.
- **Why**: With `repeat_penalty` (D4) in place, 128 tokens is safe from repetition. 128 tokens (≈12-15 lines) is a reasonable budget for multi-line completions like the Python list in the bug report. Reducing to 32 would truncate useful completions. The spec was wrong (D13 said 32 but the code shipped 128); the code value is correct.
- **Source**: user (chose keep 128 over reduce to 64 or 32)

## D9: Stop tokens — keep current set as belt-and-suspenders

- **Decision**: Keep the current stop tokens: `FIM_SUFFIX`, `FIM_PREFIX`, `"\n\n"`, `"]\n"`. No changes.
- **Why**: `repeat_penalty` (D4) is the primary fix for repetition. The custom stop tokens (`"\n\n"`, `"]\n"`) don't fire during a repetition loop but do fire at legitimate block endings (double newline = end of function/block). They're a harmless second line of defense. Removing them doesn't simplify anything meaningfully.
- **Source**: user (chose keep current over FIM-only or repetition detector)

## D10: Test strategy — TDD with vertical slices, update incorrect tests

- **Decision**: Apply the /tdd skill throughout this change. Use vertical slices (one test → one implementation → repeat), not horizontal (all tests then all impl). For the existing Rust tests that assert indent stripping (`clean_completion_normalizes_indentation`, `clean_completion_handles_multiline_with_duplicates`, etc.): update them to assert indent preservation instead. These tests are "clearly incorrect" per the global rules — they encode behavior that was never decided and causes the bug.
- **Why**: TDD ensures each fix is verified by a failing test before implementation. Vertical slices prevent writing tests for imagined behavior. The existing indent-stripping tests encode the wrong behavior (D6 decided indent should be preserved), so updating them is fixing incorrect tests, not gaming them.
- **Source**: user (chose TDD for entire change + update tests to assert preservation)

## D11: First-line whitespace stripping — strip when prefix has trailing non-newline whitespace, preserve when prefix ends with newline

- **Decision**: In `stripStarterOverlap` (frontend), when the prefix ends with non-newline whitespace and the completion starts with whitespace, strip the completion's leading whitespace before word-overlap detection. When the prefix ends with a newline, preserve the completion's leading whitespace (it's the new line's indent). This is a refinement of D6: D6 governs the backend's `clean_first_line`/`clean_completion` (don't strip indent from any line), while D11 governs the frontend's `stripStarterOverlap` (strip spurious leading whitespace on the first line when the cursor is mid-line).
- **Why**: The user typed `else: ` (trailing space) and the model regenerated `  # TODO: ...` (leading spaces). The ghost text showed `else:   # TODO:` — double whitespace. The old `clean_first_line` would have stripped this via `trim_start()`, but D6 removed that to preserve indent on multi-line completions. The fix belongs in `stripStarterOverlap` because it has access to the prefix (the backend's `clean_first_line` doesn't), and the distinction between "cursor mid-line" (strip) vs "cursor at line start" (preserve) depends on whether the prefix ends with a newline.
- **Source**: user (reported the spurious indent after seeing D6's effect live)
