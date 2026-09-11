## ADDED Requirements

### Requirement: A human-in-the-loop node's output is authored by the user
A chain node SHALL be either an agent node or a human node. A human node
SHALL NOT run an agent: it SHALL suspend the run, present its upstream
output and the chain's seed input, and accept free text from the user. That
text SHALL become the node's output and SHALL flow to downstream nodes
exactly as an agent node's output does. A human node SHALL be usable
anywhere an agent node is, including as a chain's entry node.

This is distinct from an approval gate, which lets a human judge a chain's
work but never contribute content to it.

#### Scenario: Human authors a node's output
- **WHEN** a run reaches a human node whose upstream node produced output
- **THEN** the run suspends, the upstream output is shown, and the user is
  asked for text

#### Scenario: The human's text flows downstream
- **WHEN** the user submits text at a suspended human node
- **THEN** the run resumes and the next node receives that text as its
  upstream output, indistinguishable in form from an agent node's output

#### Scenario: Human node as the entry node
- **WHEN** a chain's entry node is a human node and the run starts with a
  seed input
- **THEN** the run suspends immediately, shows the seed input, and the
  user's text becomes the first node's output

#### Scenario: Resolved at the same surface as an approval gate
- **WHEN** a run is suspended at a human node
- **THEN** it is resolved at the same place in the invoking surface where a
  paused approval gate is resolved, not at a separate one

#### Scenario: A saved chain with a human node still loads everywhere
- **WHEN** a chain saved before human nodes existed is opened or run
- **THEN** every node in it behaves as an agent node with no migration step
  and no user action

### Requirement: Where a chain run lives is decided by what started it
A chain run started **from a thread** — invoked inline with the `|=` token,
or by that thread's executor selection resolving to a saved chain — SHALL
run on that thread. These two invocations SHALL have identical effect; no
observable behaviour may depend on which of them was used.

A chain run started **from the chains panel** SHALL create its own thread,
named after the chain, and SHALL NOT run on whichever thread happened to be
focused.

#### Scenario: Inline invocation runs in place
- **WHEN** a user types `|=design-loop build a settings page` in a thread
- **THEN** the run executes on that thread

#### Scenario: Executor-selected chain runs in place
- **WHEN** a thread's executor selection resolves to a saved chain and the
  user starts go-mode execution
- **THEN** the run executes on that same thread

#### Scenario: The two in-thread invocations match
- **WHEN** the same chain and seed are run once via `|=` and once via the
  thread's executor selection
- **THEN** both runs are indistinguishable in where they run, what they
  surface, and what they record

#### Scenario: A panel run does not commandeer a thread
- **WHEN** a user starts a chain from the chains panel while a thread is
  focused
- **THEN** the run gets a new thread named after the chain, and the focused
  thread is left untouched

### Requirement: Past runs are reachable wherever a chain was invoked
The system SHALL make a chain's past run records reachable from the surface
the chain was invoked from, not only from the chains panel. Past runs SHALL
be collapsed by default so that invoking a chain does not flood the
surface with runs the user did not ask about.

#### Scenario: Past runs from a chat invocation
- **WHEN** a user invokes a chain from a thread and the run is displayed
- **THEN** that chain's past runs are reachable from the run's own display
  without leaving the thread

#### Scenario: Past runs are collapsed by default
- **WHEN** a chain run is displayed
- **THEN** its past runs are not expanded until the user asks for them

#### Scenario: Re-run reachable from a past run
- **WHEN** a user opens a past run from that surface
- **THEN** re-running it, including from a chosen node, is available there

### Requirement: Dragging a node moves it and never opens its editor
On the chain canvas, a pointer press-and-drag on a node SHALL move that
node and SHALL NOT open the node's editor when the pointer is released. A
press-and-release with no meaningful movement SHALL open the editor.

#### Scenario: Dragging a node
- **WHEN** a user presses a node, moves the pointer beyond the drag
  threshold, and releases
- **THEN** the node's position changes and no editor opens

#### Scenario: Clicking a node
- **WHEN** a user presses and releases a node without moving beyond the
  drag threshold
- **THEN** the node's editor opens and the node's position is unchanged

### Requirement: Saving a chain gives its tab the chain's identity
When a user saves a chain that was built in an unnamed tab, that tab SHALL
adopt the saved chain's name and identity. Opening the same chain again
SHALL surface the tab that already holds it rather than opening a second
one.

#### Scenario: Saving a new chain
- **WHEN** a user builds a chain named "Design Loop" in a new, unnamed tab
  and saves it
- **THEN** the tab is labelled with that chain's name

#### Scenario: Reopening a just-saved chain
- **WHEN** a user saves a new chain and then opens that same chain from the
  chains list
