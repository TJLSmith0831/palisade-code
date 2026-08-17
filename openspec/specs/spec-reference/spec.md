# spec-reference Specification

## Purpose
Replaces directory-diff inference for linking a thread to an OpenSpec change with direct queries to the `openspec` CLI, and adds a read-only view of spec state, without Palisade ever writing spec files or maintaining a second source of truth for spec content.
## Requirements
### Requirement: Spec change linkage is determined via the OpenSpec CLI
The system SHALL determine which OpenSpec change was newly created during a propose turn by querying `openspec list --json` before and after the turn, rather than diffing the changes directory.

#### Scenario: Single change created
- **WHEN** a propose turn results in exactly one new OpenSpec change
- **THEN** that change's name is linked to the originating thread

#### Scenario: Ambiguous result is surfaced, not dropped
- **WHEN** a propose turn results in more than one new OpenSpec change appearing
- **THEN** the system surfaces the ambiguity to the user rather than silently linking nothing

#### Scenario: OpenSpec binary unavailable
- **WHEN** the `openspec` binary is not available on the machine
- **THEN** the system degrades to the prior directory-diff behavior without erroring

### Requirement: Read-only spec pane
The system SHALL provide a view of an OpenSpec change's requirements, task counts, and validation status by querying the `openspec` CLI, without persisting spec content into Palisade's own store.

#### Scenario: Viewing a linked change
- **WHEN** the user views the spec pane for a thread with a linked OpenSpec change
- **THEN** the pane displays that change's task counts and validation status as reported by the `openspec` CLI

#### Scenario: Nothing written to Palisade's store
- **WHEN** the spec pane is viewed or refreshed
- **THEN** no spec content (proposal, design, tasks, decisions, or spec text) is written to `~/.palisade-code`

### Requirement: Task completion is labeled as self-reported
The system SHALL display OpenSpec task checkbox counts as agent-reported progress and SHALL NOT compute or display an aggregate "complete" or "satisfied" claim derived solely from those counts.

#### Scenario: Task counts shown without a completeness claim
- **WHEN** an OpenSpec change reports all tasks checked
- **THEN** the UI displays the task counts as reported, without asserting the change or spec is "complete" or "done"

