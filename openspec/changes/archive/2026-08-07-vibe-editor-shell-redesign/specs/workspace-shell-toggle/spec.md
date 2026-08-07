## Purpose

Lets the user switch the entire workspace layout between a chat-centric Vibe shell and a code-centric Editor shell from a persistent top-chrome control, independent of any thread's own mode.

## ADDED Requirements

### Requirement: Persistent shell toggle in top chrome
The system SHALL render a two-option "Vibe | Editor" toggle in the top chrome, positioned immediately to the right of the native window traffic lights.

#### Scenario: Toggle is visible on launch
- **WHEN** the application window renders
- **THEN** the Vibe/Editor toggle is visible in the top chrome with one option marked active

### Requirement: Toggle switches the workspace shell
Selecting "Vibe" or "Editor" in the toggle SHALL switch the entire workspace layout to the corresponding shell without navigating away from the current project or thread selection.

#### Scenario: Switching to Editor mode
- **WHEN** the user selects "Editor" in the toggle while in the Vibe shell
- **THEN** the workspace re-renders as the Editor shell (file tree, Editor/Diff tabs, right rail) with the same project and active thread still selected

### Requirement: Shell toggle is independent of thread mode
The shell toggle SHALL NOT alter, seed, or read a thread's `currentMode` (`spec` | `go`); it controls layout only.

#### Scenario: Switching shells does not change thread mode
- **WHEN** the active thread is in `go` mode and the user switches from the Vibe shell to the Editor shell
- **THEN** the thread's mode remains `go`, unaffected by the shell switch

### Requirement: Vibe shell has no Codebase Map surface
The Vibe shell SHALL NOT render a Codebase Map view; Codebase Map is only reachable by switching to the Editor shell.

#### Scenario: No codemap access in Vibe shell
- **WHEN** the workspace is in the Vibe shell
- **THEN** no control in the Vibe shell opens a Codebase Map view
