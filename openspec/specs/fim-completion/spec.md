# fim-completion Specification

## Purpose

Provides AI-powered fill-in-the-middle code completion using a local bundled model, with inline ghost text in the editor and configurable keybinding to accept suggestions.

## Requirements

### Requirement: Inline ghost text completion

The system SHALL display AI-generated code completions as greyed inline ghost text at the cursor position in the code editor, with a configurable keybinding (default: Option+Tab) to accept the suggestion into the document. The accept keybinding SHALL only trigger when ghost text is visible. Completions SHALL fire after a 1250ms trailing-edge debounce (no typing for 1.25 seconds), not on every micro-pause.

#### Scenario: Ghost text appears after typing pause

- **WHEN** user types in the code editor and pauses for 1250ms
- **THEN** the system displays greyed ghost text showing the predicted completion at the cursor position

#### Scenario: Accept completion with Option+Tab

- **WHEN** ghost text is displayed and user presses Option+Tab (or the configured accept keybinding)
- **THEN** the system inserts the ghost text into the document at the cursor position

#### Scenario: Accept keybinding does nothing without ghost text

- **WHEN** no ghost text is displayed and user presses the accept keybinding
- **THEN** the system performs no action (the keybinding is conditional on ghost text presence)

#### Scenario: Dismiss completion with Escape

- **WHEN** ghost text is displayed and user presses Escape
- **THEN** the system removes the ghost text without inserting any text

#### Scenario: Dismiss completion on cursor movement

- **WHEN** ghost text is displayed and user moves the cursor away from the completion position
- **THEN** the system removes the ghost text without inserting any text

#### Scenario: Cancel in-flight request on new keystroke

- **WHEN** a completion request is in-flight and user types another character
- **THEN** the system marks the in-flight request as aborted and drops its result when it returns, then starts a new completion request after the debounce period

### Requirement: FIM completion request format

The system SHALL send fill-in-the-middle completion requests to the local inference server with prefix (text before cursor), suffix (text after cursor), and cursor position, respecting the token budget (256 prefix tokens, 128 suffix tokens, 128 max generation tokens). The request SHALL include `repeat_penalty: 1.1` and `top_p: 0.95` to prevent repetition traps, with `temperature: 0.0` for deterministic output.

#### Scenario: Completion request with prefix and suffix

- **WHEN** the system requests a completion
- **THEN** it sends the prefix (up to 256 tokens), suffix (up to 128 tokens), cursor position, `n_predict: 128`, `repeat_penalty: 1.1`, `top_p: 0.95`, and `temperature: 0.0` to the inference server

#### Scenario: Completion response includes latency tracking

- **WHEN** the inference server returns a completion
- **THEN** the response includes the completion text and model latency in milliseconds for telemetry

### Requirement: Completion post-processing preserves indentation

The system SHALL preserve leading whitespace (indentation) in all lines of a completion. The keyword-dedup post-processing (removing `from from` / `importimport` / `import import` duplicates) SHALL operate on line content without stripping or normalizing indentation. This matches the Continue.dev reference implementation, which separates dedup from indent normalization and only performs the former.

#### Scenario: Multi-line completion preserves indentation on all lines

- **WHEN** the model returns a multi-line completion with leading whitespace on lines after the first
- **THEN** the system preserves that whitespace in the ghost text without stripping or normalizing it

#### Scenario: Keyword dedup still works without stripping indent

- **WHEN** the model returns a completion with a duplicate keyword (e.g., `from from fastmcp` or `importimport pandas`)
- **THEN** the system removes the duplicate keyword while preserving any leading indentation on that line

#### Scenario: First-line indentation is preserved

- **WHEN** the model returns a completion whose first line has leading whitespace
- **THEN** the system preserves that leading whitespace without collapsing it via whitespace normalization

### Requirement: Local inference sidecar process

The system SHALL spawn a local llama-server sidecar process at app startup, pointing it to the bundled Qwen3.5-0.8B.Q4_K_M.gguf model, and manage its lifecycle (spawn, health check, restart on crash, graceful shutdown).

#### Scenario: Sidecar spawns at app startup

- **WHEN** the Palisade Code app starts
- **THEN** the system spawns the llama-server sidecar process with the bundled model and Metal acceleration enabled

#### Scenario: Sidecar health check

- **WHEN** the system needs to request a completion
- **THEN** it verifies the sidecar is responding via HTTP health check before sending the request

