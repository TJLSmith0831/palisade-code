# Decision log — chain-execution-gaps

Grilled with `/grill-propose`. Every artifact sentence traces to an entry here.

## D1: What gaps is this change about?
- **Decision**: Six, named by the user verbatim: (a) a chat `|=` invocation
  shows no audit trail though a panel run does; (b) a panel "test run"
  hijacks the focused chat thread instead of getting its own; (c) there is no
  human-in-the-loop *node*, only an edge gate; (d) parallelism is invisible;
  (e) saving a new chain does not rename its tab; (f) there is no in-product
  explanation of how chains work.
- **Why**: These are the user's observed gaps, not inferred ones. Candidate
  gaps I proposed (per-node timeout, run budget, restart resume) were all
  declined and are explicit non-goals.
- **Source**: user

## D2: Is the "no audit trail in chat" gap real?
- **Decision**: Yes. `ChainRunHistory` is rendered only by
  `ChainsPanel.tsx:169`. Both invocation paths share `startChainRun`
  (`src/App.tsx:4587`) and both get a live `ChainRunCard`, but past-run
  history is reachable only from the Chains panel.
- **Why**: Confirms the gap is a surfacing gap, not a persistence gap — the
  records already exist (`chain_history.rs`).
- **Source**: codebase (src/ChainsPanel.tsx:169, src/App.tsx:4587)

## D3: Is the "test run uses the focused thread" gap real?
- **Decision**: Yes. `startChainRun` resolves `onThread ?? thread`
  (`src/App.tsx:4590`) and `ChainsPanel`'s button is literally labelled "Run
  on this thread" (`src/ChainsPanel.tsx:155`). A panel run has no thread of
  its own.
- **Why**: Establishes that the fix is a thread-creation decision, not a bug.
- **Source**: codebase (src/App.tsx:4590, src/ChainsPanel.tsx:155)

## D4: Is there any human-in-the-loop node today?
- **Decision**: No. `Gate::Approval` (`chains.rs:52`) is an *edge* property.
  `ChainNode` binds role + guideline + agent + model + retry only — there is
  no node kind discriminator at all.
- **Why**: An HITL node is a new node shape, not a new gate; it changes the
  on-disk chain schema and therefore needs a migration decision.
- **Source**: codebase (src-tauri/src/chains.rs:19-52)

## D5: Does the runner already parallelise?
- **Decision**: Yes. `chain_runner.rs` walks a concurrent frontier (D10),
  `Chain::max_parallel` caps it, and `NodeState::Waiting { met, required }`
  exists specifically so a fan-in node does not look hung. The gap is that
  the canvas does not make any of this legible.
- **Why**: Scopes (d) to presentation, not scheduling — no runner change.
- **Source**: codebase (src-tauri/src/chain_runner.rs:1-10, 74-78; chains.rs max_parallel)

## D6: Explicit non-goals
- **Decision**: Per-node timeouts, run-level cost ceilings, and resuming a
  run across app restart are out of scope. D-c (chains never auto-resume)
  stands untouched.
- **Why**: Offered and declined; keeping them out keeps this change shippable.
- **Source**: user

## D7: Does a chain run get its own thread?
- **Decision**: The rule is *thread-initiated vs chain-initiated*, not panel
  vs chat. A chain fired **from a thread** — inline with `|=`, or by that
  thread's model-picker executor slot resolving to `chain:<name>` — runs on
  that thread. Both paths MUST behave identically. A run started from the
  **Chains panel** creates its own thread, named after the chain.
- **Why**: Running "here" is the whole point of a thread-initiated
  invocation, and a user should not have to remember which of the two
  in-thread entry points they used. A panel run has no "here" and should not
  borrow whatever thread happened to be focused. Rejected:
  own-thread-always (breaks both in-thread paths) and one-thread-always
  (leaves the hijacking complaint unfixed).
- **Amended**: originally scoped to "panel vs `|=`"; the user noted the
  model-picker entry point (`CHAIN_EXECUTOR_PREFIX`, `lib.rs:792`) is a
  third invocation and must match `|=`.
- **Source**: user

