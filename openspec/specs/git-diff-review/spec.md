# git-diff-review Specification

## Purpose
Lets users review working-tree changes, stage and unstage individual hunks, and commit — all without leaving the IDE.
## Requirements
### Requirement: Working-tree diff view
The system SHALL display the diff of the working tree against `HEAD` in the diff pane. The diff SHALL be computed and rendered at hunk granularity, using the project's existing Dragon Fire diff color tokens.

#### Scenario: View uncommitted changes
- **WHEN** user opens the diff tab with uncommitted changes present
- **THEN** the diff pane lists each modified file and its hunks, with added lines in the addition color and removed lines in the deletion color

#### Scenario: No changes
- **WHEN** user opens the diff tab with a clean working tree
- **THEN** the diff pane shows an empty state ("No file changes yet.")

### Requirement: Per-hunk stage and unstage
The system SHALL allow the user to stage and unstage individual hunks. Staging a hunk SHALL apply just that hunk to the index; unstaging SHALL remove just that hunk from the index.

#### Scenario: Stage a single hunk
- **WHEN** user clicks the stage control on an unstaged hunk
- **THEN** only that hunk is added to the index and the hunk's UI reflects its staged state

#### Scenario: Unstage a single hunk
- **WHEN** user clicks the unstage control on a staged hunk
- **THEN** only that hunk is removed from the index and the hunk's UI reflects its unstaged state

#### Scenario: Stage all hunks in a file
- **WHEN** user clicks a "stage all" control for a file
- **THEN** all of that file's unstaged hunks are added to the index

### Requirement: Commit box
The system SHALL provide a commit box where the user enters a commit message and commits the staged changes. v1 supports message + commit only — no amend, author override, or signoff.

#### Scenario: Commit staged changes
- **WHEN** user enters a commit message and clicks commit with hunks staged
- **THEN** the system creates a commit with the staged changes and the entered message, and the diff pane updates to reflect the new HEAD

#### Scenario: Commit with nothing staged
- **WHEN** user clicks commit with no hunks staged
- **THEN** the system refuses and shows a message indicating there is nothing staged to commit

#### Scenario: Empty commit message
- **WHEN** user clicks commit with an empty message
- **THEN** the system refuses and indicates a message is required

### Requirement: Git operations via shell-out
The system SHALL perform git operations by invoking the `git` CLI from the Rust backend. v1 commands: `git diff`, `git diff --cached`, `git status`, `git apply --cached`, `git restore --staged`, `git commit -m`.

#### Scenario: Git not on PATH
- **WHEN** the system attempts a git operation and `git` is not on PATH
- **THEN** the diff pane shows an error indicating git is required and not found

### Requirement: Diff pane scope
The system SHALL show only working-tree changes vs `HEAD` in v1. Branch switching, blame, and log graph are not provided.

#### Scenario: No branch operations
- **WHEN** user is in the diff pane
- **THEN** there is no UI for switching branches, viewing blame, or viewing the commit log graph

