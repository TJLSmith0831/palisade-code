## Purpose

Gives every thread its own git worktree and branch so concurrent threads in the same project never edit the same working tree, replacing a passive collision warning with real isolation.

## ADDED Requirements

### Requirement: Thread gets a dedicated worktree on first session start
The system SHALL create a git worktree and branch for a thread the first time a session is started on it, and SHALL reuse that same worktree for every subsequent session on the thread.

#### Scenario: First session on a new thread
- **WHEN** the user starts the first session on a thread whose project is a git repository
- **THEN** the system creates a new worktree and branch for that thread and spawns the session's process with that worktree as its working directory

#### Scenario: Subsequent sessions reuse the worktree
- **WHEN** the user starts a second or later session on a thread that already has a worktree
- **THEN** the system spawns the new session in the thread's existing worktree without creating another one

### Requirement: Worktree path and branch are persisted on thread metadata
The system SHALL record a thread's worktree path and branch name in its persisted metadata so they survive an application restart.

#### Scenario: Restart with an existing worktree thread
- **WHEN** the application restarts and the user opens a thread that already has a worktree
- **THEN** the system reuses the recorded worktree path for the next session on that thread instead of creating a new one

### Requirement: Two threads in the same project never share a working tree
The system SHALL NOT allow two live sessions in different threads of the same project to run against the same working tree.

#### Scenario: Two threads, same project
- **WHEN** the user starts sessions on two different threads that both belong to the same project
- **THEN** each session runs in its own thread's worktree, and edits made by one are not visible as uncommitted changes in the other's working tree

### Requirement: Worktree cleaned up when its thread is archived or deleted
The system SHALL remove a thread's worktree when the thread is deleted, and SHALL leave the worktree in place (but no longer spawn sessions into it) when the thread is only archived.

#### Scenario: Deleting a thread with a worktree
- **WHEN** the user deletes a thread that has a worktree
- **THEN** the system removes the worktree (`git worktree remove`) in addition to the thread's metadata and message log

#### Scenario: Archiving a thread with a worktree
- **WHEN** the user archives a thread that has a worktree
- **THEN** the worktree is left on disk with its uncommitted changes intact, and no new session is spawned into it while the thread stays archived

### Requirement: Worktree creation failure does not block starting a session
The system SHALL fall back to the project's primary working tree, with a surfaced warning, if worktree creation fails (e.g. project is not a git repository, or the branch name collides).

#### Scenario: Non-git project
- **WHEN** the user starts a session on a thread whose project root is not a git repository
- **THEN** the system starts the session in the project root directly, without attempting worktree creation or surfacing an isolation warning
