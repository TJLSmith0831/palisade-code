## REMOVED Requirements

### Requirement: Global reasoning visibility toggle
**Reason**: Superseded by a per-turn collapsible disclosure (see ADDED "Per-turn reasoning disclosure, default collapsed"). The global toggle's own control was already removed in a prior change (`ide-pivot`), leaving it a dead flag with no way to set it; this change replaces the model itself rather than restoring the removed control.
**Migration**: No user-facing migration — reasoning was effectively never visible under the old toggle (no UI existed to turn it on). The new per-turn block requires no setup and appears automatically when a turn includes reasoning.

## ADDED Requirements

### Requirement: Per-turn reasoning disclosure, default collapsed
The system SHALL render each turn's reasoning/thinking content, when present, as a collapsible block distinct from the answer text — collapsed by default, showing a one-line summary ("Thought for Ns", where N is the elapsed seconds from the first reasoning content to the complete reasoning event), expandable to the full reasoning text on click. The block SHALL apply to both Claude and Codex turns, SHALL remain visible (collapsed) after the turn completes rather than disappearing, and SHALL persist across app restarts and thread reloads.

#### Scenario: A turn produces reasoning
- **WHEN** a turn emits reasoning content and then completes
- **THEN** a collapsed block appears showing "Thought for Ns", with no reasoning text shown until expanded

#### Scenario: Expanding a reasoning block
- **WHEN** the user clicks a collapsed reasoning block
- **THEN** the block expands to show the full reasoning text for that turn

#### Scenario: Reasoning survives reload
- **WHEN** the user reloads the app or switches away from and back to a thread whose turn included reasoning
- **THEN** the same collapsed reasoning block is still present, in the same collapsed state, and still expandable

## MODIFIED Requirements

### Requirement: Tool-call rendering stays collapsed with a live status
Tool-call blocks SHALL remain collapsed by default with click-to-expand for their full command and output, styled consistently with the per-turn reasoning disclosure block. The block's header SHALL reflect the call's real-time status.

#### Scenario: A tool call starts
- **WHEN** a tool call begins and has not yet returned a result
- **THEN** the collapsed block's header shows a running/in-progress indicator without requiring the block to be expanded

#### Scenario: A tool call finishes
- **WHEN** the tool call's result arrives
- **THEN** the collapsed block's header updates to reflect completion (success or failure) without requiring the block to be expanded