## D7a: The three entry points funnel through one launcher
- **Decision**: All three keep sharing `startChainRun` (`src/App.tsx:4587`),
  which becomes explicit about its thread rather than falling back to
  focused-thread state. The go-mode path (`App.tsx:4800`) and the panel path
  (`App.tsx:6122`, `6332`) both call it with no thread argument today and
  inherit `onThread ?? thread`; go-mode must pass the thread it just called
  `goMode` on, and the panel must pass the thread it creates (D7).
- **Why**: The focused-thread fallback is exactly what causes the reported
  hijacking, and leaving it in place for go-mode leaves the same latent bug
  behind under a different entry point. One launcher, no implicit thread.
- **Source**: codebase (src/App.tsx:4587, 4800, 5092, 6122, 6332)

## D8: How does a chat-invoked run reach its audit trail?
- **Decision**: `ChainRunCard` gains a collapsed "past runs" section that
  renders the existing `ChainRunHistory` for that chain. No new component, no
  second history surface; the card is already in the transcript and already
  owns re-run-from-node.
- **Why**: The records exist (D2) — only the surfacing is missing, so reuse
  the built component rather than adding one. Rejected: a link out to the
  panel (still makes you leave the thread) and always-expanded inline history
  (floods the transcript).
- **Source**: recommended-accepted

## D9: What is a human-in-the-loop node?
- **Decision**: A node that pauses the run, shows its upstream output, and
  takes free text from the human — that text becomes the node's output and
  flows downstream exactly as an agent node's would.
- **Why**: The real missing capability. `Gate::Approval` (D4) lets a human
  approve, reject, or send back; it never lets a human *contribute content*
  into a chain. Rejected: an approval gate redrawn as a node (no new
  behaviour), human branch-routing (needs fan-out first), and a three-mode
  node (three features, triple the spec and canvas surface).
- **Source**: user

## D10: How is a human node encoded on disk?
- **Decision**: `ChainNode` gains `#[serde(default)] kind: NodeKind` with
  `NodeKind::Agent` as the default; `NodeKind::Human` is the new variant.
  Every existing `.palisade/chains/*.json` keeps parsing untouched.
- **Why**: A serde default is the whole migration — no version field, no
  rewrite pass over saved chains. `agent`, `model`, and `retry` are ignored
  on a human node rather than made optional, so the struct stays one shape.
- **Source**: recommended (codebase: src-tauri/src/chains.rs:19-40)

## D11: A human node is skipped by the agent-availability preflight
- **Decision**: `unavailable_agents` (`lib.rs`) filters out `NodeKind::Human`
  nodes before checking installs.
- **Why**: Otherwise D17's preflight blocks every chain containing a human
  node, since its `agent` field is meaningless. Falls straight out of D10.
- **Source**: codebase (src-tauri/src/lib.rs `unavailable_agents`)

## D12: The wall clock pauses while a run waits on a human
- **Decision**: A run's `timeout_seconds` budget measures agent work only.
  The clock stops while the run is blocked on a human node (D9) or an
  existing `Gate::Approval`, and resumes when the human answers. A paused run
  may sit open indefinitely.
- **Why**: The budget exists to bound runaway agents, not the user's response
  time. This also fixes a live bug — today a paused approval gate can time
  out a run the user was about to approve, forcing a re-run that re-spends
  every upstream node. Rejected: a hard ceiling including human time (kills
  runs you stepped away from) and a second human-specific deadline (a second
  timeout concept in schema and canvas for no gain).
- **Note**: `ChainRun::elapsed` (`chain_runner.rs:148`) currently reads
  `started.elapsed()` directly and must become budget-aware.
- **Source**: user

## D13: Parallelism is scoped to one authoring-time line, nothing more
- **Decision**: The canvas header states how wide the chain actually runs
  (its maximum concurrent tier, and the `maxParallel` cap when one is set).
  No tier layout, no run-time grouping treatment, no scheduler change.
- **Why**: The user walked this back ("maybe I overreacted"). Run-time state
  is already legible — `stateLabel` renders "waiting on 2 of 3"
  (`ChainCanvas.tsx:1204`). The only genuine blind spot is that `maxParallel`
  is a buried `NumberInput` (`ChainCanvas.tsx:666`) with nothing stating what
  the graph does.
