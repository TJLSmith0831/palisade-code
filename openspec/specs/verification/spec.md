# verification Specification

## Purpose
Gives Palisade a mechanism to run project-defined verification commands itself and persist their result, so that "what has been tested" is answered with an observed exit code rather than an agent's self-report.
## Requirements
### Requirement: Project-configured verify commands
The system SHALL support a `verify` map in `.project-settings.json`, mapping a name to a shell command, following the same schema pattern (`#[serde(default)]`) as the existing `formatOnSave` map.

#### Scenario: Verify map present
- **WHEN** `.project-settings.json` contains a `verify` map
- **THEN** each named command is available to be run on demand

#### Scenario: Verify map absent
- **WHEN** `.project-settings.json` has no `verify` key
- **THEN** the project has no verify commands and the settings file still loads normally

### Requirement: Palisade runs verification and persists the result
The system SHALL execute a verify command itself (shell, project root as cwd, capturing stdout/stderr and exit status) and persist a record of the run, rather than only displaying the command for the user or agent to run.

#### Scenario: Passing command
- **WHEN** a verify command exits 0
- **THEN** a record is persisted with exit code 0, the command, an output tail, and the git HEAD at the time it ran

#### Scenario: Failing command
- **WHEN** a verify command exits non-zero
- **THEN** a record is persisted with the non-zero exit code and its output tail; the failure is never swallowed or displayed as success

#### Scenario: Shell metacharacters cannot break out
- **WHEN** a verify command or its target contains shell metacharacters
- **THEN** execution is properly quoted/escaped such that it cannot execute unintended commands

### Requirement: Verification runs asynchronously
The system SHALL run verify commands without blocking the UI thread, streaming the result back when the command completes.

#### Scenario: Long-running verify command
- **WHEN** a verify command takes a long time to complete
- **THEN** the UI remains responsive while it runs, and the result is delivered when the command finishes

### Requirement: No completeness claim without evidence
The system SHALL NOT display any UI text asserting a spec, change, or task is complete, satisfied, or implemented, except on the basis of a persisted verification run's exit code or an explicit user action.

#### Scenario: No unearned completeness claim
- **WHEN** the UI displays status for a spec or change
- **THEN** any "done"/"complete"/"satisfied" language is backed by a verification run's exit code or an explicit user action, never inferred from agent self-report alone

