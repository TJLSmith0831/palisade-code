## MODIFIED Requirements

### Requirement: Multiple concurrent sessions
The system SHALL support more than one live session at a time, keyed by a unique session id, without terminating an unrelated session when a new one starts. Sessions on different threads in the same project SHALL run in that thread's own worktree, so no live-session collision condition exists between them.

#### Scenario: Two agents on one thread
- **WHEN** a session using one agent is live on a thread and the user starts a session using a different agent on the same thread
- **THEN** both sessions run concurrently in that thread's worktree, each with its own busy state, and neither is terminated by the other starting

#### Scenario: One agent across two threads
- **WHEN** a session is live on thread A and the user starts a new session on thread B
- **THEN** both sessions run concurrently, each in its own thread's worktree, and events route to their respective threads

#### Scenario: Two threads in the same project no longer collide
- **WHEN** a new session is started in a project where another session is already live on a different thread
- **THEN** the system starts the new session in its own thread's worktree with no warning, since the two sessions do not share a working tree