- **THEN** the already-open tab is surfaced and no duplicate tab is created

### Requirement: The chain builder explains itself in place
The system SHALL explain how chains work at the point of use rather than
only in external documentation. An empty chain canvas SHALL explain nodes,
edges, gates, and loops. The chains list with no saved chains SHALL explain
the build-then-run cycle and SHALL offer a worked example chain that can be
opened, read, and run. That example SHALL include a human-in-the-loop node.

The canvas SHALL also state how many of the chain's nodes can run at once,
so a user can tell whether the chain they built is sequential or parallel
without running it.

#### Scenario: Empty canvas teaches
- **WHEN** a user opens a chain canvas with no nodes on it
- **THEN** the canvas explains what nodes, edges, gates, and loops are

#### Scenario: Empty chains list offers an example
- **WHEN** a user opens the chains list in a project with no saved chains
- **THEN** it explains the build-then-run cycle and offers a worked example
  chain to open

#### Scenario: The worked example is runnable
- **WHEN** a user opens the offered example chain
- **THEN** it is a valid, runnable chain containing a human-in-the-loop node

#### Scenario: Canvas states the chain's width
- **WHEN** a user views a saved chain on the canvas
- **THEN** the canvas states how many of its nodes can run concurrently,
  including any configured cap

## MODIFIED Requirements

### Requirement: A node binds a role and guideline text to a specific installed agent
Each chain node SHALL let the user assign a role name and free-text
role/system-prompt guideline instructions. An **agent node** SHALL
additionally bind a specific installed agent — selected explicitly by the
user, not auto-detected. A **human node** SHALL bind no agent, and any
agent-specific configuration on it SHALL have no effect on a run.

A node with no explicit kind SHALL be an agent node, so that chains saved
before human nodes existed keep their meaning.

#### Scenario: Assigning a role to an agent
- **WHEN** a user creates a node, names its role "designer", enters
  guideline text, and selects an installed agent for it
- **THEN** the node stores the role name, guideline text, and the selected
  agent's identity

#### Scenario: Creating a human node
- **WHEN** a user creates a node and marks it as a human node
- **THEN** the node stores its role name and guideline text, and the user is
  not asked to bind an agent to it

#### Scenario: A chain saved before human nodes existed
- **WHEN** a chain saved with no node-kind information is loaded
- **THEN** every one of its nodes is an agent node and the chain runs
  unchanged

### Requirement: A saved chain blocks its run if a bound agent is unavailable
If a chain **agent** node's bound agent is not installed or not on PATH
when the chain is run, the system SHALL block the run rather than
substituting a different agent, and SHALL surface which node and which
agent is missing. Human nodes SHALL be excluded from this check, since they
bind no agent.

#### Scenario: Bound agent missing
- **WHEN** a user runs a chain whose "designer" node is bound to an agent
  that is no longer installed
- **THEN** the run does not start, and the system displays that the
  "designer" node's bound agent is unavailable, naming the agent

#### Scenario: A chain of only human nodes is not blocked
- **WHEN** a user runs a chain whose nodes are all human nodes
- **THEN** the availability check blocks nothing and the run starts

### Requirement: Chain runs are bounded by a wall-clock timeout and per-node crash retries
A chain run SHALL have a wall-clock timeout, defaulting to 30 minutes and
configurable per chain. This budget SHALL measure agent work only: it SHALL
NOT advance while the run is suspended waiting on a human — at a
human-in-the-loop node or at a human-approval gate — and SHALL resume when
the human responds. A run suspended on a human MAY therefore remain open
indefinitely.

A node whose agent session crashes or errors SHALL retry automatically up
to a configured per-node retry count before the run aborts; each retry
SHALL start the node's session fresh rather than continuing in a context
that contains the failed attempt.

#### Scenario: Run exceeds its timeout
- **WHEN** a chain run's accumulated agent-work time exceeds its configured
  timeout
- **THEN** the run aborts and the timeout is surfaced as the stop reason

#### Scenario: A run waiting on a human does not time out
- **WHEN** a run is suspended at a human-approval gate or a human node for
  longer than its configured timeout, and then the human responds
- **THEN** the run resumes rather than having aborted, and the time spent
  waiting is not counted against its budget

#### Scenario: Node crashes and retries succeed
- **WHEN** a node's agent session crashes and its retry count has not been
  exhausted
- **THEN** the node retries with a fresh session and the run continues if
  the retry succeeds

#### Scenario: Node exhausts its retries
- **WHEN** a node's agent session crashes repeatedly until its configured
  retry count is exhausted
- **THEN** the run aborts and the exhausted-retries reason is surfaced
