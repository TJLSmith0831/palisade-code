## MODIFIED Requirements

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
