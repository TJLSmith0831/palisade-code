# Socrata-v1-Flash FIM Completion Integration - Decision Log

**Topic:** Integrate socrata-v1-flash model for AI-powered autocompletion in Floo Network
**Date:** 2026-08-12
**Status:** Harvested from grill-explore (25 decisions carried forward)

## Context

User has model files in Downloads (socrata-v1-flash, a fine-tuned Qwen3.5-0.8B model for FIM completion). Goal: Cursor/Devin Desktop-style inline code completion with ghost text and Tab to accept.

Existing research in RESEARCH.md covers model assessment, training data, inference engine options, latency budgets, and CodeMirror 6 integration requirements.

---

## D1: Model readiness state

- **Decision**: Model is already fine-tuned and quantized (Q4_K_M), ready for integration
- **Why**: User confirmed having the model files in Downloads; RESEARCH.md indicates training is complete
- **Source**: user

## D2: Integration scope

- **Decision**: Full end-to-end integration: sidecar process management → IPC → CodeMirror ghost text → telemetry
- **Why**: User wants "AI-powered autocompletion" like Cursor/Devin Desktop, which implies the complete feature
- **Source**: user

## D3: Inference engine choice

- **Decision**: Use llama.cpp as sidecar process (HTTP on localhost)
- **Why**: RESEARCH.md recommends llama.cpp for best Metal optimization on Apple Silicon; sidecar pattern matches existing executor.rs process management
- **Source**: codebase (executor.rs patterns) + RESEARCH.md recommendation

## D4: Process management pattern

- **Decision**: Follow terminal.rs pattern for sidecar process management
- **Why**: terminal.rs already demonstrates background thread ownership, PTY/process lifecycle, and graceful shutdown via Drop; inference server needs similar pattern but without PTY (just HTTP)
- **Source**: codebase (src-tauri/src/terminal.rs:28-50)

## D5: CodeMirror integration approach

- **Decision**: Build custom ViewPlugin + Decoration extension for ghost text (not dropdown)
- **Why**: Current autocompletion() uses dropdown (completeAnyWord at FileEditorPane.tsx:390); Cursor-style ghost text requires inline decoration with Tab accept, not dropdown selection
- **Source**: codebase (FileEditorPane.tsx:390) + RESEARCH.md CodeMirror section

## D6: IPC command structure

- **Decision**: New complete_code command following three-edit pattern
- **Why**: CLAUDE.md requires three edits for new IPC: #[tauri::command] fn, generate_handler! registration (lib.rs:1162), and api.ts wrapper
- **Source**: codebase (lib.rs:1162-1233, api.ts:1-50) + CLAUDE.md

## D7: Model file storage location (REVISED)

- **Decision**: Bundle model file in app resources via Tauri `bundle.resources`, not in user directories
- **Why**: Distribution requirement (D16) overrides earlier decision; model must be protected from user deletion. Tauri resources bundle into `.app/Contents/Resources/` on macOS.
- **Source**: D16 + D17 + Tauri docs

## D8: Model path configuration approach (REVISED)

- **Decision**: No user configuration needed for model path; always use bundled resource path resolved at runtime
- **Why**: Model is bundled with the app; users shouldn't need to configure this. If advanced users want custom models, that's a future feature.
- **Source**: D16 + D17

## D9: Model file current location (REVISED)

- **Decision**: Model files currently at `~/Downloads/socrata-v1-flash/gguf_q4_k_m_gguf/Qwen3.5-0.8B.Q4_K_M.gguf`
- **Why**: Need to copy this file into `src-tauri/resources/` for bundling. No migration from user directories since it's bundled.
- **Source**: user + D17

## D10: Latency budget acceptance

- **Decision**: Accept RESEARCH.md targets: <300ms TTFT (acceptable), <400ms (unacceptable)
- **Why**: User confirmed these targets are realistic for use case
- **Source**: user

## D11: Model validation priority

