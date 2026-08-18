## MODIFIED Requirements

### Requirement: Bypass-permissions toggle
The system SHALL render a standalone icon button pinned to the top-right corner of the composer, separate from the executor/model menu and the Spec/Go mode control. The button's icon SHALL be `IconShield` when the thread is in Accept mode and `IconShieldOff` when the thread is in Bypass mode; clicking it toggles directly between the two states with no intermediate menu. Enabling Bypass SHALL require confirming a Mantine popover before the state changes; disabling Bypass (returning to Accept) SHALL take effect on a single click with no confirmation. Every new, never-configured thread SHALL default to Accept mode; no user action on any thread SHALL change the default applied to other threads.

#### Scenario: Enabling bypass requires confirmation
- **WHEN** the user clicks the icon button while the thread is in Accept mode
- **THEN** a confirmation popover appears
- **WHEN** the user confirms
- **THEN** the icon changes to `IconShieldOff`, the button reflects Bypass mode, and approval prompts are skipped for that thread

#### Scenario: Declining the confirmation leaves the thread in Accept mode
- **WHEN** the user clicks the icon button while the thread is in Accept mode and dismisses the confirmation popover without confirming
- **THEN** the thread remains in Accept mode and the icon remains `IconShield`

#### Scenario: Disabling bypass needs no confirmation
- **WHEN** the user clicks the icon button while the thread is in Bypass mode
- **THEN** the thread immediately returns to Accept mode and the icon changes to `IconShield`, with no popover shown

#### Scenario: A new thread always starts in Accept mode
- **WHEN** a new thread is created that has never had its own permission preference set
- **THEN** it starts in Accept mode, regardless of any bypass toggle made on any other thread

### Requirement: Selections persist across menu close
Closing the executor/model menu SHALL retain the last selected model, reflected the next time the menu opens. The detected executor is re-derived from preflight, not stored as a user selection. The permission mode (Accept/Bypass) SHALL persist per-thread only, set via the standalone icon button described above; it is scoped to that thread and SHALL NOT be promoted into a default applied to other threads.

#### Scenario: Reopening after a model change
- **WHEN** the user changes the model, closes the menu, and reopens it
- **THEN** the newly selected model is shown as the current selection

#### Scenario: Bypass state is thread-scoped
- **WHEN** the user enables Bypass mode on one thread
- **THEN** other threads' permission mode is unaffected, and any subsequently created thread still starts in Accept mode
