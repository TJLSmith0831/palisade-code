## Why

The bypass-permissions toggle is buried inside the provider-selection menu with no confirmation, and a thread's toggle can silently become the permanent default for every future thread (`onToggleBypassDefault`, App.tsx:1949) — the kind of implicit, invisible default an AI-governance or security audit would flag. Separately, Go-mode's "prompt for execute/delete" tier (D15, acp-executor-unification) has never actually prompted anyone: `acp_client.rs:357` maps `Prompt` straight to `Cancelled`, silently denying instead of asking. Both are safety-relevant gaps in an agentic IDE that edits and executes code on the user's machine.

## What Changes

- Replace the buried "Bypass permissions" `Switch` with a standalone, always-visible icon button pinned to the composer's top-right corner. Icon swaps between `IconShield` (Accept) and `IconShieldOff` (Bypass); clicking toggles directly, no menu.
- Enabling Bypass requires a small Mantine popover confirmation; disabling it (back to Accept) is a plain click.
- Delete `onToggleBypassDefault` and its silent global-default promotion. Every new, never-configured thread always defaults to Accept (bypass=false) — no global default can drift.
- Add a real approval-prompt UI: when `decide_permission` returns `Prompt`, the tool call's existing `ToolBlock` renders a pending-approval state with three actions — Allow (once), Deny, and "Allow for rest of session" (scoped to that `ToolKind` for the live session). The agent's turn stays paused until answered; if the session ends/crashes first, the request resolves to denied.
- **BREAKING** (internal only): `onToggleBypassDefault` and the `palisade:default-bypass` localStorage key are removed. No external API changes.

## Capabilities

### New Capabilities
- `tool-approval-prompt`: the inline ToolBlock approval UI and its Allow/Deny/Allow-for-session decision flow for ACP `Prompt`-tier tool calls.

### Modified Capabilities
- `executor-model-switcher`: the "Bypass-permissions toggle" requirement changes from a menu-buried `Switch` to a standalone top-right icon button with icon-swap state and a confirmation popover on enable; the "Selections persist across menu close" requirement drops the sticky-global-default behavior — new threads always default to Accept.

## Impact

- Frontend: `src/App.tsx` (icon button, popover, delete `onToggleBypassDefault`/`getDefaultBypass`/`setDefaultBypass`/`DEFAULT_BYPASS_KEY`), `src/EventView.tsx` (`ToolBlock` pending-approval state), `src/api.ts` (new `answerPermissionPrompt` wrapper).
- Backend: `src-tauri/src/acp_client.rs` (`answer_permission` becomes async, new oneshot-channel plumbing, per-session `HashSet<ToolKind>` allow-list), `src-tauri/src/lib.rs` (new `answer_permission_prompt` Tauri command + `generate_handler!` entry), `src-tauri/src/executor.rs` (new `ExecutorEvent` variant for the pending-approval notification).
- No data migration; no changes to `permissions.rs`'s `decide_permission` policy itself (D12/D15/D20 stand as-is).
