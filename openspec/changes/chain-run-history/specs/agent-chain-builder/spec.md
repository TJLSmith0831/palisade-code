## MODIFIED Requirements

### Requirement: A chain run's history is persisted, and its process never auto-resumes across an app restart
The system SHALL persist an append-only history record for every chain
run — including one paused at an approval gate — under Palisade user
storage, never inside the target project's own file tree. The system
SHALL NOT automatically resume a chain run's process after an app
restart: an in-progress or gate-paused run left open when the app
restarts SHALL be reconciled and closed with an interrupted outcome, the
same treatment given to any other interrupted session.

#### Scenario: A run's history survives an app restart
- **WHEN** a chain run finishes, fails, or is cancelled
- **THEN** its history record — chain name, the chain definition as it
  stood at run time, seed, per-node timings and outputs, and the terminal
  outcome — remains readable after the app restarts

#### Scenario: App restarts mid-run
- **WHEN** the app restarts while a chain run is in progress or paused at
  a gate
- **THEN** the run's history record is closed with an interrupted outcome
  and does not resume; re-invoking the chain starts a new run

#### Scenario: Run history never leaks into the target project
- **WHEN** a chain run's history record is written
- **THEN** `git status` in the target project shows no new or modified
  files as a result

## ADDED Requirements

### Requirement: A run's history record snapshots the chain definition it ran
Every persisted chain-run record SHALL embed the chain definition exactly
as it was when the run started, distinct from the chain's current
definition on disk.

#### Scenario: Chain edited after a run
- **WHEN** a chain is edited after a run against it has finished
- **THEN** that run's history record still reflects the definition as it
  stood when the run started, not the edited definition

### Requirement: A run's history records reported cost without fabricating figures for agents that don't report one
Where a node's agent reports a real billed cost for its turn, the
system SHALL record it in that node's history entry. Where an agent does
not report a cost, the system SHALL leave that node's cost absent rather
than recording a zero value.

#### Scenario: A cost-reporting agent's node
- **WHEN** a node's agent reports a billed cost for its turn
- **THEN** that amount is recorded against the node in the run's history

#### Scenario: A non-cost-reporting agent's node
- **WHEN** a node's agent does not report a cost for its turn
- **THEN** that node's history entry records no cost value, distinguishable
  from a node that was billed nothing
