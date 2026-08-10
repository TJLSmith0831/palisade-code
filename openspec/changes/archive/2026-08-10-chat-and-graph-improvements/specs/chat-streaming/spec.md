## Purpose

Renders assistant output the way it's produced — incrementally as the
model generates it, for executors that support it — with reasoning
visibility controlled by one global preference instead of a per-message
disclosure widget the user has to click open every time.

## ADDED Requirements

### Requirement: Stream assistant text incrementally for Claude turns
The system SHALL parse Claude's `stream_event` content-block-delta lines
(emitted because `--include-partial-messages` is already passed) and
append each text delta to the in-progress assistant message as it
arrives, rather than waiting for the containing block to complete.

#### Scenario: Receiving a text delta
- **WHEN** a Claude turn emits a `content_block_delta` event carrying a
  text fragment
- **THEN** the system appends the fragment to the currently-rendering
  assistant message immediately, without waiting for the block to finish

#### Scenario: A message completes
- **WHEN** the block's final delta has been appended
- **THEN** the assembled message is treated as a complete `text` event for
  persistence, identical to today's whole-block behavior

### Requirement: Codex turns render per completed block
Codex has no verified delta-level event schema. The system SHALL continue
rendering each Codex output item as soon as that item completes, with no
artificial delay, but is not required to stream it incrementally.

#### Scenario: A Codex item completes
- **WHEN** Codex emits an `item.completed` event
- **THEN** the system renders that item's full content immediately upon
  receipt

### Requirement: Global reasoning visibility toggle
The system SHALL provide a single app-wide toggle controlling whether
reasoning/thinking content renders at all, replacing the previous
per-message click-to-expand disclosure. The toggle SHALL apply to both
Claude and Codex turns and SHALL persist across app restarts.

#### Scenario: Toggle is on
- **WHEN** the reasoning toggle is on and a turn emits reasoning content
- **THEN** the system streams (for Claude) or renders (for Codex) that
  reasoning content inline, visually distinguished from the answer text
  (e.g. dimmed), with no click required

#### Scenario: Toggle is off
- **WHEN** the reasoning toggle is off
- **THEN** the system does not render any reasoning content for any turn,
  and no per-message reasoning disclosure control is shown

### Requirement: Tool-call rendering stays collapsed with a live status
Tool-call blocks SHALL remain collapsed by default with click-to-expand
for their full command and output, unaffected by the reasoning toggle. The
block's header SHALL reflect the call's real-time status.

#### Scenario: A tool call starts
- **WHEN** a tool call begins and has not yet returned a result
- **THEN** the collapsed block's header shows a running/in-progress
  indicator without requiring the block to be expanded

#### Scenario: A tool call finishes
- **WHEN** the tool call's result arrives
- **THEN** the collapsed block's header updates to reflect completion
  (success or failure) without requiring the block to be expanded
