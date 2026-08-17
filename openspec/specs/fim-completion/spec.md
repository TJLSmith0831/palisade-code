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
