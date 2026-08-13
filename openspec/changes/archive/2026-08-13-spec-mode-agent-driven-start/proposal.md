## Why

Spec-mode and go-mode feel identical at start because spec-mode auto-fires `grill-explore` with the bare literal string `"grill-explore"` as the user turn body (lib.rs:722), giving the agent no framing task — so the agent improvises a generic opener and waits. A baked-in framing menu (Feature / Bugfix / Other) inserted between "pick Spec" and "agent runs" gives the agent a concrete starting frame, mirroring how Kiro asks "Feature or Bug?" before driving the SDD workflow. Additionally, both modes create threads eagerly (on mode pick), leaving orphan threads when users back out without engaging — so this change also defers thread creation to the first message.

## What Changes

- **Global: thread creation deferred to first message.** Picking "Go" or "Spec" from the Vibe/Spec picker no longer creates a thread immediately. For "Go", an empty chat composer appears; the thread is created when the user sends their first message. For "Spec", the framing menu appears first; the thread is created when the user commits to a spec type (which IS the first message). No orphan threads from backing out.
- **Spec-type framing menu.** After picking "Spec" from the Vibe/Spec picker, a second inline card row appears ("What would you like to spec out today?") with three Mantine cards: Feature, Bugfix, and Other. The agent does NOT run yet.
- **Spec type becomes the agent's first-turn framing.** Picking Feature or Bugfix starts `grill-explore` with that spec type as the user turn body (replacing the bare `"grill-explore"`). Picking Other reveals a Mantine `TextInput` for custom framing; submitting (Enter, non-empty) starts `grill-explore` with that text as the body.
- **Both spec-mode entry paths get framed.** The framing menu also appears on the composer Spec/Go toggle path (`onSpec`) when no open change exists.
- **Spec type persists on the thread.** `spec_mode` IPC command gains a `spec_type` parameter. `ThreadMeta` gains a `spec_type: Option<String>` field that persists across mode switches and app restarts. Re-entering spec mode with a stored spec type and no open change reuses the stored value without re-showing the framing menu.
- **Handoff re-injection.** On agent handoff (transcript rebuilt with 100k budget), the stored `spec_type` is re-injected as the first turn body if no open change exists — so the new agent doesn't lose the framing if the original turn was truncated.
- **Framing menu UX.** Back button returns to the Vibe/Spec picker. The "Other" text field has a contextual "or pick a different type" link. Empty "Other" submissions are disabled.
- **Agent-driven explore → propose transition.** The "Proceed to propose" button is removed. The grill-explore skill is amended to instruct the agent to emit a `[READY_TO_PROPOSE]` marker when exploration is complete. The system detects the marker in the agent's output, strips it from the visible message, and auto-fires `grill-propose`. The `propose` IPC command and `ProposeWatch` machinery stay unchanged.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `new-thread-mode-picker`: Both "Vibe" and "Spec" selections defer thread creation to the first message. Selecting "Spec" now shows a spec-type framing menu (Feature/Bugfix/Other) before thread creation; the spec type is stored on the thread and used as the agent's first-turn framing. Adds spec_type persistence and handoff re-injection requirements.

## Impact

- **Rust backend** (`src-tauri/src/lib.rs`): `spec_mode` gains `spec_type` parameter; `spec_mode_initial_prompt` uses it as the user turn body; `ensure_session` handoff path re-injects stored `spec_type`; event handler detects `[READY_TO_PROPOSE]` marker in `ExecutorEvent::Text` and auto-fires `propose`.
- **Grill-explore skill** (bundled resource): Exit section amended to instruct the agent to emit `[READY_TO_PROPOSE]` when exploration is change-shaped.
- **Rust store** (`src-tauri/src/store.rs`): `ThreadMeta` gains `spec_type: Option<String>` field with `#[serde(default)]` for backward compat with old records.
- **Rust grill injection** (`src-tauri/src/grill_inject.rs`): `build_prompt` already takes `user_message` — no change needed, just a new caller passing `spec_type` instead of `"grill-explore"`.
- **TypeScript frontend** (`src/App.tsx`): new `specTypePicker` state, inline Mantine card row (Feature/Bugfix/Other), "Other" TextInput with empty-submit prevention, Back button, deferred thread creation in `onPickMode` (both Go and Spec), empty composer state for Go mode, framing menu on `onSpec` path, removal of "Proceed to propose" button.
- **TypeScript API** (`src/api.ts`): `specMode` wrapper gains `specType` parameter.
- **Tests**: Rust tests for `spec_mode` param, `ThreadMeta` serialization, handoff re-injection; TS tests for framing menu rendering, card clicks, "Other" field, back button, deferred thread creation (both modes), state flow.
- **Existing spec amended**: `new-thread-mode-picker` spec's "Selecting Vibe/Spec" scenarios change from "creates thread immediately" to "defers thread creation to first message"; "Selecting Spec" adds framing menu step.
