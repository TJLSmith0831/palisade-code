## Why

The model and bypass controls in the top chrome are stored client-side but do not reach the executor, so the menu reads as decorative and the "not yet wired to the executor" copy advertises an unimplemented feature. This change makes the preferences functional, scopes them to the active thread, and moves them to the composer where the user chooses settings for the next turn.

## What Changes

- Wire the selected model to the executor's `--model` flag on the next new session.
- Wire the bypass toggle to the executor-specific "skip approvals" flag on the next new session.
- Move the model and bypass controls from the top chrome into the active thread's composer bar.
- Support a per-thread model/bypass override with a global default fallback.
- Remove the "Stored preference — not yet wired to the executor" hint from the UI.
- Add Rust and frontend tests for the new preference propagation.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `executor-model-switcher`: the model and bypass selections are no longer display-only; they determine the flags used to spawn the next session and are scoped to the active thread.

## Impact

- `src/App.tsx` and `App.css`: chrome control removed, composer control added.
- `src/api.ts`: new preference-settling commands or new `sendMessage`/`go_mode` parameters.
- `src-tauri/src/executor.rs`: `SpawnCtx` and agent `args` consume model and bypass.
- `src-tauri/src/lib.rs`: `start_session` and commands receive and forward preferences.
- `src-tauri/src/store.rs`: if thread overrides are stored server-side instead of localStorage; otherwise `localStorage` pattern in `App.tsx`.
- `openspec/specs/executor-model-switcher/spec.md`: delta spec for the new behavior.
