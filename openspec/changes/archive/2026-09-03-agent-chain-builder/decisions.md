# Explore: low-code agent chain builder

Topic: let users visually wire multiple agent sessions into a pipeline
(spec agent -> build agent -> test agent -> review agent, or fan-out/fan-in
across agents), instead of hand-managing one thread at a time.

## Research grounding (logged before any design decisions)

- **Anthropic, "Building Effective Agents"**: five workflow patterns —
  prompt chaining, routing, parallelization, orchestrator-workers,
  evaluator-optimizer. Recommends starting from the simplest pattern that
  fits, composing simple pieces rather than adopting a heavyweight
  framework. https://www.anthropic.com/research/building-effective-agents
- **Error compounding in multi-step LLM pipelines**: even 99% per-step
  accuracy degrades to ~36.6% success at 100 steps; failed attempts left in
  context contaminate retries; a single injected error in a multi-agent
  dependency chain produces topological-fragility impact factors of
  6.29–10.31x across frameworks studied. Implication: long unsupervised
  chains are a reliability liability, not a feature — chains need to be
  short, or need hard verification gates between steps, or both.
  (arxiv 2601.22290 "Six Sigma Agent"; arxiv 2605.08563 "Why Retrying
  Fails"; Redis eng blog "Why Multi-Agent LLM Systems Fail")
- **Human-in-the-loop gate placement**: HITL effectiveness depends heavily
  on *where* it's applied — gate the expensive/irreversible step, not
  everything ("if you gate everything, the human becomes a rubber stamp").
  The approval/advance requirement should live in the workflow structure,
  not in a prompt the agent could reason its way around.
  (MindStudio "HITL Checkpoints for AI Agents"; explainx.ai "When to Gate
  Agents")
- **Low-code/node-based builder usability**: node-based visual interfaces
  reduce cognitive load and support intuitive construction/debugging for
  non-experts, but tools built for professional devs impose higher
  cognitive load on non-technical users than tools purpose-built for
  citizen developers — audience assumption changes the right UI weight.
  (arxiv 2508.02470 "AIAP: No-Code Workflow Builder"; usability
  systematic-literature-review on low-code platforms)
- **Framework orchestration philosophies** (LangGraph=state machine,
  CrewAI=roles, AutoGen=conversation) — useful vocabulary for naming
  Palisade's own model, not something to adopt wholesale.

## Codebase grounding (Explore agent report, this session)

- Concurrent sessions already work: `AcpSession` keyed by id
  (`acp_client.rs:134`), independent `busy`/`terminate` per session,
  confirmed by `openspec/specs/concurrent-sessions/spec.md`. A chain
  scheduler needs no new process-management layer for fan-out.
- All agents speak one wire format: `acp_events.rs::from_session_update`
  (line 46) maps any ACP agent's `session/update` to one `ExecutorEvent`.
  Chain nodes can be agent-agnostic by construction.
- Existing "chaining" is 1:1, sequential, single-thread only: agent-switch
  mid-thread reparks the prior transcript as a text prefix for the *next*
  session (`ensure_session`, `lib.rs:721-789`; `pending_prefix`,
  `lib.rs:791-809`). This is the seed for edge semantics but needs
  generalizing to a DAG and to cross-thread targets.
- Store is flat: `ThreadMeta` (`store.rs:211`) has no parent/lineage field;
  no DAG concept exists in the data model today.
- Executor is explicitly *not* user-selectable in current UI/specs
  (`executor-model-switcher/spec.md`) — a chain builder letting users pick
  per-node executors is new surface, not reuse.
- CLAUDE.md constraints that bound this feature: "Two modes only
  (spec/go)... No third mode" (chain nodes must fit inside spec/go, not add
  a mode); "Verification is the only evidence... never because a model
  said so" (chain-step "success" must gate on a named verify command, not
  agent self-report — this converges exactly with the HITL gate-placement
  research above); "Session history is append-only."

## Decisions

### D1: Chain model — user-drawn DAG, not runtime-improvised orchestration
- **Decision**: Chains are sequential/fan-out/fan-in DAGs the user draws
  low-code (n8n-style), built from agent-invocation nodes connected by
  handoff edges — not an orchestrator-workers pattern where an LLM
  decomposes the graph at runtime.
