## Purpose

Lets users run a real interactive shell inside the IDE — full PTY fidelity for TUI apps, signals, and resize — docked as a resizable panel.

## ADDED Requirements

### Requirement: PTY-backed terminal
The system SHALL provide an integrated terminal backed by a real pseudo-terminal (PTY). The terminal SHALL spawn the user's login shell (`$SHELL`, fallback `/bin/zsh` on macOS) and support interactive TUI programs (e.g. `vim`, `top`, `less`), ANSI colors, and cursor control.

#### Scenario: Open the terminal
- **WHEN** user opens the terminal panel
- **THEN** a PTY spawns the user's shell and the terminal displays a working prompt

#### Scenario: Run a TUI program
- **WHEN** user runs `vim` (or any TUI program) in the terminal
- **THEN** the program renders correctly with full-screen control sequences and returns to the shell prompt on exit

#### Scenario: ANSI color output
- **WHEN** a command emits ANSI-colored output (e.g. `ls --color`)
- **THEN** the terminal renders the colors as they would appear in a standalone terminal

### Requirement: Terminal input including signals
The system SHALL forward keyboard input to the PTY, including control signals.

#### Scenario: Ctrl-C interrupts a running command
- **WHEN** a long-running command is in progress and user presses Ctrl-C
- **THEN** the running command is interrupted and the shell returns to a prompt

#### Scenario: Tab completion works
- **WHEN** user types a partial command and presses Tab
- **THEN** shell tab-completion behaves as it would in a standalone terminal

### Requirement: Terminal resize
The system SHALL forward resize events to the PTY when the terminal panel is resized, so TUI programs redraw to the new dimensions.

#### Scenario: Resize the terminal panel
- **WHEN** user drags the terminal panel border to a new size
- **THEN** running TUI programs redraw to fit the new dimensions

### Requirement: Single terminal instance
The system SHALL maintain a single terminal instance per project in v1. Multiple terminal tabs or splits are not provided.

#### Scenario: Only one terminal
- **WHEN** the terminal panel is already open and user opens it again
- **THEN** the existing terminal is shown rather than a new one being spawned

### Requirement: Terminal placement
The system SHALL dock the terminal as a resizable bottom panel by default. The user SHALL be able to toggle the terminal to the right sidebar.

#### Scenario: Default bottom placement
- **WHEN** user opens the terminal with the default layout
- **THEN** the terminal appears as a resizable panel below the editor/chat area

#### Scenario: Move terminal to sidebar
- **WHEN** user toggles terminal placement to sidebar
- **THEN** the terminal moves to the right sidebar region and the editor/chat area expands vertically
