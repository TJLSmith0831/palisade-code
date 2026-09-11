## Context

See `proposal.md` — Why. The constraints that shape the approach, all
verified in source:

- `chain_runner.rs` is generic over `NodeRunner`/`GateEvaluator` (D26)
  precisely so the state machine is testable without a live agent.
  Anything that is a *scheduling* fact belongs in the trait surface;
  anything that is an *agent* fact belongs in `chain_exec.rs`.
- The run budget is an absolute `Instant`: `self.started + self.timeout`
  (`chain_runner.rs:255`), computed per dispatch round and **moved into
  worker threads**, which compare against it directly
  (`run_node_turn`, `chain_runner.rs:585`). A paused clock cannot be a
  subtraction at one call site.
- Approval gates already park on a channel that `resolve_chain_gate`
  (`lib.rs:3205`) sends into. `wait_for_approval` (`chain_exec.rs:475`)
  takes the run budget as its receive timeout and gives up with
  *"nobody answered the approval gate after N minutes"* (`chain_exec.rs:489`)
  — the live bug D12 names.
- `GateEvaluator` is main-thread-only, but worker node turns keep running
  while the main thread is parked on a gate. A pause is therefore
  concurrent with agent work, not exclusive of it.
- All three run entry points already funnel through one launcher,
  `startChainRun` (`src/App.tsx:4587`), whose `onThread ?? thread` fallback
  is the hijacking bug (D7a).

## Goals / Non-Goals

**Goals:**
- One clock abstraction that both the scheduler and its worker threads
  consult, so pausing is correct under concurrency rather than at one site.
- Human nodes as a *scheduling* concept in `chain_runner.rs`, not a branch
  hidden inside `chain_exec.rs` — so the pause is testable with fakes.
- One pause surface and one launcher; no parallel second mechanism for
  either.

**Non-Goals:**
- No change to the frontier scheduler's fan-out, barrier, or `max_parallel`
  handling (D5, D13).
- No change to `chain_history.rs`'s record shape or to run persistence.
- No new dependency. Everything here is `std::sync` and existing Mantine
  components.

## Decisions

### 1. A shared `Budget` replaces `started: Instant`

`ChainRun` carries an `Arc<Budget>` holding the start instant plus
accumulated paused time and a pause **depth**. `Budget::elapsed()` is
`started.elapsed() - paused`. The scheduler's timeout check and
`run_node_turn`'s deadline check both consult it, so no stale absolute
deadline escapes into a worker thread.

A `Budget::pause()` returns an RAII guard; paused time accrues only as
depth falls 1 → 0, so two overlapping pauses (a human node in one branch, an
approval gate in another) are counted once rather than twice.

*Alternative rejected*: keep the absolute deadline and extend `started` when
a pause ends. Exact for approval gates only, because `GateEvaluator` is
main-thread-only — but a human node dispatches as a worker turn holding a
deadline already copied, so the extension would not reach it.

*Alternative rejected*: an `AtomicU64` of paused millis with no depth. One
line shorter, and double-counts every overlapping pause — the exact case
this change introduces by adding a second kind of pause.

### 2. A human node is dispatched by the scheduler, not by the runner

`NodeRunner` gains `human_turn(&self, role, instruction) -> Result<String,
String>`. `walk_from` dispatches on `NodeKind` and calls it instead of
`run_turn`, with **no retry loop**: `max_attempts` is an agent-crash
concept, and retrying a human's prompt is meaningless.

*Alternative rejected*: branch inside `AcpNodeRunner::run_turn` — zero trait
change, but the retry loop would wrap a human prompt, and the generic state
machine could no longer be tested for human pauses, which is the reason the
traits exist (D26).

### 3. The human wait reuses the approval-gate plumbing's shape, not its type

A `chain_humans: Mutex<HashMap<(run_id, role), Sender<String>>>` on
`Harness`, mirroring `chain_gates`, resolved by a `resolve_chain_human`
command shaped like `resolve_chain_gate`. Both waits observe the same
cancellation flag and both take a `Budget::pause()` guard.

*Alternative rejected*: overload `chain_gates` and carry the text in
`Approval::SendBack`'s note. One fewer map, and it makes two unrelated
behaviours share a type whose variant names would then lie.

### 4. `NodeKind` is a serde-default field, not a schema version

`ChainNode { #[serde(default)] kind: NodeKind }` with `NodeKind::Agent` as
`Default`. Existing `.palisade/chains/*.json` parse unchanged; nothing
rewrites saved files. `agent`, `model`, and `retry` stay on the struct and
are ignored for human nodes rather than being made optional — one node
shape, not two.

`unavailable_agents` (`lib.rs`) filters human nodes before checking
installs (D11); without this, D17's preflight blocks every chain containing
one.

### 5. `startChainRun` takes its thread explicitly

The `onThread ?? thread` fallback is deleted. Go-mode (`App.tsx:4800`)
passes the thread it just called `goMode` on; the panel passes the thread
it creates; `|=` already passes one. The launcher stays single — three
entry points, one path, no implicit focus dependency (D7, D7a).

### 6. The drag guard latches instead of reading torn-down state

`onNodePointerUp` currently nulls `dragging.current` (`ChainCanvas.tsx:549`)
and pointerup always precedes click, so the guard at `ChainCanvas.tsx:805`
reads `null` on every drag. A `justDragged` ref is set on pointerup when the
drag moved, read-and-cleared by the click that follows, and reset on the
next pointerdown so an interrupted gesture cannot leave it stuck.

*Alternative rejected*: deferring the null with `queueMicrotask` —
microtasks drain before the click task, so it changes nothing.

## Risks / Trade-offs

- **Agent work during a human pause is not billed to the budget** → Accepted
  and intended: concurrent branches keep running while you answer, and that
  time is free. A chain that pairs a long human pause with a runaway
  parallel branch can exceed its nominal 30 minutes of wall time. The budget
  bounds *unattended* agent work, which is what it exists for.
- **A run suspended on a human can stay open forever** → This is the
  specified behaviour (D12). Stop still works: both waits poll the same
  cancellation flag, and an app restart closes the record `interrupted` via
  the existing reconciliation (D-c), unchanged.
- **A human node inside a loop can re-prompt repeatedly** → The loop's
  mandatory iteration cap (D3) already bounds it; no new backstop needed.
- **The worked example chain is an artifact that can rot** → It is validated
  by `chains::save`'s existing validation in a test, so a schema change that
  invalidates it fails the suite rather than shipping.
- **Threading `Budget` through `run_node_turn` touches the runner's hottest
  path** → Contained: it replaces two `Instant` comparisons with two calls on
  an `Arc`, and the existing timeout tests cover the behaviour.

## Migration Plan

No migration step and no user action. `NodeKind` defaults to `Agent` on
deserialize, so every saved chain keeps its exact meaning; a chain is
rewritten only when the user saves it, and a chain with no human nodes
round-trips to the same JSON it had. Rollback is reverting the code —
a chain saved with a human node on the new build parses on the old build
with the `kind` field ignored, which would silently treat the human node as
an agent node bound to whatever `agent` held; this is the one forward-
incompatibility and it is why the worked example, not a migration, is how
human nodes are introduced.
