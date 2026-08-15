# Dogfood Report: Floo Network (Chat — Spec & Go modes, OpenCode big-pickle)

| Field       | Value                                                                                        |
| ----------- | -------------------------------------------------------------------------------------------- |
| **Date**    | 2026-08-12                                                                                   |
| **App URL** | http://localhost:1420 (Tauri WKWebView, MCP bridge 127.0.0.1:9223)                           |
| **Session** | floo-chat-dogfood                                                                            |
| **Scope**   | Chat feature in Spec mode and Go mode, using OpenCode agent with `opencode/big-pickle` model |
| **Agent**   | OpenCode (binary at ~/.opencode/bin/opencode, v1.15.13)                                      |
| **Model**   | opencode/big-pickle                                                                          |

## Summary

| Severity  | Count | Fixed |
| --------- | ----- | ----- |
| Critical  | 1     | 1     |
| High      | 1     | 1     |
| Medium    | 0     | 0     |
| Low       | 0     | 0     |
| **Total** | **2** | **2** |

## Fixes

### ISSUE-001 Fix: Spec-mode notification-layer enforcement

**Files changed:** `src-tauri/src/acp_client.rs`

Added `spec_mode_violation()` — a pure function that checks whether a tool call's kind violates the session's permission mode, mirroring `permissions::decide_permission` but operating on the `session/update` notification stream. When a write-kind tool call (`edit`/`delete`/`move`/`execute`, except openspec-whitelisted execute) appears in Spec mode, the notification handler:

1. Sends `session/cancel` to the agent
2. Clears the turn's text/thought buffers
3. Emits a `Crashed` event with a "Spec mode denies X tool calls" message
4. Clears the busy flag
5. Skips the normal event mapping (so the tool call isn't rendered as successful)

The per-turn `cancelled` AtomicBool prevents double-cancellation and suppresses the duplicate `Done` from the prompt response.

**Tests added:** 6 Rust unit tests in `acp_client::tests` covering edit/delete/move detection, read/search/think/fetch allowance, Go mode allowance, Bypass allowance, and openspec execute whitelisting.

**Verification:** Created a Spec-mode thread in the running app, asked the agent to edit a file via both bash and the edit tool. Both attempts were blocked with "Spec mode denies execute/edit tool calls" messages. The target file was not modified. Go mode still allows edits (verified by creating `/tmp/floo-go-test.txt`).

### ISSUE-002 Fix: Stop button + event emission

**Files changed:** `src/App.tsx`, `src-tauri/src/lib.rs`

**Frontend:** Added `onStop` callback to `ChatSurface`. When `busy` is true, the composer renders a red stop button (`data-testid="composer-stop"`) instead of the send button. The stop button calls `api.stopExecutor(sessionId)` with the live session ID for the current thread (or `null` to stop all sessions if no specific session is identified yet).

**Backend:** Updated `stop_executor` to emit a `Crashed` event with "Cancelled by user" via `app.emit("executor-event", ...)` before calling `end_session`. Without this, the frontend's event listener never received a terminal event and the busy state stayed stuck.

**Tests added:** 1 frontend test in `App.test.tsx` verifying the stop button appears when busy and calls `stop_executor` on click.

**Verification:** Created a Go-mode thread, sent a long prompt, confirmed the stop button appeared while busy, clicked it, and confirmed the busy state cleared (send button returned, composer became editable).

## Issues

### ISSUE-001: Spec mode does not prevent file edits — OpenCode auto-approves workspace writes without sending ACP permission requests

| Field           | Value                                                              |
| --------------- | ------------------------------------------------------------------ |
| **Severity**    | critical                                                           |
| **Category**    | functional / security                                              |
| **URL**         | http://localhost:1420 (Spec mode thread)                           |
| **Repro Video** | N/A (verified via direct ACP protocol probe + on-disk file change) |

**Description**

Spec mode is documented as read-only/plan: "Plan first — reach shared understanding with the agent before it writes any code." The backend `permissions::decide_permission` correctly auto-denies `ToolKind::Edit` in `PermissionMode::Spec`. **However, OpenCode never sends a `session/request_permission` notification for edits inside the project workspace** — it auto-approves them internally and just performs the write. As a result, Floo's permission gate is never consulted, and the agent edits files freely in Spec mode.

Observed during dogfood: the OpenCode/big-pickle agent in Spec mode appended decision entries D41–D44 to `openspec/explore/socrata-fim-completion.md` (an EDIT tool block appeared in the chat, and the file changed on disk at 06:31 CDT, 2026-08-12). The backend log contained zero `permission` / `deny` / `cancel` entries.

Verified the root cause with a direct ACP probe (`python3 probe_opencode_perm2.py`): a prompt asking the agent to append a line to a file **inside** the project produced **0 `session/request_permission` notifications** and the prompt completed with `stopReason: "end_turn"` — the file was modified. The same prompt targeting `/tmp/` (outside the project) produced a permission request with `kind: "other"`, title `"external_directory"`. So OpenCode treats workspace writes as not requiring permission.

Floo's `acp_client.rs` does not call ACP `session/set_mode` (the protocol's native mode-switching mechanism), and OpenCode's `session/new` response advertises no `modes` field — so the only enforcement path available is the `session/request_permission` flow, which OpenCode bypasses for in-project edits.

