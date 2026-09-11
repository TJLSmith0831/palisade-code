## Why

`chain_runner.rs:105` currently reads:

> `/// One in-flight run. Deliberately not persisted (D15).`

with the module doc adding: "Holds run state in memory only — a run
interrupted by an app restart is gone, same as any other session (D15)."

That decision is reversed here. Run history is the prerequisite for
**re-run-from-node**: after a run stops partway (a failed gate, a crash, a
cancelled node), restarting it today re-spends every upstream node from
scratch. Each node is a real ACP agent turn against a paid subscription, so
re-spending three already-successful nodes to retry a fourth is not a
convenience gap, it is a recurring cost. Persisting what each node produced
is what makes "start again from node 4 with node 3's real output" possible,
and for a surface that spends real money per node, that is the highest-value
feature on the table.

This proposal is scoped to *why the record exists and what it must never
do*. It does not itself build re-run-from-node's UI (a later task's
concern) — it establishes the persisted record that feature depends on, and
locks in the constraint that makes persisting it safe.

## What Changes

- **Run history becomes a persisted, append-only record** — one per run,
  under Palisade user storage (`~/.palisade-code`, alongside session
  records), never inside the target repository. Never the JSON `.palisade/`
  files a chain definition itself lives in, and never anything `git status`
  in the target project would show.
- Each record captures: run id, chain name and **a snapshot of the chain
  definition exactly as it was when the run started**, seed, start/end
  timestamps, every per-node state transition with its timestamp, each
  node's backing session id, its iteration count, and its reported cost
  where the agent supplied one (absent stays absent — never coerced to
  `0.0`, which would read as free instead of unknown).
- The snapshot is load-bearing: re-running from a node must replay the
  definition as it stood at run time, not the current one, so editing a
  chain after a run can never silently change what a later re-run does.
- **No auto-resume.** This does not touch D-c, the standing product
  decision that in-progress chains never resume automatically after a
  restart (see `PRODUCT.md`). A run record left open when the app restarts
  is closed `interrupted` — the same reconciliation `store.rs` already
  performs for ordinary sessions (`close_stale_sessions`). Palisade
  persists the *record* of what happened; it does not resume the *process*.

## Capabilities

### Modified Capabilities

- `agent-chain-builder`: rewrites "Chain runs do not persist across an app
  restart" to describe a persisted, non-resuming record instead of an
  in-memory-only run — the run's *history* now survives; the run's
  *process* still does not.

### New Capabilities

_None._ Run history is additive detail on the existing chain-run
capability, not a new one.

## Impact

- **Code**: `src-tauri/src/chain_history.rs` (new, this change) — the
  append-only record and its startup reconciliation, self-contained and
  independently tested. Wiring it up (a `mod chain_history;` line in
  `lib.rs`, the `list_chain_runs`/`get_chain_run` IPC commands, and the
  `src/api.ts`/`ChainsPanel.tsx` surfaces that read it) is separate,
  already-scoped work tracked in `tasks.md` below — this proposal does not
  claim that wiring is done.
- **Data**: new `~/.palisade-code/projects/<hash>/chain_runs.jsonl`,
  following the same convention as `verify.jsonl` and
  `<thread>.sessions.jsonl`.
- **Verification**: `cd src-tauri && cargo test chain_history::` once the
  module is registered; `cargo test` stays green as a whole (no existing
  file is edited by this change).
