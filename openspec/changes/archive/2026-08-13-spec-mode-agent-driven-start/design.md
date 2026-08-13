## Context

Today both spec-mode and go-mode create a thread eagerly on mode pick. Spec-mode then auto-fires `grill-explore` with the bare literal `"grill-explore"` as the user turn body (lib.rs:722), giving the agent no framing task. The agent improvises a generic opener. See proposal.md for the motivation.

The existing `new-thread-mode-picker` spec (App.tsx:1603 `onPickMode`) renders an inline Vibe/Spec card row. The composer Spec/Go toggle (App.tsx:2002 `onSpec`) is the second spec-mode entry point. Both call `api.specMode()`, which calls the `spec_mode` IPC command (lib.rs:733). `spec_mode_initial_prompt` (lib.rs:720) decides whether to auto-fire: only when `open_spec_change_name` is `None`. The `ThreadMeta` struct (store.rs:189) has no `spec_type` field. Agent handoff rebuilds the transcript with a 100k-token budget (lib.rs:584), which may truncate early turns.

## Goals / Non-Goals

**Goals:**

- Give spec-mode a structured first-turn framing (Feature / Bugfix / Other) so the agent's opener is directed, not improvised.
- Defer thread creation to the first meaningful interaction for both modes (no orphan threads).
- Persist the spec type so it survives restarts and can be re-injected on agent handoff.

**Non-Goals:**

- Kiro-style approval gates between explore → propose → apply phases. Floo's stage derivation (`src/stage.ts`) already tracks these stages; this change does not add inter-phase gates.
- A `bugfix.md` artifact variant. Floo's grill flow is type-agnostic — the spec type is framing context only, not a different artifact structure (D7).
- Agent-generated framing options. The menu is baked-in UI (D2).
- Re-showing the framing menu when a stored spec type exists. Re-entry reuses the stored value (D11).

## Decisions

### D5+D10: spec_type as a parameter, silently ignored when a change exists

`spec_mode` gains a `spec_type: String` parameter. `spec_mode_initial_prompt` passes it to `build_prompt` as the user turn body instead of the literal `"grill-explore"`. When `open_spec_change_name` is set, `spec_type` is silently dropped (no auto-fire, same as today). The frontend gates the framing menu on "no open change" (D9), so the backend never receives `spec_type` when a change exists in practice.

**Alternative considered:** Error when `spec_type` is provided but a change exists. Rejected — the frontend never sends this combination, so it's a dead-code error path that complicates the IPC contract.

### D11+D12: spec_type on ThreadMeta, re-injected on handoff only

`ThreadMeta` gains `spec_type: Option<String>` with `#[serde(default)]` for backward compat. On agent handoff (transcript rebuilt, lib.rs:584), if `spec_type` is set and no open change exists, the spec type is re-injected as the first turn body for the new agent. On same-agent restart, the full history (including the original first turn) is reloaded, so no re-injection.

**Alternative considered:** Fire-and-forget (don't persist). Rejected — the user said "the type of spec should give context to the agent," which means it must survive restarts and handoffs, not just the opening turn.

**Alternative considered:** Re-inject on every new session. Rejected — duplicates the framing turn on same-agent restart where the original turn is still in history.

### D4: Mantine inline card row, not Popover/Menu

The framing menu is a second inline card row using Mantine `UnstyledButton` + `Paper`/`Card`, matching the existing `ds-mode-card` pattern but with Mantine components per CLAUDE.md. Same inline-not-modal posture as the `new-thread-mode-picker` spec mandates.

**Alternative considered:** Mantine Popover off the Spec card. Rejected — introduces a floating overlay where the rest of the flow is inline.

### D19+D20: Deferred thread creation for both modes

`onPickMode("go")` no longer calls `createThread` immediately. Instead, it sets a state that shows an empty composer in go mode. The thread is created on first message send. `onPickMode("spec")` shows the framing menu; the thread is created when the user commits to a spec type. For `onSpec` (composer toggle on an existing thread), the thread already exists, so this is a non-issue.

**Alternative considered:** Create thread on mode pick, delete if user backs out. Rejected — deletion is destructive and leaves gaps in the append-only store; deferring creation is cleaner.

### D21+D22: Agent-driven explore → propose transition via structured marker

The "Proceed to propose" button (App.tsx:338-349) is removed. The grill-explore skill's Exit section is amended to instruct the agent to emit `[READY_TO_PROPOSE]` when exploration is change-shaped. The system's event handler (lib.rs, `ExecutorEvent::Text` arm) detects the marker in the agent's text output, strips it from the text before persisting and emitting, and auto-fires the existing `propose` IPC command. The `propose` command and `ProposeWatch` machinery stay unchanged — only the trigger moves from a user-clicked button to a marker-detected auto-fire.

**Alternative considered:** Auto-fire on every `ExecutorEvent::Done` in exploring stage. Rejected — too aggressive; the agent may need multiple turns of back-and-forth before exploration is complete.

**Alternative considered:** Agent calls `/grill-propose` as a slash command. Rejected — couples the skill to the harness's command vocabulary; a structured marker is harness-agnostic.

## Risks / Trade-offs

- **[Empty composer state for Go mode is new UI]** → The go-mode empty composer must be clearly distinguishable from "no project selected" or "no thread" states. Mitigation: show a subtle hint ("Type a message to start this thread") in the composer, and the composer is active (focused, ready to type) so the user knows to engage.
- **[Deferred creation changes the IPC call sequence]** → Today `createThread` → `specMode` are two calls; with deferred creation, `createThread` + `specMode` + first message send must be atomic from the user's perspective. Mitigation: the frontend chains these in one async handler; if `createThread` fails, the message is not sent.
- **[ThreadMeta backward compat]** → Old thread records lack `spec_type`. Mitigation: `#[serde(default)]` on the field treats missing as `None`; no migration needed. Verified by a serialization test.
- **[Handoff re-injection duplicates framing if history is short]** → If the transcript is short enough that the original first turn survives the 100k budget, re-injection produces two framing turns. Mitigation: the handoff path checks whether the transcript already contains a turn with the spec type as the body before re-injecting. (This is a refinement — the initial implementation may accept the duplication as harmless since the skill content is the same.)
- **[Composer toggle path shows framing menu in an existing thread's chat surface]** → The framing menu replaces the chat content temporarily, which may feel jarring on a thread with prior go-mode messages. Mitigation: the framing menu only shows when `openSpecChangeName` is null and `spec_type` is null (first spec entry); once a spec type is stored, re-entry reuses it without the menu (D11).
- **[Agent may not emit the marker reliably]** → The agent might forget to emit `[READY_TO_PROPOSE]` or emit it prematurely. Mitigation: the grill-explore skill's Exit section is explicit about when to emit it ("scope, approach, and non-goals have entries"). If the agent doesn't emit it, the user can still type `/grill-propose` in the composer as a manual fallback — the `propose` IPC command is still callable. The marker is an automation, not the only path.
