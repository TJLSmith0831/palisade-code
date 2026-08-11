## Context

See `proposal.md` for the motivation. Today the model and bypass controls in `src/App.tsx` are pure client state (`localStorage`) and never reach `src-tauri/src/executor.rs`. `executor.rs` builds argv from `SpawnCtx` without model or bypass fields. The design below threads the preferences through `SpawnCtx` and moves the UI to the composer.

## Goals / Non-Goals

**Goals:**
- Wire the selected model and bypass to the next new session's executor argv.
- Move the model/bypass control from the top chrome into the active thread's composer.
- Support per-thread overrides with a global default.
- Keep the existing spec/go concurrency and resume semantics unchanged.

**Non-Goals:**
- Re-wiring or restarting the currently live session when the user toggles a preference.
- Full Codex model-list support; the current three labels are Claude-only for now.
- Changing how the executor is auto-detected.

## Decisions

1. **Preferences travel through `SpawnCtx`.** `executor::SpawnCtx` gains `model: Option<String>` and `bypass: bool`; each agent's `args` closure appends the matching CLI flag. This keeps the per-agent flag mapping in one place (the `Agent` table) rather than branching in `lib.rs`.
2. **Per-thread override in `localStorage`.** A thread's model and bypass are stored under `floo:thread-prefs:<projectHash>:<threadId>`. New threads fall back to `floo:default-model` and `floo:default-bypass`. The backend does not need to know the storage scheme; the frontend resolves the effective value before each `sendMessage`/`go_mode`/`propose` call and passes it to the Rust command.
3. **Frontend passes resolved preferences on every session-starting command.** `sendMessage`, `go_mode`, and `propose` add `model` and `bypass` parameters. The backend applies them only when it starts a new session; if it reuses a live session, the parameters are ignored.
4. **Claude aliases for the model list.** `Sonnet 5` → `sonnet`, `Opus 5` → `opus`, `Haiku 4.5` → `haiku`. The actual CLI accepts these aliases and resolves them to the latest named model. Codex model selection is deferred because the current UI names do not map to Codex model IDs.
5. **Bypass per-executor mapping.** Claude uses `--dangerously-skip-permissions`; Codex uses `--dangerously-bypass-approvals-and-sandbox`. This is a deliberate security trade-off: bypass means different things to each CLI, so the harness follows each CLI's documented flag rather than inventing a unified concept.

## Risks / Trade-offs

- **[Risk]** A user toggles bypass mid-thread and expects the live session to become unrestricted. → **Mitigation**: show a hint such as "Next session will use bypass" and never restart a live session.
- **[Risk]** The `claude` or `codex` CLI changes its flag names. → **Mitigation**: model and bypass flags are configured in the `Agent` table in `executor.rs`; one central edit per flag change.
- **[Risk]** Codex users see a Claude-only model list. → **Mitigation**: disable the model picker when `codex` is the selected executor, or display a "not available for Codex" hint.
- **[Trade-off]** `localStorage` for per-thread overrides is quick but not shared across machines. This is acceptable for a desktop Tauri app where each machine has its own local state.
