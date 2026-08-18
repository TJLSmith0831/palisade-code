## 1. Backend: async permission-answer plumbing (riskiest — do first)

- [x] 1.1 Add `PermissionAnswer` enum (`Allow`, `Deny`, `AllowSession`) and `Harness.pending_permissions: Mutex<HashMap<String, oneshot::Sender<PermissionAnswer>>>` in acp_client.rs/executor.rs.
- [x] 1.2 RED→GREEN: test that `answer_permission` for a `Prompt`-tier request registers a pending entry keyed by a fresh id and does not respond until the paired sender fires.
- [x] 1.3 RED→GREEN: test that sending `PermissionAnswer::Allow`/`Deny` through the paired sender resolves `answer_permission` to the corresponding `RequestPermissionResponse`.
- [x] 1.4 Wire the real await into `on_receive_request`'s closure (acp_client.rs:568-573), replacing the immediate `Cancelled` response for `Prompt`.

## 2. Backend: session-scoped allow-list

- [x] 2.1 RED→GREEN: test that a `HashSet<permissions::ToolKind>` local to the bridge task, once a kind is inserted, causes subsequent `Prompt`-tier requests of that kind to auto-allow without registering a new pending entry.
- [x] 2.2 Wire `PermissionAnswer::AllowSession` to insert into that set before resolving the current request as allowed.

## 3. Backend: fail-safe teardown

- [x] 3.1 RED→GREEN: test that draining `pending_permissions` for a torn-down session sends `PermissionAnswer::Deny` through every still-pending sender for that session.
- [x] 3.2 Call the drain from the existing crash/stop/leave teardown paths (`on_crash`, session close in acp_client.rs).

## 4. Backend: event + IPC surface

- [x] 4.1 Add `ExecutorEvent::PermissionRequest { id, tool_call_id, kind, command, paths }`; emit it (instead of nothing) when a `Prompt`-tier request registers a pending entry.
- [x] 4.2 Add `answer_permission_prompt(request_id, decision)` Tauri command in lib.rs, register in `generate_handler!`; missing/already-resolved id is a no-op success.
- [x] 4.3 Add `answerPermissionPrompt` wrapper in src/api.ts and the `permissionRequest` variant to the `ExecutorEvent` TS union.

## 5. Frontend: inline ToolBlock approval UI

- [x] 5.1 Extend `ToolBlock` (EventView.tsx) with a pending-approval state, matched to its tool call by `tool_call_id`, rendering Allow / Deny / "Allow for rest of session" buttons in place of the running/done/failed indicator.
- [x] 5.2 Wire each button to `answerPermissionPrompt`, clearing the pending state locally once a decision is sent.
- [ ] 5.3 Manual check: trigger a Go-mode `execute` call and confirm the turn visibly pauses on the pending ToolBlock until answered.

## 6. Frontend: icon button (Accept/Bypass)

- [x] 6.1 Add the standalone icon button to the composer's top-right corner, reading thread permission state; `IconShield` for Accept, `IconShieldOff` for Bypass.
- [x] 6.2 Wire a Mantine `Popover` confirmation on the Accept→Bypass click path only; Bypass→Accept remains a plain click.
- [x] 6.3 Remove the old `Switch`-based bypass toggle and its "· bypass" label from the executor/model dropdown menu (App.tsx:1229-1238, 1187-1188, 1225-1227).

## 7. Frontend: delete the sticky-default bug

- [x] 7.1 Delete `onToggleBypassDefault`, `getDefaultBypass`, `setDefaultBypass`, `DEFAULT_BYPASS_KEY` from App.tsx.
- [x] 7.2 Change `resolvePrefs`/the `threadPrefs` initial state so an unconfigured thread always resolves to `{ bypass: false }` rather than reading a global default.
- [x] 7.3 RED→GREEN: test that creating two threads and enabling Bypass on the first leaves the second (and any newly created third) thread in Accept mode.

## 8. Verification

- [x] 8.1 `cd src-tauri && cargo test` — full backend suite green, including new permission-plumbing tests.
- [x] 8.2 `pnpm test` — full frontend suite green, including new ToolBlock/icon-button/default tests.
- [ ] 8.3 Manual run (run-palisade-code skill): new thread starts in Accept, execute a shell command in Go mode and confirm the pending-approval prompt appears and each of Allow/Deny/Allow-for-session behaves per specs/tool-approval-prompt/spec.md scenarios.
