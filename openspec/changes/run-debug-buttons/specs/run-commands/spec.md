## Purpose

Provides quick access to run project commands via a split button in the editor tab bar, with configuration stored in `.project-settings.json` and commands executing in the terminal pane.

## ADDED Requirements

### Requirement: Run button in editor tab bar

The system SHALL display a run button in the editor tab bar next to file names. The button SHALL be a split button with a primary action and a dropdown for alternative commands.

#### Scenario: Run button displays in tab bar

- **WHEN** a file is open in the editor
- **THEN** the run button appears in the tab bar next to the file name

#### Scenario: Run button split button interaction

- **WHEN** user clicks the primary action of the run button
- **THEN** the currently selected run command executes
- **WHEN** user clicks the dropdown portion of the run button
- **THEN** a menu displays all configured run commands

### Requirement: Run command configuration in project settings

The system SHALL store run command configurations in `.project-settings.json` as a `run` field mapping command names to shell commands (HashMap<String, String>).

#### Scenario: Run commands load from project settings

- **WHEN** a project is opened with run commands configured in `.project-settings.json`
- **THEN** the run button dropdown displays the configured commands

#### Scenario: Run configuration with no commands

- **WHEN** a project is opened with no `run` field in `.project-settings.json`
- **THEN** the run button still displays but has no configured commands

### Requirement: Command execution in terminal pane

The system SHALL execute run commands in the project's terminal pane, with command output visible in the terminal.

#### Scenario: Run command executes in terminal

- **WHEN** user selects a run command from the run button
- **THEN** the command is written to the terminal PTY and executes
- **THEN** the command output appears in the terminal pane

#### Scenario: Terminal focus on command execution

- **WHEN** a run command is executed
- **THEN** the terminal pane becomes the active/focused pane

### Requirement: Last-used command memory

The system SHALL remember the last-used run command and set it as the primary action for the next run button click.

#### Scenario: Last-used command becomes primary action

- **WHEN** user selects a run command from the dropdown
- **THEN** that command becomes the primary action for subsequent run button clicks

#### Scenario: First run with no prior selection

- **WHEN** user clicks the run button for the first time with no prior selection
- **THEN** the system executes a default command or prompts for configuration

### Requirement: No-configuration onboarding

The system SHALL provide onboarding for first-time users when no run configuration exists, helping them create a simple "run current file" configuration.

#### Scenario: Onboarding prompt on first click with no config

- **WHEN** user clicks the run button with no run configuration in `.project-settings.json`
- **THEN** the system displays a prompt to create a simple run configuration

#### Scenario: Simple run current file configuration creation

- **WHEN** user accepts the onboarding prompt
- **THEN** the system creates a basic "run current file" configuration in `.project-settings.json` appropriate for the current file's language

### Requirement: Run command persistence

The system SHALL persist run command configurations to `.project-settings.json` so they are available across sessions and shareable with team members.

#### Scenario: Run configuration persists across sessions

- **WHEN** user creates or modifies run command configurations
- **THEN** the configurations are saved to `.project-settings.json` and available in future sessions

#### Scenario: Run configuration version control

- **WHEN** run command configurations are added to `.project-settings.json`
- **THEN** the configurations can be committed to version control and shared with team members
