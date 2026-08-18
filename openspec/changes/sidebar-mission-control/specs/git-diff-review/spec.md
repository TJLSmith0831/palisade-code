## ADDED Requirements

### Requirement: Diff view switches between inline and side-by-side
The diff view SHALL offer both a unified (inline) and a side-by-side presentation, and SHALL remember the reader's choice across files and app restarts.

#### Scenario: Switching to side-by-side
- **WHEN** the reader selects the side-by-side view
- **THEN** each changed region shows the old file's lines on the left and the new file's on the right, and the unified view is no longer shown

#### Scenario: A replaced block reads as a replacement
- **WHEN** a run of removed lines is immediately followed by a run of added lines
- **THEN** in side-by-side the old and new versions of each line sit on the same row, and where the runs are uneven the shorter side shows a blank cell

#### Scenario: Choice persists
- **WHEN** the reader picks a view and later reopens the diff
- **THEN** the previously chosen view is still in effect

### Requirement: Diff rows carry line numbers
The diff view SHALL show each line's number in the old and new file, taken from the hunk header, and SHALL leave the number blank on the side where a line does not exist.

#### Scenario: Added and removed lines
- **WHEN** a hunk contains an added line and a removed line
- **THEN** the added line shows only a new-file number and the removed line shows only an old-file number

### Requirement: A thread's changes are shown while its agent works
The system SHALL show the open thread's worktree diff in the code area when a turn starts on that thread, so a user reading the conversation also sees the edits landing.

#### Scenario: Turn starts
- **WHEN** an agent turn starts on the open thread in the Vibe shell
- **THEN** the code area shows that thread's worktree diff without the user opening it

#### Scenario: Reader closes it mid-turn
- **WHEN** the user closes the diff while a turn is still running
- **THEN** it stays closed for the rest of that turn

#### Scenario: Diff follows the agent's edits
- **WHEN** the agent writes further changes during a turn
- **THEN** the shown diff and the thread's change counts update without user action

### Requirement: Reviewing a thread's worktree is read-only
The diff view SHALL NOT offer staging, discarding, or committing while it is showing a thread's worktree, because those act on the project's own working tree.

#### Scenario: Viewing a thread's worktree
- **WHEN** the diff view is showing a thread's isolated worktree
- **THEN** no stage, unstage, or discard control is offered

#### Scenario: Viewing the project's own tree
- **WHEN** the diff view is showing the project's working tree
- **THEN** staging and discarding are offered as before
