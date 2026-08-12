## Purpose

Provides AI-powered fill-in-the-middle code completion using a local bundled model, with inline ghost text in the editor and configurable keybinding to accept suggestions.

## ADDED Requirements

### Requirement: Inline ghost text completion

The system SHALL display AI-generated code completions as greyed inline ghost text at the cursor position in the code editor, with a configurable keybinding (default: Option+Tab) to accept the suggestion into the document. The accept keybinding SHALL only trigger when ghost text is visible.

#### Scenario: Ghost text appears after typing pause

- **WHEN** user types in the code editor and pauses for 150ms
- **THEN** the system displays greyed ghost text showing the predicted completion at the cursor position

#### Scenario: Accept completion with Option+Tab

- **WHEN** ghost text is displayed and user presses Option+Tab (or the configured accept keybinding)
- **THEN** the system inserts the ghost text into the document at the cursor position

#### Scenario: Accept keybinding does nothing without ghost text

- **WHEN** no ghost text is displayed and user presses the accept keybinding
- **THEN** the system performs no action (the keybinding is conditional on ghost text presence)

#### Scenario: Dismiss completion with Escape

- **WHEN** ghost text is displayed and user presses Escape
- **THEN** the system removes the ghost text without inserting any text

#### Scenario: Dismiss completion on cursor movement

- **WHEN** ghost text is displayed and user moves the cursor away from the completion position
- **THEN** the system removes the ghost text without inserting any text

#### Scenario: Cancel in-flight request on new keystroke

- **WHEN** a completion request is in-flight and user types another character
- **THEN** the system cancels the in-flight request and starts a new completion request after the debounce period

### Requirement: FIM completion request format

The system SHALL send fill-in-the-middle completion requests to the local inference server with prefix (text before cursor), suffix (text after cursor), and cursor position, respecting the token budget (256 prefix tokens, 128 suffix tokens, 32 max generation tokens).

#### Scenario: Completion request with prefix and suffix

- **WHEN** the system requests a completion
- **THEN** it sends the prefix (up to 256 tokens), suffix (up to 128 tokens), and cursor position to the inference server

#### Scenario: Completion response includes latency tracking

- **WHEN** the inference server returns a completion
- **THEN** the response includes the completion text and model latency in milliseconds for telemetry

### Requirement: Local inference sidecar process

The system SHALL spawn a local llama-server sidecar process at app startup, pointing it to the bundled Qwen3.5-0.8B.Q4_K_M.gguf model, and manage its lifecycle (spawn, health check, restart on crash, graceful shutdown).

#### Scenario: Sidecar spawns at app startup

- **WHEN** the Floo Network app starts
- **THEN** the system spawns the llama-server sidecar process with the bundled model and Metal acceleration enabled

#### Scenario: Sidecar health check

- **WHEN** the system needs to request a completion
- **THEN** it verifies the sidecar is responding via HTTP health check before sending the request

#### Scenario: Sidecar crash recovery

- **WHEN** the llama-server sidecar process crashes
- **THEN** the system attempts one restart; if the second crash occurs, it disables completion for the session and shows a toast notification

#### Scenario: Sidecar graceful shutdown

- **WHEN** the Floo Network app quits
- **THEN** the system terminates the llama-server sidecar process gracefully

### Requirement: Bundled model and inference engine

The system SHALL bundle the Qwen3.5-0.8B.Q4_K_M.gguf model (540MB) and static llama-server binary (20MB) in the Tauri app bundle, ensuring the app works without external dependencies or user configuration.

#### Scenario: Model loads from bundled resources

- **WHEN** the sidecar process starts
- **THEN** it loads the model from the bundled resources path (`.app/Contents/Resources/models/` on macOS)

#### Scenario: Static binary has no external dependencies

- **WHEN** the app is distributed to another user
- **THEN** the bundled llama-server binary runs without requiring Homebrew, dylibs, or other external dependencies

### Requirement: Completion enable/disable toggle

The system SHALL provide a settings UI toggle to enable or disable AI completion, with completion enabled by default for all projects.

#### Scenario: Disable completion via settings

- **WHEN** user disables completion in settings
- **THEN** the system stops the sidecar process (if running) and ghost text no longer appears

#### Scenario: Enable completion via settings

- **WHEN** user enables completion in settings
- **THEN** the system spawns the sidecar process and ghost text appears after typing pauses

### Requirement: Configurable accept keybinding

The system SHALL allow users to configure the autocomplete accept keybinding via settings UI, with Tab as the default.

#### Scenario: Change accept keybinding

- **WHEN** user changes the accept keybinding in settings
- **THEN** the system uses the new keybinding to accept ghost text completions

#### Scenario: Default keybinding is Tab

- **WHEN** user has not configured a custom keybinding
- **THEN** the system uses Tab as the accept keybinding (matching Cursor and Windsurf defaults)

### Requirement: Completion telemetry

The system SHALL track completion acceptance metrics (shown, accepted, dismissed, typed-past) and TTFT percentiles (p50, p99), storing the data locally in `~/.floo-network/completion-telemetry.json`.

#### Scenario: Record completion shown

- **WHEN** ghost text is displayed to the user
- **THEN** the system increments the "shown" counter in telemetry

#### Scenario: Record completion accepted

- **WHEN** user accepts a completion via the keybinding
- **THEN** the system increments the "accepted" counter and records the TTFT in telemetry

#### Scenario: Record completion dismissed

- **WHEN** user dismisses a completion (Escape, cursor movement, or typing past)
- **THEN** the system increments the "dismissed" counter in telemetry

#### Scenario: Record typed past completion

- **WHEN** user types characters that make the displayed completion irrelevant
- **THEN** the system increments the "typed-past" counter in telemetry

### Requirement: Graceful degradation on missing resources

The system SHALL disable completion silently and log an error if the bundled model or llama-server binary is missing, showing a one-time toast notification per session.

#### Scenario: Missing model file

- **WHEN** the bundled model file is missing or corrupted
- **THEN** the system disables completion silently, logs the error, and shows a one-time toast per session

#### Scenario: Missing inference binary

- **WHEN** the bundled llama-server binary is missing
- **THEN** the system disables completion silently, logs the error, and shows a one-time toast per session

## REMOVED Requirements

None
