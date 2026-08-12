## Context

Floo Network currently has basic word autocomplete via CodeMirror's `@codemirror/autocomplete` (dropdown-style, `completeAnyWord` at FileEditorPane.tsx:390). The code-editor spec explicitly planned for a "Completion-interface seam for future FIM model" but v1 shipped with no FIM implementation. The socrata-v1-flash model (fine-tuned Qwen3.5-0.8B for FIM) is validated and performs excellently (67ms TTFT, ~200 tokens/sec). The user needs to package Floo Network for distribution, requiring the model and inference engine to be bundled in the app rather than stored in user-writable locations. (D5, D12, D16)

## Goals / Non-Goals

**Goals:**

- Bundle the 540MB Qwen3.5-0.8B.Q4_K_M.gguf model and llama-server binary (~10MB) in the Tauri app bundle for distribution (D17, D18, D21)
- Implement sidecar process management following the terminal.rs pattern for llama-server lifecycle (D4, D19)
- Build CodeMirror ghost text extension with Tab-to-accept (configurable keybinding) replacing dropdown-only autocomplete (D5, D40)
- Add IPC layer for completion requests with 150ms debounce and cancellation (D6, D14, D36)
- Provide settings UI with enable/disable toggle and keybinding configuration (D22, D40)
- Track telemetry (acceptance rate, TTFT) locally for performance tuning (D25)

**Non-Goals:**

- Custom model selection by users (model is bundled and fixed) (D8, D29)
- Cross-platform support beyond Apple Silicon (aarch64-apple-darwin only) (D20, D29)
- Streaming completions (single-shot FIM requests only) (D29)
- Multi-line context beyond token budget (256 prefix / 128 suffix / 32 generation) (D13, D29)
- Remote/cloud model support (local-only inference) (D29)

## Decisions

### Sidecar vs In-Process Inference (D31)

**Decision:** Use sidecar process (llama-server) instead of embedding llama.cpp directly in Rust.

**Rationale:**

- Sidecar keeps the Rust binary smaller (~10MB vs ~1GB for mistral.rs, unknown for llama.cpp in-process)
- Allows swapping inference engines without rebuilding the app
- Matches existing terminal.rs pattern for process lifecycle management
- HTTP on localhost adds ~1-5ms overhead, negligible vs 67ms TTFT

**Alternative considered:** In-process inference using `llama-cpp-2` crate. Rejected due to C++ build dependencies, larger binary size, and harder engine swapping.

### llama.cpp vs mistral.rs (D24)

**Decision:** Use llama.cpp over mistral.rs for inference engine.

**Rationale:**

- **Performance:** llama.cpp is 20-40% faster on Metal (736-1532 T/s vs 606-1116 T/s for prompt processing)
- **Bundle size:** llama.cpp binary is ~10MB vs mistral.rs ~1GB (100x smaller)
- **FIM support:** llama.cpp FIM is validated (benchmark confirmed it works); mistral.rs FIM support is unclear from docs
- **Sidecar fit:** Both work as sidecars, but llama.cpp's smaller size keeps app bundle reasonable (~550MB total vs ~1.5GB)

**Alternative considered:** mistral.rs. Rejected due to larger bundle size, unclear FIM support, and no clear performance advantage.

### Tauri Resources vs User Directory Storage (D7, D17)

**Decision:** Bundle model file in app resources via Tauri `bundle.resources`, not in user directories.

**Rationale:**

- Distribution requirement: user wants to package Floo Network for other users
- User-writable locations (Downloads, home directory) are user-deletable
- Tauri resources bundle into `.app/Contents/Resources/` on macOS (user-protected)
- No user configuration needed for model path (always use bundled resource path)

**Alternative considered:** Store in `~/.floo-network/models/`. Rejected due to distribution requirement (D16).

### Bundle Structure (D21)

**Decision:** Create `src-tauri/resources/models/` for the GGUF file and `src-tauri/binaries/` for llama-server with target triple suffix.

**Rationale:**

- Tauri expects resources in `src-tauri/resources/` and sidecars in `src-tauri/binaries/`
- Architecture suffix (`llama-server-aarch64-apple-darwin`) required by Tauri's `externalBin` feature
- This structure bundles correctly into the app during `pnpm tauri build`

### CodeMirror Ghost Text vs Dropdown (D5)

**Decision:** Build custom ViewPlugin + Decoration extension for inline ghost text, not dropdown.

