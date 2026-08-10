# store-integrity Specification

## Purpose
Fixes confirmed live data-integrity defects in the append-only store — test writes leaking into the real `~/.floo-network`, an unreconciled project index, an O(n²) message-append path, and unbounded persisted payloads — so the structural changes in the rest of this change land on a store that behaves correctly.
## Requirements
### Requirement: Sessions carry their own `floo_home`
The system SHALL resolve the store home directory from the `Session` that owns a write, not from a global lookup, so that a session started against a non-default home (e.g. a test fixture directory) never writes outside it.

#### Scenario: Codex session with a tempdir home
- **WHEN** a Codex session is started with `floo_home` pointing at a tempdir
- **THEN** every write performed during that session's turns (including the per-turn spawn path) lands only inside that tempdir, and the real `~/.floo-network` is untouched

### Requirement: Project index reconciliation
The system SHALL reconcile `projects.json` against the `projects/` directory on listing, adopting any directory containing a valid `project.json` that is missing from the index.

#### Scenario: Orphaned project directory
- **WHEN** `list_projects` is called and `projects/<hash>/project.json` exists but `<hash>` is absent from `projects.json`
- **THEN** the project is adopted into the returned list and the index is updated to include it

#### Scenario: Directory without a valid project.json
- **WHEN** a directory under `projects/` has no `project.json` or an unparseable one
- **THEN** it is left out of the returned list and is not adopted

### Requirement: O(1) message append sequencing
The system SHALL NOT re-read an entire thread log to compute the next message sequence number on every append.

#### Scenario: High-volume append sequence
- **WHEN** 500 messages are appended in sequence to one thread log
- **THEN** each message's `seq` is monotonically increasing with no gaps or duplicates, and appends do not re-read the full log each time

### Requirement: Capped persisted payload size
The system SHALL cap the persisted size of `FileEdit.before`, `FileEdit.after`, and `ToolResult.output` at 64 KB, replacing content beyond that bound with a truncation marker in the durable log. The live-emitted event SHALL retain the full, untruncated payload.

#### Scenario: Large file rewrite persisted
- **WHEN** a `FileEdit` event carries an `after` payload larger than 64 KB
- **THEN** the copy written to the thread's JSONL log is truncated at 64 KB with a truncation marker, while the event delivered to the live UI contains the full content

#### Scenario: Test suite does not grow the real store
- **WHEN** the Rust test suite (`cargo test`) runs to completion
- **THEN** the count of directories under the real `~/.floo-network/projects/` is unchanged before and after the run

