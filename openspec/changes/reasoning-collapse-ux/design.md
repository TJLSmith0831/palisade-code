## Context

See proposal.md - Why. `EventView.tsx`'s `reasoning` case currently either renders raw dimmed text (if the dead `showThinking` flag were ever true) or `null`. `executor.rs`'s `persist()` explicitly discards `Reasoning`/`TextDelta`/`ReasoningDelta`/`Done` events — only `Text`, structured events (`ToolCall`/`ToolResult`/`FileEdit`), and `Crashed` reach the store. `ToolBlock` (EventView.tsx:102) already implements the target interaction shape: `useState(open)`, collapsed by default, click to expand, a `Paper` with a status-bearing header.

## Goals / Non-Goals

**Goals:**
- Reasoning survives a reload/thread-switch, same as tool calls and diffs already do.
- Visual and interaction parity with `ToolBlock` — one collapsible-block pattern in the chat, not two.

**Non-Goals:**
- Any global setting/preference for reasoning visibility — this removes that model, not adds another form of it.
- Changing the reasoning *content* transformation, chunking, or the ACP mapping that produces `Reasoning`/`ReasoningDelta` events (`acp_events.rs`) — only what happens to those events once produced.

## Decisions

### D-design-1: Persist `Reasoning` the same way as `ToolCall`/`ToolResult`
`persist()`'s `Reasoning { text }` arm changes from `return` (discarded) to `("tool", serde_json::to_string(&capped(structured)).unwrap_or_default())`, matching the existing structured-event path. `capped()` gains a `Reasoning { text }` arm that caps `text` at `PERSIST_CAP`, identical to how `FileEdit`/`ToolResult` are already capped.
- **Alternative considered**: a dedicated `role: "reasoning"` message type instead of reusing `role: "tool"`. Rejected — `itemsFromMessages` already round-trips any `ExecutorEvent` through `role: "tool"` JSON (EventView.tsx:83-100); a new role would need its own parse branch for no behavioral gain.

### D-design-2: Elapsed time is backend-computed and carried on the `Reasoning` event
"Thought for Ns" needs a start and end instant that survives reload — which rules out computing it purely in the frontend, since `persist()` (the thing that actually writes to the store) runs in the Rust bridge (acp_client.rs → executor.rs), not the browser. The `Reasoning` `ExecutorEvent` variant gains an `elapsed_secs: u64` field. The bridge already accumulates `think_buf` per turn (acp_client.rs:485); it records `Instant::now()` the moment `think_buf` first becomes non-empty for a turn, and computes elapsed seconds when the turn's complete `Reasoning` event is built for both emission and persistence. One source of truth — the persisted value is exactly what the live view showed, no frontend-side reconstruction needed after reload.
- **Alternative considered**: computing elapsed time client-side from `reasoningDelta` receipt timestamps. Rejected — the value would then only exist in the live view; persisting it would require a second, separate frontend-to-backend round trip just to save a number the backend can compute for free from state it already tracks.

### D-design-3: Reasoning block reuses `ToolBlock`'s collapsible shell
A new small component (or a light generalization of `ToolBlock`) renders the reasoning summary line + expand/collapse, using the same `Paper`/header/chevron styling `ToolBlock` already has, rather than a bespoke look. `showThinking` prop threading is deleted from `ChatSurface`/`EventView`'s props entirely — the reasoning case no longer branches on it.

## Risks / Trade-offs

- **[Risk]** Persisting full reasoning text (even capped at 64KB) grows thread logs more than before, since every turn with reasoning now writes a persisted entry instead of nothing. **Mitigation**: same cap already accepted for tool output/diffs; reasoning is typically much shorter than a full-file diff in practice.
- **[Risk]** Moving `elapsed_secs` computation into the backend (D-design-2's correction) is slightly more invasive than a pure frontend change. **Mitigation**: it's a single `Instant`/duration calculation added to state the bridge already tracks per-turn (`think_buf`); no new subsystem.
- **[Risk]** This change directly reverses a previous explicit user decision (D19, chat-and-graph-improvements) to remove per-message reasoning disclosure in favor of a global toggle. **Mitigation**: flagged explicitly in decisions.md (D1) as a deliberate supersession based on this session's specific, detailed instruction — not a silent overwrite.

## Migration Plan

No data migration. Existing persisted threads have no reasoning entries for turns that already completed under the old (non-persisting) behavior — this is expected and matches today's actual state (nothing was ever persisted). New turns going forward get the persisted, collapsible block.