- **Source**: user

## D14: Dragging a node must not open its editor
- **Decision**: Fix the click/drag discrimination in `ChainCanvas`. Root
  cause found: the surface's `onPointerUp` calls `onNodePointerUp`, which
  nulls `dragging.current` (`ChainCanvas.tsx:549`) — and pointerup always
  fires *before* click, so the guard `if (dragging.current?.moved) return`
  (`ChainCanvas.tsx:805`) reads `null` on every drag and falls through to
  `activate()`. The `DRAG_SLOP` threshold works; the guard that consumes it
  is dead code.
- **Why**: A canvas where you cannot move a node without opening a modal is
  unusable, and the existing comment at :803 shows the guard was intended to
  do exactly this. Fix: latch `moved` into a ref that survives pointerup and
  is cleared by the click that reads it — not by nulling the drag state.
- **Source**: user (bug report) + codebase (src/ChainCanvas.tsx:549, 805)

## D15: Saving a chain renames its tab
- **Decision**: `ChainCanvas`'s `save()` reports the saved name up so the
  open tab adopts it.
- **Why**: A new chain opens as `openChain(null)`, whose tab key is
  `chain:new` (`src/openTabs.ts:87`), and `save()` never notifies the tab
  layer — so a saved chain keeps a "new chain" tab forever, and opening it
  again from the sidebar yields a second tab for the same chain.
- **Source**: user + codebase (src/openTabs.ts:87, src/ChainCanvas.tsx save())

## D16: How chains are explained
- **Decision**: Two surfaces, both in-product. (1) Empty-state teaching: an
  empty canvas explains nodes, edges, gates, and loops in place, and
  `ChainsPanel`'s empty state teaches the build-then-run cycle rather than
  the single line about `|=` it shows today (`ChainsPanel.tsx:106`). (2) One
  worked example chain the user can open, read, and run from that empty
  state.
- **Why**: Teaching lands where the user is already stuck, and the example
  makes loops and gates concrete in a way prose does not. Rejected: a
  separate docs page (a surface you must deliberately open, and it rots
  independently of the UI).
- **Note**: The example must stay valid as the schema changes — it should
  include a human node (D9), which also makes it the canonical demonstration
  of the new capability.
- **Source**: user

## D17: Where the human answers a human node
- **Decision**: The same `awaiting` slot on `ChainRunCard` that already
  resolves approval gates, with a free-text field in place of the
  approve/reject/send-back buttons.
- **Why**: One pause surface, not two. The card already carries the pause,
  the upstream output, and the resolution callback (`onGateResolved`), so a
  human node is a third shape in an existing slot rather than a new surface.
- **Source**: recommended (codebase: src/ChainRunCard.tsx, src/App.tsx:4556)

## D18: TDD is binding for this change
- **Decision**: Every non-trivial task writes its test first, confirms it
  red, then makes it green. Task groups are ordered tests-first, and a task
  report that cannot show the red step is not done.
- **Why**: The user's standing rule, and it fits what this change touches —
  a concurrency-sensitive `Budget` (design §1) and a click/drag guard (D14)
  are both things where a green test proves nothing unless it was red first.
  Precedent: `chain-run-history` task 1.1 recorded exactly this.
- **Source**: user

## D19: Ponytail is binding for this change
- **Decision**: Laziest working solution throughout — reuse before writing,
  stdlib/native before dependencies, shortest diff that actually fixes the
  root cause. No new dependency; `std::sync` and existing Mantine components
  only. Deliberate corner-cuts carry a `ponytail:` comment naming the
  ceiling.
- **Why**: The user's standing rule. Already visible in the design: D8 reuses
  `ChainRunHistory` rather than building a second history surface, D17 reuses
  the `awaiting` slot, D10 makes a serde default the entire migration, and
  D14 is a latch rather than a rewrite of the drag system.
- **Note**: Ponytail shortens the solution, never the reading — root-cause
  fixes only. D14 is the example: the reported symptom is "drag opens the
  editor"; the cause is a guard reading state that pointerup already nulled.
- **Source**: user
