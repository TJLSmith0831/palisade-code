## Context

See `proposal.md` - Why. Relevant existing primitives (see
`decisions.md` codebase-grounding section for full citations):

- Concurrent `AcpSession`s already run side by side, keyed by id, each with
  independent `busy`/`terminate` (`acp_client.rs:134`).
- `acp_events.rs::from_session_update` maps any ACP agent's output to one
  agent-agnostic `ExecutorEvent` — chain nodes don't need per-agent parsing.
- `ensure_session`/`pending_prefix` (`lib.rs:721-809`) already do a 1:1,
  same-thread agent handoff by reparking the prior transcript as a text
  prefix for the next session. Chain edges generalize this same idea
  (prior output feeds the next node's instruction) to a DAG and across
  threads.
- `settings.rs` has a single `FILE_NAME` const and is the only place that
  joins the settings filename to the project root — the path move is a
  small, localized change.
- `verify` commands are already run by Palisade with a persisted
  exit-code record (`openspec/specs/verification/spec.md`) — chain verify
  gates call this same execution path.

## Goals / Non-Goals

**Goals:**
- Define a chain's on-disk shape and how a run walks it.
- Define how a chain node's session is created/reused and how output flows
  to the next node.
- Define the gate/loop/retry/timeout state machine precisely enough to
  implement without guessing.
- Define the `.palisade/` migration's blast radius.

**Non-Goals** (see proposal.md and decisions.md D10 for the full non-goal
list; design-level additions only):
- Fan-out/fan-in execution semantics (parallel branches, merge policy) —
  D10 defers this, but the data shapes below are chosen so adding it later
  doesn't require a schema rewrite (see Decisions: Edge shape).
- Cross-project/global chains (D20) — the schema has no project-independent
  identity for a chain.
- Resuming a chain run across app restart (D15) — no durable run-state
  store, only durable chain *definitions*.

## Decisions

### Chain definition shape (`.palisade/chains/<name>.json`)

```jsonc
{
  "name": "design-loop",
  "nodes": {
    "designer": {
      "role": "designer",
      "guideline": "You are the designer. Focus on UX; defer implementation detail.",
      "agent": "gemini-cli"        // ACP agent id, resolved against the same
                                     // registry preflight normal auto-detect uses
    },
    "programmer": {
      "role": "programmer",
      "guideline": "You are the programmer. Implement exactly what the designer specifies.",
      "agent": "claude-code"
    }
  },
  "edges": [
    { "from": "designer", "to": "programmer" },                 // forward, no gate (default)
    {
      "from": "programmer", "to": "designer",                    // loop-closing
      "gate": { "type": "verify", "command": "typecheck" },      // or {"type": "approval"}
      "maxIterations": 5
    }
  ],
  "entry": "designer",
  "timeoutSeconds": 1800,          // D18/D19 default, overridable
  "retry": { "maxAttempts": 2 }    // D21, per-node override allowed by the
                                    // same key inside a node object
}
```

**Why this shape**: nodes keyed by role name (unique within a chain, used
as both the human-readable label and the edge endpoint reference — no
separate numeric id needed for a v1 with no fan-out). Edges are a flat
list rather than nested under nodes, because a loop-closing edge and a
forward edge are structurally identical (`from`/`to`/optional `gate`) —
the only difference is topological (does `to` appear upstream of `from`
in the graph), which the execution engine detects at load time rather than
requiring the user to declare "this is a loop." **Alternative considered**:
tagging edges explicitly as `"kind": "loop"` — rejected because it
duplicates information already derivable from the graph and risks getting
out of sync if the user rewires the canvas.

**Fan-out readiness**: `edges` as a flat list (rather than `nextNode:
string` on each node) already supports a node having multiple outgoing or
incoming edges without a schema change — a future fan-out change adds
merge-policy fields to a node, not a new edge shape.

### Execution engine: one Rust module owning run state, built on existing `AcpSession`s

A new `chain_runner.rs` module holds an in-memory `ChainRun` per active
run (run id, current node, per-loop iteration counters, elapsed time,
retry counts) — deliberately not persisted, per D15. Each node's turn
creates or reuses a real `AcpSession` exactly the way a normal thread does
today (`ensure_session`), so a chain node's transcript IS a normal session
transcript — satisfying the "click a node, see its real transcript"
requirement with no new transcript-storage format.

**Why a new module instead of extending `Harness`**: `Harness` already
owns the `acp_sessions` map and is the thing chain runs read/write against;
a separate `chain_runner.rs` keeps run-state/graph-walking logic apart from
session-lifecycle plumbing, mirroring the existing split between
`executor.rs` (detect/spawn) and `acp_client.rs` (session object).
**Alternative considered**: embedding run state directly in `Harness` —
rejected, `Harness` is already a wide struct (D9/D18 in its own history)
and chain-run bookkeeping is a distinct concern.

### Instruction composition per node turn (D23)

On each node turn, the system builds the instruction as:
`{guideline}\n\n---\n\nOriginal request: {seedInput}\n\nPrevious step output ({fromRole}): {upstreamOutput}`
— sent as the session's next user turn. First-node turns omit the
"Previous step output" segment (no upstream yet, per spec scenario). A
send-back-with-note turn appends `\n\nHuman note: {note}` to this same
composed instruction rather than inventing a fourth input channel.

### Gate evaluation

A gate is evaluated once its edge's source node's turn completes. A
`verify`-type gate calls the same command-execution path
`verification`'s existing mechanism uses, keyed by the command name in the
gate, and reads its persisted exit code. An `approval`-type gate suspends
the run (visible in the live DAG view as "awaiting approval") until one of
approve/reject/send-back-with-note arrives over a new IPC command.

### `.palisade/` migration blast radius

- `settings.rs`: `FILE_NAME` const and its one path-join call site move
  under a new `.palisade/` join; `.gitignore` line
  `.project-settings.json` → `.palisade/`.
- `acp_preflight.rs:131,139`: two warning strings reference the old
  filename in prose — update text only, no behavior change.
- **Correction (apply-time)**: explore's grep missed the frontend. Two
  TypeScript constants also address the file directly —
  `SettingsPanel.tsx`'s exported `PROJECT_SETTINGS_FILE` and a duplicate
  local const in `App.tsx` — plus display strings in `RunPanel.tsx`,
  `VerifyPane.tsx`, `SpecChangeTab.tsx`, `lib.rs`, and the
  `SettingsPanel`/`App` test fixtures. Handled by pointing `App.tsx` at
  `SettingsPanel`'s exported constant (removing the duplicate) and
  rewriting the prose references. Frontend writes need no directory
  handling: `fs_ops::resolve_creatable_path` already `create_dir_all`s the
  parent.
- New `.palisade/chains/` directory created on first chain save, same
  lazy-create pattern `settings.rs` already uses for
  `.project-settings.json` (`settings.rs:74`, "Creates ... with
  self-documenting defaults if the file is absent").

### New IPC commands (names indicative, per CLAUDE.md's three-edit rule: `#[tauri::command]` fn + `generate_handler!` entry + `src/api.ts` wrapper for each)

- `list_chains`, `save_chain`, `delete_chain` — CRUD against
  `.palisade/chains/`.
- `run_chain(chain_name, seed_input, thread_id)` — starts a run, returns a
  run id.
- `resolve_chain_gate(run_id, decision, note?)` — approve / reject /
  send-back-with-note for a paused approval gate.
- Chain-run progress reuses the existing `Envelope{session_id, thread_id,
  event}` emission pattern (CLAUDE.md gotcha) with a new `ExecutorEvent`
  variant or a parallel `chain-event` channel carrying run id, current
  node, and state — exact wire shape is an implementation detail for
  tasks.md, not a spec-level concern.

## Risks / Trade-offs

- **[Risk]** Automatic node-crash retry (D21) re-sends into a fresh
  session, but the *chain's* accumulated context (seed + upstream output)
  is still handed to the retry — the underlying error-compounding concern
  (contaminated context) is only partially mitigated, since the chain-level
  narrative isn't reset, only the crashed node's own session. →
  **Mitigation**: document this explicitly in the node's guideline UI
  ("retries start a fresh session but see the same upstream output"); no
  further engineering mitigation attempted in v1 per user's explicit
  override of the recommended abort-only behavior (decisions.md D21).
- **[Risk]** A chain with a very deep or wide DAG could make the live view
  hard to read, and nothing in this design caps chain size. →
  **Mitigation**: none in v1; revisit if it's actually a problem in
  practice (no fan-out yet caps width anyway, per D10).
- **[Risk]** Per-node agent picker (D16) is a real, spec-visible exception
  to `executor-model-switcher`'s detection-not-config rule — a future
  reader of that spec could see the chain-node picker and assume the rule
  was dropped project-wide. → **Mitigation**: the `agent-chain-builder`
  spec's node-binding requirement explicitly scopes the exception to chain
  nodes; `executor-model-switcher`'s spec is left unmodified (not touched
  by this change) so its normal-thread requirement stands as-is.

## Migration Plan

1. Land the `.palisade/` path change and `agent-chain-builder` data
   model/execution engine together (per D11, bundled).
2. No data migration for existing `.project-settings.json` files — clean
   break (D12); users move the file manually if they want to keep it.
3. No feature flag: single-developer project, no staged rollout needed.
