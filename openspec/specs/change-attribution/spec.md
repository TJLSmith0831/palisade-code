# change-attribution Specification

## Purpose
Gives Floo an evidence-based way to answer "what changed during this session" using git state recorded at session boundaries, labeling anything short of that evidence (agent-reported file-edit hints) as a hint rather than proof — including honestly reporting ambiguity when concurrent sessions make exact attribution impossible.
## Requirements
### Requirement: Git state recorded at session boundaries
The system SHALL record the git `HEAD` commit and a working-tree status snapshot at both the start and end of a session.

#### Scenario: Session boundary snapshot
- **WHEN** a session starts and later ends
- **THEN** the session's record includes the git `HEAD` observed at start and at end

### Requirement: Committed changes are attributed exactly
The system SHALL attribute committed changes to a session by comparing its recorded `HEAD` before and after.

#### Scenario: Session that commits
- **WHEN** a session commits one or more changes during its run
- **THEN** its recorded `HEAD` before and after differ, and the commits between them are attributable to that session

#### Scenario: Session that commits nothing
- **WHEN** a session makes no commits during its run
- **THEN** its recorded `HEAD` before and after are identical

### Requirement: Uncommitted changes are attributed with explicit ambiguity under concurrency
The system SHALL attribute uncommitted (dirty) changes to a session via the working-tree status delta when no other session was live in the same project during that session's run. When another session was live concurrently in the same project, the system SHALL report attribution as ambiguous rather than guessing a split.

#### Scenario: No concurrent session
- **WHEN** a session runs alone in its project (no other live session shares the project root during its run)
- **THEN** the set of files that became dirty during its run is attributed to that session

#### Scenario: Concurrent sessions in the same project
- **WHEN** two or more sessions are live in the same project root at overlapping times
- **THEN** the uncommitted-change attribution for that period is reported as ambiguous, naming the number of overlapping sessions, rather than being split by heuristic

### Requirement: FileEdit paths are a labeled hint, not proof
The system SHALL present paths derived from `FileEdit` events as an agent-reported hint, distinct from and never merged into the git-derived evidence as if equally reliable.

#### Scenario: FileEdit hint displayed separately
- **WHEN** the UI shows what a session touched
- **THEN** paths sourced from `FileEdit` events are labeled as agent-reported, and paths sourced from git evidence are labeled distinctly as such

