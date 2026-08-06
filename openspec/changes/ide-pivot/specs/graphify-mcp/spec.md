## Purpose

Gives the detected executor (Claude or Codex) access to Graphify's code knowledge graph as MCP tools during agent turns, so the agent queries the graph mid-turn instead of relying on a pre-injected summary.

## ADDED Requirements

### Requirement: Auto-registration on project load
The system SHALL idempotently register Graphify's MCP server with the detected executor when a project is loaded. Registration SHALL extend the existing per-project `graphify watch` startup path. The user SHALL NOT need to manually configure MCP to receive graph tools.

#### Scenario: Project with Graphify installed
- **WHEN** user opens a project where `graphify` is on PATH and a graph exists (or the watcher will build one)
- **THEN** the system ensures the Graphify MCP server is registered with the detected executor before the next agent turn

#### Scenario: Idempotent re-registration
- **WHEN** the system re-registers the MCP server on a project that already has it registered
- **THEN** no duplicate registration occurs and the existing registration is left intact

#### Scenario: Graphify not installed
- **WHEN** `graphify` is not on PATH at project load
- **THEN** the system skips MCP registration and surfaces the existing preflight warning (no new error)

### Requirement: Project-scoped MCP config
The system SHALL register the Graphify MCP server via a project-scoped config file (e.g. `.mcp.json` for Claude) in the project root, not via the user's home directory config. The config file SHALL be user-gitignoreable.

#### Scenario: Config file written to project root
- **WHEN** the system registers the Graphify MCP server for a Claude executor
- **THEN** a project-scoped MCP config file is written to the project root pointing at the Graphify MCP server

#### Scenario: User gitignores the config
- **WHEN** the user adds the MCP config file to their project's `.gitignore`
- **THEN** the system continues to function and re-creates the file if missing

### Requirement: Per-executor config shape
The system SHALL register the MCP server using the config mechanism appropriate to the detected executor. Claude and Codex have different MCP config formats; the system SHALL use the correct one for each.

#### Scenario: Claude executor detected
- **WHEN** the detected executor is Claude
- **THEN** the system registers Graphify MCP using Claude's project-scoped MCP config format

#### Scenario: Codex executor detected
- **WHEN** the detected executor is Codex
- **THEN** the system registers Graphify MCP using Codex's MCP config format

> Open: exact Codex MCP config shape to be verified at apply time (D21).

### Requirement: GraphPane unchanged
The system SHALL keep the existing human-facing GraphPane (code map visualization, query/path/explain) unchanged in behavior. MCP registration adds agent-facing graph tools; it does not alter the human-facing pane.

#### Scenario: GraphPane still works
- **WHEN** user opens the GraphPane after MCP registration
- **THEN** the pane behaves identically to before — run, query, path, explain, and report viewing all work as today
