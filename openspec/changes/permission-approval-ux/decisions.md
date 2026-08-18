# Explore: permission approval UX (bypass fix + real approval prompt)

## D1: Scope is a targeted fix, not a 5-mode redesign
- **Decision**: Keep Spec/Go as the primary mode axis (Spec≈Plan, Go≈Auto/AcceptEdits per prior D15). Do not build a Claude-Code-style 5-way Mode dropdown. Fix defaults/bugs and add a real approval-prompt UI within the existing structure.
- **Why**: User's actual complaint is the default/bypass-safety issue and a missing approval UI, not the mode-selector shape. D15 (archived acp-executor-unification) already mapped spec/go/bypass to industry's plan/accept-edits/bypass tiers.
- **Source**: user

## D2: Bypass control becomes an icon button (IconShieldOff), minimal visual change
- **Decision**: Replace/augment the current buried `Switch` ("Bypass permissions") with an icon button using Tabler's `IconShieldOff`.
- **Why**: User wants a minimal visual footprint, not a redesign.
- **Source**: user
- **Open**: exact interaction model (toggle vs menu) and icon state semantics — still being grilled.

## D3 (harvested bug): Prompt decisions are currently silently denied
- **Decision**: N/A yet — documenting the defect. `acp_client.rs:357-358` maps `PermissionDecision::Prompt` to `RequestPermissionOutcome::Cancelled` with no user-facing UI. Go-mode's execute/delete "prompt" tier (D15) has never actually prompted anyone.
- **Why**: This is the "catch in the UI" the user is asking for — it doesn't exist yet.
- **Source**: codebase (src-tauri/src/acp_client.rs:357)

## D4 (harvested bug): sticky global-default promotion
- **Decision**: N/A yet — documenting the defect. `App.tsx:1949-1955` (`onToggleBypassDefault`) silently promotes a single thread's toggle into the global default for all future never-configured threads.
- **Why**: Likely source of "I'm pretty sure we default to bypass" — one click, no warning, permanent effect.
- **Source**: codebase (src/App.tsx:1949)

## D2b: Icon button is a direct one-click toggle (no menu)
- **Decision**: Clicking the `IconShieldOff`-based button toggles directly between Accept and Bypass. No intermediate menu.
- **Why**: Minimal visual change; binary choice doesn't need a menu.
- **Source**: user

## D2c: Icon button placement — composer top-right corner, standalone
- **Decision**: The bypass/accept icon button is pinned to the top-right corner of the composer box (above the text input), separate from the bottom row's executor/model pickers, Spec/Go control, and send button.
- **Why**: Always-visible, not grouped with unrelated controls — reinforces audit-visibility goal. User confirmed via annotated screenshot pointing at that exact corner.
- **Source**: user

## D2d: Icon swaps between IconShield (Accept) and IconShieldOff (Bypass)
- **Decision**: Button icon itself changes — `IconShield` when Accept is active, `IconShieldOff` when Bypass is active. Not a fixed icon with only a color change.
- **Why**: Icon meaning carries the state, not color alone — accessible and matches user's naming intent.
- **Source**: user

## D2e: Confirmation popover required to enable Bypass
- **Decision**: Turning Bypass ON requires a small Mantine popover confirmation (e.g. "Bypass permissions for this thread?" with a confirm action) before the state actually flips. Turning it back OFF (Accept) is a plain single click, no confirmation.
- **Why**: User wants friction specifically on the dangerous direction (enabling bypass), not on disabling it.
- **Source**: user

## D6: Sticky global-default promotion is deleted
- **Decision**: Remove `onToggleBypassDefault` and its silent global-default promotion. Every new, never-configured thread always defaults to Accept (bypass=false). No global-default concept survives.
- **Why**: Simplest audit-safe guarantee; nothing in scope asked for a configurable global default.
- **Source**: user

## D7: Real approval-prompt UI — inline on ToolBlock
- **Decision**: When `decide_permission` returns `Prompt`, the tool call's existing `ToolBlock` (EventView.tsx) gains a "pending approval" state with inline action buttons, rather than a modal/toast. The agent's turn stays paused (ACP request held open) until answered.
- **Why**: Reuses the existing ToolBlock state machine (running/done/failed) instead of introducing a new overlay pattern; keeps the approval visually attached to the specific command being approved.
- **Source**: user
- **Note (codebase)**: `acp_client.rs:326-328` already documents this as a known stub: "Prompt has no UI surface yet, so it cancels — the safe default until the permission prompt UI lands." This change fills that gap.

## D7b: Approval options — Allow / Deny / Allow for rest of session
- **Decision**: The ToolBlock approval UI offers three actions: Allow (once), Deny, and "Allow for rest of session." The third scopes to the tool's `ToolKind` (matches decide_permission's existing granularity) for the remainder of the live session — resets when the session ends/crashes/is stopped. Not scoped to the exact command string, and not persisted beyond the session.
- **Why**: Researched industry pattern (Claude Code's pattern-scoped "don't ask again" rules, VS Code Agent Mode's session/workspace/always tiers) — session-scoped, category-level approval is the standard middle tier every major tool offers. ToolKind is the finest granularity Palisade's permission system already reasons over, so it's the natural equivalent.
- **Source**: user (requested 3rd option) + web research (Claude Code docs, VS Code Agent Mode)

## D9 (amended during apply): `pending_permissions` lives on `AcpSession`, not `Harness`
- **Decision**: `pending_permissions: Arc<Mutex<HashMap<String, oneshot::Sender<PermissionAnswer>>>>` is a field on `AcpSession` (acp_client.rs), shared with the bridge task the same way `busy: Arc<AtomicBool>` already is — not a top-level `Harness.pending_permissions` map keyed by request id across all sessions, as design.md's D-design-1 originally specified.
- **Why**: `run_bridge`/`start_with_transport` have no `Harness` reference today (only `Sink`, `busy`, and the spawn config) — routing `Harness` through would be a wider, more invasive change than reusing the existing per-session shared-state pattern already established for `busy`. It also gives the fail-safe teardown (D-design-4) a natural home: `AcpSession::terminate()` (already the single place `busy`/`stopping` are cleared, called from every teardown path — explicit stop, crash, drop) now also drains and denies that session's own pending map, with no separate cleanup bookkeeping needed. Externally observable behavior is unchanged: `answer_permission_prompt(session_id, request_id, decision)` still looks up by session id then request id, exactly as design.md specified.
- **Source**: recommended-accepted (implementation-time amendment, grill-apply rule: cheaper approach discovered during implementation, logged rather than silently substituted)

## D8: Backend plumbing for real approval (engineering decision, not grilled)
- **Decision**: `answer_permission`'s `on_receive_request` handler (currently synchronous, acp_client.rs:568-573) becomes async-await on a oneshot channel. Prompt-tier requests emit a new `ExecutorEvent` (tool call id, kind, command) to the frontend instead of immediately responding; a new Tauri command (`answer_permission_prompt(session_id, request_id, decision)`) resolves the channel when the user clicks Allow/Deny/Allow-for-session on the ToolBlock. A per-`AcpSession` `HashSet<ToolKind>` tracks "allowed for this session" kinds, checked before consulting `decide_permission` again. If the session ends/crashes/is stopped while a request is pending, it resolves to `Cancelled` (fail safe to deny) rather than hanging.
- **Why**: Minimal-diff way to bridge ACP's synchronous-looking request/responder into an async user-facing wait, reusing the existing per-session state rather than adding a new subsystem. Fail-safe-to-deny on session teardown matches the existing spec-mode-violation cancellation pattern already in the file.
- **Source**: recommended-accepted (engineering judgment, not a product decision)
