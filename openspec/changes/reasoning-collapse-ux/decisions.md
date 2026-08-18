# Explore: reasoning-collapse-ux (per-turn collapsible thinking, default collapsed)

User delegated this change "start to finish" without further grilling. Decisions below are my best-judgment resolutions, harvested from the codebase and this session's conversation; logging per skill discipline anyway so the reasoning is auditable.

## D1: Supersede D19 (chat-and-graph-improvements) — per-message disclosure replaces the global toggle
- **Decision**: Replace the global on/off "show thinking" preference with a per-turn collapsible disclosure, default collapsed, mirroring the existing `ToolBlock` pattern (EventView.tsx) and Cursor's "Thought for Xs" bubble. Reasoning stays visible after the turn completes (collapsed), not removed.
- **Why**: This directly contradicts a prior explicit decision (D19, chat-and-graph-improvements archive: "User picked [global toggle] over 'keep the per-message block, just default it open.'") — flagging that supersession rather than silently overwriting it. But the user's *this-session* instructions are unambiguous and more specific: they explicitly described wanting reasoning to "remain but default to collapsed," referenced Cursor/Windsurf's per-message pattern by name, and I confirmed via web research that pattern is exactly "Thought for Xs" collapsed-by-default with a chevron. A specific, detailed instruction given directly to me this session outweighs an older global preference the user may not have been thinking about when stating it.
- **Source**: user (this session) — supersedes D19/chat-and-graph-improvements and the `chat-streaming` spec's "Global reasoning visibility toggle" requirement.

## D2: Reasoning becomes persisted (capped), not transient-only
- **Decision**: `persist()` (executor.rs) stops discarding `Reasoning` events. It persists them the same way `ToolCall`/`ToolResult` already are — `role: "tool"`, JSON-serialized, capped at the existing `PERSIST_CAP` (64KB) via `capped()`.
- **Why**: "I want it to remain" only holds up across a thread reload if it's actually stored — today it's process-memory-only (`liveBySession`), gone the moment the thread is reloaded or switched away from and back. The prior "not persisted" decision was specifically about unbounded growth ("can be enormous") — the existing cap mechanism already solves that same problem for tool output/diffs, so reusing it here removes the original objection rather than ignoring it.
- **Source**: recommended-accepted

## D3: Visual pattern — "Thought for Ns" collapsed summary, click to expand
- **Decision**: Each reasoning block renders as a collapsed one-line summary ("Thought for Ns", where N is elapsed seconds from first reasoning delta to the complete event), with a chevron to expand the full text — reusing `ToolBlock`'s existing `Paper`/collapsible styling for visual consistency rather than inventing a new component style.
- **Why**: Matches the researched Cursor pattern exactly; reusing `ToolBlock`'s established look keeps this a small diff instead of a new design language.
- **Source**: recommended-accepted (grounded in Cursor pattern research from this session)

## D4: Old global-toggle infrastructure is deleted
- **Decision**: Remove `SHOW_THINKING_KEY`, the `showThinking` prop threaded through App.tsx/ChatSurface/EventView, and the `chat-streaming` spec's "Global reasoning visibility toggle" requirement (superseded, not left dangling).
- **Why**: Dead code once per-message disclosure replaces it; leaving the unused toggle plumbing around invites confusion about which mechanism actually controls visibility.
- **Source**: recommended-accepted
