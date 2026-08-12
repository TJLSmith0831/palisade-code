## MODIFIED Requirements

### Requirement: Completion-interface seam for future FIM model

The system SHALL expose the editor's completion-source interface such that a model-backed fill-in-the-middle (FIM) completion provider is registered and provides inline ghost text with a configurable accept keybinding (default: Option+Tab). The accept keybinding SHALL only trigger when ghost text is visible.

#### Scenario: FIM provider registered and active

- **WHEN** the FIM completion provider is registered and enabled
- **THEN** the editor displays inline ghost text completions at the cursor position with the configured accept keybinding

#### Scenario: FIM provider disabled

- **WHEN** the FIM completion provider is disabled via settings
- **THEN** the editor does not display ghost text and only provides basic word/symbol autocomplete

#### Scenario: Ghost text acceptance with Option+Tab

- **WHEN** ghost text is displayed and user presses Option+Tab (or the configured accept keybinding)
- **THEN** the editor inserts the ghost text into the document at the cursor position

#### Scenario: Accept keybinding does nothing without ghost text

- **WHEN** no ghost text is displayed and user presses the accept keybinding
- **THEN** the editor performs no action (the keybinding is conditional on ghost text presence)

#### Scenario: Ghost text dismissal

- **WHEN** ghost text is displayed and user presses Escape or moves the cursor
- **THEN** the editor removes the ghost text without inserting any text