#### Scenario: Sidecar crash recovery

- **WHEN** the llama-server sidecar process crashes
- **THEN** the system attempts one restart; if the second crash occurs, it disables completion for the session and shows a toast notification

#### Scenario: Sidecar graceful shutdown

- **WHEN** the Palisade Code app quits
- **THEN** the system terminates the llama-server sidecar process gracefully

### Requirement: Bundled model and inference engine

The system SHALL bundle the Qwen3.5-0.8B.Q4_K_M.gguf model (540MB) and static llama-server binary (20MB) in the Tauri app bundle, ensuring the app works without external dependencies or user configuration.

#### Scenario: Model loads from bundled resources

- **WHEN** the sidecar process starts
- **THEN** it loads the model from the bundled resources path (`.app/Contents/Resources/models/` on macOS)

#### Scenario: Static binary has no external dependencies

- **WHEN** the app is distributed to another user
- **THEN** the bundled llama-server binary runs without requiring Homebrew, dylibs, or other external dependencies

### Requirement: Completion enable/disable toggle

The system SHALL provide a settings UI toggle to enable or disable AI completion, with completion enabled by default for all projects.

#### Scenario: Disable completion via settings

- **WHEN** user disables completion in settings
- **THEN** the system stops the sidecar process (if running) and ghost text no longer appears

#### Scenario: Enable completion via settings

- **WHEN** user enables completion in settings
- **THEN** the system spawns the sidecar process and ghost text appears after typing pauses

### Requirement: Configurable accept keybinding

The system SHALL allow users to configure the autocomplete accept keybinding via settings UI, with Option+Tab as the default.

#### Scenario: Change accept keybinding

- **WHEN** user changes the accept keybinding in settings
- **THEN** the system uses the new keybinding to accept ghost text completions

#### Scenario: Default keybinding is Option+Tab

- **WHEN** user has not configured a custom keybinding
- **THEN** the system uses Option+Tab as the accept keybinding (avoiding conflicts with regular Tab behavior)

### Requirement: Completion telemetry

The system SHALL track completion acceptance metrics (shown, accepted, dismissed, typed-past) and TTFT percentiles (p50, p99), storing the data locally in `~/.palisade-code/completion-telemetry.json`.

#### Scenario: Record completion shown

- **WHEN** ghost text is displayed to the user
- **THEN** the system increments the "shown" counter in telemetry

#### Scenario: Record completion accepted

- **WHEN** user accepts a completion via the keybinding
- **THEN** the system increments the "accepted" counter and records the TTFT in telemetry

#### Scenario: Record completion dismissed

- **WHEN** user dismisses a completion (Escape, cursor movement, or typing past)
- **THEN** the system increments the "dismissed" counter in telemetry

#### Scenario: Record typed past completion

- **WHEN** user types characters that make the displayed completion irrelevant
- **THEN** the system increments the "typed-past" counter in telemetry

### Requirement: Graceful degradation on missing resources

The system SHALL disable completion silently and log an error if the bundled model or llama-server binary is missing, showing a one-time toast notification per session.

#### Scenario: Missing model file

- **WHEN** the bundled model file is missing or corrupted
- **THEN** the system disables completion silently, logs the error, and shows a one-time toast per session

#### Scenario: Missing inference binary

- **WHEN** the bundled llama-server binary is missing
- **THEN** the system disables completion silently, logs the error, and shows a one-time toast per session

## Decisions