- **Why**: "Low-code chain **building**" implies something to build; an
  LLM-improvised graph leaves nothing to draw. A DAG also reuses ~80% of
  existing primitives (concurrent `AcpSession`s, unified ACP event parser,
  `pending_prefix` handoff) rather than requiring a new supervising-agent
  runtime.
- **Source**: user

### D2: Nodes are named roles bound to a specific agent, not generic steps
- **Decision**: A node = a role (e.g. "designer", "programmer") bound to a
  specific ACP agent + system/prompt instructions for that role. The
  motivating case is cross-agent role assignment (Gemini as designer,
  Claude as programmer), not same-agent pipeline steps.
- **Why**: user's concrete example is role-to-agent binding, which is
  closer to CrewAI's role-based orchestration than a plain DAG-of-prompts.
- **Source**: user

### D3: Graph supports real cycles, gated by verify-or-approval + mandatory iteration cap
- **Decision**: Loop edges (e.g. designer -> programmer -> designer) are
  real automatic cycles, not just a manual "send back" button — but every
  loop-closing edge must carry a gate, and every gate is one of: a named
  verify command (exit automatically on pass) or a manual human-approval
  step (advance/reject/send-back). Every cycle additionally requires a
  hard iteration cap as a backstop regardless of gate type.
- **Why**: user wants "both" automatic looping and manual control. Manual
  approval turns out to be a gate *type*, not a separate mechanism — so
  unifying gates (verify-command | human-approval) covers both the
  autonomous case and the human-in-the-loop case with one concept. The
  mandatory iteration cap is load-bearing, not optional: the error-
  compounding research above shows unsupervised multi-step loops degrade
  fast, and HITL research shows gates must live in workflow structure, not
  a prompt — an uncapped auto-loop is exactly the failure mode both bodies
  of research warn about.
- **Source**: user + research (arxiv 2601.22290, 2605.08563; MindStudio
  HITL checkpoints)

### D4: Chains are saved, reusable, named constructs
- **Decision**: A chain (e.g. "Design Loop": Gemini designer <-> Claude
  programmer) is built once in a canvas and saved by name at project (or
  global) scope, then invoked repeatedly from any thread — not rebuilt
  per-thread.
- **Why**: matches user's "hook up Gemini as designer" framing — defining
  a reusable setup, not one-off wiring.
- **Source**: user

### D5: Chain invocation stays inside the two-mode invariant — go mode / spec-apply only, no third mode
- **Decision**: A saved chain can power a thread's "go" execution (incl.
  applying an OpenSpec change, which is go-mode work) in place of a single
  agent session — selected the same way `selected_executor` resolves today
  (thread picker -> project override -> auto-detect), just with "a chain"
  as one more kind of thing that slot can resolve to. No new mode is
  added; "spec mode" does not invoke chains.
- **Why**: CLAUDE.md is explicit — "Two modes only (spec/go)... No third
  mode." A chain must be a strategy *within* go, not a parallel surface.
- **Source**: user

### D6: In-chat invocation via a dedicated `|=` token, not `/`
- **Decision**: Chains can also be invoked mid-chat, skill-style, but
  using a distinct `|=<chain-name>` token rather than `/` (which is
  reserved for skills/slash-commands elsewhere in the product).
- **Why**: user wants chain invocation visually and semantically distinct
  from skill invocation.
- **Source**: user

### D7: Live DAG run view, per-node transcript on click
- **Decision**: While a chain runs, a dedicated panel shows the graph with
  nodes highlighting as they execute (n8n/ComfyUI-style), not a flat
  interleaved transcript. Clicking a node opens its actual session
  transcript. The invoking thread gets a condensed summary message when
  the chain finishes or hits an approval gate.
- **Why**: the visual-execution payoff is the point of a low-code builder;
  a flat transcript would be unreadable for loop nodes with many
  round-trips. Per-node click-through keeps full detail available without
  cluttering the live view.
- **Source**: user

### D8: Verify gates reuse the existing `verify` command mechanism, not a new one
- **Decision**: A node's verify-type gate is a named command from the
  project's existing `.project-settings.json` `verify` map
  (`openspec/specs/verification/spec.md`), run by Palisade itself with a
  persisted exit-code record — the same mechanism used elsewhere for
  "is this done." No parallel verification system for chains.
