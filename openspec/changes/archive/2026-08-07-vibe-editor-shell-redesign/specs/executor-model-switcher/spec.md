## Purpose

Exposes executor and model selection plus a permission-bypass toggle in the UI, neither of which had any control surface before this change.

## ADDED Requirements

### Requirement: Top-chrome executor/model picker
The system SHALL render a control in the top chrome, showing the currently detected executor and the currently selected model, that opens a menu on click. The executor row SHALL be a read-only display of the auto-detected executor (per the project's detection-not-config rule); the model row SHALL be user-selectable.

#### Scenario: Opening the picker
- **WHEN** the user clicks the executor/model control in the top chrome
- **THEN** a menu opens showing the detected executor as read-only status and a selectable list of available models, with the current model marked

#### Scenario: Executor cannot be manually overridden
- **WHEN** the user views the executor row in the menu
- **THEN** it displays the auto-detected executor without offering a selectable control to switch it

### Requirement: Bypass-permissions toggle
The executor/model menu SHALL include a toggle for bypass-permissions mode, defaulting to off, that is visually distinct when enabled.

#### Scenario: Enabling bypass
- **WHEN** the user turns on the bypass-permissions toggle in the menu
- **THEN** the toggle shows an enabled/on state and the control communicates that approval prompts will be skipped

### Requirement: Selections persist across menu close
Closing the executor/model menu SHALL retain the last selected model and bypass state, reflected the next time the menu opens. The detected executor is re-derived from preflight, not stored as a user selection.

#### Scenario: Reopening after a change
- **WHEN** the user changes the model, closes the menu, and reopens it
- **THEN** the newly selected model is shown as the current selection
