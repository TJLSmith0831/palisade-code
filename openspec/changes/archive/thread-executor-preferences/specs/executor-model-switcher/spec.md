## REMOVED Requirements

### Requirement: Top-chrome executor/model picker
**Reason**: The model and bypass controls now live in the active thread's composer, not the top chrome, so they are scoped to the thread and next turn.
**Migration**: See the new "Thread-level executor/model picker" requirement.

## MODIFIED Requirements

### Requirement: Bypass-permissions toggle
The thread-level executor/model menu SHALL include a toggle for bypass-permissions mode, defaulting to off, that is visually distinct when enabled. When enabled, the next new session on this thread SHALL be spawned with the executor's approval-skipping flag.

#### Scenario: Enabling bypass
- **WHEN** the user turns on the bypass-permissions toggle in the thread-level menu
- **THEN** the toggle shows an enabled/on state, communicates that approval prompts will be skipped, and the next new session is spawned with the bypass flag

### Requirement: Selections persist across menu close
Closing the thread-level executor/model menu SHALL retain the last selected model and bypass state for that thread, reflected the next time the menu opens. New threads inherit the global default until the user sets a thread override. The detected executor is re-derived from preflight, not stored as a user selection.

#### Scenario: Reopening after a change
- **WHEN** the user changes the model or bypass for a thread, closes the menu, and reopens it
- **THEN** the newly selected values for that thread are shown as the current selection

#### Scenario: New thread inherits global default
- **WHEN** the user creates a new thread and opens the executor/model menu
- **THEN** the menu shows the global default model and bypass values

## ADDED Requirements

### Requirement: Thread-level executor/model picker
The system SHALL render a control in the active thread's composer showing the currently detected executor and the currently selected model, that opens a pop-up menu on click. The model SHALL be user-selectable; the executor row SHALL be a read-only display of the auto-detected executor.

#### Scenario: Opening the picker
- **WHEN** the user clicks the executor/model control in the active thread's composer
- **THEN** a pop-up menu opens showing the detected executor as read-only status and a selectable list of available models, with the current model for that thread marked

### Requirement: Model selection affects the next new session
The system SHALL pass the selected model as the executor's `--model` argument when spawning the next new session on the thread. The currently live session, if any, SHALL keep its original model.

#### Scenario: Starting a new session with a selected model
- **WHEN** the user has selected "Opus 5" for a thread and a new session is spawned
- **THEN** the executor is invoked with `--model opus` and the existing live session, if any, is not restarted

### Requirement: Bypass affects the next new session
The system SHALL pass the bypass flag as an executor-specific argument when spawning the next new session on the thread if the toggle is enabled. The currently live session, if any, SHALL keep its original permission flags.

#### Scenario: Starting a new session with bypass enabled
- **WHEN** the user has enabled bypass for a thread and a new session is spawned
- **THEN** for Claude the executor is invoked with `--dangerously-skip-permissions`; for Codex it is invoked with `--dangerously-bypass-approvals-and-sandbox`; and the existing live session, if any, is not restarted
