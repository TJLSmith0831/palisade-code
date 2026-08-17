# Graph tool nudge

## Why

Palisade auto-registers Graphify's MCP server with every session (`ensure_graphify_mcp`,
D9/D21), so the agent has graph tools in its tool list from turn one. Nothing ever tells
it to use them. They sit alongside grep and read, which is what the agent reaches for by
default, so the structural questions the graph answers in one call — "what calls X", "how
does A reach B", "what breaks if I change X" — get answered by a grep fan-out instead,
paying full token cost for a worse answer. (D1)

Registration is necessary but not sufficient: a tool nobody points at is a tool nobody
calls.

## What Changes

- Add `src-tauri/src/graph_nudge.rs`: one `&'static str` instruction block plus a gating
  function. Same shape as `grill_inject.rs` — a bundled constant and a plain function, no
  framework. (D6)
- Hook it into `ensure_session` in `src-tauri/src/lib.rs` (~line 619), the one place a
  session is created before its first turn, for both spec and go mode. The text is parked
  on the session's `pending_prefix` and drained by `send_to` on the first prompt — the
  existing handoff-transcript mechanism, reused. (D2, D3)
- Gate on the same conditions as MCP registration — `graphify-mcp` on PATH and an agent
  with an MCP config path (`claude-acp` / `codex-acp`) — plus an existing
  `graphify-out/graph.json`. Any miss skips silently. (D5)
- The nudge names the real MCP tool names and says explicitly when *not* to use the graph,
  so it does not push the agent off grep for the things grep is right for. (D4)

## Capabilities

### Modified Capabilities

- `graphify-mcp`: registration alone does not produce usage. Adds a requirement that the
  system instructs the agent, once per session, when to prefer graph tools over grep —
  gated on the tools actually being usable.

## Impact

**Affected code:**
- New: `src-tauri/src/graph_nudge.rs` (~40 lines incl. the constant)
- Modified: `src-tauri/src/lib.rs` — `mod graph_nudge;` and the two new-session paths in
  `ensure_session`

**Not affected, deliberately:**
- `src-tauri/src/completion.rs` — feeding graph context to the FIM model was explored and
  rejected on measured evidence. See D7.
- `grill_inject.rs` — unchanged. The nudge composes with grill's prefix rather than
  extending it. (D6)
- No new IPC command, no frontend change, no `src/api.ts` edit, no settings key.
- No telemetry. Verification is a one-time manual A/B, not a shipped counter. (D8)

**Correction to the premise this change was raised on:** the Graphify MCP server exposes
ten tools (`query_graph`, `get_node`, `get_neighbors`, `get_community`, `god_nodes`,
`graph_stats`, `shortest_path`, `list_prs`, `get_pr_impact`, `triage_prs`), not three, and
none is named `graphify_query`. `graphify_query` is the Rust fn in `integrations.rs`
backing the human Graph pane — a different surface. Verified against the installed
`graphifyy` package (`graphify/serve.py:1346-1490`). The injected text names the real
tools; naming a tool that does not exist is the fastest way to get the block ignored.
