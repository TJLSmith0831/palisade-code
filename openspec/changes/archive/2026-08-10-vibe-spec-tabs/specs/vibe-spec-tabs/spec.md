## Purpose

Makes OpenSpec changes readable and actionable from the Vibe shell by opening them as editor tabs, so a thread in spec mode never has to switch to the Editor shell just to see its linked change.

## ADDED Requirements

### Requirement: Vibe right sidebar lists project spec changes
The system SHALL render a "Specs" section in the Vibe shell's right sidebar that lists every OpenSpec change for the active project.

#### Scenario: Specs launcher is visible
- **WHEN** the Vibe shell renders for a project
- **THEN** the right sidebar contains a "Specs" section below Threads and above File Explorer

#### Scenario: Specs launcher shows status and progress
- **WHEN** the Specs section has at least one change
- **THEN** each row shows the change name, an `openspec`-reported status badge, and a mini progress bar derived from the change's task checkboxes

### Requirement: Clicking a spec opens it as an editor tab
The system SHALL open a selected OpenSpec change as a new tab in the Vibe files column when the user clicks its name in the Specs launcher.

#### Scenario: Open a spec from the launcher
- **WHEN** the user clicks a change name in the Specs launcher
- **THEN** a new tab labeled with that change name opens in the files-column tab strip and becomes the active tab

#### Scenario: Active tab shows the spec view
- **WHEN** a spec tab is active
- **THEN** the files column shows a read-only, structured view of that OpenSpec change instead of a code editor or diff

### Requirement: Spec tab has inner artifact tabs
The system SHALL render inner tabs inside an active spec tab for the change's artifacts: Proposal, Design, Spec, Tasks, and Verify.

#### Scenario: Switching artifact views
- **WHEN** the user selects a different inner tab inside a spec tab
- **THEN** the content area updates to show the corresponding artifact without replacing the top-level spec tab

### Requirement: Spec view is read-only
The system SHALL render spec artifacts as read-only content. It SHALL NOT provide controls that write to any file under `openspec/changes/`.

#### Scenario: No save affordance
- **WHEN** the user is viewing a spec tab
- **THEN** no save button, auto-save, or dirty indicator is present, and the tab close button does not prompt for unsaved changes

### Requirement: Linked-change chip opens the linked spec
The system SHALL make the linked-change chip in the chat header clickable, and clicking it SHALL open the linked spec as a tab in the files column.

#### Scenario: Clicking the linked-change chip
- **WHEN** the active thread has an `openSpecChangeName` and the user clicks that chip
- **THEN** the linked change opens as a tab in the Vibe files column (creating the tab if it does not already exist) and becomes the active tab

### Requirement: Verify tab shows project-level runs
The system SHALL render a Verify inner tab that lists all configured project verify commands and their latest run results.

#### Scenario: Verify tab shows exit codes
- **WHEN** the user opens the Verify tab of a spec
- **THEN** each configured `verify` command is shown with its name, command string, the exit code of its latest run, and the commit hash at which it ran

### Requirement: Tasks tab shows a primary verify action
The system SHALL display a primary "Run verify" action at the top of the Tasks inner tab when a verify command is pinned for that change.

#### Scenario: Pinned verify button appears
- **WHEN** the user opens the Tasks tab of a change that has an entry in `.project-settings.json`'s `verifyPins`
- **THEN** a single primary button is shown using the first pinned command, and clicking it invokes `api.runVerify` for that command

### Requirement: Editor shell remains unchanged
The system SHALL NOT modify the Editor shell's existing `SpecPane` or right-rail disclosure.

#### Scenario: Editor shell still works
- **WHEN** the user switches from Vibe to Editor
- **THEN** the Editor shell's Specs tab in the "Threads & Codebase Map" disclosure is still present and functions as before