- **Decision**: Create standalone benchmark script before any app integration
- **Why**: RESEARCH.md Phase 0 emphasizes validating model loads and performs before integration investment; hybrid architecture support in llama.cpp is unconfirmed
- **Source**: RESEARCH.md Phase 0 + user confirmation

## D12: Benchmark results - model validation passed

- **Decision**: Model loads successfully in llama.cpp, produces correct FIM output, meets latency targets
- **Why**: Benchmark script results: llama-server starts in 1s with Metal, FIM completion produces syntactically correct Python code (`total += item['price']`), TTFT ~67-70ms (well under 300ms target), memory 26MB (CPU only)
- **Source**: benchmark-fim.sh execution results

**Benchmark details:**

- Model: `Qwen3.5-0.8B.Q4_K_M.gguf` loads successfully with Metal
- FIM format: `<|fim_prefix|>`, `<|fim_suffix|>`, `<|fim_middle|>` tokens work correctly
- TTFT: 67-70ms across varying context lengths (100-1024 tokens)
- Generation speed: ~200 tokens/sec
- Prompt processing: ~42ms for 4 tokens (~10.6ms/token)
- Memory: 26MB CPU (GPU memory not measured in RSS)

## D13: Context window budget

- **Decision**: Prefix 256 tokens, suffix 128 tokens, max generation 32 tokens
- **Why**: Benchmark shows TTFT stays under 70ms even at 1024 tokens; we can afford generous context. RESEARCH.md suggested 256/128/32, and the model's performance supports this.
- **Source**: RESEARCH.md latency targets + benchmark validation

## D14: Debounce and cancellation strategy

- **Decision**: 150ms debounce after last keystroke, cancel immediately on any new keystroke or cursor movement
- **Why**: RESEARCH.md recommends 150ms based on human typing pause (200-300ms); cancellation prevents wasted inference when user types past the suggestion
- **Source**: RESEARCH.md latency budget section

## D15: Default enablement scope

- **Decision**: Enable completion for all projects by default
- **Why**: User wants universal availability; model performance (67ms TTFT) justifies always-on behavior
- **Source**: user

## D16: Distribution requirement - model bundling

- **Decision**: Model must be bundled with the app for distribution, not stored in user-writable locations
- **Why**: User wants to package Floo Network for other users; Downloads or home directory locations are user-deletable. Need model embedded in app bundle or sidecar.
- **Source**: user

## D17: Tauri resources feature for model bundling

- **Decision**: Use Tauri's built-in `resources` feature to bundle the model file in the app bundle
- **Why**: Tauri supports bundling large files via `bundle.resources` in tauri.conf.json; at runtime, use `app.path().resolve("path", BaseDirectory::Resource)` to get the bundled file path. On macOS, resources live in `.app/Contents/Resources/` (user-protected).
- **Source**: Tauri docs (v2.tauri.app/develop/resources/) + web search results

## D18: llama-server as Tauri sidecar binary

- **Decision**: Bundle llama-server as a Tauri sidecar using `externalBin` feature, not embedded in Rust binary
- **Why**: llama.cpp provides pre-built static binaries for macOS (arm64/x64) via GitHub releases (~10MB each). Tauri's `externalBin` handles architecture selection automatically. This avoids building llama.cpp from source in Rust and keeps the app bundle size reasonable.
- **Source**: web search (llama.cpp releases, Tauri sidecar docs, Medium article on Tauri + llama.cpp)

## D19: Sidecar architecture pattern

- **Decision**: Rust backend spawns bundled llama-server sidecar at app startup, pointing it to bundled model path via resources
- **Why**: Sidecar pattern keeps llama.cpp as a separate process (like terminal.rs pattern), but the binary and model are both bundled in the app. Rust backend manages lifecycle via spawn/kill, HTTP IPC for completions.
- **Source**: codebase (terminal.rs pattern) + web search (Tauri sidecar examples)

## D20: Target architecture for distribution

- **Decision**: Primary target is aarch64-apple-darwin (Apple Silicon), matching current development machine
- **Why**: User's machine is Apple Silicon; llama.cpp provides pre-built binaries for this architecture. Cross-platform support (Intel macOS, Windows, Linux) can be added later if needed.
- **Source**: rustc host triple output (aarch64-apple-darwin)

