# Decision log — chain-run-history

Source of truth for this change. Reverses D15 from the original
`agent-chain-builder` work.

## D1: Reverse D15 — persist chain run history

- **Decision**: A chain run's history is persisted to disk, append-only,
  one record per run. `chain_runner.rs:105`'s original comment —
  `/// One in-flight run. Deliberately not persisted (D15).` — is
  superseded by this change, not hand-edited; the comment's fate belongs
  here, in the spec history, not in a silently rewritten code comment.
- **Why**: Persisted history is the prerequisite for re-run-from-node —
  restarting a stopped run at the node that stopped it, using the
  already-recorded output of every upstream node instead of re-spending
  them. Each node is a real paid agent turn, so re-spending three
  successful nodes to retry a fourth is a recurring cost, not a
  convenience gap. Across everything else considered for chain runs, this
  is the highest-value feature, and it is only possible once a run's
  outputs outlive the process that produced them.
- **Source**: user

## D2: What does NOT change — D-c (no auto-resume) stands

- **Decision**: Persisting the record does not mean resuming the process.
  `PRODUCT.md`'s constraint — in-progress chains do not automatically
  resume after an app restart — is preserved exactly. A run record still
  open when the app restarts is closed with an `interrupted` outcome, the
  same reconciliation `store.rs::close_stale_sessions` already performs
  for ordinary sessions: no agent process survives a restart, so an open
  record is stale by construction, and Palisade never spawns one back up
  on the user's behalf.
- **Why**: D15's original concern (do not pretend a dead run is still
  alive) is exactly D-c's concern too. Reversing "not persisted" does not
  require reversing "not resumed" — they are independent properties, and
  conflating them would silently reintroduce auto-resume, which was never
  asked for and contradicts a standing product decision.
- **Source**: user (PRODUCT.md), reasoning from this change's author

## D3: Where the record lives, and what convention it follows

- **Decision**: `~/.palisade-code/projects/<hash>/chain_runs.jsonl` —
  under `store::project_dir`, alongside `verify.jsonl` and
  `<thread>.sessions.jsonl`. Never under the target project's own tree.
  The write shape mirrors `store::SessionRecord`: a run's record is
  appended repeatedly as it progresses (open, each state transition, the
  terminal outcome), id-keyed, with the last line for an id winning on
  read — never rewritten in place.
- **Why**: `store.rs` already solved "durable, append-only, outside the
  target repo" twice (session logs, verification runs). Inventing a
  second storage convention for the same problem is unjustified; matching
  it means no new failure mode to reason about (torn-line recovery,
  atomic-enough appends, JSONL tolerance of corrupt lines) — the module
  reuses `store.rs`'s reasoning, not its private code, since
  `chain_history.rs` intentionally stays self-contained.
- **Source**: codebase (`src-tauri/src/store.rs` — `append_verification`,
  `append_session`/`close_session`, `close_stale_sessions`)

## D4: The chain definition snapshot, not the live definition

- **Decision**: Every run record embeds `chain_snapshot: Chain` — the
  exact chain definition object at the moment the run started, not a
  reference to `.palisade/chains/<name>.json`. A later re-run (from the
  start or from a node) replays this snapshot, never the file as it
  currently reads.
- **Why**: A chain is editable at any time. Without a snapshot, editing a
  chain between a stopped run and its re-run would silently change what
  the re-run does — possibly re-running a node whose role no longer
  exists, or with a different agent bound to it than the one that
  produced the recorded upstream output the re-run is about to consume.
  The snapshot is what makes re-run-from-node *safe*, not merely
  possible.
- **Source**: user

## D5: Absent cost stays absent

- **Decision**: A node's reported cost is `Option<NodeCost>`. It is never
  set to `0.0` to mean "not reported" — the field is left `None`, and a
  record with some nodes costed and others not stays that way permanently
  on disk.
- **Why**: `0.0` reads as free; an agent that doesn't report `usage.cost`
  is not free, it's simply unmetered by this record. Coercing the two
  together would make every future reader (a run's total-cost display,
  in particular) silently understate real spend for any chain mixing a
  cost-reporting agent with one that doesn't.
- **Source**: `PLAN.md` §1 D-d ("Never show a partial total as if it were
  complete")

## D6: `NodeState`/`Outcome` are mirrored, not reused, on disk

- **Decision**: `chain_history.rs` defines its own `NodeStateSnapshot` and
  `OutcomeSnapshot` enums, structurally identical to
  `chain_runner::NodeState`/`Outcome`, converted via an exhaustively
  matched `From` impl, rather than deriving `Deserialize` on the
  originals or storing them as loosely-typed JSON.
- **Why**: `chain_runner::NodeState`/`Outcome` only derive `Serialize` —
  an in-memory run never needs to deserialize its own state, so there was
  no reason for `chain_runner.rs` (owned by a different, concurrent task)
  to carry that derive. A history record must round-trip, so this module
  needs `Deserialize` somewhere. Mirroring locally means `chain_history.rs`
  stays self-contained per its own scope (it must compile and test
  independently of the `mod chain_history;` line a later task adds) and
  means a future `NodeState`/`Outcome` variant fails this module's build
  instead of silently losing data on disk. The one addition on this side —
  `OutcomeSnapshot::Interrupted` — has no equivalent in `chain_runner::Outcome`
  because it is not a run outcome at all; it is what startup reconciliation
  writes on the run's behalf (D2).
- **Source**: reasoning from this change's author, during implementation
