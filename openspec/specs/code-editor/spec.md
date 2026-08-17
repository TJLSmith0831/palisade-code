# code-editor Specification

## Purpose

Lets users view and edit project files in a real code editor with syntax highlighting and autocomplete, replacing the read-only textarea viewer.

## Requirements

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

### Requirement: Completion-interface seam for FIM model

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

### Requirement: Local AI inline completion (FIM)

The system SHALL provide inline fill-in-the-middle (FIM) code completions using a bundled local model (`Qwen3.5-0.8B.Q4_K_M.gguf`) served by a bundled `llama-server` sidecar. Completions SHALL appear as ghost text at the cursor position and SHALL be acceptable via a configurable keybinding (default Option/Alt+Tab).

#### Scenario: Ghost text appears while typing

- **WHEN** the user pauses typing for 150ms with inline completion enabled
- **THEN** the editor displays a greyed inline suggestion at the cursor, sourced from the local FIM model

#### Scenario: Accept a completion

- **WHEN** the user presses the configured accept keybinding (default Option/Alt+Tab) while ghost text is visible
- **THEN** the suggestion is inserted at the cursor and the cursor advances to the end of the inserted text

#### Scenario: Dismiss a completion

- **WHEN** the user presses Escape or moves the cursor away while ghost text is visible
- **THEN** the ghost text is removed without inserting anything

#### Scenario: Cancel stale requests

- **WHEN** the user continues typing before a completion response arrives
- **THEN** the in-flight request is aborted and the stale response is ignored

#### Scenario: Disable inline completion

- **WHEN** the user toggles inline completion off in Settings
- **THEN** no ghost text appears and no completion requests are sent to the sidecar

#### Scenario: Configurable accept keybinding

- **WHEN** the user changes the accept keybinding in Settings
- **THEN** the new keybinding takes effect immediately without restarting the editor

#### Scenario: Graceful degradation when resources are missing

- **WHEN** the bundled model or sidecar binary is unavailable
- **THEN** the editor continues to function without inline completion and surfaces no crash

#### Scenario: Sidecar crash detection

- **WHEN** the sidecar process exits unexpectedly
- **THEN** the system detects the crash and completion requests fail gracefully without hanging the editor

### Requirement: Local completion telemetry

The system SHALL record local, privacy-preserving telemetry about inline completion usage: counters for shown/accepted/dismissed/typed-past events and p50/p99 TTFT percentiles. Telemetry SHALL be persisted to `~/.palisade-code/completion-telemetry.json` and SHALL NOT include source code or completion content.

#### Scenario: Telemetry counters increment

- **WHEN** a ghost text is shown, accepted, dismissed, or typed past
- **THEN** the corresponding counter increments in local telemetry storage

#### Scenario: TTFT percentiles are computed

- **WHEN** a completion response arrives with a latency measurement
- **THEN** p50 and p99 TTFT are recalculated from the recent latency history

#### Scenario: Telemetry persists to disk

- **WHEN** telemetry is flushed
- **THEN** the public telemetry counters are written to `~/.palisade-code/completion-telemetry.json`

### Requirement: Large file rendering

The system SHALL render files using CodeMirror's viewport-based virtualization so that opening large files does not block the UI.

#### Scenario: Open a multi-thousand-line file

- **WHEN** user opens a file with thousands of lines
- **THEN** the editor renders without freezing the UI and scrolling remains responsive