## D21: Bundle structure

- **Decision**: Create `src-tauri/resources/models/` directory and copy `Qwen3.5-0.8B.Q4_K_M.gguf` there; create `src-tauri/binaries/` directory and download llama-server binary with target triple suffix
- **Why**: Tauri expects resources in `src-tauri/resources/` and sidecars in `src-tauri/binaries/` with architecture suffix. This structure will be bundled into the app.
- **Source**: Tauri docs + web search examples

## D22: Settings UI for completion (REVISED)

- **Decision**: Add enable/disable toggle to settings panel; remove model path configuration (no longer user-configurable)
- **Why**: Model is bundled, so users only need to turn completion on/off. Advanced model selection is a future feature.
- **Source**: D17 + D18 (bundled approach)

## D23: Error handling for missing bundled resources

- **Decision**: If bundled model or llama-server binary is missing, disable completion silently and log error; show one-time toast per session
- **Why**: Bundled resources should always be present in production, but dev builds might be incomplete. Graceful degradation prevents crashes.
- **Source**: codebase error handling patterns

## D24: Engine choice - llama.cpp vs mistral.rs comparison

- **Decision**: Stick with llama.cpp over mistral.rs for this use case
- **Why**:
  - **Performance**: llama.cpp is faster on Metal (Apple Silicon) - benchmarks show llama.cpp 736-1532 T/s vs mistral.rs 606-1116 T/s for prompt processing
  - **Bundle size**: llama.cpp binary is ~10MB vs mistral.rs ~1GB (10x smaller)
  - **FIM support**: llama.cpp FIM is validated (benchmark confirmed it works); mistral.rs FIM support is unclear from docs
  - **Sidecar pattern**: Both work as sidecars, but llama.cpp's smaller size keeps app bundle reasonable
