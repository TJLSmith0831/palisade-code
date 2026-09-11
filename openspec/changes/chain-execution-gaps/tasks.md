**Binding for every task below (D18, D19):**

- **TDD.** Write the test first, confirm it red, then make it green. A task
  report that cannot show the red step is not done. Test bullets lead their
  group wherever the test is writable before the code.
- **Ponytail.** Laziest working solution: reuse before writing, stdlib and
  native before dependencies, shortest diff that fixes the *root cause*. No
  new dependency — `std::sync` and existing Mantine components only. A
  deliberate corner-cut carries a `ponytail:` comment naming its ceiling.

Riskiest first (design §1): the `Budget` change touches the runner's hot
path and every timeout test, so it lands before anything depends on it.
Each group is independently verifiable and independently shippable.

## 1. Pause-aware run budget (riskiest — do first)

- [x] 1.1 **Red first.** Write the `Budget` tests against `unimplemented!()`
  stubs and confirm them failing: `elapsed()` excludes paused time; two
  *concurrent* pause guards accrue one pause, not two (the overlap case this
  change introduces by adding a second kind of pause); a guard dropped on
  panic still closes its pause.
- [x] 1.2 Green: `Budget { started, paused, depth }` behind an `Arc`, with
  `elapsed()` = `started.elapsed() - paused` and a `pause()` RAII guard that
  accrues only as depth falls 1 → 0 (design §1). `std::sync` only — no
  dependency.
- [x] 1.3 **Red first.** A run suspended at an approval gate past its
  timeout resumes when the human answers rather than having aborted. This
  test fails against today's `chain_exec.rs:489`, which is the bug.
- [x] 1.4 Green: replace `ChainRun::started: Instant` with the shared
  `Budget`; `ChainRun::elapsed` and `run_node_turn`'s deadline check
  (`chain_runner.rs:585`) both consult it, so no absolute `Instant` is
  copied into a worker thread. `wait_for_approval` (`chain_exec.rs:475`)
  takes a `pause()` guard and stops using the run budget as its receive
  timeout.
- [x] 1.5 Confirm a run whose *agent* work exceeds the budget still reports
  `TimedOut`, and existing `with_timeout` tests stay green.
- [x] 1.6 Gate: `cd src-tauri && cargo test chain_runner::` green.

## 2. Human-in-the-loop node — definition and scheduling

- [x] 2.1 **Red first.** Round-trip tests against stubs: a saved chain JSON
  with no `kind` loads as an agent node; a human-node chain serializes
  without disturbing existing fields; `save` accepts an all-human chain;
  `unavailable_agents` passes an all-human chain.
- [x] 2.2 Green: `NodeKind { Agent, Human }` with `Agent` as `Default`,
  added to `ChainNode` as `#[serde(default)] kind`. The serde default is the
  whole migration (D10) — no version field, no rewrite pass.
- [x] 2.3 Green: `lib.rs`'s `unavailable_agents` filters human nodes before
  checking installs (D11) — otherwise the preflight blocks every chain
  containing one.
- [x] 2.4 **Red first.** Fake-runner scheduling tests: a human node's
  returned text reaches its downstream node as upstream output; a human
  node as entry receives the seed; a human node in a loop is still bounded
  by the loop's iteration cap; Stop during a human wait yields `Cancelled`,
  not `Failed`; a human node is **never retried**.
- [x] 2.5 Green: `NodeRunner::human_turn(role, instruction)`; `walk_from`
  dispatches on `NodeKind` and calls it without the retry loop (design §2).

## 3. Human node — resolution plumbing

- [x] 3.1 `chain_exec.rs`: `AcpNodeRunner::human_turn` parks on a channel,
  taking a `Budget::pause()` guard and polling the same cancellation flag
  the approval wait does. Emits node state so the live view shows the
  suspension.
- [x] 3.2 `Harness.chain_humans: Mutex<HashMap<(run_id, role),
  Sender<String>>>`, mirroring `chain_gates` rather than overloading it
  (design §3).
