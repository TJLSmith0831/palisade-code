# resizable-layout Specification

## Purpose
Lets users resize and collapse the IDE's sidebars and terminal panel, with dimensions persisting per project across sessions.
## Requirements
### Requirement: Resizable sidebars
The system SHALL allow the user to drag the border of both the left (sessions) and right (codemap/terminal) sidebars to resize their width. Sidebars SHALL also be collapsible.

#### Scenario: Drag to resize a sidebar
- **WHEN** user drags the left sidebar's right border
- **THEN** the sidebar width changes to follow the pointer and the center column adjusts to fill the remaining space

#### Scenario: Collapse a sidebar
- **WHEN** user invokes the collapse command for a sidebar (e.g. `⌘\` for left, `⌘J` for right)
- **THEN** the sidebar slides out of view and the center column expands

### Requirement: Resizable terminal panel
The system SHALL allow the user to drag the top border of the bottom terminal panel to resize its height.

#### Scenario: Resize the terminal panel
- **WHEN** user drags the terminal panel's top border
- **THEN** the terminal height changes and the editor/chat area above adjusts

### Requirement: Persisted layout dimensions
The system SHALL persist sidebar widths and terminal panel height per project across app restarts. Layout state is personal preference and SHALL NOT be stored in `project-settings.json`.

#### Scenario: Layout survives restart
- **WHEN** user resizes panels, quits the app, and reopens the same project
- **THEN** the panels restore to the dimensions the user last set

#### Scenario: Per-project layout isolation
- **WHEN** user sets panel widths in project A, switches to project B, then back to project A
- **THEN** project A's panel widths are restored and project B uses its own (or default) widths

### Requirement: Layout fallbacks
The system SHALL provide sensible default dimensions when no persisted layout exists for a project.

#### Scenario: First open of a project
- **WHEN** user opens a project with no persisted layout
- **THEN** the sidebars and terminal panel use default widths/height

