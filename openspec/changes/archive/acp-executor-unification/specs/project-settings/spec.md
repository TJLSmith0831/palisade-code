## MODIFIED Requirements

### Requirement: Executor override

The system SHALL support an `executorOverride` key that sets the default executor for this project, resolved against discovered ACP registry agent ids. New threads in the project SHALL default to the override; the user can still switch per-thread via the picker. An override naming an agent not discovered on the machine SHALL produce a warning and fall back to the first available agent.

#### Scenario: Override to a specific executor

- **WHEN** `executorOverride` is set to a discovered ACP agent id and the user opens the project on a machine where a different agent would normally be the default
- **THEN** the system uses the overridden agent as the default for new threads in this project

#### Scenario: Override to an unavailable executor

- **WHEN** `executorOverride` is set to an agent id that is not discovered on the machine
- **THEN** the system surfaces a warning and falls back to the first available discovered agent

#### Scenario: No override

- **WHEN** `executorOverride` is absent
- **THEN** the system uses the first available discovered ACP agent as the default for new threads
