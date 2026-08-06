## Purpose

Lets the user remove threads they no longer need, without risking silent
data loss or corrupting an in-flight executor turn.

## ADDED Requirements

### Requirement: Delete a thread
The system SHALL allow deleting a thread from the thread list, permanently
removing its stored metadata (`<id>.meta.json`) and message log
(`<id>.jsonl`) from disk. There is no undo or recovery after deletion.

#### Scenario: Deleting a thread
- **WHEN** the user confirms deletion of a thread
- **THEN** the system removes that thread's metadata and log files from
  disk and the thread no longer appears in the thread list

### Requirement: Confirm before deleting
The system SHALL require an explicit confirmation step before deleting a
thread, using an in-app confirmation control (native browser `confirm()`
does not function in this app's webview).

#### Scenario: Requesting deletion
- **WHEN** the user initiates deleting a thread
- **THEN** the system shows an in-app confirmation before removing any
  files, and deletion proceeds only if the user confirms

#### Scenario: Cancelling deletion
- **WHEN** the user dismisses the confirmation without confirming
- **THEN** no files are removed and the thread remains unchanged

### Requirement: Block deleting a thread with an in-flight turn
The system SHALL refuse to delete a thread whose executor turn is
currently in flight.

#### Scenario: Attempting to delete a busy thread
- **WHEN** the user attempts to delete a thread that currently has an
  executor turn in progress
- **THEN** the system refuses the deletion and indicates the thread is
  busy, and no files are removed

#### Scenario: Deleting after the turn completes
- **WHEN** the in-flight turn on a thread finishes (successfully or via
  crash)
- **THEN** the thread becomes eligible for deletion

### Requirement: Fall back to another thread after deleting the active one
The system SHALL, when the deleted thread was the currently-open thread,
select the next remaining thread in the list, or show the empty
"create a thread to get started" state if none remain.

#### Scenario: Other threads remain
- **WHEN** the user deletes the currently-open thread and at least one
  other thread exists in the project
- **THEN** the system selects the next remaining thread in the list

#### Scenario: No threads remain
- **WHEN** the user deletes the currently-open thread and no other
  threads exist in the project
- **THEN** the system shows the empty "create a thread to get started"
  state
