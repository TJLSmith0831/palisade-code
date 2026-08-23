## 1. `.palisade/` settings migration (small, independent, do first)

- [x] 1.1 Move `settings.rs`'s `FILE_NAME` path join to `.palisade/project-settings.json`, no fallback to the old root path
- [x] 1.2 Update `.gitignore`: replace `.project-settings.json` with `.palisade/`
- [x] 1.3 Update the two stale-path warning strings in `acp_preflight.rs:131,139`
- [x] 1.4 `cargo test settings::` — confirm load/save/absent/malformed scenarios all pass at the new path

## 2. Chain definition data model + storage

- [x] 2.1 Define the chain JSON shape (design.md: nodes/edges/entry/timeout/retry) as Rust structs with serde
- [x] 2.2 Implement load/save/list/delete against `.palisade/chains/<name>.json`, lazy-creating the directory on first save (mirroring `settings.rs:74`'s pattern)
- [x] 2.3 Validate on save: every edge's endpoints exist as node keys; every loop-closing edge (detected by graph cycle, not a user-set flag) has a gate and a `maxIterations`
- [x] 2.4 IPC commands `list_chains`/`save_chain`/`delete_chain` (fn + `generate_handler!` entry + `src/api.ts` wrapper each)
- [x] 2.5 `cargo test` for the new module — round-trip save/load, validation rejects an ungated loop edge

## 3. Execution engine core (riskiest — build and verify before gates/UI)

- [x] 3.1 New `chain_runner.rs`: in-memory `ChainRun` (run id, current node, iteration counters, elapsed time, retry counts), not persisted
- [x] 3.2 Node-turn instruction composition per design.md (guideline + seed input + upstream output; first node omits upstream segment)
- [x] 3.3 Forward-edge walk: entry node runs, output hands off to the next node with no gate, using a real `AcpSession` per node turn (reuse `ensure_session`)
- [x] 3.4 `cargo test chain_runner::` — a 2-node, no-loop, no-gate chain runs start to finish and each node's transcript is a real session transcript

## 4. Gates and loops

- [x] 4.1 Verify-type gate: call the existing verification execution path by command name, read persisted exit code, exit loop on 0 / repeat on non-zero
- [x] 4.2 Approval-type gate: suspend run state, add `resolve_chain_gate(run_id, decision, note?)` IPC command handling approve/reject/send-back-with-note
- [x] 4.3 Send-back-with-note re-runs the upstream node with the note appended to its composed instruction (design.md)
- [x] 4.4 Iteration cap enforcement: loop stops and surfaces a reason once `maxIterations` is reached regardless of gate type
- [x] 4.5 `cargo test` — verify-gated loop exits on pass, repeats on fail, stops at cap; approval-gated loop suspends and resumes correctly on all three decisions

## 5. Runaway guardrails

- [x] 5.1 Per-run wall-clock timeout (default 1800s, overridable in the chain definition), aborting the run and surfacing the timeout reason
- [x] 5.2 Per-node crash retry: configurable `maxAttempts`, each retry starts a fresh `AcpSession` (not continuing the crashed one's context); run aborts with a surfaced reason once exhausted
- [x] 5.3 `cargo test` — a run exceeding its timeout aborts; a node exhausting retries aborts with the exhausted-retries reason

## 6. Agent-unavailable pre-run check

- [x] 6.1 Before starting a run, check every node's bound agent against the same registry preflight normal auto-detect uses; block the run and name the missing node/agent if any is unavailable
- [x] 6.2 `cargo test` — a chain with an uninstalled bound agent fails to start with a specific, named error

## 7. Chain-run events to the frontend

- [x] 7.1 Add `run_chain(chain_name, seed_input, thread_id)` IPC command, returns a run id
- [x] 7.2 Emit chain-run progress (run id, current node, node state) following the existing `Envelope{session_id, thread_id, event}` pattern
- [x] 7.3 `src/api.ts` wrappers for `run_chain` and `resolve_chain_gate`

## 8. `|=` sigil invocation

- [x] 8.1 Generalize `src/slashCommands.ts`'s `SIGILS` handling from `slice(1)` to `slice(sigil.length)`, add `|=` to the array
- [x] 8.2 Add a second command source to the popup (saved chains from `.palisade/chains/`), merged with ACP-advertised commands, visually distinguished
- [x] 8.3 Parse `|=<chain-name> <seed text>`: chain name is the first token, remainder (if any) becomes seed input; bare invocation is valid with empty seed
- [x] 8.4 `npx vitest run` on the updated `slashCommands` test file — multi-char sigil open/close/fuzzy-match behavior, plus chain-name matching

## 9. Chain canvas builder UI

- [x] 9.1 New canvas view: add/connect/delete nodes and edges (Mantine components only, per CLAUDE.md)
- [x] 9.2 Node editor: role name, guideline text input, agent picker sourced from the cached registry preflight (D16's deliberate exception to detection-not-config, scoped to chain nodes only)
- [x] 9.3 Edge editor: gate type (verify command picker / human-approval), `maxIterations` field, required only when the edge closes a cycle
- [x] 9.4 Save/list/delete chains through the Section 2 IPC commands
- [x] 9.5 Manual verification via the `run` skill: build a 2-node chain with one loop edge in the running app, confirm it saves and reappears on reload

## 10. Live DAG run view

- [x] 10.1 Run panel: render the graph, highlight the currently executing node, mark completed/failed nodes
- [x] 10.2 Click-through from a node to its real session transcript
- [x] 10.3 Approval-gate UI: approve / reject / send-back-with-note controls, wired to `resolve_chain_gate`
- [x] 10.4 Condensed summary message posted to the invoking thread on run completion or gate pause
- [x] 10.5 Manual verification via the `run` skill: run a saved chain from `|=`, watch it execute live, approve a gate, confirm the thread receives the summary

## 11. Go-mode integration

- [x] 11.1 Extend the executor-resolution slot (thread picker → project override → auto-detect, `lib.rs` `selected_executor`) to accept "a saved chain" as a resolvable target, without adding a third mode
- [x] 11.2 Wire go-mode execution (including OpenSpec change application) to run the selected chain instead of a single agent session when so configured
- [x] 11.3 Manual verification via the `run` skill: set a thread's go-mode executor to a saved chain, run `/go`, confirm the chain executes end to end

## 12. Final gate

- [x] 12.1 `cargo test` (full suite) and `pnpm test` (full suite) both green
- [x] 12.2 `openspec validate agent-chain-builder --strict` passes
- [x] 12.3 Manual end-to-end run through the `run` skill covering: build a chain, save it, invoke via `|=`, invoke via go mode, hit a loop with both gate types, hit the timeout path (short-timeout test chain), hit the missing-agent block path
