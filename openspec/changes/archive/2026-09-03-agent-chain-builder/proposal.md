## Why

Palisade currently drives one agent per thread at a time. Real work often
needs more than one specialist cooperating — e.g. Gemini as a designer and
Claude as the programmer, critiquing each other's output until a build
passes — and today that requires manually copy-pasting between separate
threads. A low-code chain builder lets a user wire named, role-bound agent
nodes into a DAG (with optional gated loops) once, save it, and re-run it
from any thread — turning a manual, error-prone hand-off into a first-class,
reusable capability.

## What Changes

- Add a visual, low-code DAG canvas for building "chains": named, reusable
  pipelines of role-bound agent nodes connected by handoff edges, savable
  per-project.
- Each node binds a role (free-text guideline instructions) to a specific
  installed agent, selected explicitly by the user — a deliberate exception
  to the existing detection-not-config rule for normal-thread executors,
  since explicit agent choice is the point of a chain node.
- Support real graph cycles (loops), each loop-closing edge gated by a
  verify command or a human-approval step (approve / reject /
  send-back-with-note), plus a mandatory per-loop iteration cap. Non-loop
  (forward) edges are plain pipes by default; gates on them are optional.
- Verify gates reuse the existing project `verify` command mechanism
  (`.project-settings.json`'s `verify` map) — no new verification system.
- A chain run has a configurable wall-clock timeout (default 30 min) and
  per-node configurable auto-retry-then-abort on a crashed node.
- Chains are invoked two ways, both inside the existing two-mode
  (spec/go) invariant — no third mode: (1) as the executor strategy behind
  a thread's "go" execution (including applying an OpenSpec change), and
  (2) mid-chat via a new `|=<chain-name> <seed text>` sigil, reusing and
  generalizing the existing `/`/`$` sigil-menu mechanism.
- While a chain runs, a live DAG panel shows node execution state; clicking
  a node opens its real session transcript. The invoking thread gets a
  condensed summary message on completion or when a gate pauses for
  approval.
- Chain runs don't persist across app restart (consistent with existing
  session lifecycle) — an in-progress run is simply interrupted.
- **BREAKING**: `.project-settings.json` moves from the project root to
  `.palisade/project-settings.json`; chain definitions live alongside it at
  `.palisade/chains/<name>.json`. No fallback or auto-migration from the
  old path — a clean break (single-developer project, no external users).

## Capabilities

### New Capabilities
- `agent-chain-builder`: the chain data model (role-bound nodes, DAG/loop
  edges, gates, retry/timeout config), the execution engine, the
  `|=`-sigil and go-mode invocation surfaces, and the live-run DAG view.

### Modified Capabilities
- `project-settings`: the `project-settings.json` location requirement
  changes from the project root to `.palisade/project-settings.json`; all
  other requirements (format-on-save, executor override, gitignoreability)
  keep their existing behavior at the new path.

## Impact

- **Backend**: `src-tauri/src/settings.rs` (`FILE_NAME` const and its
  path-join call sites), `src-tauri/src/acp_preflight.rs` (warning message
  strings referencing the old path), new chain-definition storage/loading,
  new chain-execution scheduling built on the existing `AcpSession` map
  (`acp_client.rs`) and unified ACP event parser (`acp_events.rs`), new IPC
  commands (chain CRUD, chain run start/approve/reject/send-back), verify
  gates calling the existing verification execution path
  (`openspec/specs/verification/spec.md`).
- **Frontend**: `src/slashCommands.ts` (`SIGILS` generalized to multi-char,
  a second command source for chain names), a new chain-canvas/build UI, a
  new live-DAG run-view panel, `src/api.ts` wrappers for the new IPC
  commands, `.gitignore` entry moves from `.project-settings.json` to
  `.palisade/`.
- **Specs**: new `agent-chain-builder` spec; delta to `project-settings`
  for the path change. `executor-model-switcher`'s detection-not-config
  rule is unaffected for normal threads — the chain-node agent picker is a
  new, additive surface scoped to chain configuration only.