**Repro Steps**

1. Start Floo Network with OpenCode as the executor and `opencode/big-pickle` as the model.
2. Create a new thread and pick **Spec** mode.
3. Send a prompt asking the agent to edit a file inside the project (e.g., "Append the line 'MARKER' to openspec/explore/socrata-fim-completion.md").
4. Observe: the agent performs the edit; an `EDIT` tool block appears in the chat; the file changes on disk. No permission denial occurs.

**Expected**: Spec mode prevents file edits; the agent's edit attempt is denied (or never sent).
**Actual**: The agent edits files freely; Floo's permission gate is never consulted because OpenCode doesn't emit `session/request_permission` for in-project writes.

**Root cause**: `src-tauri/src/acp_client.rs` relies entirely on `session/request_permission` notifications to enforce mode permissions, but OpenCode auto-approves workspace writes internally and never sends those notifications for in-project edits. ACP `session/set_mode` is not used, and OpenCode doesn't advertise session modes anyway.

**Fix direction** (for TDD below): Since OpenCode won't ask permission for workspace writes, Floo must enforce Spec mode at the `session/update` notification layer — when a `session/update` carries a tool call whose `kind` is `edit`/`delete`/`move` and the session mode is `Spec`, Floo should (a) cancel the in-flight prompt and (b) emit a `Crashed`/denied event to the frontend. Alternatively, intercept the `ToolCallUpdate`/`ToolCall` notification and send `session/cancel` when a Spec-mode session attempts a write tool call.

### ISSUE-002: No stop/cancel button while the agent is busy — `stopExecutor` API exists but is never wired to the UI

| Field           | Value                                                    |
| --------------- | -------------------------------------------------------- |
| **Severity**    | high                                                     |
| **Category**    | functional / ux                                          |
| **URL**         | http://localhost:1420 (any busy thread, Spec or Go mode) |
| **Repro Video** | N/A (absence — verified by DOM inspection while busy)    |

**Description**

CLAUDE.md states "Stopping is per session" and the backend exposes a `stop_executor` IPC command (`src/api.ts:215`: `stopExecutor(sessionId?)`). The `SessionRecord.outcome` type even includes `"cancelled"` and `"interrupted"`. **But the frontend never calls `stopExecutor` anywhere** — `grep stopExecutor src/App.tsx` returns zero matches — and there is no stop/cancel/interrupt button rendered while a turn is in flight. While the agent is busy the composer's send button is disabled and the mode selector is disabled, leaving the user with no way to abort a runaway or unwanted turn short of quitting the app.

Verified during dogfood: started a Go-mode turn ("Count from 1 to 20…"), and while `sendDisabled === true`, searched the entire DOM for any visible button whose aria-label/title/text matched `/stop|cancel|interrupt|halt|abort/i` — zero matches. The only escape is to wait for the agent to finish or kill the app.

**Repro Steps**

1. Start any thread (Spec or Go), send a prompt that takes a few seconds.
2. While the agent is busy (send button disabled), scan the toolbar/composer area for a stop button.
3. Observe: no stop control exists. The user cannot cancel the in-flight turn.

**Expected**: A stop/cancel button appears in the composer area while `busy === true`, calling `api.stopExecutor(currentSessionId)`.
**Actual**: No stop control; `stopExecutor` is dead code in the API wrapper.

**Root cause**: `src/App.tsx` imports and wires `sendExecutor`/`goMode`/`specMode`/`propose`/`applySkill` but never imports `stopExecutor`. The ChatSurface receives `busy` but renders only the send ActionIcon, never a stop ActionIcon when busy.