- **Why**: CLAUDE.md's "verification is the only evidence" rule and the
  existing verification spec already define exactly this primitive
  (project-configured named shell commands, Palisade-run, exit-code
  persisted, async, no self-report). Reusing it keeps chain-gate semantics
  identical to spec-completion semantics project-wide, and costs no new
  execution mechanism.
- **Source**: codebase (openspec/specs/verification/spec.md) + CLAUDE.md

### D9: Human-approval gates offer Approve / Reject / Send-back-with-note
- **Decision**: A paused approval gate gives three actions: approve
  (advance), reject (abort the chain run), or send-back-with-note (re-run
  the upstream node with the human's note appended as extra instruction).
- **Why**: matches the designer/programmer critique-loop example directly
  — a human correction mid-loop is a send-back-with-note action, not a
  separate mechanism.
- **Source**: user

### D10: Fan-out/fan-in deferred as an explicit non-goal for v1
- **Decision**: v1 ships sequential chains and gated cycles only — no
  parallel branches/merge. Deferred by UI/merge-semantics complexity, not
  blocked architecturally (concurrent `AcpSession`s already exist as the
  backend primitive) — the data model and edge schema should be designed
  so fan-out/fan-in can be added later without a rewrite.
- **Why**: user's motivating examples (sequential handoff, designer/
  programmer loop) don't need simultaneous branches; parallel merge
  semantics roughly double the v1 UI surface for no immediate payoff.
- **Source**: user

### D11: Chains and project settings both move into a new `.palisade/` folder
- **Decision**: Chain definitions live at `.palisade/chains/<name>.json`,
  one file per chain. This change also migrates `.project-settings.json`
  to `.palisade/project-settings.json`, updating every `settings::load`/
  `settings::save` call site, rather than deferring that migration to a
  separate change.
- **Why**: user wants both consolidated under one folder now rather than
  landing chains in a directory of their own while settings stays put.
  Recommended splitting the migration into a separate change to keep this
  proposal scoped to chains; user chose to bundle it.
- **Source**: user (recommended-split, user-overrode-to-bundle)

### D12: Clean break on the settings-file move, no fallback/migration
- **Decision**: `settings::load`/`settings::save` (`settings.rs:49` `FILE_NAME`
  const) point only at `.palisade/project-settings.json`. No fallback read
  of the old root-level `.project-settings.json`, no auto-migration.
  `.gitignore` entry moves from `.project-settings.json` to `.palisade/`.
- **Why**: single-developer project right now, no external users/installs
  to keep compatible; a fallback path would be unused complexity.
- **Source**: user

### D13: `|=` grammar — chain name token + trailing free-text seed input
- **Decision**: `|=<chain-name> <free text>` — the chain name is the first
  whitespace-delimited token after `|=`; any trailing text becomes the
  seed input passed to the chain's first node (same role a normal chat
  message plays). Bare `|=<chain-name>` with no trailing text is also
  valid (empty seed).
- **Why**: mirrors how slash-command args already work; makes `|=` useful
  mid-conversation instead of just a manual trigger.
- **Source**: user

### D14: `|=` reuses the existing sigil-menu mechanism, generalized to multi-char sigils
- **Decision**: `|=` becomes a third sigil alongside `/` and `$`
  (`src/slashCommands.ts:19` `SIGILS`), reusing `slashQuery`/
  `matchCommands`/the popup UI. Two changes to that file: (1) sigil
  matching/stripping generalizes from `slice(1)` to `slice(sigil.length)`
  to support a 2-char sigil; (2) the popup's command list gets a second
  source — local `.palisade/chains/*.json` names — merged alongside the
  ACP-advertised `AgentCommand` list, visually distinguished (e.g. a small
  icon) since a chain is a different kind of thing than a single skill.
- **Why**: the sigil mechanism already generalizes cleanly (open-on-leading-
  sigil, close-on-space, fuzzy match) — reusing it is strictly less code
  than a parallel popup, and gives chains the same UX polish (fuzzy search,
  keyboard nav) for free.
- **Source**: user + codebase (src/slashCommands.ts:1-37)

### D15: Chain runs don't survive app restart, same as any other session
- **Decision**: A chain run in progress (including one paused at an
  approval gate) is interrupted on app restart exactly like any other
  session (`AcpSession`s are in-memory only). No resume-from-checkpoint in
  v1 — restarting the app means re-invoking the chain from scratch.
