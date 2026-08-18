## MODIFIED Requirements

### Requirement: Delete a thread
The system SHALL allow deleting a thread from the thread list, permanently
removing its stored metadata (`<id>.meta.json`) and message log
(`<id>.jsonl`) from disk, and removing its git worktree if it has one.
There is no undo or recovery after deletion.

#### Scenario: Deleting a thread
- **WHEN** the user confirms deletion of a thread
- **THEN** the system removes that thread's metadata and log files from
  disk and the thread no longer appears in the thread list

#### Scenario: Deleting a thread with a worktree
- **WHEN** the user confirms deletion of a thread that has a git worktree
- **THEN** the system removes the worktree in addition to the thread's
  metadata and log files
