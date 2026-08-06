## Purpose

Lets users view and edit project files in a real code editor with syntax highlighting and autocomplete, replacing the read-only textarea viewer.

## ADDED Requirements

### Requirement: CodeMirror 6 editor surface
The system SHALL provide a code editor based on CodeMirror 6 that replaces the textarea-based file viewer. The editor SHALL open files selected from the file tree or fuzzy-open palette, display them with syntax highlighting, and allow direct editing.

#### Scenario: Open a file from the file tree
- **WHEN** user clicks a file in the file tree
- **THEN** the editor pane loads and displays the file contents with syntax highlighting appropriate to the file extension

#### Scenario: Open a file via fuzzy palette
- **WHEN** user triggers the fuzzy-open palette (`⌘P`), types a partial filename, and selects a match
- **THEN** the editor pane loads and displays the selected file

#### Scenario: Edit and save a file
- **WHEN** user edits file content in the editor and invokes save (`⌘S` or the Save button)
- **THEN** the system writes the new content to disk via the existing `write_file_content` IPC and the editor reflects the saved state (no unsaved indicator)

#### Scenario: Unsaved changes indicator
- **WHEN** the editor has unsaved content
- **THEN** the editor surface SHALL show a visible dirty indicator (e.g. "Save *") that clears once the file is saved

### Requirement: Syntax highlighting for common languages
The system SHALL apply syntax highlighting for at least Rust, JavaScript/TypeScript (including TSX/JSX), Python, Go, JSON, Markdown, and CSS files. Files of unrecognized types SHALL display as plain text without errors.

#### Scenario: Rust file highlighting
- **WHEN** user opens a `.rs` file
- **THEN** the editor renders Rust syntax highlighting (keywords, strings, types, comments)

#### Scenario: TypeScript file highlighting
- **WHEN** user opens a `.ts` or `.tsx` file
- **THEN** the editor renders TypeScript/JSX syntax highlighting

#### Scenario: Unrecognized file type
- **WHEN** user opens a file with an extension no language package covers
- **THEN** the editor displays the file as plain text without throwing an error

### Requirement: Built-in autocomplete
The system SHALL provide CodeMirror's built-in word/symbol autocomplete (`@codemirror/autocomplete`) in the editor. Autocomplete suggestions SHALL be derived from the open document's content.

#### Scenario: Autocomplete triggers while typing
- **WHEN** user types in the editor and an autocomplete trigger fires
- **THEN** the editor displays completion suggestions sourced from the current document and accepts a selection on confirm

#### Scenario: Autocomplete dismissable
- **WHEN** user presses Escape or moves the cursor away from the suggestion
- **THEN** the autocomplete popup dismisses without inserting a completion

### Requirement: Completion-interface seam for future FIM model
The system SHALL expose the editor's completion-source interface such that a future model-backed fill-in-the-middle (FIM) completion provider can be registered without rewriting the editor. v1 ships no FIM implementation — only the seam.

#### Scenario: FIM provider registration point exists
- **WHEN** a future FIM completion provider is implemented
- **THEN** it can be wired into the editor's existing completion-source interface without changing the editor's public surface

### Requirement: Large file rendering
The system SHALL render files using CodeMirror's viewport-based virtualization so that opening large files does not block the UI.

#### Scenario: Open a multi-thousand-line file
- **WHEN** user opens a file with thousands of lines
- **THEN** the editor renders without freezing the UI and scrolling remains responsive
