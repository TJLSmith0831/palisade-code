# Graph Tool Nudge Decision Log

## D1: Why not a skill file?

- **Decision**: The instruction ships as text Palisade injects at session start, not as a
  file under `~/.claude/skills/`, `.agents/`, or `.claude/`.
- **Why**: Those directories are gitignored in this repo, so a skill there is a
  machine-local edit that never ships to another user. Palisade's whole premise is that
  the shell configures the agent — the same reason grill skills are bundled `&'static str`
  constants rather than installed files (`grill_inject.rs` header). A user who installs
  Palisade should get graph-aware agents without installing anything else.
- **Source**: user, explicit.

## D2: Prompt prefix or an ACP-level system prompt?

- **Decision**: Prompt prefix, via the existing `pending_prefix` map.
- **Why**: ACP has no system-prompt channel. `NewSessionRequest` carries exactly `cwd`,
  `additional_directories`, `mcp_servers`, and `_meta` (verified in
  agent-client-protocol-schema 1.5.0, `src/v2/agent.rs:1110`; the v1 struct at
  `src/v1/agent.rs:1011` is the same set). `_meta` is explicitly reserved and agents
  "MUST NOT make assumptions about values at these keys", so it is not a prompt channel
  either. There is nowhere else to put the text.
- **Consequence**: the nudge costs input tokens on the first turn of every qualifying
  session. That is the price of the mechanism; it is bounded by keeping the block short
  (D4).

## D3: Once per session, or every turn like grill?

- **Decision**: Once, on the session's first prompt. Both spec and go mode.
- **Why**: Grill re-injects because it is a *procedure* the agent must keep following turn
  after turn, and losing it mid-thread changes how the agent behaves. This is a *tool
  routing hint* — an agent that has learned the tools exist does not need to be re-told,
  and once the agent has actually called `query_graph` once, the transcript itself is the
  reminder. Per-turn re-injection would multiply the token cost by turn count to buy
  nothing, which inverts the point of the change.
- **Both modes**: unlike grill (spec-only, D19), "what breaks if I change this" is a
  mid-build question, not just an explore-phase one. Go mode is where impact analysis
  matters most.
- **Mechanism**: `pending_prefix` is drained by `send_to` and cleared, so "once" is
  already the built-in semantics — no new state. A `/go` that starts a session without
  prompting parks the prefix and it rides the next real turn, same as handoff transcripts.

## D4: What does the injected text say?

- **Decision**: Short block: what the tools are (by real name), a question→tool mapping for
  the cases the graph wins, and an explicit statement of when to use grep instead.
- **Why**: Two failure modes to avoid. Too vague ("graph tools are available") and the
  agent ignores it, which is the status quo. Too pushy ("prefer graph tools") and the agent
  routes literal-text searches through a semantic graph, gets worse answers, and the change
  is a net loss. The mapping makes the trigger conditions concrete; the counter-instruction
  keeps grep as the default for what grep is good at.
- **Cost discipline**: the block stays under ~150 tokens. It is paid on every session
  start, so length is a recurring cost, not a one-off.
- **Draft text** (final wording set at apply time, task 2.1):

  > This project has a prebuilt code graph, exposed as MCP tools from the `graphify`
  > server: `query_graph` (semantic search over the graph), `get_neighbors` (direct
  > callers/callees of a node), `shortest_path` (how two things connect), `get_node`,
  > `god_nodes` (most-connected nodes), `graph_stats`.
  >
  > Use them instead of a grep fan-out for structural questions:
  > - what calls / uses X → `get_neighbors`
  > - how does A reach B → `shortest_path`
  > - what breaks if I change X → `get_neighbors`, then `query_graph`
  > - where does concept X live in this codebase → `query_graph`
  > - first orientation in unfamiliar code → `god_nodes`
  >
  > Keep using grep and file reads for exact strings, current file contents, and anything
  > you are about to edit. The graph is a map of the code, not the code — confirm in the
  > file before changing it.

## D5: When is the nudge suppressed?

- **Decision**: Skip silently unless all three hold — `graphify-mcp` resolves on PATH, the
  session's agent is one Palisade actually writes MCP config for (`claude-acp`,
  `codex-acp`), and `<project>/graphify-out/graph.json` exists.
- **Why**: The first two mirror `ensure_graphify_mcp` exactly — if that function skipped
  registration, the tools are not in the agent's list, and describing them produces an
  agent that tries to call tools it does not have. The third is the one condition
  registration does not check: `.mcp.json` can name a server whose graph was never built,
  and every tool call then fails. A nudge toward failing tools is strictly worse than no
  nudge.
- **Consequence**: a session started before the watcher's first graph build gets no nudge,
  and does not get one later (D3 — once per session). Accepted: it self-corrects on the
  next session, and re-checking every turn is the per-turn cost D3 rejects.
- **Silent**: no warning event. The missing-`graphify` preflight warning already covers
  the install case, per the same reasoning in `ensure_graphify_mcp`'s doc comment.

## D6: New module or extend `grill_inject.rs`?

- **Decision**: New `graph_nudge.rs`. `grill_inject.rs` is untouched.
- **Why**: Different trigger (tool availability, not thread mode), different cadence (once
  vs. every turn), different lifetime. Merging them would mean a mode-keyed enum growing a
  variant that is not a mode, which makes both harder to read. Two ~40-line modules beat
  one branching one. Neither gets a shared "injection framework" — a plain function per
  concern is the pattern already proven here.
- **Composition**: where both apply (spec mode, first turn), the nudge is prepended to the
  prefix `ensure_session` already builds, same `\n\n` join as the handoff/reinjection pair.
  Order: nudge first, then the handoff transcript, then the user's message.

## D7: FIM completion model — rejected, do not revisit

- **Decision**: `completion.rs` is out of scope. No graph context in the FIM prompt.
- **Why**: Already measured. Prefixing the FIM prompt with a single `<|file_sep|>{path}`
  header — the smallest possible addition — made output worse on the bundled model
  (Qwen3.5-0.8B, 2048 ctx): three repeated docstrings instead of a coherent completion. The
  model is not trained to expect anything ahead of the FIM prefix token. A graph excerpt is
  larger and noisier, and the context budget (`MAX_PREFIX_CHARS` / `MAX_SUFFIX_CHARS`) is
  already fully spent on code. See `completion.rs:251-260`.
- **Reopen only on**: a different completion model, or a new measurement.

## D8: How is this verified?

- **Decision**: One manual A/B against a real project, run once at apply time, recorded in
  tasks. No counter, no log, no telemetry surface.
- **Why**: The claim is "the agent now calls graph tools", and a single controlled pair of
  runs proves the mechanism fires or does not. Building usage telemetry to prove a ~40-line
  change works is a larger project than the change, and this repo's rule is that
  verification is a named command at a named commit, not a dashboard.
- **Shape**: same fixed prompt, same project, two sessions — one with the nudge, one with
  the gate forced off. Pass = a `graphify` MCP tool call appears in the injected run's tool
  calls and not in the baseline's. Recorded in `tasks.md` task 4.
- **Known blocker on this machine**: the installed `graphify-mcp` fails at startup with
  `ModuleNotFoundError: No module named 'mcp'`
  (`~/.local/share/uv/tools/graphifyy/.../graphify/serve.py:1927`). The MCP server must be
  repaired (reinstall `graphifyy` with its `mcp` extra) before task 4 can run — the
  verification is not meaningful against a server that cannot start.
