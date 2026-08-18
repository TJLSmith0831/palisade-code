## Purpose

Gives the user an actual way to approve or deny a tool call that the permission policy has flagged as needing a decision, instead of that decision being silently denied with no visible prompt.

## ADDED Requirements

### Requirement: Pending tool calls render an inline approval prompt
When the permission policy determines a tool call needs the user's decision (rather than being auto-allowed or auto-denied), the system SHALL render that tool call's existing chat block in a pending-approval state with three actions: Allow, Deny, and "Allow for rest of session." The agent's turn SHALL remain paused until one of the three is chosen.

#### Scenario: A pending tool call shows approval actions
- **WHEN** a tool call arrives whose kind requires a decision under the thread's current permission mode
- **THEN** its block renders in a pending-approval state showing Allow, Deny, and "Allow for rest of session" actions, and the agent's turn does not proceed

#### Scenario: Allow approves only this call
- **WHEN** the user clicks Allow on a pending tool call
- **THEN** that specific tool call proceeds and the agent's turn resumes; a later tool call of the same kind in the same session still requires its own decision

#### Scenario: Deny rejects only this call
- **WHEN** the user clicks Deny on a pending tool call
- **THEN** that specific tool call is rejected and the agent's turn resumes without it; a later tool call of the same kind in the same session still requires its own decision

#### Scenario: Allow for rest of session approves the tool kind for the session
- **WHEN** the user clicks "Allow for rest of session" on a pending tool call of a given kind
- **THEN** that call proceeds, and subsequent tool calls of the same kind in the same live session are auto-approved without a further prompt
- **WHEN** that session ends, crashes, or is stopped
- **THEN** the auto-approval no longer applies — a new session for the same thread requires its own decisions again

### Requirement: An unanswered pending approval fails safe on session teardown
If the session ends, crashes, or is stopped while a tool call is awaiting the user's decision, the system SHALL resolve that pending decision as denied rather than leaving it unresolved or defaulting to allow.

#### Scenario: Session crashes while a call is pending
- **WHEN** a tool call is in the pending-approval state and its session crashes or is stopped before the user responds
- **THEN** the pending call resolves as denied
