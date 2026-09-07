# agent-chain-builder Specification

## Purpose
Lets a user visually wire multiple role-bound agent sessions into a
reusable, savable pipeline (a "chain") — sequential handoffs and gated
loops across different agents — instead of hand-managing one thread at a
time.
## Requirements
### Requirement: Chains are named, reusable, project-scoped definitions
The system SHALL let a user build a chain in a visual DAG canvas and save
it by name at `.palisade/chains/<name>.json`, scoped to the current
project. A saved chain SHALL be invocable repeatedly without rebuilding it.

#### Scenario: Saving a chain
- **WHEN** a user finishes building a chain named "Design Loop" in the
  canvas and saves it
- **THEN** the system writes `.palisade/chains/design-loop.json` in the
  current project and the chain becomes invocable by name

#### Scenario: Chains do not cross projects
- **WHEN** a user opens a different project
- **THEN** chains saved in another project's `.palisade/chains/` are not
  available

### Requirement: A node binds a role and guideline text to a specific installed agent
Each chain node SHALL let the user assign a role name, free-text
role/system-prompt guideline instructions, and a specific installed agent
— selected explicitly by the user, not auto-detected.

#### Scenario: Assigning a role to an agent
- **WHEN** a user creates a node, names its role "designer", enters
  guideline text, and selects an installed agent for it
- **THEN** the node stores the role name, guideline text, and the selected
  agent's identity

### Requirement: A node's effective instruction combines its guideline, the chain's seed input, and upstream output
When a node executes, the system SHALL construct its instruction from
three parts: its own guideline text, the chain run's original seed input,
and the accumulated output of its upstream node(s).

#### Scenario: First node in a chain
- **WHEN** a chain run starts with seed input "build a settings page" and
  the first node has guideline text "you are the designer"
- **THEN** the node receives its guideline text plus the seed input, with
  no upstream output yet

#### Scenario: Downstream node in a chain
- **WHEN** a node runs after an upstream node has produced output
- **THEN** the node receives its own guideline text, the chain's original
  seed input, and the upstream node's output

### Requirement: A saved chain blocks its run if a bound agent is unavailable
If a chain node's bound agent is not installed or not on PATH when the
chain is run, the system SHALL block the run rather than substituting a
different agent, and SHALL surface which node and which agent is missing.

#### Scenario: Bound agent missing
- **WHEN** a user runs a chain whose "designer" node is bound to an agent
  that is no longer installed
- **THEN** the run does not start, and the system displays that the
  "designer" node's bound agent is unavailable, naming the agent

### Requirement: Forward edges are plain handoffs; loop-closing edges require a gate and an iteration cap
A non-loop (forward) edge in a chain SHALL be a plain handoff of output to
the next node, requiring no gate by default. A loop-closing edge (one that
returns execution to an earlier node in the same run) SHALL require
exactly one gate — either a named verify command or a human-approval step
— and SHALL require a configured maximum iteration count.

#### Scenario: Plain forward edge
- **WHEN** a chain has two nodes connected by a forward edge with no gate
  configured
- **THEN** the first node's output hands off to the second node
  automatically with no pause

#### Scenario: Loop edge without a gate is invalid
- **WHEN** a user connects a loop-closing edge without configuring a gate
  or an iteration cap
- **THEN** the system does not allow the chain to be saved as runnable
  until both are set

#### Scenario: Loop exits automatically on verify pass
- **WHEN** a loop-closing edge's verify command exits 0 during a run
- **THEN** the loop exits and execution proceeds past the loop

#### Scenario: Loop hits its iteration cap
- **WHEN** a loop-closing edge reaches its configured maximum iteration
  count without its gate passing
- **THEN** the run stops at that point and the stop reason is surfaced

### Requirement: Verify gates run the project's existing named verify commands
A verify-type gate SHALL run a named command from the project's existing
verify-command configuration and use its persisted exit code to decide
whether to advance — the same mechanism used elsewhere in the product for
verification, not a separate one.

#### Scenario: Verify gate passes
- **WHEN** a loop-closing edge's verify command exits 0
- **THEN** the gate passes and the run advances past the loop

#### Scenario: Verify gate fails
- **WHEN** a loop-closing edge's verify command exits non-zero and the
  iteration cap has not been reached
- **THEN** the loop repeats

