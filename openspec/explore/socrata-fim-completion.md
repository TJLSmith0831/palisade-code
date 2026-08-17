# Socrata-v1-Flash FIM Completion Integration

**Topic:** Integrate socrata-v1-flash model for AI-powered autocompletion in Palisade Code
**Date:** 2026-08-12
**Status:** Exploration started

## Context

User has model files in Downloads (socrata-v1-flash, a fine-tuned Qwen3.5-0.8B model for FIM completion). Goal: Cursor/Devin Desktop-style inline code completion with ghost text and Tab to accept.

Existing research in RESEARCH.md covers model assessment, training data, inference engine options, latency budgets, and CodeMirror 6 integration requirements.

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

## D22: Settings UI for completion (REVISED)

- **Decision**: Add enable/disable toggle to settings panel; remove model path configuration (no longer user-configurable)
- **Why**: Model is bundled, so users only need to turn completion on/off. Advanced model selection is a future feature.
- **Source**: D17 + D18 (bundled approach)

## D23: Error handling for missing bundled resources

- **Decision**: If bundled model or llama-server binary is missing, disable completion silently and log error; show one-time toast per session
- **Why**: Bundled resources should always be present in production, but dev builds might be incomplete. Graceful degradation prevents crashes.
- **Source**: codebase error handling patterns

## D16: Distribution requirement - model bundling

- **Decision**: Model must be bundled with the app for distribution, not stored in user-writable locations
- **Why**: User wants to package Palisade Code for other users; Downloads or home directory locations are user-deletable. Need model embedded in app bundle or sidecar.
- **Source**: user

## D17: Tauri resources feature for model bundling

- **Decision**: Use Tauri's built-in `resources` feature to bundle the model file in the app bundle
- **Why**: Tauri supports bundling large files via `bundle.resources` in tauri.conf.json; at runtime, use `app.path().resolve("path", BaseDirectory::Resource)` to get the bundled file path. On macOS, resources live in `.app/Contents/Resources/` (user-protected).
- **Source**: Tauri docs (v2.tauri.app/develop/resources/) + web search results

## D18: llama-server as Tauri sidecar binary (AMENDED — premise invalidated by D41)

- **Decision**: Bundle llama-server as a Tauri sidecar using `externalBin`, not embedded in the Rust binary. Still stands as the *shape*; the "pre-built static binary" premise does not.
- **Why**: `externalBin` is still the right mechanism, but the "~10MB pre-built static binary" claim was wrong (see D41). The binary must be produced as a genuinely static build for `externalBin` to work as a single file.
- **Source**: web search (superseded on the static claim by D41's `otool` verification)

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

## D24: Engine choice - llama.cpp vs mistral.rs comparison

- **Decision**: Stick with llama.cpp over mistral.rs for this use case
- **Why**:
  - **Performance**: llama.cpp is faster on Metal (Apple Silicon) - benchmarks show llama.cpp 736-1532 T/s vs mistral.rs 606-1116 T/s for prompt processing
  - **Bundle size**: llama.cpp binary is ~10MB vs mistral.rs ~1GB (10x smaller)
  - **FIM support**: llama.cpp FIM is validated (benchmark confirmed it works); mistral.rs FIM support is unclear from docs
  - **Sidecar pattern**: Both work as sidecars, but llama.cpp's smaller size keeps app bundle reasonable
- **Source**: web search (GitHub issue #903 tracking Metal performance, mistral.rs releases showing 1GB binaries, llama.cpp releases showing 10MB binaries)

## D25: Telemetry scope

- **Decision**: Track acceptance rate (shown/accepted/dismissed/typed-past) and TTFT p50/p99; store locally in `~/.palisade-code/completion-telemetry.json`
- **Why**: RESEARCH.md recommends acceptance metrics to tune context budgets and debounce; local storage preserves privacy
- **Source**: RESEARCH.md Phase 5 tuning section

## D41: Prebuilt llama-server is NOT a single static binary (RESOLVED)

- **Decision**: Homebrew's llama-server dynamically links six non-system dylibs — four via `@rpath` (`libllama-server-impl`, `libllama-common.0`, `libmtmd.0`, `libllama.0`) and two via absolute Homebrew paths (`/opt/homebrew/opt/ggml/lib/libggml.0.dylib`, `libggml-base.0.dylib`), plus Homebrew OpenSSL — so it cannot be used as an `externalBin`. Resolved by switching to the static build from the `batiai/llamacpp-server-macos` Hugging Face repo. D18's sidecar shape stands; only the "prebuilt binary" source changed.
- **Why**: `otool -L $(which llama-server)` verified the dylib problem; `otool -L /tmp/llama-server-macos-arm64` verified the replacement links only system frameworks (Accelerate, Metal, MetalKit, Foundation, CoreFoundation, libSystem, libc++, libobjc). Static binary benchmarked at parity (66–67ms TTFT vs 67–70ms).
- **Source**: codebase (`otool -L` on both binaries) + `benchmark-static-server.sh`

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

## D45: Static binary exists only in `/tmp`, with no recorded provenance

- **Decision**: The verified static llama-server lives at `/tmp/llama-server-macos-arm64` (19.7MB) and nothing in the repo records where it came from — no URL, no revision, no checksum. `/tmp` is cleared on reboot, so the D41 fix is currently one restart away from being unreproducible.
- **Why**: A third-party binary shipped to other users needs a pinned source and a hash to verify against, both for reproducibility and because `batiai/llamacpp-server-macos` is an unofficial build.
- **Source**: codebase (`ls -la /tmp/llama-server-macos-arm64`, `benchmark-static-server.sh:8`)

## D46: Bundle payload is ~537MB

- **Decision**: Model `Qwen3.5-0.8B.Q4_K_M.gguf` is 516.8MB; static llama-server is 19.7MB. Bundling both (D17 + D18) adds ~537MB to a `.app` whose only bundle target today is `["app"]` — no DMG, no updater.
- **Why**: Sizes the distribution problem concretely; D24's "~10MB binary keeps the app bundle reasonable" was reasoning about the wrong order of magnitude, since the model dominates.
- **Source**: codebase (`ls -la ~/Downloads/socrata-v1-flash/gguf_q4_k_m_gguf/`, `/tmp/llama-server-macos-arm64`, `src-tauri/tauri.conf.json`)

## D47: There is no git remote, no LFS, and no `.gitattributes`

- **Decision**: `git remote -v` is empty, `git lfs` is not installed, `.gitattributes` does not exist, and neither `.gitignore` mentions `resources/`, `binaries/`, `models/`, or `*.gguf`. D21's "copy the model into `src-tauri/resources/`" would therefore commit 537MB into git history by default.
- **Why**: A 516MB blob in history is permanent and would exceed GitHub's 100MB per-file hard limit the moment a remote is added. Also means D16's "package for other users" currently has no delivery channel at all.
- **Source**: codebase (`git remote -v`, `git lfs env`, `.gitignore`)

## D48: Sidecar codesigning is already covered for the self-signed path

- **Decision**: No new signing work is needed for the local/self-signed flow — `package.sh:112` runs `codesign --force --deep --identifier "$BUNDLE_ID" --sign "$CODESIGN_ID"`, and `--deep` signs the nested sidecar Mach-O in `Contents/MacOS/`. This partially answers the codesigning gap D43 flagged.
- **Why**: Avoids inventing signing steps that already exist. Caveat kept open: `--deep` is Apple-deprecated and insufficient for notarized distribution, which needs inside-out signing plus entitlements.
- **Source**: codebase (`package.sh:112`, `package.sh:132-133`)

