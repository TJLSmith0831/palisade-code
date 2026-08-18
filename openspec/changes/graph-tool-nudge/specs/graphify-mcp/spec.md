## ADDED Requirements

### Requirement: Session-start graph tool instruction

The system SHALL instruct the agent, once per session, when to prefer the Graphify MCP
tools over a grep/read search. The instruction SHALL be injected by Palisade into the
session's first prompt — not delivered as a skill file the user must install — and SHALL
apply in both spec and go mode. Registering the MCP server alone does not satisfy this
requirement.

#### Scenario: First turn of a new session

- **WHEN** a session is created on a project where the Graphify MCP tools are usable, and
  the first prompt is sent to the agent
- **THEN** the prompt carries a graph-tool instruction ahead of the user's message

#### Scenario: Subsequent turns in the same session

- **WHEN** the user sends a second or later message to a session that already received the
  instruction
- **THEN** the instruction is not repeated

#### Scenario: Session started without an immediate prompt

- **WHEN** `/go` brings up a session without sending a turn
- **THEN** the instruction is held and carried on that session's next real turn, rather
  than being discarded

#### Scenario: Both modes

- **WHEN** a go-mode session is created on a project where the tools are usable
- **THEN** the instruction is injected, the same as in spec mode

### Requirement: Instruction gated on tool usability

The system SHALL suppress the graph-tool instruction unless the tools it describes are
actually callable: the MCP server binary resolves on PATH, the session's agent is one the
system registers MCP config for, and a built graph exists for the project. A suppressed
instruction SHALL be silent — no warning and no error.

#### Scenario: Graphify MCP server not installed

- **WHEN** `graphify-mcp` is not on PATH at session start
- **THEN** no instruction is injected and no warning is emitted

#### Scenario: Agent with no MCP registration path

- **WHEN** the session's agent is not one the system writes MCP config for
- **THEN** no instruction is injected

#### Scenario: Graph not yet built

- **WHEN** the project has no `graphify-out/graph.json` at session start
- **THEN** no instruction is injected, because every tool it names would fail

### Requirement: Instruction preserves non-graph search

The instruction SHALL name the MCP server's real tool names and SHALL state when the agent
should continue using grep and file reads, so that it routes structural questions to the
graph without displacing exact-text search or pre-edit file verification.

#### Scenario: Structural question

- **WHEN** the agent is asked what calls a function, how two components connect, or what a
  change would affect
- **THEN** the instruction directs it to the corresponding graph tool

#### Scenario: Exact-text or pre-edit read

- **WHEN** the agent needs a literal string match or the current contents of a file it is
  about to edit
- **THEN** the instruction directs it to grep and file reads, not the graph
