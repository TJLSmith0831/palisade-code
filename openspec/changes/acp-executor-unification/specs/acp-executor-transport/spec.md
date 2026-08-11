## Purpose

Provides a single ACP (Agent Client Protocol) transport for all executors — discovering agents via the ACP Registry, managing session lifecycle over JSON-RPC 2.0 stdio, mapping ACP events into Floo's ExecutorEvent stream, handling permission requests per spec/go/bypass policy, and reporting context-window usage from ACP usage_update notifications.

## ADDED Requirements

### Requirement: Executors are discovered at runtime via the ACP Registry

The system SHALL discover available executors by fetching the ACP Registry (one `agent.json` manifest per agent), caching it locally under `~/.floo-network/acp-registry/` with a TTL, and cross-referencing each entry's invocation command against PATH. Agents not found on PATH SHALL NOT appear in the available list. A manual config fallback SHALL allow registering agents not present in the registry.

#### Scenario: Registry fetch and cache

- **WHEN** the system starts or the user refreshes the agent list
- **THEN** the system fetches `agent.json` manifests from the ACP Registry, caches them locally with a 24-hour TTL, and returns the list of agents whose invocation command resolves on PATH

#### Scenario: Registry fetch fails

- **WHEN** the registry fetch fails and a cached copy exists
- **THEN** the system uses the cached copy without error

#### Scenario: Registry fetch fails with no cache

- **WHEN** the registry fetch fails and no cached copy exists
- **THEN** the system shows only manually-configured agents, or none if none are configured

#### Scenario: Agent not on PATH

- **WHEN** a registry entry's invocation command does not resolve on PATH
- **THEN** that agent is excluded from the available list

#### Scenario: Manual config fallback

- **WHEN** an agent is not in the ACP Registry but is declared in a local config file
- **THEN** the system includes it in the available list if its invocation command resolves on PATH

### Requirement: ACP session lifecycle

The system SHALL manage executor sessions using the ACP protocol: connect to the agent process via stdio, call `initialize` to negotiate capabilities, call `session/new` to create a session, call `session/prompt` to send user turns, and call `session/cancel` to terminate. The `agent-client-protocol` Rust crate SHALL be used for JSON-RPC transport and notification dispatch.

#### Scenario: Starting a session

- **WHEN** the system starts a new executor session for a thread
- **THEN** it spawns the agent process per the registry entry's invocation command, performs the ACP `initialize` handshake, and calls `session/new` with the project root as the working directory

#### Scenario: Sending a turn

- **WHEN** the user sends a message to a live session
- **THEN** the system calls `session/prompt` with the message text

#### Scenario: Terminating a session

- **WHEN** the user cancels a session or the session is released
- **THEN** the system calls `session/cancel` and closes the stdio transport

### Requirement: ACP events are mapped into ExecutorEvent

The system SHALL map ACP `session/update` notifications into the existing `ExecutorEvent` enum. `message_update` SHALL map to `Text` or `Reasoning` (with delta variants for partial updates). `tool_call_update` SHALL map to `ToolCall` and `ToolResult`. The session stop reason SHALL map to `Done` (normal stop) or `Crashed` (error/abnormal exit). `plan_update` notifications SHALL be ignored. The existing `ExecutorEvent` variants and the `Envelope` wrapping (session_id, thread_id) SHALL remain unchanged.

#### Scenario: Assistant text maps to Text event

- **WHEN** an ACP `message_update` notification carries assistant text content
- **THEN** the system emits a `Text` `ExecutorEvent` wrapped in the session's `Envelope`

#### Scenario: Tool call maps to ToolCall and ToolResult

- **WHEN** an ACP `tool_call_update` notification reports a tool call starting and then completing
- **THEN** the system emits a `ToolCall` event followed by a `ToolResult` event, both wrapped in the session's `Envelope`

#### Scenario: Normal stop maps to Done

- **WHEN** a session's `session/prompt` response returns with a normal stop reason
- **THEN** the system emits a `Done` `ExecutorEvent`

#### Scenario: Abnormal exit maps to Crashed

- **WHEN** the agent process exits unexpectedly or the stop reason indicates an error
- **THEN** the system emits a `Crashed` `ExecutorEvent` with the exit code and message

### Requirement: Permission requests are handled per spec/go/bypass policy

The system SHALL respond to ACP `permission_request` notifications according to the session's mode and bypass state, using the ACP tool-call `kind` taxonomy. In spec-mode, `read`/`search`/`think`/`fetch` tool kinds SHALL be auto-approved; `edit`/`delete`/`move`/`execute` SHALL be auto-denied. In go-mode, `read`/`search`/`think`/`fetch`/`edit`/`move` SHALL be auto-approved; `execute` and `delete` SHALL prompt the user. When bypass is enabled, all tool kinds SHALL be auto-approved regardless of mode. Tool kinds that are ambiguous or `other` SHALL prompt the user.

#### Scenario: Spec-mode denies file edits

- **WHEN** a session in spec-mode receives a permission request for an `edit` tool kind
- **THEN** the system auto-denies the request without prompting the user

#### Scenario: Go-mode approves file edits

- **WHEN** a session in go-mode receives a permission request for an `edit` tool kind
- **THEN** the system auto-approves the request without prompting the user

#### Scenario: Go-mode prompts for shell execution

- **WHEN** a session in go-mode receives a permission request for an `execute` tool kind
- **THEN** the system prompts the user to approve or deny the request

#### Scenario: Bypass approves everything

- **WHEN** a session with bypass enabled receives a permission request for any tool kind
- **THEN** the system auto-approves the request regardless of mode

#### Scenario: Ambiguous tool kind prompts

