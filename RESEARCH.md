# RESEARCH: Local FIM Code Completion for Palisade Code

**Status:** Research phase — model still training
**Date:** 2026-08-09
**Model:** Socrata-v1-Flash (fine-tune of `unsloth/Qwen3.5-0.8B-GGUF`)
**Goal:** Copilot-style inline code completion (ghost text, Tab to accept) running locally inside the Tauri app

---

## 1. Model Assessment: Qwen3.5-0.8B

### What it actually is

`unsloth/Qwen3.5-0.8B-GGUF` is a GGUF quantization of Qwen3.5-0.8B, which is part of Qwen's 3.5 family (released ~March 2026). Key characteristics:

- **Multimodal vision-language model** — has a vision encoder, trained with early-fusion on multimodal tokens. Not a text-only code model.
- **Hybrid architecture:** Gated DeltaNet (linear attention) + Gated Attention, not a standard transformer. 16 linear attention heads (V/QK, dim 128) + 8 attention heads Q / 2 KV (dim 256, RoPE dim 64).
- **0.8B parameters**, 24 layers, 262K native context
- **Apache 2.0** license
- Supports "thinking" and "non-thinking" modes (non-thinking is default for 0.8B)
- Can run text-only by skipping the vision encoder (`--language-model-only` in vLLM)

### Red flags for FIM code completion

1. **It's multimodal, not code-specialized.** The vision encoder weights and multimodal training are wasted overhead for a text-only FIM task. Qwen2.5-Coder-0.5B is purpose-built for code, text-only, and has native, well-documented FIM token support (`<|fim_prefix|>`, `<|fim_suffix|>`, `<|fim_middle|>`).

2. **Hybrid Gated DeltaNet architecture has uncertain inference engine support.** llama.cpp, mistral.rs, and candle have heavily optimized kernels for standard Qwen2/Qwen3 transformer architectures. A Gated DeltaNet + Gated Attention hybrid may not have optimized Metal kernels yet, which could mean slower inference or compatibility gaps in the GGUF/quantized path. **This needs to be tested before committing.**

3. **No documented native FIM support.** Qwen2.5-Coder has explicit, documented FIM token format. Qwen3.5-0.8B's model card focuses on multimodal reasoning, coding, and tool calling — there's no mention of FIM tokens. The fine-tune would need to establish FIM behavior from scratch rather than preserving it.

### What this means for the fine-tune (Socrata-v1-Flash)

The fine-tune is doing heavy lifting: teaching a multimodal generalist model to behave as a specialized FIM engine. This can work — FIM is fundamentally a prompt format + loss masking pattern — but the base model's code understanding ceiling may be lower than a purpose-built code model's. The training data quality and volume become the deciding factor.

**Recommendation:** Benchmark Socrata-v1-Flash against Qwen2.5-Coder-0.5B (base, no fine-tune) on FIM tasks once training completes. If the fine-tune doesn't meaningfully beat the purpose-built code model, the base choice should be reconsidered.

---

## 2. Training Data Assessment

### Dataset: TIGER-Lab/FIM-Midtraining-400K

**Could not verify this dataset exists.** Searched HuggingFace and the web; found TIGER-Lab/VISTA-400K and TIGER-Lab/MMLU-Pro, but no dataset named "FIM-Midtraining-400K" in TIGER-Lab's public catalog. Possibilities:
- The name is slightly off (check exact HF ID)
- It's a private or custom-assembled dataset
- It's a configuration/subset of another dataset

**Action required:** Verify the exact HuggingFace dataset ID and URL. If it's custom, document its composition.

### Training approach (as described by the user)

- **Format:** Native Qwen FIM sequences (`<|fim_prefix|>` / `<|fim_suffix|>` / `<|fim_middle|>`)
- **Loss:** Concentrated on the missing completion (middle), not the prefix/suffix
- **Data shape:** `single_function` configuration — real functions with body masked
- **Scale plan:** 100M tokens (pilot) → 250M → 500M → 1B, scaling only if eval justifies

This is a sound FIM training methodology. The loss masking on the middle token is correct. The function-level masking approach is appropriate for IDE completion (completes within a function body, not across files).

### Completion length targets (user's stated expectations)