**Rationale:**

- Current autocompletion() uses dropdown (completeAnyWord)
- Cursor/Devin Desktop-style completion requires inline ghost text with Option+Tab accept
- Dropdown is for multiple choices; ghost text is for single inline suggestion
- ~150 lines of CodeMirror extension code needed

**Alternative considered:** Extend existing dropdown. Rejected because it doesn't match the UX pattern (inline ghost text vs dropdown selection).

### IPC Command Signature (D36)

**Decision:** Tauri command: `complete_code(project_hash: string, file_path: string, prefix: string, suffix: string) -> Result<CompletionResponse>`

**Rationale:**

- project_hash and file_path provide context for potential future features (per-project settings, file-type-specific behavior)
- prefix/suffix are the FIM inputs (following D13 token budget)
- Response includes completion string and modelLatencyMs for telemetry (D25)
- Follows existing IPC patterns in the codebase

### Context Window Budget (D13)

**Decision:** Prefix 256 tokens, suffix 128 tokens, max generation 32 tokens.

**Rationale:**

- Benchmark shows TTFT stays under 70ms even at 1024 tokens
- RESEARCH.md suggested 256/128/32, and the model's performance supports this
- Keeps prefill under 350ms on M2+ (well under 300ms target)
- 32-token generation limits completion to function-body-level, not whole files

### Debounce and Cancellation (D14, D35)

**Decision:** 150ms debounce after last keystroke, cancel immediately on any new keystroke or cursor movement.

**Rationale:**

- Human typing pause is 200-300ms; 150ms debounce catches pauses without feeling laggy
- Cancellation prevents wasted inference when user types past the suggestion
- Only one active request per editor instance (no request queue buildup)

### Failure Handling (D23, D33, D34)

**Decision:**

- Missing bundled resources: disable completion silently, log error, show one-time toast per session
- Sidecar crash: attempt one restart; if second crash, disable for session and show toast
- Model load failure: disable completion silently, log error, show one-time toast per session

**Rationale:**

- Bundled resources should always be present in production; dev builds might be incomplete
- Graceful degradation prevents crashes
- Single restart handles transient failures; repeated crashes indicate real problems
- Toast informs user without blocking the editor

### Telemetry Storage (D25)

**Decision:** Track acceptance rate (shown/accepted/dismissed/typed-past) and TTFT p50/p99; store locally in `~/.floo-network/completion-telemetry.json`.

**Rationale:**

- RESEARCH.md recommends acceptance metrics to tune context budgets and debounce
- Local storage preserves privacy (no cloud telemetry)
- Allows performance tuning based on real usage data

## Risks / Trade-offs

**Bundle size increase (~550MB)**

- **Risk:** App bundle size increases significantly (540MB model + 10MB llama-server)
- **Mitigation:** llama.cpp was chosen over mistral.rs for smaller binary size; model is already quantized (Q4_K_M); this is acceptable for a desktop IDE

**Memory overhead (~26MB RSS)**

- **Risk:** Sidecar process adds memory overhead during runtime
- **Mitigation:** Benchmark showed 26MB CPU RSS (GPU memory not measured in RSS); this is acceptable for a desktop app; sidecar can be terminated if completion is disabled

**Distribution complexity**

- **Risk:** Bundling large binaries and model files adds complexity to the build and packaging process
- **Mitigation:** Tauri's built-in `resources` and `externalBin` features handle this; follow established patterns from Tauri docs and examples

**Apple Silicon only**

- **Risk:** Current implementation targets only aarch64-apple-darwin (Apple Silicon)
- **Mitigation:** This is an explicit non-goal (D20, D29); cross-platform support can be added later by bundling additional binaries for other architectures

**Model quality ceiling**

- **Risk:** Qwen3.5-0.8B is a generalist model, not code-specialized; completion quality may be lower than purpose-built code models
- **Mitigation:** Model is fine-tuned on commitpack dataset (92M tokens); benchmark showed syntactically correct completions; if quality is insufficient, can swap to a code-specialized model later (bundle structure supports this)

## Migration Plan

No migration needed — this is a new feature with no existing data to migrate (D38). The model is bundled (not user-configured), there's no existing completion system to replace, and the settings UI adds new controls without changing existing settings structure.

## Open Questions

None — all technical decisions have been resolved through the 40 decisions in the decision log.
