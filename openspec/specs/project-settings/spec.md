# project-settings Specification

## Purpose
Provides a project-root configuration file that shapes IDE behavior — format-on-save and executor selection — with fallbacks when absent.
## Requirements
### Requirement: project-settings.json location and loading
The system SHALL read a `project-settings.json` file from `.palisade/` at
the project root on project load. The file is optional; the IDE SHALL
function with sensible defaults when it is absent. There is no fallback
to a `project-settings.json` at the project root itself — any pre-existing
file there is not read.

#### Scenario: Settings present
- **WHEN** user opens a project with a `.palisade/project-settings.json`
- **THEN** the system reads and applies the settings on load

#### Scenario: Settings absent
- **WHEN** user opens a project with no `.palisade/project-settings.json`
- **THEN** the system uses defaults (no format-on-save, executor
  auto-detected) and the IDE works normally

#### Scenario: Malformed settings
- **WHEN** `.palisade/project-settings.json` exists but is invalid JSON
- **THEN** the system surfaces a non-fatal warning and falls back to
  defaults

#### Scenario: Legacy root-level file is not read
- **WHEN** a project has a `project-settings.json` at its root (the old
  location) but nothing at `.palisade/project-settings.json`
- **THEN** the system treats settings as absent and uses defaults; it does
  not read or migrate the root-level file

### Requirement: Format-on-save mappings
The system SHALL support a `formatOnSave` key mapping file globs or regexes to shell commands. When the editor saves a file matching a pattern, the system SHALL run the corresponding command.

#### Scenario: Format on save for Rust
- **WHEN** `formatOnSave` maps `\.rs$` to `cargo fmt` and user saves a `.rs` file
- **THEN** the system runs `cargo fmt` after the save completes

#### Scenario: No mapping for a file type
- **WHEN** user saves a file whose path matches no `formatOnSave` pattern
- **THEN** no command runs and the save completes normally

#### Scenario: Format command output
- **WHEN** a format-on-save command produces output or errors
- **THEN** the system surfaces the output in the terminal pane or a toast, non-blocking

### Requirement: Executor override
The system SHALL support an `executorOverride` key that forces the executor (`claude` or `codex`) for this project, overriding machine-specific auto-detection.

#### Scenario: Override to a specific executor
- **WHEN** `executorOverride` is set to `claude` and the user opens the project on a machine where `codex` would normally be auto-detected
- **THEN** the system uses `claude` as the executor for this project

#### Scenario: Override to an unavailable executor
- **WHEN** `executorOverride` is set to an executor not on PATH
- **THEN** the system surfaces a warning and falls back to auto-detection

#### Scenario: No override
- **WHEN** `executorOverride` is absent
- **THEN** the system uses the existing auto-detection (prefer `claude` if both present, else `codex`, else chat-only)

### Requirement: Settings file is user-gitignoreable
The system SHALL NOT force `project-settings.json` to be tracked. The user may gitignore it for personal-only settings or commit it for team-shared settings.

#### Scenario: User gitignores settings
- **WHEN** the user adds `project-settings.json` to `.gitignore`
- **THEN** the system continues to read it from disk and apply it on load

