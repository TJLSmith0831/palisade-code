## 1. Persisted run record (this task)

- [x] 1.1 `src-tauri/src/chain_history.rs`: append-only `ChainRunRecord` —
  run id, project hash, thread id, chain name, chain definition snapshot,
  seed, start/end timestamps, per-node transitions/session id/iterations/
  cost, terminal outcome. TDD: tests written first, confirmed red against
  `unimplemented!()` stubs, then green (see this task's report for the
  red/green output).
- [x] 1.2 `start_run`/`record_transition`/`record_cost`/`end_run`/
  `list_runs`/`get_run` — append-and-amend, id-keyed, last line wins on
  read, mirroring `store::SessionRecord`'s convention.
- [x] 1.3 `close_stale_runs` — startup reconciliation: any record left
  open with an id outside the live set is closed `interrupted`, mirroring
  `store::close_stale_sessions`. No auto-resume (D2).
- [x] 1.4 Tests: round-trip through every `NodeState`/`Outcome` variant;
  an open record is closed `interrupted` on reconciliation and a live one
  is untouched; a record's resolved path lives outside a `tempfile`
  project root; a node with no reported cost round-trips as absent, never
  `0.0`.
- [x] 1.5 This OpenSpec change: document the D15 reversal as a spec
  change rather than an edited comment (`chain_runner.rs:105`'s comment is
  left as-is; this change is its supersession).

## 2. Wiring (owned by other, already-scoped tasks — not this change's work)

- [x] 2.1 `mod chain_history;` in `src-tauri/src/lib.rs`
- [x] 2.2 `list_chain_runs(project_hash, chain_name?)` and
  `get_chain_run(run_id)` `#[tauri::command]`s, registered in
  `generate_handler!`
- [x] 2.3 `src/api.ts` wrappers for the above (CLAUDE.md: a new IPC
  command is three edits — this is the one silently forgotten)
- [x] 2.4 Call `chain_history::start_run`/`record_transition`/
  `record_cost`/`end_run` from `chain_exec.rs`'s `AcpNodeRunner` as a run
  progresses
- [x] 2.5 `ChainsPanel.tsx` run-history UI and re-run-from-node, consuming
  the persisted `chain_snapshot` rather than the live chain definition

## 3. Gate

- [x] 3.1 `chain_history.rs`'s own tests pass, verified against real
  copies of `chain_runner.rs`/`chains.rs` in an isolated crate (this
  module cannot itself be registered in `lib.rs` by this task; see the
  task report)
- [x] 3.2 `cd src-tauri && cargo test` green once `mod chain_history;`
  is registered (task 2.1)
