## 1. Rust — spawn context and agent args

- [x] 1.1 Add `model: Option<String>` and `bypass: bool` to `SpawnCtx` in `src-tauri/src/executor.rs`
- [x] 1.2 Append `--model <alias>` to the `CLAUDE` `args` closure when `model` is present
- [x] 1.3 Append `--model <value>` to the `CODEX` `args` closure when `model` is present
- [x] 1.4 Append `--dangerously-skip-permissions` to `CLAUDE` `args` when `bypass` is true
- [x] 1.5 Append `--dangerously-bypass-approvals-and-sandbox` to `CODEX` `args` when `bypass` is true
- [x] 1.6 Update `executor.rs` tests (`args_of` helpers) to cover the new flags

## 2. Rust — commands and session start

- [x] 2.1 Add `model` and `bypass` parameters to `send_message`, `go_mode`, and `propose` Tauri commands
- [x] 2.2 Forward resolved preferences from `ensure_session` / `start_session` into `executor::start`
- [x] 2.3 Update `src-tauri/src/lib.rs` inline tests for the new command signatures

## 3. Frontend — API and thread-level state

- [x] 3.1 Add `model` and `bypass` arguments to `api.sendMessage`, `api.goMode`, and `api.propose` in `src/api.ts`
- [x] 3.2 Implement per-thread `localStorage` helpers for `floo:thread-prefs:<projectHash>:<threadId>`
- [x] 3.3 Resolve the effective model/bypass for the active thread before each session-starting call
- [x] 3.4 Remove the `selectedModel` and `bypassEnabled` chrome state from `src/App.tsx`
- [x] 3.5 Add the new composer control to the active thread's chat input area

## 4. Frontend — UI and tests

- [x] 4.1 Remove the top-chrome `Menu` and `Switch` for model/bypass
- [x] 4.2 Render a pop-up model dropdown and bypass toggle in the composer
- [x] 4.3 Show "Next session will use X" hint after a preference change while a session is live
- [x] 4.4 Disable or hide the model picker when the detected executor is Codex
- [x] 4.5 Update existing `executor-model-switcher` tests and add new tests for the composer control
- [x] 4.6 Run `pnpm test` and `cd src-tauri && cargo test` to verify

## 5. Spec sync

- [x] 5.1 Run `openspec validate --change thread-executor-preferences`
- [x] 5.2 Apply the change (`/opsx:apply` or `openspec-apply-change`) when implementation is complete
