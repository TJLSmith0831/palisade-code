## MODIFIED Requirements

### Requirement: CodeMirror 6 editor surface

The system SHALL provide a code editor based on CodeMirror 6 that replaces the textarea-based file viewer. The editor SHALL open files selected from the file tree or fuzzy-open palette, display them with syntax highlighting, and allow direct editing. The editor SHALL support LSP client extensions for semantic code intelligence features when language servers are available.

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

#### Scenario: LSP client extension loading

- **WHEN** an LSP server is active for the current file's language
- **THEN** the CodeMirror editor SHALL load and activate LSP client extensions for semantic features

## ADDED Requirements

### Requirement: LSP client integration

The system SHALL integrate @codemirror/lsp-client with the CodeMirror editor to enable communication with language servers via WebSocket transport, providing semantic features like go-to-definition, hover tooltips, diagnostics, and semantic autocomplete.

#### Scenario: LSP client initialization

- **WHEN** an LSP server connection is established for the current file's language
- **THEN** the CodeMirror editor initializes the LSP client with the appropriate language extensions

#### Scenario: LSP client WebSocket communication

- **WHEN** the LSP client needs to send requests to the language server
- **THEN** the client communicates via WebSocket transport using the Tauri WebSocket plugin bridge

#### Scenario: LSP client disconnection

- **WHEN** the LSP server connection is lost or the project is switched
- **THEN** the LSP client gracefully disconnects and cleans up resources
