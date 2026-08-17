# graphify-integration Specification

## Purpose
Keeps palisade-code's code map current by correctly invoking the real
`graphify` CLI and continuously refreshing it in the background, instead
of requiring a manual run with an argument shape that doesn't match the
real tool.
## Requirements
### Requirement: Run Graphify against the active project
The system SHALL shell out to `graphify extract <project-dir> --out
<project-root> --code-only` (scoped to the active project's root, or a
user-selected subdirectory, as the extraction target — `--out` always
receives the project root itself, since the CLI writes its own nested
`graphify-out/` under whatever `--out` is given). On a successful
`extract`, the system SHALL follow with `graphify cluster-only
<project-root> --no-viz` to produce `GRAPH_REPORT.md` and community
labels — `extract` alone does not write a report. A failure at either
step SHALL be treated as a failed run (per "Surface run failures without
crashing" below).

#### Scenario: Running Graphify
- **WHEN** the user triggers a Graphify run from the results pane
- **THEN** the system spawns `graphify extract` with the active project
  (or selected subdirectory) as the target and the project root as
  `--out`, and on success spawns `graphify cluster-only <project-root>
  --no-viz`

#### Scenario: Toggling the deep-mode option
- **WHEN** the user enables the deep-mode toggle before running
- **THEN** the system adds `--mode deep` to the `extract` invocation

#### Scenario: Toggling the incremental option
- **WHEN** the user enables the incremental toggle before running with no
  subpath scope set
- **THEN** the system invokes `graphify update <project-dir>` instead of
  `graphify extract` (incremental rescanning is a separate subcommand, not
  an `extract` flag; unlike `extract`, `update` has no `--out` override,
  so its output always lands at `<project-dir>/graphify-out`, matching
  where the results pane reads from)

#### Scenario: Incremental is unavailable when a subpath is scoped
- **WHEN** the user has entered a subpath in the scope field
- **THEN** the incremental toggle is disabled, since `graphify update`
  cannot target a subdirectory while still writing to the project root's
  `graphify-out` that the results pane reads

### Requirement: Display Graphify results in a dedicated pane
The system SHALL read `GRAPH_REPORT.md` and `graph.json` from the output
directory after a successful run and render them in a results pane, with a
query surface for `graphify query`/`path`/`explain`.

#### Scenario: Viewing results after a run
- **WHEN** a Graphify run completes successfully
- **THEN** the system loads `GRAPH_REPORT.md` as a summary view and
  `graph.json` as an explorable, filterable graph in the results pane

#### Scenario: Querying the graph
- **WHEN** the user selects `query` or `explain` and submits a question
- **THEN** the system invokes `graphify <subcommand> "<question>" --graph
  <out-dir>/graph.json` and displays the result

#### Scenario: Finding a path between two nodes
- **WHEN** the user selects `path` and submits two node names
- **THEN** the system invokes `graphify path "<node-a>" "<node-b>" --graph
  <out-dir>/graph.json` and displays the result

### Requirement: Auto-inject a bounded report summary into the thread on a manual run
The system SHALL, after each successful manually-triggered Graphify run,
append a `role: "tool"` message to the active thread containing the first
4000 characters of `GRAPH_REPORT.md` and a note that the full report and
graph are available in the results pane.

#### Scenario: Summary injection after a manual run
- **WHEN** the user triggers a Graphify run from the results pane and it
  completes successfully
- **THEN** the system appends a `role: "tool"` JSONL message with the
  truncated report summary and a pointer to the full results pane

### Requirement: Surface run failures without crashing
The system SHALL surface a Graphify process failure (non-zero exit) as an
inline error in the results pane and SHALL NOT inject any message into the
thread for a failed run.

#### Scenario: Graphify process fails
- **WHEN** `graphify extract` (or `update`) exits non-zero
- **THEN** the system shows the process's stderr output in the results
  pane and does not append any message to the thread's session log

### Requirement: Keep the code map continuously up to date
The system SHALL run `graphify watch <project-root>` as a supervised
background process for the currently open project, starting automatically
when the project is opened or switched to, with no manual toggle. Code
changes detected by the watcher SHALL trigger an incremental rebuild and
refresh the results pane's `graph.json`/`GRAPH_REPORT.md` without user
action and without injecting any message into any thread.

#### Scenario: Opening a project starts the watcher
- **WHEN** the user opens or switches to a project
- **THEN** the system starts a `graphify watch` process scoped to that
  project's root, terminating any watcher for a previously active project

#### Scenario: A code change triggers a silent refresh
- **WHEN** the watcher detects a code file change and completes an
  incremental rebuild
- **THEN** the results pane's graph and report update automatically and
  no message is appended to any thread

#### Scenario: Switching away stops the watcher
- **WHEN** the user switches to a different project or closes the app
- **THEN** the system terminates the previous project's `graphify watch`
  process

### Requirement: Surface a missing or failing watcher as a warning, not a blocking error
The system SHALL treat an unavailable `graphify` binary, or a `graphify
watch` process that fails to start or crashes, as a non-blocking warning —
the rest of the app SHALL remain usable, and a manual "Run Graphify"
attempt SHALL still surface its own failure per the run-failure
requirement above.

#### Scenario: `graphify` is not installed
- **WHEN** the system attempts to start `graphify watch` and the binary
  cannot be found on PATH
- **THEN** the system shows a warning (consistent with the existing
  executor/openspec preflight warnings) and does not block any other app
  functionality

#### Scenario: The watcher process crashes after starting
- **WHEN** a running `graphify watch` process exits unexpectedly
- **THEN** the system shows a warning and does not attempt to inject
  anything into a thread or crash the app

