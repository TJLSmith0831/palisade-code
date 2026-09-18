## Purpose

Gives a developer running several agents at once a single home view of every thread and its worktree, so what needs attention is visible without opening each thread individually.

## ADDED Requirements

### Requirement: Fleet board is the project home view
The system SHALL render a fleet board as the default view when a project opens, listing every thread in the project grouped by status: Needs attention, Running, Idle.

#### Scenario: Opening a project
- **WHEN** the user opens a project
- **THEN** the fleet board renders as the landing view, with threads grouped under Needs attention, Running, and Idle

### Requirement: Each row surfaces status, agent, diff, and verify signals
Each fleet board row SHALL show the thread's agent, project and branch, diff stat (files/added/removed), a verify badge worded from actual verify evidence (pass, fail, or not run — never "complete" on any other basis), and a cross-thread file overlap warning when the thread's changed files intersect another live thread's in the same project.

#### Scenario: Row with recorded verify evidence
- **WHEN** a thread's most recent verify run passed at its current commit
- **THEN** its fleet row shows a pass-worded verify badge citing that command and commit

#### Scenario: Row with no verify run yet
- **WHEN** a thread has never had a verify command run at its current commit
- **THEN** its fleet row shows a "not run" verify badge, never a pass or complete badge

#### Scenario: Two threads editing the same file
- **WHEN** two live threads in the same project have both touched the same file in their uncommitted diffs
- **THEN** both threads' fleet rows show an overlap warning naming the other thread

### Requirement: Row actions reach the thread without leaving the board
Each row SHALL offer actions to open the thread, open its review lane, stop its live session, merge it (subject to the review lane's merge gate), open a PR, or archive it.

#### Scenario: Reviewing from the board
- **WHEN** the user selects a row's Review action
- **THEN** the system opens that thread's review lane

### Requirement: New runs start from the fleet board
The fleet board SHALL offer a composer that starts a new thread with a prompt, agent selection, and mode in a single step, creating the thread's isolated worktree as part of starting it.

#### Scenario: Starting a new run
- **WHEN** the user enters a prompt, picks an agent and mode, and submits the fleet board's composer
- **THEN** a new thread is created with its own worktree and appears on the fleet board once its session starts
