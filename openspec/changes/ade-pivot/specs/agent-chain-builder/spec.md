## MODIFIED Requirements

### Requirement: Playbooks are named, reusable, project-scoped definitions
The system SHALL let a user build a playbook (formerly "chain") in a visual DAG canvas and save it by name, scoped to the current project. A saved playbook SHALL be invocable repeatedly without rebuilding it, and a run of it SHALL appear on the fleet board as a fleet row with the same status, diff, and verify signals as any other thread.

#### Scenario: Saving a playbook
- **WHEN** a user finishes building a playbook named "Design Loop" in the canvas and saves it
- **THEN** the system persists it under the current project and the playbook becomes invocable by name

#### Scenario: Playbooks do not cross projects
- **WHEN** a user opens a different project
- **THEN** playbooks saved in another project are not available

#### Scenario: A playbook run appears on the fleet board
- **WHEN** the user launches a saved playbook from the fleet board
- **THEN** the run appears as a fleet row showing status, agent, diff stat, and verify evidence like any other thread