- [x] 3.3 `resolve_chain_human(run_id, role, text)` `#[tauri::command]`,
  shaped like `resolve_chain_gate` (`lib.rs:3205`) — **and registered in
  `generate_handler!`**.
- [x] 3.4 `src/api.ts` wrapper for it. (CLAUDE.md: a new IPC command is
  three edits; this is the one silently forgotten.)
- [x] 3.5 `ChainRunCard.tsx`: the existing `awaiting` slot gains a
  free-text shape alongside approve/reject/send-back (D17) — one pause
  surface, not two.

## 4. Where a run lives

- [x] 4.1 `src/App.tsx`: delete `startChainRun`'s `onThread ?? thread`
  fallback (`App.tsx:4590`); the thread becomes a required argument.
- [x] 4.2 Go-mode (`App.tsx:4800`) passes the thread it just called
  `goMode` on — closing the same latent hijacking bug on that path (D7a).
- [x] 4.3 `ChainsPanel` run creates a thread named after the chain and
  passes it; its button stops saying "Run on this thread"
  (`ChainsPanel.tsx:155`).
- [x] 4.4 Test: `|=` and an executor-selected chain produce
  indistinguishable results; a panel run leaves the focused thread
  untouched.

## 5. Past runs where the chain was invoked

- [x] 5.1 `ChainRunCard.tsx`: a collapsed "past runs" section rendering the
  existing `ChainRunHistory` for that chain — no new component (D8).
- [x] 5.2 Wire its re-run callback to the card's existing
  `rerunChainRun` path so re-run-from-node works identically from chat.
- [x] 5.3 Test: past runs are collapsed by default and expand on request.

## 6. Canvas fixes

- [x] 6.1 **Red first.** A drag past `DRAG_SLOP` moves the node and opens no
  editor; a press-release below it opens the editor and does not move the
  node. The first assertion fails against today's code — that is the bug
  report reproduced.
- [x] 6.2 Green: latch `justDragged` on pointerup, read-and-clear it in the
  node's `onClick`, replacing the guard at `ChainCanvas.tsx:805` that reads
  state `onNodePointerUp` already nulled (design §6). Reset on the next
  pointerdown so an interrupted gesture cannot leave it stuck. Root cause,
  not a symptom patch: `DRAG_SLOP` already works.
- [x] 6.3 Node editor: a kind toggle (agent / human) that hides the agent
  and model pickers for a human node. Mantine components only.
- [x] 6.4 Canvas header states how many nodes can run at once, and the
  configured `maxParallel` cap when set (D13). One line — D13 is
  deliberately scoped to this and nothing more.

## 7. Tab identity

- [x] 7.1 `ChainCanvas.save()` reports the saved name upward; `openTabs.ts`
  gains a rename so the tab's key moves from `chain:new`
  (`openTabs.ts:87`) to `chain:<name>`.
- [x] 7.2 Test: saving a new chain renames its tab, and opening that chain
  from the sidebar surfaces the existing tab instead of a duplicate.

## 8. Teaching surfaces

- [x] 8.1 Empty chain canvas explains nodes, edges, gates, and loops in
  place.
- [x] 8.2 `ChainsPanel` empty state explains the build-then-run cycle,
  replacing today's single `|=` line (`ChainsPanel.tsx:106`).
- [x] 8.3 A worked example chain, including a human node, openable from the
  empty state. Test that it passes `chains::save`'s validation, so a schema
  change that invalidates it fails the suite rather than shipping.

## 9. Gate

- [x] 9.1 `cd src-tauri && cargo test` green.
- [x] 9.2 `pnpm test` and `npx tsc --noEmit` green.
- [x] 9.3 Drive the running app (`.agents/skills/run-palisade-code/SKILL.md`):
  build a two-node chain with a human node, drag a node without opening its
  editor, save it and see the tab renamed, run it from the panel and
  confirm it takes its own thread, answer the human node, and open past
  runs from the run card.
