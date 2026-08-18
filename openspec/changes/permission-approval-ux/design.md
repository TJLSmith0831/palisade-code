## Context

See proposal.md - Why. Today `answer_permission` (acp_client.rs:329-361) is a pure, synchronous function called from inside `on_receive_request`'s async closure (acp_client.rs:568-573) — it computes a `PermissionDecision` and the closure responds immediately. `PermissionDecision::Prompt` currently maps straight to `Cancelled` because there is no way for that closure to wait on the user. `decide_permission` (permissions.rs) itself is unchanged by this design — only what happens on `Prompt` changes.

## Goals / Non-Goals

**Goals:**
- Turn `Prompt` from "silently denied" into "agent's turn pauses, user decides, turn resumes."
- Do it with the smallest addition to the existing ACP bridge — no new subsystem, no persisted approval rules.

**Non-Goals:**
- Changing `decide_permission`'s policy (spec/go/bypass tiers stay as D12/D15/D20 defined them).
- Cross-session or cross-thread persisted approval rules (Claude Code's `settings.local.json`-style pattern rules) — out of scope per D7b.
- Multiple concurrent pending-approval UI patterns beyond "one ToolBlock per pending call" — if an agent fires several `Prompt`-tier calls at once, each gets its own pending ToolBlock; no special batching/queueing UI.

## Decisions

### D-design-1: Oneshot channel bridges the async responder to a user click
`answer_permission` gains an async variant: when `decide_permission` returns `Prompt`, instead of responding immediately, the bridge (a) generates a request id (ULID, matching the id style already used for session identity), (b) stores a `oneshot::Sender<PermissionAnswer>` in `AcpSession.pending_permissions: Arc<Mutex<HashMap<String, oneshot::Sender<PermissionAnswer>>>>` (amended during apply — see decisions.md D9: lives on the session handle, not `Harness`, shared with the bridge task the same way `busy` already is), (c) emits a new `ExecutorEvent::PermissionRequest { id, tool_call_id, tool_kind, command, paths }` to the frontend, and (d) awaits the paired `oneshot::Receiver` before calling `responder.respond(...)`.
- **Alternative considered**: polling a shared `Mutex<HashMap<..., Option<PermissionAnswer>>>` from the async closure. Rejected — a oneshot channel is the idiomatic tokio primitive for exactly this "one value, one waiter" shape and avoids a poll loop.

### D-design-2: New Tauri command resolves the channel
`answer_permission_prompt(request_id: String, decision: "allow" | "deny" | "allow_session") -> Result<(), String>` looks up and removes the sender from `pending_permissions`, sends the decision through it. If the id is missing (already resolved, or the session is gone), it's a no-op success — the frontend may have a stale button after a fast session teardown, and treating that as an error would surface a confusing message for something the user already can't act on.
- **Alternative considered**: keying by `tool_call_id` alone instead of a fresh request id. Rejected — `tool_call_id` is only unique within one ACP session; a fresh id avoids any cross-session collision risk without needing to also thread the session id through every lookup.

### D-design-3: Session-scoped allow-list lives on the bridge, not `Harness`
"Allow for rest of session" is tracked in a `HashSet<permissions::ToolKind>` local to `run_bridge`'s async task (captured by the `on_receive_request` closure the same way `perm_mode` already is), not in `Harness`. Before consulting `decide_permission`, the closure checks this set first; `Allow` and `Deny` don't touch it, only `AllowSession` inserts into it.
- **Why here and not `Harness`**: the set's lifetime is exactly the bridge task's lifetime — it needs no cleanup step, because when the session ends the whole closure (and its captured set) is dropped. Putting it in `Harness` would require explicit removal on session teardown, which is the same fail-safe bookkeping `pending_permissions` already needs for D-design-4, without adding value.

### D-design-4: Fail-safe-to-deny on teardown
Session teardown (crash, stop, `on_crash`, explicit leave) drains any of that session's still-pending entries from `pending_permissions` and sends `PermissionAnswer::Deny` through each before dropping them, rather than letting the `Receiver` just observe a dropped `Sender` (which would need its own error-handling branch at the await point). Explicit deny keeps the await site's success path the only path.
- **Alternative considered**: relying on `oneshot::Receiver`'s `Err(RecvError)` when the `Sender` drops. Rejected — that still needs to be treated as "deny," so sending an explicit `Deny` is no more code and keeps `answer_permission`'s await straightforward (`Ok(answer)` only).

## Risks / Trade-offs

- **[Risk]** "Allow for rest of session" is coarser than Claude Code's command-pattern rules (D7b) — a user who allows "execute" once could see a very different command auto-approved later in the same session. **Mitigation**: this is the explicit, researched tradeoff from D7b — `decide_permission` only reasons over `ToolKind`, so kind-level is the finest grain available without a larger rework of the permission model; scope is session-only, never persisted.
- **[Risk]** Removing `onToggleBypassDefault`/`DEFAULT_BYPASS_KEY` changes behavior for any existing installs that already set a global bypass default — their threads silently stop inheriting it. **Mitigation**: intentional (proposal.md's BREAKING note); each thread's own prior `threadPrefsKey` entry is untouched, only the fallback-for-unconfigured-threads behavior changes.
- **[Risk]** An agent that fires several `Prompt`-tier tool calls concurrently produces several pending ToolBlocks at once with no queueing. **Mitigation**: accepted for v1 — each is independently resolvable, and ACP's per-call ids already keep them distinct; batching UI is a fast-follow if it turns out to matter in practice.

## Migration Plan

No data migration. `palisade:default-bypass` becomes an orphaned, unread localStorage key on upgrade — safe to leave; no code reads it after this change. No rollback concerns beyond a normal revert (no schema/store changes).