- **Why**: consistent with existing session-lifecycle behavior; durable
  DAG-run state for resumability is a real feature to add later if missed,
  not something to build speculatively now.
- **Source**: user

### D16: Per-node agent picker is a deliberate exception to detection-not-config, sourced from the same registry
- **Decision**: A chain node's agent binding is user-selectable (unlike a
  normal thread's executor, which stays read-only per
  `executor-model-switcher/spec.md`'s detection-not-config rule) because
  explicit role-to-agent binding is the entire point of a chain. The
  picker lists from the same cached ACP registry preflight normal
  auto-detect already uses (installed, on-PATH agents) — no new discovery
  mechanism, just a selectable surface scoped to chain-node config.
- **Why**: detection-not-config exists to keep incidental executor
  plumbing invisible on normal threads; a chain node's agent choice isn't
  incidental, it's the feature. Reusing the registry avoids a second
  agent-discovery path.
- **Source**: user + codebase (executor-model-switcher/spec.md,
  acp_registry.rs preflight)

### D17: A saved chain with a now-uninstalled agent blocks the run, surfaced clearly
- **Decision**: If a chain node's bound agent isn't currently
  installed/on-PATH, the chain run is blocked (not silently substituted
  with a fallback agent), with the specific missing node/agent surfaced
  prominently — not a generic error.
- **Why**: unlike normal-thread auto-detect (where any installed agent is
  an acceptable substitute), a chain node's agent choice is a deliberate
  binding (D16) — silently swapping "Gemini as designer" for whatever's
  installed defeats the reason the chain was built that way.
- **Source**: user

### D18: Configurable per-run wall-clock timeout, in addition to the mandatory iteration cap
- **Decision**: Every chain run has a wall-clock timeout (configurable per
  chain, sane default) in addition to each loop edge's mandatory iteration
  cap (D3). On timeout, the run stops the same way a rejected approval
  gate does (abort, surfaced to the user) — it is not a silent kill.
- **Why**: an iteration cap only bounds *looping* nodes; a single hung or
  unusually slow node (no loop involved) isn't caught by it at all — a
  wall-clock timeout catches that distinct failure mode.
- **Source**: user

### D19: 30-minute default wall-clock timeout, user-overridable per chain
- **Decision**: Chain runs default to a 30-minute wall-clock timeout,
  overridable per chain in its definition.
- **Why**: reasonable ceiling for a coding-agent chain without cutting off
  a legitimate long build+test loop.
- **Source**: recommended-accepted

### D20: Chains are project-scoped only for v1, no global/shared chains
- **Decision**: `.palisade/chains/` lives per-project (consistent with D11
  putting it inside the per-project `.palisade/` folder); a chain built in
  one project isn't available in another. Global/cross-project chains are
  deferred.
- **Why**: `.palisade/` is being introduced as per-project; agent
  availability can differ per project; global sharing is a real feature to
  add later, not needed for v1.
- **Source**: user

### D21: A crashed node retries automatically, configurable retry count, then aborts
- **Decision**: If a node's agent session errors/crashes, it retries
  automatically up to a configurable per-node retry count before the run
  aborts (surfaced, same as a timeout/reject). Not a manual-only action.
- **Why**: user overrode the recommended abort-only approach. Logged
  tension: the error-compounding research (retries leave contaminated
  context, elevating next-attempt error rate) argues for caution here —
  worth flagging in design.md that each retry should start the node fresh
  (not append the failed attempt into the same context) rather than
  naively re-sending into a context that already contains the failure.
- **Source**: user (recommended-abort-only, user-overrode-to-retry)

### D22: DAG edges are plain pipes by default; gates are opt-in except on loop-closing edges
- **Decision**: A forward (non-loop) DAG edge is a plain start-to-end pipe
  — output handoff with no gate required. D3's gate requirement (verify or
  approval, plus iteration cap) applies specifically to loop-closing
  edges, not to every edge in the graph. A user can still add an optional
  verify/approval gate to any edge, loop or not — it's just not mandatory
  on non-loop edges.