- **Source**: web search (GitHub issue #903 tracking Metal performance, mistral.rs releases showing 1GB binaries, llama.cpp releases showing 10MB binaries)

## D25: Telemetry scope

- **Decision**: Track acceptance rate (shown/accepted/dismissed/typed-past) and TTFT p50/p99; store locally in `~/.floo-network/completion-telemetry.json`
- **Why**: RESEARCH.md recommends acceptance metrics to tune context budgets and debounce; local storage preserves privacy
- **Source**: RESEARCH.md Phase 5 tuning section

## D26: Spec alignment with code-editor

- **Decision**: Update code-editor spec to reflect FIM completion implementation (fulfilling the "future FIM model" requirement)
- **Why**: The code-editor spec explicitly planned for FIM completion as a future feature; this change implements it, so the spec should reflect the new capability
- **Source**: user + code-editor spec ("Completion-interface seam for future FIM model" requirement)

## D27: Why now - timing rationale

- **Decision**: Implement now because model is validated (D12), performance targets are met (67ms TTFT), and distribution requirement is urgent (user wants to package for other users)
- **Why**: Model validation passed with excellent performance; no technical blockers remain. Distribution timing is user-driven.
- **Source**: D12 + D16 + user

## D28: Who benefits

- **Decision**: Primary beneficiary is the user (dogfooding Floo Network as main IDE); secondary beneficiaries are other users who will receive the packaged app
- **Why**: User explicitly wants to package for distribution; this is a product feature for end users.
- **Source**: user + D16

## D29: Explicit non-goals

- **Decision**: Non-goals: (1) Custom model selection by users, (2) Cross-platform support beyond Apple Silicon, (3) Streaming completions, (4) Multi-line context beyond token budget, (5) Remote/cloud model support
- **Why**: These are explicitly out of scope to keep the change focused. Custom models (D8), cross-platform (D20), and streaming are future work. Token budget (D13) limits context. Remote models contradict the local-only approach.
- **Source**: D8 + D13 + D20 + grill-explore scoping

## D30: What "done" looks like

- **Decision**: Done when: (1) llama-server sidecar spawns at app startup with bundled model, (2) CodeMirror shows ghost text completions with Tab accept, (3) Settings UI has enable/disable toggle, (4) Telemetry tracks acceptance rate, (5) Benchmark confirms <300ms TTFT in integrated environment
- **Why**: These are the concrete deliverables from D2 (integration scope) that must work for the feature to be usable.
- **Source**: D2 + D5 + D22 + D25 + D10

## D31: Rejected alternative - in-process inference

- **Decision**: Rejected in-process inference (embedding llama.cpp directly in Rust) in favor of sidecar process
- **Why**: Sidecar keeps the Rust binary smaller, allows swapping engines without rebuilding, and matches existing terminal.rs pattern. In-process would require C++ build dependencies and increase binary size significantly.
- **Source**: D3 + D4 + D18 + D19

## D32: Completion request data shape

- **Decision**: IPC request: `{ prefix: string, suffix: string, cursorPosition: { line: number, column: number } }`; response: `{ completion: string, modelLatencyMs: number }`
- **Why**: Prefix/suffix are the FIM inputs. Cursor position helps with context extraction. Latency tracking supports telemetry (D25). Simple JSON matches existing IPC patterns.
- **Source**: D6 + D13 + D25 + codebase IPC patterns

## D33: Failure modes - sidecar crash

- **Decision**: If llama-server crashes, attempt one restart; if second crash occurs, disable completion for the session and show toast
- **Why**: Single restart handles transient failures. Repeated crashes indicate a real problem; disabling prevents crash loops. Toast informs user without blocking.
- **Source**: D23 + codebase error handling patterns

## D34: Failure modes - model load failure

- **Decision**: If bundled model file is missing or corrupted, disable completion silently and log error; show one-time toast per session
- **Why**: Bundled resources should always be present in production. Dev builds might be incomplete. Silent disable prevents crashes; toast informs user.
- **Source**: D23 + D17

## D35: Edge case - concurrent completion requests

- **Decision**: Cancel in-flight request on new keystroke (D14); only one active request per editor instance
- **Why**: Prevents request queue buildup and wasted inference. User typing past the suggestion makes the old completion irrelevant.
- **Source**: D14 + D13

## D36: Integration point - exact IPC signature

- **Decision**: Tauri command: `complete_code(project_hash: string, file_path: string, prefix: string, suffix: string) -> Result<CompletionResponse>`
- **Why**: project_hash and file_path provide context for potential future features (per-project settings, file-type-specific behavior). prefix/suffix are the FIM inputs.
- **Source**: D6 + D32 + codebase IPC patterns

## D37: Implementation sequencing - riskiest first

- **Decision**: Sequence: (1) Bundle setup (model + binary), (2) Sidecar process management, (3) IPC layer, (4) CodeMirror ghost text, (5) Settings UI, (6) Telemetry
- **Why**: Bundle setup and sidecar are riskiest (new Tauri features, external process). IPC is straightforward following existing patterns. CodeMirror extension is new but isolated. Settings and telemetry are lower risk.
- **Source**: D3 + D4 + D5 + D18 + D21 + risk assessment

## D38: Migration strategy

- **Decision**: No migration needed - this is a new feature with no existing data to migrate
- **Why**: Model is bundled (D7), not user-configured. No existing completion system to replace. Settings UI adds new toggle but doesn't change existing settings structure.
- **Source**: D7 + D8 + D22

## D39: Verification per task

- **Decision**: Each phase has specific verification: (1) Bundle: app builds with resources, (2) Sidecar: llama-server starts and responds to /health, (3) IPC: complete_code returns valid completions, (4) CodeMirror: ghost text renders and Tab accepts, (5) Settings: toggle enables/disables, (6) Telemetry: file writes with correct data
- **Why**: Incremental verification catches issues early. Each component can be tested independently before integration.
- **Source**: D30 + D37 + codebase testing patterns

## D40: Autocomplete keybinding configuration (REVISED)

- **Decision**: Use Option+Tab (or Alt+Tab) as the default accept keybinding, and only trigger the action when ghost text is visible. Allow users to configure the keybinding via settings UI.
- **Why**: User wants Option+Tab to avoid conflicts with regular Tab behavior. The keybinding should be conditional on ghost text presence to prevent accidental triggers when no completion is available.
- **Source**: user

## D41: Prebuilt llama-server is NOT a single static binary (REVISED)

- **Decision**: The llama-server used to produce the D12 benchmark is Homebrew's, and it dynamically links six non-system dylibs — four via `@rpath` (`libllama-server-impl`, `libllama-common.0`, `libmtmd.0`, `libllama.0`) and two via absolute Homebrew paths (`/opt/homebrew/opt/ggml/lib/libggml.0.dylib`, `libggml-base.0.dylib`), plus Homebrew OpenSSL. Solution: use the static binary from `batiai/llamacpp-server-macos` Hugging Face repository instead.
- **Why**: `otool -L $(which llama-server)` verified the dylib problem. The Hugging Face static binary (20MB) has zero external deps (only macOS base frameworks), benchmarked at identical performance (66-67ms TTFT vs 67-70ms Homebrew, 19.9MB memory vs 26MB Homebrew). This validates D18's sidecar approach while fixing the distribution blocker.
- **Source**: codebase (`otool -L /opt/homebrew/bin/llama-server`) + web search (batiai/llamacpp-server-macos) + benchmark-static-server.sh verification

## D42: Existing HTTP client covers the sidecar IPC

- **Decision**: No new HTTP dependency is needed for D3's localhost IPC — `ureq = "2"` is already in `src-tauri/Cargo.toml`.
- **Why**: Reuse before writing; `ureq` is blocking, which fits the `spawn_blocking` pattern the async commands already use.
- **Source**: codebase (`src-tauri/Cargo.toml:39`)

## D43: Bundle config is entirely unwritten

- **Decision**: `tauri.conf.json`'s `bundle` block currently has only `active`, `targets: ["app"]`, and `icon`. There is no `resources`, no `externalBin`, and no `macOS` signing/entitlements block — all of D17/D18/D21 is greenfield config, not a modification.
- **Why**: Sizing the work accurately; also means the sidecar's codesigning has no existing hook to inherit from. `package.sh` re-signs Tauri's bundle output with a self-signed identity after the fact.
- **Source**: codebase (`src-tauri/tauri.conf.json:29-41`, `package.sh:17-42`)

## D44: FileEditorPane integration point confirmed intact

- **Decision**: D5's target is still live after the architecture refactor — `autocompletion({ override: [completeAnyWord] })` at `src/FileEditorPane.tsx:390`.
- **Why**: The recent structural split (commit b3f596b) could have moved it; it did not.
- **Source**: codebase (`src/FileEditorPane.tsx:390`)

## D45: Large bundled assets are build inputs, not committed source

- **Decision**: The 540MB model and 20MB sidecar binary are copied to `src-tauri/resources/models/` and `src-tauri/binaries/` but added to `.gitignore`. They are treated as build-time inputs for local DMG/app packaging; future distribution requires an installer/fetcher to deliver them to build machines.
- **Why**: Copying 540MB into git history would exceed GitHub's 100MB per-file limit and bloat the repository (D47). The user confirmed this is acceptable with a note that an install script or gated location is needed later.
- **Source**: user

## D46: `externalBin` name is `llama-server` (not `binaries/llama-server`)

- **Decision**: `tauri.conf.json` uses `"externalBin": ["llama-server"]` and the source binary is `src-tauri/llama-server-aarch64-apple-darwin`.
- **Why**: Tauri v2's bundler (verified by `cargo test`) resolves the file from `src-tauri/<name>-<target-triple>` and places the sidecar in the app bundle as `MacOS/<name>`. Using `binaries/llama-server` caused a build failure because the CLI did not search `src-tauri/binaries/` for the source sidecar. The source lives at `src-tauri/llama-server-aarch64-apple-darwin` for the bundler to find it.
- **Source**: Tauri v2 bundler build error + sidecar docs
