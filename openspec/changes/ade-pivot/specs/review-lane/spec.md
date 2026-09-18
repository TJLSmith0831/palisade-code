## Purpose

Gives a thread's diff a dedicated review surface that pairs it with verify evidence, so merge readiness is judged against recorded evidence rather than agent self-report.

## ADDED Requirements

### Requirement: Review lane combines diff, viewed state, and verify evidence
The system SHALL render a review lane per thread combining its diff (inline or side-by-side), a persisted per-file Viewed state, and a verify evidence strip showing the thread's most recent verify command, its commit, and its pass/fail/not-run result.

#### Scenario: Opening a thread's review lane
- **WHEN** the user opens a thread's review lane
- **THEN** the system shows its diff, each file's current Viewed state, and the verify evidence strip for that thread's current commit

#### Scenario: Marking a file viewed
- **WHEN** the user marks a file Viewed in the review lane
- **THEN** that file's Viewed state persists for the thread across reopening the review lane

### Requirement: Merge is gated on verify evidence
The system SHALL disable the review lane's Merge action unless the thread's most recent verify run passed at its current commit, or the user explicitly invokes an override.

#### Scenario: Merge blocked without a passing verify
- **WHEN** a thread has no passing verify run at its current commit
- **THEN** the Merge action is disabled, with the verify evidence strip explaining why

#### Scenario: Explicit override
- **WHEN** the user explicitly invokes the merge override on a thread without a passing verify
- **THEN** the system allows the merge but records that it was an override, not a verified merge

### Requirement: Keyboard file navigation
The review lane SHALL support j/k keyboard navigation between changed files without leaving the lane.

#### Scenario: Navigating files with the keyboard
- **WHEN** the user presses j or k while the review lane is focused
- **THEN** the lane moves to the next or previous changed file
