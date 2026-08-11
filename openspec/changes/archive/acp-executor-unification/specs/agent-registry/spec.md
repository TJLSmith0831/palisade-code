## MODIFIED Requirements

### Requirement: Agents are discovered at runtime via the ACP Registry

The system SHALL discover known agents at runtime by fetching the ACP Registry and cross-referencing each entry's invocation command against PATH, not by a compiled-in table. Adding a new agent requires no code changes — the agent appears when its registry entry is fetched and its invocation command resolves on PATH.

#### Scenario: Adding a new agent requires no recompile

- **WHEN** a new ACP-compatible agent is installed on the machine and listed in the ACP Registry
- **THEN** it is discovered, selectable, spawnable, and its events render correctly, with no code changes required in Floo

#### Scenario: Agent appears when installed

- **WHEN** an agent's invocation command is not on PATH and the user installs it
- **THEN** a registry refresh makes that agent appear in the available list

### Requirement: Preflight reports agents as a list from the registry

The system SHALL report agent availability as a list of per-agent status entries derived from the ACP Registry, each indicating whether the invocation command was found on PATH. The list SHALL include registry metadata (id, name, version). Floo-level tool checks (`openspec`, `graphify`) SHALL remain; per-agent skill and plugin checks SHALL NOT be performed.

#### Scenario: Preflight status is iterable

- **WHEN** the frontend receives a preflight result
- **THEN** it can render the status of every discovered agent by iterating a list, without referencing any agent by a hardcoded name

#### Scenario: Floo-level tools checked

- **WHEN** preflight runs
- **THEN** the system checks for `openspec` and `graphify` on PATH and surfaces warnings if they are missing

### Requirement: Unknown executor override warns instead of discarding settings

The system SHALL validate a project's executor override against the discovered ACP registry agents by id. An override naming an agent not discovered on the machine SHALL produce a warning and fall back to the first available agent, without discarding the rest of the project's settings.

#### Scenario: Unknown override name

- **WHEN** `.project-settings.json` specifies an `executorOverride` that does not match any discovered agent id
- **THEN** the system warns and falls back to the first available discovered agent, and all other settings remain intact

#### Scenario: Known override name

- **WHEN** `.project-settings.json` specifies an `executorOverride` matching a discovered agent id
- **THEN** that agent is used as the default for new threads in the project

### Requirement: Tool naming is agent-scoped

The system SHALL treat a `ToolCall`/`ToolResult` event's tool name as verbatim from the originating ACP agent, and SHALL NOT apply one agent's tool-naming convention when parsing another agent's output.

#### Scenario: Non-Claude agent uses its own tool names

- **WHEN** a non-Claude ACP agent's `tool_call_update` produces a `ToolCall` event
- **THEN** the tool name reflects that agent's own vocabulary rather than being coerced into Claude's naming

## REMOVED Requirements

### Requirement: Existing agent behavior is unchanged

**Reason**: The compiled-in `KNOWN_AGENTS` table and proprietary stream-json parsers are replaced by a single ACP client. Claude and Codex now run via their ACP adapters, not their native CLI binaries, so byte-identical argv and parsed events are no longer guaranteed or relevant.
**Migration**: Claude and Codex sessions are spawned via `@agentclientprotocol/claude-agent-acp` and `@agentclientprotocol/codex-acp` respectively. Existing session history records retain their original `agent_id` values as historical data; new sessions use ACP registry agent ids.
