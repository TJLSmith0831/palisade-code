## Purpose

Gives every executor event a `session_id` and `thread_id` so events can be routed to the correct session/thread view, which is the prerequisite for concurrent sessions, per-session attribution, and correct UI state during a thread switch.

## ADDED Requirements

### Requirement: Every emitted event is wrapped in an identified envelope
The system SHALL wrap every `ExecutorEvent` emitted to the frontend in an `Envelope` carrying the originating `session_id` and `thread_id`. No existing `ExecutorEvent` variant SHALL be removed, renamed, or added as part of this requirement.

#### Scenario: Event carries its origin
- **WHEN** any executor event (Text, Reasoning, FileEdit, ToolCall, ToolResult, Done, Crashed, or a delta variant) is emitted
- **THEN** the emitted payload includes the `session_id` and `thread_id` of the session that produced it

#### Scenario: Existing event variants unchanged
- **WHEN** the envelope is introduced
- **THEN** all nine pre-existing `ExecutorEvent` variants remain structurally unchanged, and no new event variant is added

### Requirement: Frontend routes events by session
The system SHALL maintain live event state keyed by `session_id` rather than a single global list, so that events from one session never appear in a view scoped to a different session.

#### Scenario: Two live sessions, isolated views
- **WHEN** two sessions are streaming events concurrently
- **THEN** a view scoped to session A displays only session A's events, and a view scoped to session B displays only session B's events

#### Scenario: Thread switch mid-turn does not corrupt the other thread's view
- **WHEN** the user switches the active thread while a session on the previous thread is still streaming
- **THEN** the previous thread's session continues streaming into its own keyed state and does not appear in the newly active thread's view

### Requirement: Persisted messages record their originating session
The system SHALL persist a `session_id` on each message written to a thread's log. Messages written before this field existed SHALL continue to parse with the field absent.

#### Scenario: New message includes session_id
- **WHEN** a message is persisted during or after this change
- **THEN** the persisted record includes the `session_id` of the session that produced it

#### Scenario: Legacy message without session_id
- **WHEN** a pre-existing message record with no `session_id` field is read
- **THEN** it parses successfully with `session_id` absent (not an error)
