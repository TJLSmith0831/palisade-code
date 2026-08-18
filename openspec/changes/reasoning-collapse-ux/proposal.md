## Why

Today reasoning/thinking content has no working UI at all: `showThinking` is a dead flag with no remaining control to set it (its checkbox was removed in a prior change, `ide-pivot`), and even when on, reasoning is never persisted — it vanishes on thread reload. This matches neither what the user wants nor how comparable AI IDEs (Cursor, Windsurf) work: a per-turn "Thought for Xs" summary that stays visible, collapsed, after the turn completes.

## What Changes

- Replace the global reasoning on/off toggle (`chat-streaming` spec's "Global reasoning visibility toggle") with a per-turn collapsible disclosure — collapsed by default, showing "Thought for Ns", expandable to the full reasoning text. Reuses the existing `ToolBlock` collapsible styling.
- Persist reasoning events to the thread store (capped at the existing 64KB `PERSIST_CAP`, same mechanism already used for tool output/diffs) so reasoning survives a reload instead of being process-memory-only.
- Remove the dead `showThinking`/`SHOW_THINKING_KEY` plumbing (App.tsx, EventView.tsx) now that it's superseded.
- **BREAKING** (internal only): the `chat-streaming` spec's global-toggle requirement is replaced; no external API changes.

## Capabilities

### Modified Capabilities
- `chat-streaming`: "Global reasoning visibility toggle" requirement replaced with a per-turn, default-collapsed disclosure requirement; the "Tool-call rendering stays collapsed" requirement's stale reference to "the reasoning toggle" is updated since that toggle no longer exists.

## Impact

- Frontend: `src/EventView.tsx` (reasoning case becomes a collapsible block matching `ToolBlock`'s pattern, tracks elapsed time from first delta to completion), `src/App.tsx` (remove `showThinking` state/prop threading and `SHOW_THINKING_KEY`).
- Backend: `src-tauri/src/executor.rs` (`persist()` stops discarding `Reasoning` events; `capped()` gains a `Reasoning` arm).
- No data migration for existing threads — old threads simply have no persisted reasoning for turns that already completed, same as today.
