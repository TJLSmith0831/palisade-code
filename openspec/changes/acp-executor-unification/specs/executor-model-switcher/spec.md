## MODIFIED Requirements

### Requirement: Composer provider/model pickers

The composer SHALL render two adjacent controls: a **provider** picker showing the thread's effective executor, and a **model** picker showing the thread's effective model. The provider picker SHALL be a user-selectable dropdown of the ACP agents actually installed on this machine (binary distributions resolved on PATH; npx distributions only when the package is already in a local npm cache — an npx shim that would download on first run is not "installed"). The model picker SHALL list only the models the selected provider reports through its ACP `model` session config option, probed live via a throwaway `session/new`; providers that report no model selector SHALL show a hint instead of a list.

#### Scenario: Opening the provider picker

- **WHEN** the user clicks the provider control in the composer
- **THEN** a menu opens listing the installed ACP agents, with the thread's effective executor marked

#### Scenario: Executor is user-switchable

- **WHEN** the user selects a different provider from the dropdown
- **THEN** the choice is persisted on the thread, and the thread's next session starts under the new agent — a live session under the old agent is closed and the previous turns are handed off as a raw-text transcript prefix on the first prompt

#### Scenario: Provider selection feeds the model menu

- **WHEN** the user opens the model menu for a provider
- **THEN** Floo probes that provider over ACP and lists exactly the models it offers, with the current selection marked

#### Scenario: Provider manages its own model

- **WHEN** the probed provider reports no `model` config option
- **THEN** the model menu shows a hint that the provider manages its own model, and no list is offered

#### Scenario: Model choice applies to the next session

- **WHEN** the user selects a model
- **THEN** the provider and model are pinned on the thread together, and the next new session applies the model via ACP `session/set_config_option` before the first prompt

### Requirement: Bypass-permissions toggle

The provider menu SHALL include a toggle for bypass-permissions mode, defaulting to off, that is visually distinct when enabled. When enabled, the system SHALL auto-approve all ACP permission requests for the session regardless of mode, suppressing all permission prompts.

#### Scenario: Enabling bypass

- **WHEN** the user turns on the bypass-permissions toggle in the menu
- **THEN** the toggle shows an enabled/on state and all subsequent ACP permission requests for the session are auto-approved without prompting

### Requirement: Selections persist across menu close

Closing the picker menus SHALL retain the last selected provider, model, and bypass state, reflected the next time the menus open. Provider and model are stored as per-thread preferences on the thread meta (falling back to the project's `executorOverride`, then auto-detection); the bypass state is stored as a per-thread preference with a global default.

#### Scenario: Reopening after a change

- **WHEN** the user changes the provider or model, closes the menu, and reopens it
- **THEN** the newly selected provider and model are shown as the current selection