### Requirement: Human-approval gates offer approve, reject, and send-back-with-note
A human-approval gate SHALL pause the run and present three actions:
approve (advance past the gate), reject (abort the run), and
send-back-with-note (re-run the upstream node with the human's note
appended as additional instruction).

#### Scenario: Approving a gate
- **WHEN** a user approves a paused human-approval gate
- **THEN** the run advances past that gate

#### Scenario: Rejecting a gate
- **WHEN** a user rejects a paused human-approval gate
- **THEN** the chain run aborts

#### Scenario: Sending back with a note
- **WHEN** a user sends back a paused human-approval gate with a note
- **THEN** the upstream node re-runs with the note appended to its
  instruction

### Requirement: Chain runs are bounded by a wall-clock timeout and per-node crash retries
A chain run SHALL have a wall-clock timeout, defaulting to 30 minutes and
configurable per chain. A node whose agent session crashes or errors
SHALL retry automatically up to a configured per-node retry count before
the run aborts; each retry SHALL start the node's session fresh rather
than continuing in a context that contains the failed attempt.

#### Scenario: Run exceeds its timeout
- **WHEN** a chain run's elapsed wall-clock time exceeds its configured
  timeout
- **THEN** the run aborts and the timeout is surfaced as the stop reason

#### Scenario: Node crashes and retries succeed
- **WHEN** a node's agent session crashes and its retry count has not been
  exhausted
- **THEN** the node retries with a fresh session and the run continues if
  the retry succeeds

#### Scenario: Node exhausts its retries
- **WHEN** a node's agent session crashes repeatedly until its configured
  retry count is exhausted
- **THEN** the run aborts and the exhausted-retries reason is surfaced

### Requirement: A chain can power a thread's go-mode execution without introducing a third mode
The system SHALL allow a saved chain to be selected as the execution
strategy behind a thread's "go" execution (including applying an OpenSpec
change), in place of a single agent session. This SHALL NOT introduce any
mode beyond the existing spec/go pair.

#### Scenario: Running go mode with a chain
- **WHEN** a thread's go-mode executor selection resolves to a saved chain
  instead of a single agent
- **THEN** the thread's go execution runs the chain, and the thread remains
  in "go" mode

### Requirement: A chain can be invoked mid-chat with a dedicated `|=` token
The system SHALL support invoking a saved chain mid-chat using
`|=<chain-name> <seed text>`, where the chain name is the first
whitespace-delimited token after `|=` and any trailing text becomes the
chain run's seed input. This token SHALL open the same fuzzy-searchable
popup menu used for existing skill/command sigils, listing saved chains
alongside agent-advertised commands, visually distinguished from them.

#### Scenario: Invoking a chain from chat
- **WHEN** a user types `|=design-loop build a settings page` and submits
- **THEN** the "design-loop" chain runs with "build a settings page" as
  its seed input

#### Scenario: Bare invocation with no seed text
- **WHEN** a user types `|=design-loop` alone and submits
- **THEN** the chain runs with an empty seed input

#### Scenario: Sigil menu lists chains
- **WHEN** a user types `|=` in the composer
- **THEN** a popup menu opens listing the project's saved chains, fuzzy
  filtered as the user continues typing, visually distinguished from
  agent-advertised skill commands

### Requirement: A running chain shows a live DAG view with per-node transcript access
While a chain runs, the system SHALL display its graph with nodes
reflecting their current execution state, and SHALL let the user open a
node's real session transcript. The invoking thread SHALL receive a
condensed summary message when the run finishes or pauses at an approval
gate.

#### Scenario: Watching a run
- **WHEN** a chain run is in progress
- **THEN** the live DAG view shows which node is currently executing and
  which have completed

#### Scenario: Opening a node's transcript
- **WHEN** a user clicks a node in the live DAG view
- **THEN** that node's actual session transcript opens

#### Scenario: Summary posted to the invoking thread
- **WHEN** a chain run invoked from a thread finishes or pauses at an
  approval gate
- **THEN** a condensed summary message appears in that thread

### Requirement: Chain runs do not persist across an app restart
The system SHALL treat an in-progress chain run, including one paused at
an approval gate, the same as any other interrupted session on app
restart — it does not resume automatically.

#### Scenario: App restarts mid-run
- **WHEN** the app restarts while a chain run is in progress or paused at
  a gate
- **THEN** the run is marked interrupted and does not resume; re-invoking
  the chain starts a new run

