## Purpose

Replaces the two-variant `Kind` enum and `Preflight`'s hardcoded per-provider fields with a compiled-in data table, so that adding a new agent is a table-row-and-parser change rather than a change that touches preflight detection, resolution matches, and the TypeScript boundary.

## ADDED Requirements

### Requirement: Agents are defined as data in a compiled-in table
The system SHALL define known agents as entries in a single compiled-in table (id, binary name, transport, permission mapping, skill locations, argv builder, turn writer, event parser), not as a hardcoded enum matched throughout the codebase.

#### Scenario: Adding a third agent touches only the table and its parser
- **WHEN** a new agent is added to the compiled-in table along with its own event parser
- **THEN** it is detected by preflight, selectable, spawnable, and its events render correctly, with no code changes required outside the table definition and that parser

### Requirement: Preflight reports agents as a list, not named fields
The system SHALL report agent detection status (path found, skills present, plugin present) as a list of per-agent status entries, not as separate named fields per known agent.

#### Scenario: Preflight status is iterable
- **WHEN** the frontend receives a preflight result
- **THEN** it can render the status of every known agent by iterating a list, without referencing any agent by a hardcoded name in the iteration logic

### Requirement: Unknown executor override warns instead of discarding settings
The system SHALL validate a project's executor override against the known-agents table by id. An override naming an unrecognized agent SHALL produce a warning and fall back to auto-detection, without discarding the rest of the project's settings.

#### Scenario: Unknown override name
- **WHEN** `.project-settings.json` specifies an `executorOverride` that does not match any id in the known-agents table
- **THEN** the system warns and falls back to auto-detected agent selection, and all other settings (e.g. `formatOnSave`) remain intact

#### Scenario: Known override name
- **WHEN** `.project-settings.json` specifies an `executorOverride` matching a known agent id
- **THEN** that agent is used, subject to it being detected on the machine

### Requirement: Tool naming is agent-scoped
The system SHALL treat a `ToolCall`/`ToolResult` event's tool name as verbatim from the originating agent, and SHALL NOT apply one agent's tool-naming convention when parsing another agent's output.

#### Scenario: Non-Claude agent uses its own tool names
- **WHEN** a non-Claude agent's parser produces a `ToolCall` event
- **THEN** the tool name reflects that agent's own vocabulary rather than being coerced into Claude's naming (e.g. `"Bash"`)

### Requirement: Existing agent behavior is unchanged
The system SHALL produce byte-identical argv and parsed events for the Claude and Codex agents after migrating them into the table, compared to their pre-migration behavior.

#### Scenario: Regression-free migration
- **WHEN** Claude or Codex is spawned and its output parsed after the table migration
- **THEN** the resulting argv and parsed `ExecutorEvent` sequence match the pre-migration fixtures exactly
