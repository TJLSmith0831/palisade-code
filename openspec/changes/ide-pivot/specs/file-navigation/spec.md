## Purpose

Lets users quickly open files by name without navigating the file tree — the primary file-navigation gesture in the IDE.

## ADDED Requirements

### Requirement: Fuzzy file-open palette
The system SHALL provide a fuzzy file-open palette triggered by `⌘P` that lets the user type a partial path or filename and select a matching file to open in the editor.

#### Scenario: Open palette and search
- **WHEN** user presses `⌘P`
- **THEN** a palette appears with a text input focused for fuzzy search

#### Scenario: Fuzzy match ranking
- **WHEN** user types a partial filename
- **THEN** the palette lists files whose paths fuzzy-match the query, ranked by relevance, and the user can select one with the keyboard or mouse

#### Scenario: Open selected file
- **WHEN** user selects a file from the palette results
- **THEN** the palette closes and the editor opens the selected file

#### Scenario: Dismiss palette
- **WHEN** user presses Escape with the palette open
- **THEN** the palette closes without opening a file

### Requirement: File tree retained
The system SHALL retain the existing file tree for hierarchical browsing. The fuzzy palette is the primary navigation gesture; the tree remains for users who prefer to browse by directory.

#### Scenario: Browse via tree
- **WHEN** user expands directories and clicks a file in the file tree
- **THEN** the editor opens that file, identical to selecting it via the palette