- **D1** — Model was already fine-tuned and quantized (Q4_K_M), ready for integration. (2026-08-12, socrata-fim-completion)
- **D2** — Full end-to-end integration: sidecar → IPC → CodeMirror ghost text → telemetry. (2026-08-12, socrata-fim-completion)
- **D3** — llama.cpp as sidecar (HTTP on localhost); best Metal optimization on Apple Silicon. (2026-08-12, socrata-fim-completion)
- **D4** — Sidecar process management follows terminal.rs pattern (background thread, lifecycle, Drop shutdown). (2026-08-12, socrata-fim-completion)
- **D5** — Custom ViewPlugin + Decoration for ghost text (not dropdown); Cursor-style inline requires decoration with Tab accept. (2026-08-12, socrata-fim-completion)
- **D6** — New `complete_code` IPC command following the three-edit pattern (command fn, generate_handler!, api.ts wrapper). (2026-08-12, socrata-fim-completion)
- **D7** — Model bundled in app resources via Tauri `bundle.resources`, not in user-writable directories; distribution requirement overrides user-dir approach. (2026-08-12, socrata-fim-completion)
- **D8** — No user configuration for model path; always use bundled resource path resolved at runtime. Custom models are a future feature. (2026-08-12, socrata-fim-completion)
- **D9** — Model source was `~/Downloads/socrata-v1-flash/...Q4_K_M.gguf`, copied into `src-tauri/resources/` for bundling. (2026-08-12, socrata-fim-completion)
- **D10** — Latency targets: <300ms TTFT acceptable, <400ms unacceptable. (2026-08-12, socrata-fim-completion)
- **D11** — Standalone benchmark script created before app integration to validate model loads and performs. (2026-08-12, socrata-fim-completion)
- **D12** — Benchmark passed: 67-70ms TTFT, ~200 tok/s, 26MB CPU memory, correct FIM output. (2026-08-12, socrata-fim-completion)
- **D13** — Context budget: 256 prefix tokens, 128 suffix tokens, 32 max generation. TTFT stays under 70ms even at 1024 tokens. (2026-08-12, socrata-fim-completion)
- **D14** — 150ms debounce after last keystroke, cancel immediately on new keystroke or cursor movement. (2026-08-12, socrata-fim-completion) **Superseded by D47 — 1250ms is the tuned value; 150ms fired on every micro-pause and disrupted coding flow.**
- **D15** — Completion enabled by default for all projects; 67ms TTFT justifies always-on. (2026-08-12, socrata-fim-completion)
- **D16** — Model must be bundled for distribution; Downloads/home directory locations are user-deletable. (2026-08-12, socrata-fim-completion)
- **D17** — Tauri `bundle.resources` used to bundle the model; runtime path via `app.path().resolve(..., BaseDirectory::Resource)`. (2026-08-12, socrata-fim-completion)
- **D18** — llama-server bundled as Tauri sidecar via `externalBin`, not embedded in Rust binary; ~10MB per architecture. (2026-08-12, socrata-fim-completion)
- **D19** — Rust backend spawns bundled sidecar at startup, manages lifecycle via spawn/kill, HTTP IPC for completions. (2026-08-12, socrata-fim-completion)
- **D20** — Primary target is aarch64-apple-darwin (Apple Silicon). Cross-platform is future work. (2026-08-12, socrata-fim-completion)
- **D21** — Bundle structure: `src-tauri/resources/models/` for model, sidecar binary with target-triple suffix. (2026-08-12, socrata-fim-completion)
- **D22** — Settings UI has enable/disable toggle only; no model path configuration (bundled, not user-configurable). (2026-08-12, socrata-fim-completion)
- **D23** — Missing bundled resources → disable completion silently, log error, one-time toast per session. (2026-08-12, socrata-fim-completion)
- **D24** — llama.cpp over mistral.rs: faster on Metal (736-1532 T/s vs 606-1116), 10x smaller binary (10MB vs 1GB), validated FIM. (2026-08-12, socrata-fim-completion)
- **D25** — Telemetry: acceptance rate (shown/accepted/dismissed/typed-past) and TTFT p50/p99; local storage in `~/.palisade-code/completion-telemetry.json`. (2026-08-12, socrata-fim-completion)
- **D26** — code-editor spec updated to reflect FIM implementation (fulfills the "future FIM model" seam requirement). (2026-08-12, socrata-fim-completion)
- **D27** — Implemented now because model is validated (67ms TTFT), performance targets met, distribution is urgent. (2026-08-12, socrata-fim-completion)
- **D28** — Primary beneficiary is the user (dogfooding as main IDE); secondary are other users receiving the packaged app. (2026-08-12, socrata-fim-completion)
- **D29** — Non-goals: no custom model selection, no cross-platform beyond Apple Silicon, no streaming completions, no multi-line context beyond token budget, no remote/cloud models. (2026-08-12, socrata-fim-completion)
- **D30** — Done = sidecar spawns with bundled model, ghost text with Tab accept, settings toggle, telemetry tracks acceptance, benchmark confirms <300ms TTFT. (2026-08-12, socrata-fim-completion)
- **D31** — Rejected in-process inference (embedding llama.cpp in Rust) in favor of sidecar; sidecar keeps Rust binary smaller, allows engine swaps, matches terminal.rs pattern. (2026-08-12, socrata-fim-completion)
- **D32** — IPC shape: `{ prefix, suffix, cursorPosition }` → `{ completion, modelLatencyMs }`. (2026-08-12, socrata-fim-completion)
- **D33** — Sidecar crash: attempt one restart; second crash → disable completion for session, show toast. Prevents crash loops. (2026-08-12, socrata-fim-completion)
- **D34** — Model load failure (missing/corrupted): disable silently, log error, one-time toast per session. (2026-08-12, socrata-fim-completion)
- **D35** — Concurrent requests: cancel in-flight on new keystroke; one active request per editor instance. (2026-08-12, socrata-fim-completion)
- **D36** — IPC signature: `complete_code(project_hash, file_path, prefix, suffix) -> Result<CompletionResponse>`. (2026-08-12, socrata-fim-completion)
- **D37** — Implementation sequence: bundle → sidecar → IPC → CodeMirror → settings → telemetry (riskiest first). (2026-08-12, socrata-fim-completion)
- **D38** — No migration needed; new feature with no existing data. (2026-08-12, socrata-fim-completion)
- **D39** — Each phase has specific verification (bundle builds, sidecar /health, IPC returns completions, ghost text renders, toggle works, telemetry writes). (2026-08-12, socrata-fim-completion)
- **D40** — Option+Tab (or Alt+Tab) as default accept keybinding, not Tab; avoids conflicts with regular Tab. Keybinding is conditional on ghost text presence. (2026-08-12, socrata-fim-completion)
- **D41** — Static llama-server binary from `batiai/llamacpp-server-macos` (HuggingFace), not Homebrew; Homebrew's dynamically links six non-system dylibs. Static binary is 20MB, zero external deps, identical performance. (2026-08-12, socrata-fim-completion)
- **D42** — `ureq = "2"` (already in Cargo.toml) covers the localhost HTTP IPC; no new HTTP dependency needed. (2026-08-12, socrata-fim-completion)
- **D43** — Tauri bundle config was entirely unwritten (no resources, no externalBin, no macOS signing block); all greenfield config. (2026-08-12, socrata-fim-completion)
- **D44** — FileEditorPane integration point (`autocompletion({ override: [completeAnyWord] })` at line 390) confirmed intact after architecture refactor. (2026-08-12, socrata-fim-completion)
- **D45** — Large bundled assets (540MB model, 20MB binary) are build inputs, not committed source; gitignored. Future distribution requires an installer/fetcher to deliver them to build machines. (2026-08-12, socrata-fim-completion)
- **D46** — `externalBin` name is `llama-server` (not `binaries/llama-server`); Tauri v2 bundler resolves from `src-tauri/<name>-<target-triple>`. (2026-08-12, socrata-fim-completion)
- **D47** — 1250ms trailing-edge debounce (amended from 3000ms after live dogfooding). Supersedes D14's 150ms. Pure debounce, not throttle+trailing — a throttle would fire mid-keystroke with stale context on a model prone to repetition. (2026-08-13, fim-completion-throttle-and-repetition-fix)
- **D48** — Sampling params: `repeat_penalty: 1.1` + `top_p: 0.95`, `temperature` stays 0.0. Breaks the greedy-decoding repetition trap on the 0.8B model. `top_k` rejected as redundant with `top_p` for this vocabulary size. (2026-08-13, fim-completion-throttle-and-repetition-fix)
- **D49** — Backend `clean_completion`/`clean_first_line` preserve indentation (no `trim_start`); keyword-dedup regex stays. Matches Continue.dev, which separates dedup from indent normalization and only performs the former. (2026-08-13, fim-completion-throttle-and-repetition-fix)
- **D50** — Client-side abort check only (no server-side cancel IPC). Tauri `invoke` can't accept an `AbortSignal`; the 1250ms debounce limits wasted compute from stale requests. The controller is captured locally before `await` so the check tests the right request. (2026-08-13, fim-completion-throttle-and-repetition-fix)
- **D51** — Frontend `stripStarterOverlap` strips spurious first-line whitespace when the prefix ends with non-newline whitespace (cursor mid-line); preserves indent when the prefix ends with a newline (cursor at line start). Splits indent handling with D49: backend preserves all lines, frontend strips mid-line whitespace regen. (2026-08-13, fim-completion-throttle-and-repetition-fix)
- **D52** — Cross-file context is hand-built into the `/completion` prompt, not passed to llama-server's `/infill` endpoint. `/infill` accepts `input_extra: [{filename, text}]` and would format it with the model's own repo-level tokens, but measured against the bundled checkpoint it is **silently ignored**: `tokens_evaluated` was 29 both with and without a ~60-token extra file. The GGUF does not declare the `FIM_REPO`/`FIM_SEP` metadata `/infill` needs. Re-test on any new checkpoint — Qwen2.5-Coder declares those tokens, and adopting `/infill` would delete `build_context_block`. (2026-08-31, GH#9 Phase 1)
- **D53** — Context selection lives in the frontend, serialization and budgeting in the backend. The frontend is the side that knows open tabs, edit recency and — via the `sessions` map — each buffer's *unsaved* text, which is what the user is actually looking at. It sends `ContextFile[]`; the backend orders and trims. (2026-08-31, GH#9 Phase 1)
- **D54** — The context block leads the prompt and is ordered by path, never by relevance. Relevance decides membership only. Prefix caching reuses the longest common *token prefix*, so re-sorting by recency on each keystroke would invalidate it. Files that do not fit the ~512-token budget are dropped whole, never truncated — a truncation point that moves with the budget destabilizes the same prefix. (2026-08-31, GH#9 Phase 1)
- **D55** — Phase 2 (KV/prefix caching) is **not deliverable on the Qwen3.5-0.8B checkpoint**, and `--cache-reuse` is deliberately absent from the sidecar args. llama.cpp logs `cache_reuse is not supported by this context, it will be disabled` and `forcing full prompt re-processing due to lack of cache data (likely due to SWA or hybrid/recurrent memory)`. The hybrid Gated DeltaNet attention defeats both KV shifting and ordinary prefix caching. A 32/64/128/256 sweep moved neither prefill time nor tokens-evaluated (367 every time); larger values were slightly slower from bookkeeping. `cache_prompt: true` is kept in the request body because it is free and becomes load-bearing after the model swap. (2026-08-31, GH#9 Phase 2)
- **D56** — Base model committed: **`Qwen/Qwen2.5-Coder-0.5B`**. `starcoderbase-1b` is dropped as a fallback. Decided on two independent measurements, not just FIM-nativeness: on identical prompts and simulated typing, Qwen2.5-Coder-0.5B re-evaluated **10** tokens per keystroke at 11.2ms prefill, against **241** tokens at 74.5ms for the shipped Qwen3.5-0.8B — 24x less prefill work, with no cache warnings in the server log. This makes the model swap the precondition for Phases 1 and 2 both: cross-file context costs +43ms per keystroke forever on Qwen3.5, but sits in the cached prefix on Qwen2.5-Coder — paid once, then free. (2026-08-31, GH#9 Phase 3)
- **D57** — Training data is `bigcode/starcoderdata`, not `the-stack-v2`. Both `the-stack-v2-dedup` and `-train-smol-ids` ship only SWHIDs and require AWS credentials plus a SoftwareHeritage/INRIA bulk-download agreement — a paperwork dependency, not plumbing, and not satisfiable from a Colab notebook. `starcoderdata` has a real `content` field and per-language `data_dir`, gated behind one-click HF terms. (2026-08-31, GH#9 Phase 3)
- **D58** — Cross-file context (GH#9 Phase 1) is **built but not shipped**. Measured **zero** quality gain at **2.7–2.9x the TTFT cost**, on both the shipped Qwen3.5-0.8B and Qwen2.5-Coder-0.5B — a latency regression bought nothing. The implementation is parked on `claude/colab-access-f422df` (commit `1d12d93`, pushed to origin), recoverable if usage data ever justifies repo-level retrieval. **The trigger to reopen is D63's telemetry**: revisit when `shown`/`retained` show inline completion carrying real traffic, not before. Note the null result is weaker than it reads — exact-match 0.07 is 7 tasks in 100, so a gain of one or two is below the metric's resolution; what was disproved is *proximity-based concatenation*, not repo-level context as such. If it is revisited, it should be a dependency graph built for the purpose (GraphCoder/CodeRAG rank for *necessity*, not similarity), not this path-ordered concatenation. D52–D54 describe the parked design and stay on record for that retry. (2026-09-02, GH#9 Phase 1)
- **D59** — Ship **stock `Qwen2.5-Coder-0.5B` Q5_K_M**; shelve the fine-tune `Palisade-Coder-0.5B-FIM-v1.1`. Measured like-for-like at Q5_K_M (n=100), the fine-tune hit both target metrics — empty rate 0.12→0.00 single / 0.09→0.00 multi, multi length ratio 0.76→1.00 — and lost correctness on **four of six** accuracy measures (single pass@1 0.77→0.72, multi exact match 0.11→0.07, RepoBench-C exact match 0.07→0.04) while multiplying overshoot >2x by five (0.04→0.13 single, 0.02→0.19 multi). The earlier large "win" was against a Q4_K_M baseline and was quantization, not fine-tuning. The flat training loss (0.95 @ step 100 → 0.97 @ step 9,000, after cosine decay) predicted this: a FIM-pretrained base on a generic corpus trades behavior, it does not add capability. Keep the checkpoint as the control group. (2026-09-02, GH#9 Phase 3)
- **D60** — The stock model's empty completions are **abstention, not failure**, and are kept deliberately. A 9–21% empty rate is the model declining when it has nothing confident to say; the calibration literature reports acceptance rising 27.4%→40.9% when the least-confident prompts are *rejected on purpose*. The fine-tune trained away a free, well-calibrated version of the exact mechanism worth building. This reframes the empty path from a defect to a feature and is the premise for D61. (2026-09-02, GH#9 Phase 3)
- **D61** — Abstention gets a **voice in the editor status bar**, not inline ghost text. Correcting the premise: there was never an empty grey box — `GhostTextPlugin.ts` returns early on empty text and the decoration builder returns `Decoration.none`, so idle, in-flight, abstained and errored all rendered identically (nothing). This is a new affordance, and inline was rejected: at a 9–21% abstention rate, text at the cursor competes with the code being written at the exact moment of concentration. The bar carries the same fact, glanceably. Signalled by a window event (`palisade:completion-abstained`) — the same idiom the FIM toggle already uses — rather than a CodeMirror state field, because nothing in the editor reacts to it. Errors are deliberately **not** abstentions: a failed round-trip is the network, not the model declining. (2026-09-02, GH#9)
- **D62** — The abstention notice is throttled to **at most once per file per 3 minutes, and never twice for the same cursor position**. At 9–21% abstention against a 1250ms debounce (D1) an unthrottled notice fires many times a minute, which is how a well-meant affordance becomes one users resent. The throttle is module state keyed by file path so it survives the plugin being reconfigured mid-session. Copy is three words — `nothing confident here` — with the explanation in a tooltip; "cannot", "failed", "unable" and "please" are all barred because they read as errors for something that is working correctly. (2026-09-02, GH#9)
- **D63** — Acceptance telemetry gains `abstained` and `retained`. `retained` counts an accepted completion still present in the file 30s later — GitHub's rebuild of Copilot found accepted-and-retained characters the metric that tracks developer happiness where raw acceptance rate does not, and accepted-then-deleted is not an accepted completion. `abstained` is counted on **every** abstention, unthrottled; only the status-bar notice is throttled (D62), because sizing the behavior and surfacing it are different jobs. Retention is checked by substring rather than a mapped range: a distinct completion is unlikely to also appear elsewhere in the file, and this is a usage counter, not a ledger. Both land in `~/.palisade-code/completion-telemetry.json`; the new Rust fields are `#[serde(default)]` so a payload written before they existed still parses. This is step 2 of the sequence — the measurement that decides whether inline completion justifies any further work. (2026-09-02, GH#9)
- **D64** — **Amends D11/D51.** `stripStarterOverlap` strips a regenerated leading whitespace run only when the cursor is past real content on the line; when everything since the last newline is whitespace the cursor sits in the indent, and the completion's leading whitespace is kept. Found dogfooding the D59 swap: an accepted completion landed two spaces inside a four-space block, which Python rejects. D51's blanket strip was correct for Qwen3.5-0.8B, which regenerated the indent; the shipped model supplies the **remainder** instead. Measured on it, cursor in a 12-space block — 12 typed → `"out.append(...)"`, 4 typed → `"        out.append(...)"`, 0 typed → `"            out.append(...)"`. The word-overlap check is skipped in the same case for the same reason: it exists to catch a model repeating the token you just typed, which only means anything while the cursor still touches it. Across a newline it matched by coincidence — a previous line ending in `helper` turned `    helper_two(value)` into `_two(value)`, indent gone and identifier chewed. (2026-09-02, GH#9)
