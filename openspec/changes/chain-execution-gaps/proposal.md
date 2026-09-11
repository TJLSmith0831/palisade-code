## Why

The chain builder ships and runs — a concurrent frontier scheduler, gated
loops, retries, persisted run history, re-run-from-node. What it does not
yet do is survive contact with a user building a chain by hand. Dragging a
node opens its editor instead of moving it; saving a new chain leaves its
tab named "new chain" forever; running one from the panel silently
commandeers whatever chat thread happened to be focused; a run started from
chat can't see its own past runs; a human can approve or reject a chain's
work but can never contribute to it; and nothing in the product explains
what any of this is.

Those are seven distinct gaps with one shape: the execution engine is
further along than the surface that drives it. This change closes the
surface gaps and adds the one missing execution capability (D1).

## What Changes

- **A human-in-the-loop node.** `ChainNode` gains a `kind` field
  (`agent` by default, `human` new). A human node pauses the run, shows its
  upstream output, and takes free text — that text becomes the node's
  output and flows downstream exactly as an agent's would (D9). This is
  distinct from the existing `Gate::Approval`, which lets a human judge a
  chain's work but never contribute content to it (D4). The pause is
  resolved in the `awaiting` slot on `ChainRunCard` that already resolves
  approval gates — one pause surface, not two (D17).
- **The wall clock pauses while a run waits on a human.** A run's
  `timeout_seconds` budget measures agent work only, and stops for human
  nodes and existing approval gates alike (D12). This fixes a live bug: a
  paused approval gate can currently time out a run the user was about to
  approve, forcing a re-run that re-spends every upstream node.
- **A chain run's home is decided by who started it.** A chain fired from
  a thread — inline with `|=`, or by that thread's model-picker executor
  slot resolving to `chain:<name>` — runs on that thread, and the two paths
  behave identically. A run started from the Chains panel creates its own
  thread, named after the chain, instead of commandeering whatever thread
  was focused (D3, D7). All three entry points keep sharing one launcher,
  which becomes explicit about its thread rather than falling back to
  focused-thread state — that fallback is the hijacking bug, and it is
  latent on the go-mode path too (D7a).
- **Past runs reachable from chat.** `ChainRunCard` gains a collapsed
  "past runs" section rendering the existing `ChainRunHistory` for that
  chain, which today is reachable only from `ChainsPanel` (D2, D8).
- **Dragging a node no longer opens its editor.** The click/drag guard is
  dead code: the surface's `onPointerUp` nulls the drag state before the
  click fires, so the guard always reads `null` (D14).
- **Saving a chain renames its tab**, and stops a saved chain from opening
  a second tab beside its own "new chain" one (D15).
- **Chains explain themselves**: teaching empty states on the canvas and in
  `ChainsPanel`, plus one worked example chain — including a human node —
  that can be opened, read, and run (D16). The canvas header also states
  how wide the chain actually runs (D13).

### Non-goals

Per-node timeouts, run-level cost ceilings, and resuming a run across an
app restart are explicitly out of scope; D-c (chains never auto-resume)
stands untouched (D6). Parallel scheduling itself does not change — the
frontier already fans out and `stateLabel` already renders "waiting on 2 of
3"; only the authoring-time blind spot is addressed (D5, D13).

## Capabilities

### New Capabilities

_None._ Every item here is a gap in the existing chain capability, not a
new one.

### Modified Capabilities

- `agent-chain-builder`: adds a human-in-the-loop node kind whose output is
  authored by the user; scopes the run wall clock to agent work so a
  human-blocked run cannot time out; requires a thread-initiated run (`|=`
  or the model picker, identically) to run on that thread while a
  panel-started run owns a thread of its own; requires past runs to be
  reachable wherever a chain was invoked; and requires the builder to be
  self-explanatory from its empty states.

## Impact

- **Rust**: `chains.rs` (`NodeKind`, serde-default migration),
  `chain_runner.rs` (`elapsed` becomes budget-aware; human node dispatch),
  `chain_exec.rs` (human turn resolution), `lib.rs`
  (`unavailable_agents` skips human nodes — otherwise D17's preflight
  blocks every chain containing one).
- **Frontend**: `ChainCanvas.tsx` (drag guard, node-kind editor, header
  parallelism line, empty state), `ChainRunCard.tsx` (past-runs section,
  free-text pause shape), `ChainsPanel.tsx` (own-thread run, empty state),
  `openTabs.ts` + `App.tsx` (tab rename on save), `api.ts` (human-node
  resolution IPC).
- **On-disk**: `.palisade/chains/*.json` gains an optional `kind` per node.
  A serde default is the entire migration — every existing chain keeps
  parsing untouched (D10).
- **No change** to `chain_history.rs`'s record shape, to run persistence,
  or to the spec/go two-mode invariant.
