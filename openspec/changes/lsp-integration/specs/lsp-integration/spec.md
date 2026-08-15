## Purpose

Provides semantic code intelligence features like go-to-definition, hover tooltips, diagnostics, and semantic autocomplete by integrating language servers with the CodeMirror editor, enabling deeper understanding of code beyond syntax highlighting.

## ADDED Requirements

### Requirement: LSP server auto-detection and startup

The system SHALL automatically detect and start language servers for supported languages when a file is opened, using PATH detection to find installed LSP servers without requiring user configuration.

#### Scenario: LSP server auto-detection on file open

- **WHEN** user opens a file of a supported language (e.g., .ts, .py, .rs) and the corresponding LSP server is installed on PATH
- **THEN** the system automatically spawns the LSP server and establishes communication for that language

#### Scenario: Missing LSP server graceful degradation

- **WHEN** user opens a file of a supported language but the corresponding LSP server is not found on PATH
- **THEN** the system continues to display the file with basic syntax highlighting and surfaces a warning in the harness warnings system

#### Scenario: LSP server startup failure handling

- **WHEN** an LSP server fails to start or crashes during initialization
- **THEN** the system logs the failure in the harness warnings system and continues with basic syntax highlighting

### Requirement: Go-to-definition navigation

The system SHALL provide go-to-definition functionality that allows users to navigate from a symbol usage to its definition location within the codebase when an LSP server is active for the current file's language.

#### Scenario: Go-to-definition on symbol

- **WHEN** user invokes go-to-definition (e.g., via keyboard shortcut or click) on a symbol with a known definition
- **THEN** the editor navigates to the file and line containing the symbol's definition

#### Scenario: Go-to-definition without LSP

- **WHEN** user invokes go-to-definition but no LSP server is active for the current file's language
- **THEN** the system silently does nothing (no navigation, no error)

### Requirement: Hover tooltips for type information

The system SHALL display hover tooltips showing type information, documentation, or other contextual information when the user hovers over symbols in the editor, provided by the active LSP server.

#### Scenario: Hover tooltip display

- **WHEN** user hovers the cursor over a symbol in the editor and an LSP server is active
- **THEN** the system displays a tooltip with type information, documentation, or other contextual information provided by the LSP server

#### Scenario: Hover tooltip dismissal

- **WHEN** user moves the cursor away from the symbol or presses Escape
- **THEN** the hover tooltip is dismissed

### Requirement: Diagnostics display

The system SHALL display code diagnostics (errors, warnings, information) from the active LSP server as visual indicators in the editor, such as underlines or squiggles, with details available on hover or in a diagnostics panel.

#### Scenario: Diagnostics indicators display

- **WHEN** an LSP server reports diagnostics for the current file
- **THEN** the editor displays visual indicators (e.g., red underlines for errors, yellow for warnings) at the appropriate locations

#### Scenario: Diagnostic details on hover

- **WHEN** user hovers over a diagnostic indicator
- **THEN** the system displays a tooltip with the diagnostic message and details provided by the LSP server

#### Scenario: Diagnostics update on edit

- **WHEN** user edits the file content
- **THEN** the diagnostic indicators update to reflect the new state as reported by the LSP server

### Requirement: Semantic autocomplete

The system SHALL provide semantic autocomplete suggestions based on the LSP server's understanding of the codebase, supplementing or replacing the basic word/symbol autocomplete when an LSP server is active.

#### Scenario: Semantic autocomplete suggestions

- **WHEN** user types in the editor and an LSP server is active for the current file's language
- **THEN** the editor displays completion suggestions based on semantic understanding from the LSP server

#### Scenario: Autocomplete fallback without LSP

- **WHEN** user types in the editor but no LSP server is active
- **THEN** the editor displays basic word/symbol autocomplete from the document content

### Requirement: LSP configuration overrides

The system SHALL support optional configuration overrides in `.project-settings.json` to disable LSP for specific languages or specify custom LSP server binary paths, while defaulting to auto-detection from PATH.

#### Scenario: Default auto-detection behavior

- **WHEN** no LSP configuration is present in `.project-settings.json`
- **THEN** the system auto-detects LSP servers from PATH for all supported languages

#### Scenario: Per-language disable override

- **WHEN** `.project-settings.json` contains an LSP override setting `enabled: false` for a specific language
- **THEN** the system does not attempt to start or use an LSP server for that language

#### Scenario: Custom server path override

- **WHEN** `.project-settings.json` contains an LSP override with a custom `server_path` for a specific language
- **THEN** the system uses the specified binary path instead of PATH detection for that language's LSP server

### Requirement: LSP server lifecycle management

The system SHALL manage LSP server processes per language per project, keeping servers running while working with files of that language in the project, and shutting down servers when switching projects entirely.

#### Scenario: Per-language server persistence

- **WHEN** user switches between files of different languages within the same project (e.g., from .ts to .py)
- **THEN** the LSP server for the first language remains running and the LSP server for the second language starts if not already running

#### Scenario: Project switch cleanup

- **WHEN** user switches to a different project
- **THEN** the system shuts down all LSP servers for the previous project

#### Scenario: LSP server restart on crash

- **WHEN** an LSP server crashes during normal operation
- **THEN** the system automatically restarts the server up to 3 times with exponential backoff before disabling LSP for that language for the current session

### Requirement: Multi-language support

The system SHALL support LSP integration for all languages that have both CodeMirror language packages and mature LSP servers, including but not limited to TypeScript/JavaScript, Python, Rust, Go, Java, C++, PHP, HTML, CSS, JSON, SQL, Markdown, YAML, and XML.

#### Scenario: Language-specific LSP server detection

- **WHEN** user opens a file of any supported language
- **THEN** the system attempts to detect and use the appropriate LSP server for that specific language

#### Scenario: Unsupported language handling

- **WHEN** user opens a file of a language without a mature LSP server or CodeMirror language package
- **THEN** the system displays the file with basic syntax highlighting or plain text without LSP features