- **WHEN** a session receives a permission request for an `other` or unrecognized tool kind
- **THEN** the system prompts the user to approve or deny the request

### Requirement: Context-window usage is reported from ACP usage_update

The system SHALL consume ACP `usage_update` notifications (carrying `used` and `size` token counts) and expose them to the frontend for a context-usage donut chart. The chart SHALL render `used / size` as a percentage with color thresholds: green below 60%, amber 60–85%, red above 85%. Agents that do not send `usage_update` SHALL show an "unknown" state.

#### Scenario: Usage updates render in the donut

- **WHEN** a session receives a `usage_update` notification with `used` and `size`
- **THEN** the frontend renders a donut chart showing the percentage of context used, colored by threshold

#### Scenario: Agent does not report usage

- **WHEN** a session's agent does not send `usage_update` notifications
- **THEN** the frontend shows an "unknown" state for context usage

### Requirement: Mid-thread executor switch with context handoff

The system SHALL allow the user to switch executors on the current thread. Switching starts a fresh ACP session with the new agent and passes the previous conversation turns as a raw-text transcript (formatted as `User: ...\nAssistant: ...\n`) followed by the user's new message, as the new session's first `session/prompt`. The transcript SHALL be token-budget-bounded: the system opens the new session, reads the `size` from the first `usage_update`, estimates the transcript's token count with a `chars / 4` heuristic, and includes turns most-recent-first until the budget is approached. A confirmation dialog SHALL be shown before the handoff, explaining that the new agent starts a fresh session and the previous turns are passed as context.

#### Scenario: Switch with confirmation

- **WHEN** the user selects a different executor for a thread that has previous turns
- **THEN** the system shows a modal warning dialog explaining the handoff, and only proceeds after explicit user confirmation

#### Scenario: Handoff passes transcript as context

- **WHEN** the user confirms an executor switch
- **THEN** the system opens a new ACP session with the new agent, formats the previous turns as a raw-text transcript, bounds it to the token budget, and sends it as the first `session/prompt` along with the user's new message

#### Scenario: Switch with no previous turns

- **WHEN** the user switches executors on a thread with no previous turns
- **THEN** the system starts a new ACP session without a confirmation dialog or transcript handoff

#### Scenario: Token budget drops older turns

- **WHEN** the transcript's estimated token count exceeds the new agent's context window budget
- **THEN** the system drops the oldest turns (most-recent-first inclusion) until the transcript fits within the budget

### Requirement: Executor selection persists as a per-project default

The system SHALL support a per-project default executor via `executorOverride` in `.project-settings.json`, resolved against discovered ACP registry agent ids. New threads in the project SHALL default to the override. The user can still switch per-thread via the picker. An override naming an agent not discovered on the machine SHALL produce a warning and fall back to the first available agent.

#### Scenario: Override sets default executor

- **WHEN** `executorOverride` is set to a discovered agent id and the user creates a new thread
- **THEN** the new thread defaults to that executor

#### Scenario: Override names unavailable agent

- **WHEN** `executorOverride` names an agent not discovered on the machine
- **THEN** the system warns and falls back to the first available agent

#### Scenario: No override

- **WHEN** `executorOverride` is absent
- **THEN** new threads default to the first available discovered agent

### Requirement: Grill skills are baked into Floo and injected per-mode

The system SHALL include the four grill skills (explore, propose, apply, archive) as built-in resources, not installed in each ACP agent's own skill system. The system SHALL inject the relevant skill's instructions into every `session/prompt` based on the thread's mode: spec-mode injects `grill-explore` (or `grill-propose` if an OpenSpec change already exists for the thread); go-mode injects `grill-apply`. The skill instructions SHALL be prepended to the user's message text. `grill-archive` SHALL be triggered by a UI action, not by mode. The ACP agent receives the skill content as part of the prompt text — no reliance on the agent's native skill system.

#### Scenario: Spec-mode injects grill-explore

- **WHEN** the user sends a message in spec-mode and no OpenSpec change exists for the thread
- **THEN** the system prepends `grill-explore` skill instructions to the message and sends the combined text as the `session/prompt`

#### Scenario: Spec-mode injects grill-propose when change exists

- **WHEN** the user sends a message in spec-mode and an OpenSpec change already exists for the thread
- **THEN** the system prepends `grill-propose` skill instructions to the message and sends the combined text as the `session/prompt`

#### Scenario: Go-mode injects grill-apply

- **WHEN** the user sends a message in go-mode
- **THEN** the system prepends `grill-apply` skill instructions to the message and sends the combined text as the `session/prompt`

#### Scenario: Grill-archive is a UI action

- **WHEN** the user triggers archive from the UI for a completed change
- **THEN** the system injects `grill-archive` skill instructions into the session prompt

#### Scenario: No per-agent skill installation required

- **WHEN** the user switches to an ACP agent that has no grill skills installed in its own skill system
- **THEN** the grill skills still function because they are injected by Floo, not by the agent

### Requirement: openspec CLI commands are whitelisted in all modes

The system SHALL auto-approve ACP permission requests for `openspec` commands (list, show, validate, new, status) in all modes, including spec-mode where `execute` tool kinds are normally auto-denied. This whitelist is required because the grill skills shell out to `openspec` to read and validate changes.

#### Scenario: openspec approved in spec-mode

- **WHEN** a session in spec-mode receives a permission request for an `execute` tool kind running an `openspec` command
- **THEN** the system auto-approves the request despite spec-mode's default deny for `execute`

#### Scenario: Non-openspec execute still denied in spec-mode

- **WHEN** a session in spec-mode receives a permission request for an `execute` tool kind running a command that is not `openspec`
- **THEN** the system auto-denies the request per the normal spec-mode policy