| Token range | Expected quality |
|-------------|-----------------|
| 1–10 | Excellent |
| 10–50 | Excellent |
| 50–150 | Good |
| 150–300 | Useful but inconsistent |
| 300+ | Increasingly unreliable |
| Whole functions | Not the primary objective |

These are realistic for a 0.8B FIM-specialized model. The "FIM engine, not coding model" framing is the right mental model.

---

## 3. Inference Engine: Rust Runtime, Not Rust Inference

### Clarification from the user

The user clarified: "Not the language model, how it runs locally." The intent is Rust for the **local runtime/deployment mechanism** (process management, IPC, app integration), not a claim that Rust makes the model itself faster. This is a reasonable distinction.

### Engine options for Apple Silicon

| Engine | Language | Metal support | Qwen3.5 hybrid arch | Notes |
|--------|----------|--------------|---------------------|-------|
| **llama.cpp** | C++ | Excellent, most optimized | **Unknown — needs testing** | Fastest Metal kernels, most mature |
| **mistral.rs** | Rust | Good (candle-based) | **Unknown — needs testing** | Rust-native, OpenAI-compatible server, embeddable |
| **candle (raw)** | Rust | Good | **Unknown — needs testing** | Lower-level, more integration work |
| **MLX** | Python/Swift | Best on Apple Silicon | **Unknown — needs testing** | Apple's own framework, not Rust |
| **Ollama** | Go (llama.cpp) | Via llama.cpp | If GGUF converts | HTTP overhead for single-query |

**Critical unknown:** None of these engines have confirmed support for the Gated DeltaNet + Gated Attention hybrid architecture in Qwen3.5. Standard Qwen2/Qwen3 transformer architectures are well-supported; this hybrid is new and may require engine updates or may have unoptimized kernels.