- **Why**: user's reminder — chains are DAGs with plain sequential piping
  as the default case, not just loops. Mandatory gating everywhere would
  contradict the HITL research already logged ("if you gate everything,
  the human becomes a rubber stamp") and add friction to the common case.
- **Source**: user

### D23: Each node has a free-text role/system-prompt guideline field, applied alongside the seed prompt + upstream output
- **Decision**: A node's role definition (D2) includes a text-input field
  for role/system-prompt guidelines (e.g. "you are the designer; focus on
  UX, defer implementation detail to the programmer node"). At run time,
  the node's actual instruction is: its guideline text + the chain's
  original seed input (D13) + the accumulated output of its upstream
  node(s) — the guideline shapes *how* the node acts on that combined
  input, it doesn't replace it.
- **Why**: user's clarification — role isn't just an agent binding (D2),
  it's an explicit behavioral guideline that persists across every turn
  the node takes, applied on top of the evolving chain context rather than
  being a one-time initial prompt.
- **Source**: user

### D24: A failing verify gate on a forward edge aborts the run; only loop edges repeat
- **Decision**: A gate on a forward (non-loop) edge is a checkpoint, not a
  retry loop. Verify exit 0 advances; non-zero aborts the run with the
  command name and exit code surfaced, the same way a timeout (D18) or a
  rejected approval (D9) ends it. Only a loop-closing edge repeats, and only
  under its mandatory cap (D3).
- **Why**: D22 allows an optional gate on any edge but D3 requires an
  iteration cap only on loop-closing edges — so a repeating forward gate
  would be the one unbounded repeat path in the design, exactly what the
  logged error-compounding research warns against. Aborting keeps "nothing
  repeats without a cap" true everywhere.
- **Source**: recommended-accepted

### D25: Chain-node sessions are excluded from normal thread session reuse
- **Decision**: Sessions started by a chain run spawn with `mode: "go"` (so
  they get go-mode write permissions per D5) but are tracked in a
  chain-owned session set that `find_live_session` skips. A user pressing
  `/go` on a thread with a chain running gets their own session, never a
  chain node's.
- **Why**: `find_live_session` keys on `(thread_id, mode)`, so without this
  a chain node's go-mode session would be handed to the thread's own `/go`
  — the user would type into a node's session mid-run. Tracking the ids
  Palisade-side avoids threading a new field through `AcpSpawn`/
  `SessionIdentity`/`AcpSession`.
- **Source**: recommended-accepted

### D26: The chain walk is generic over a node-runner trait so the engine is testable
- **Decision**: `chain_runner.rs` walks the graph against a `NodeRunner` /
  `GateEvaluator` trait pair rather than calling `AcpSession` directly. The
  production implementation drives real sessions; tests drive scripted
  fakes.
- **Why**: tasks.md §3–§5 demand `cargo test` coverage of forward walks,
  gate/loop behaviour, iteration caps, timeouts, and retry exhaustion —
  none of which is reachable in a unit test if the walk can only run a live
  ACP agent. The seam is the minimum needed to make the required tests
  possible, not a speculative abstraction.
- **Source**: recommended-accepted

### D27: Chain-run commentary in a thread uses its own `chain` role, not `system`
- **Decision**: The condensed summary a chain posts into the invoking thread
  (D7) is stored with `role: "chain"` and rendered as a neutral Alert.
  `system` is reserved for crash banners.
- **Why**: found in manual verification — `EventView` renders every `system`
  turn as a red danger "crash-banner", so "Chain `design-loop` — finished."
  appeared in the thread styled as a failure. Colour is never the only
  signal, and here it was actively the wrong one.
- **Source**: codebase (src/EventView.tsx:432)

### D28: A chain node's editor opens on click, with a drag threshold
- **Decision**: A node card distinguishes a click (open the node editor) from
  a drag (move the node) with a 4px movement threshold, and the canvas is
  fully operable by mouse alone: toolbar zoom in/out buttons, plain-wheel
  pan, click-empty-canvas to cancel a half-drawn connection, and an explicit
  Cancel button next to the connect hint.
- **Why**: user requirement raised during apply — "the user can operate all
  of this using their mouse not just keyboard". The first implementation
  captured the pointer on mousedown, which swallowed the click entirely, so
  a node's editor could not be opened by mouse at all; zoom was ctrl+wheel
  only and cancelling a connection was Esc only.
- **Source**: user