**Action required before any app integration:** Test that the GGUF loads and produces correct output in at least one engine (start with llama.cpp, since Unsloth's model card provides llama.cpp instructions). Measure tokens/sec and TTFT.

### Recommended architecture: Sidecar process

Run the inference engine as a **local sidecar process** managed by the Rust backend, not embedded in the Tauri binary.

**Why:**
- Model stays loaded in memory across app restarts (no reload wait)
- Can use llama.cpp (fastest kernels) without a C++ build dependency in the Tauri crate
- Engine is swappable without rebuilding the app
- HTTP on localhost adds ~1-5ms — negligible vs. 400ms+ inference time
- Palisade Code already has process management patterns (`executor.rs` spawns/manages CLI processes)

**Flow:**
1. App startup → Rust backend spawns `llama-server` or `mistralrs serve` with the GGUF, Metal enabled, on `127.0.0.1:<port>`
2. User types in CodeMirror → debounce 150ms → extract prefix/suffix
3. Frontend calls Tauri IPC `complete_code(prefix, suffix)`
4. Rust backend POSTs to local server's `/completion` endpoint with FIM-formatted prompt
5. Rust backend returns completion string
6. Frontend renders as ghost text in CodeMirror

### If in-process is required: `llama-cpp-2` crate

If everything must be in one binary with no sidecar, use the `llama-cpp-2` crate (Rust bindings to llama.cpp) with the `metal` feature. This gives llama.cpp's kernel quality inside a Rust API. Do **not** use raw candle — there's a known bug (candle issue #3410) where Qwen2.5-Coder GGUF produces degraded output due to a wrong RoPE convention for NEOX-style models.

---

## 4. Latency Budget

### Industry benchmarks

- **GitHub Copilot:** acceptance rate collapses after ~400ms TTFT (time-to-first-token)
- **Cursor:** targets sub-100ms for ghost text
- **Human typing pause:** 200-300ms between keystrokes — if suggestion arrives after 500ms, user has typed past it
- **Cancellation propagation:** <10ms from IDE signal to GPU preemption (industry target)

### Estimated performance for 0.8B at Q4_K_M on Apple Silicon

Based on Qwen2.5-Coder-0.5B benchmarks (the closest available proxy — 0.8B will be somewhat slower):

| Metric | M2 (16GB) | M4 (24GB) | Notes |
|--------|-----------|-----------|-------|
| Decode speed | ~180-216 tok/s | ~220-259 tok/s | After first token |
| Prefill speed | ~1000-1500 tok/s | ~1200-1800 tok/s | Prompt processing |
| Memory (Q4_K_M) | ~1.5-2.0 GB | ~1.5-2.0 GB | Weights + KV cache |

**TTFT breakdown for a typical request (300 tokens prefix + 150 suffix = 450 token prompt):**
- Prefill: 450 tokens / 1200 tok/s = **~375ms**
- First token decode: **~5ms**
- **Total TTFT: ~380ms** — right at the acceptance cliff

**For 20-token completion generation:**
- 20 tokens / 200 tok/s = **~100ms**
- **Total request time: ~480ms**

### What this means

The model is viable but the margin is thin. To stay under 400ms TTFT:
- Keep FIM context **short** (200-400 tokens of prefix+suffix, not the full file)
- Use **prefix caching** so repeated keystrokes don't re-process the same prefix
- **Debounce** 150ms after last keystroke before firing
- **Cancel** in-flight requests on any new keystroke
- Generate **few tokens** (10-30 max) per request
- Consider **speculative decoding** if the engine supports it (small draft model proposes, main model verifies in one forward pass)

---

## 5. Good Performance Targets for This Model Class

For a 0.8B FIM-specialized model on Apple Silicon (M2+):

| Metric | Target | Acceptable | Unacceptable |
|--------|--------|------------|--------------|
| TTFT (p50) | <150ms | <300ms | >400ms |
| TTFT (p99) | <300ms | <500ms | >800ms |
| Completion generation (20 tokens) | <100ms | <150ms | >250ms |
| Total request (TTFT + 20 tokens) | <250ms | <450ms | >650ms |
| Memory footprint | <2GB | <3GB | >4GB |
| Model load time (cold start) | <3s | <8s | >15s |
| Acceptance rate (user tabs to accept) | >25% | >15% | <10% |

**Context window budget per request:**
- Prefix: 256 tokens (last ~200-300 lines of context before cursor)
- Suffix: 128 tokens (next ~100-150 lines after cursor)
- Total prompt: ~384 tokens
- Max generation: 32 tokens (hard stop)
- This keeps prefill under 350ms on M2+

**Debounce and cancellation:**
- Debounce: 150ms after last keystroke
- Cancel: immediately on any new keystroke or cursor movement
- Min trigger: only fire if cursor is at end of a line or after a non-whitespace character (avoid firing mid-word)

---

## 6. Frontend Integration: CodeMirror 6

### Current state

`FileEditorPane.tsx` uses CodeMirror 6 with `@codemirror/autocomplete`. The current completion setup (line 388):

```typescript
autocompletion({ override: [completeAnyWord] }),
```

This is a **dropdown** completer (word completion). Copilot-style greyed inline "ghost text" is **not** supported by `@codemirror/autocomplete` — it only does dropdown completions.

### What needs to be built

A custom CodeMirror 6 `ViewPlugin` + `Decoration` extension for inline ghost text. This is approximately 150 lines of CodeMirror extension code. The extension needs to:

1. **Render greyed inline text** at the cursor position as a decoration
2. **Tab to accept** — insert the ghost text into the document
3. **Escape / any keystroke to dismiss** — clear the decoration
4. **Cancel on cursor move** — clear if cursor leaves the completion position
5. **Cancel in-flight requests** — abort the IPC call if user types before completion arrives

### Integration point

The `override` array in `autocompletion()` is where an async FIM completion source plugs in. Replace `completeAnyWord` with a source that:
1. Extracts prefix (text before cursor) and suffix (text after cursor)
2. Calls Tauri IPC `complete_code(prefix, suffix)`
3. Returns the completion as a dropdown option OR feeds it to the ghost text plugin

For ghost text specifically, the `autocompletion` dropdown is not the right UX — a custom `ViewPlugin` is needed. The dropdown is for multiple choices; ghost text is for a single inline suggestion.

### IPC wiring (three edits per CLAUDE.md)

A new `complete_code` Tauri command requires:
1. The `#[tauri::command]` fn in `lib.rs` (or a new `completion.rs` module)
2. Its name in `generate_handler!` at `lib.rs:1538`
3. A wrapper in `src/api.ts`

---

## 7. Implementation Priorities

### Phase 0: Validate the model (before any app code)

1. Download `unsloth/Qwen3.5-0.8B-GGUF` (UD-Q4_K_XL quantization)
2. Run `llama-server --model <gguf> --metal --port 8080`
3. POST a FIM-formatted prompt to `/completion`:
   ```
   <|fim_prefix|>def calculate_total(items):
       total = 0
       for item in items:
   <|fim_suffix|>
       return total
   <|fim_middle|>
   ```
4. Measure: Does it load? Does it produce correct output? What's the TTFT? What's tok/s?
5. **If the hybrid architecture isn't supported by llama.cpp**, test mistral.rs and MLX. If none work, the model choice needs to be reconsidered.

### Phase 1: Standalone inference benchmark

1. Script that fires FIM requests at varying context lengths (100, 256, 512, 1024 tokens)
2. Measure TTFT, tok/s, total request time at each context length
3. Determine the max context that stays under 400ms TTFT
4. This defines the prefix/suffix budget for the app

### Phase 2: CodeMirror ghost text extension

1. Build the `ViewPlugin` + `Decoration` extension (~150 lines)
2. Greyed inline text at cursor, Tab to accept, Escape to dismiss
3. Cancel on cursor move or new keystroke
4. Test with a mock completion source (static text) before wiring IPC

### Phase 3: IPC wiring

1. `complete_code` Tauri command (three edits: command fn, `generate_handler!`, `api.ts`)
2. Rust backend POSTs to local inference server
3. Debounce + cancellation logic in the frontend
4. Replace mock completion source with the IPC-backed source

### Phase 4: Sidecar process management

1. Rust backend spawns/manages the inference server process on app startup
2. Health check (is the server responding?)
3. Graceful shutdown on app quit
4. Model path configuration (settings panel)

### Phase 5: Tuning

1. Adjust prefix/suffix token budgets based on real TTFT measurements
2. Tune debounce delay (start at 150ms, adjust based on feel)
3. Tune max generation length (start at 32 tokens, adjust based on acceptance rate)
4. Add prefix caching if the engine supports it
5. Add acceptance metrics logging (shown / accepted / dismissed / typed past)

---

## 8. Open Questions

1. **Does llama.cpp support Qwen3.5's Gated DeltaNet + Gated Attention architecture?** This is the biggest unknown. If not, the model may need to be converted to a standard architecture or a different base model chosen.
2. **Does Qwen3.5-0.8B have native FIM tokens, or is the fine-tune establishing them from scratch?** If from scratch, the FIM token IDs need to be added to the tokenizer and the model needs to learn the pattern purely from training data.
3. **What is the exact HuggingFace ID for "TIGER-Lab/FIM-Midtraining-400K"?** Could not verify this dataset exists under that name.
4. **Does the GGUF conversion preserve the hybrid architecture correctly?** Unsloth provides GGUF files, but quantized inference correctness for hybrid architectures is not guaranteed.
5. **What hardware is the target?** M1 (8GB) is the minimum viable; M2+ (16GB) is comfortable. The latency targets above assume M2+.
6. **Should the model run text-only (skip vision encoder)?** Qwen3.5 supports `--language-model-only` in vLLM. The GGUF may already exclude vision weights, or may need explicit configuration. This affects memory footprint and load time.

---

## 9. Honest Summary

### What works
- FIM is the correct approach for IDE code completion
- The training methodology (FIM-formatted, loss on middle, function-level masking) is sound
- The completion length targets (1-150 tokens) are realistic for 0.8B
- Sidecar process architecture fits Palisade Code's existing patterns
- The "FIM engine, not coding model" framing is the right mental model

### What's at risk
- **Qwen3.5-0.8B is multimodal with a hybrid architecture** — inference engine support is unconfirmed, and it's not a code-specialized base. Qwen2.5-Coder-0.5B would be a safer, purpose-built alternative.
- **Latency is tight** — 400ms TTFT is the acceptance cliff, and a 0.8B model with 450 tokens of context will land right around it. Prefix caching and short context are mandatory.
- **CodeMirror ghost text doesn't exist** — it's ~150 lines of custom extension code, not a drop-in package.
- **The training dataset couldn't be verified** — confirm the exact HuggingFace ID.

### What to do first
**Benchmark the model standalone before writing any app code.** If llama.cpp can't load the GGUF or the TTFT is over 500ms with a realistic context window, the plan needs to change before any integration work is invested.
