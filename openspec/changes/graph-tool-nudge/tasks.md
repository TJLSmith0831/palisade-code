## 1. Gating logic (riskiest first — a wrong gate tells the agent about tools it lacks)

- [ ] 1.1 Write failing Rust test: `nudge()` returns `None` for an agent id with no MCP
      config path (e.g. `"gemini-acp"`), even with a graph present (RED)
- [ ] 1.2 Write failing Rust test: `nudge()` returns `None` when
      `<root>/graphify-out/graph.json` does not exist (RED)
- [ ] 1.3 Write failing Rust test: `nudge()` returns `Some` for `claude-acp` with a graph
      file present, and the text names `query_graph`, `get_neighbors`, `shortest_path` (RED)
- [ ] 1.4 Create `src-tauri/src/graph_nudge.rs`: `GRAPH_NUDGE: &'static str` +
      `nudge(agent_id: &str, project_root: &Path) -> Option<&'static str>`; PATH check via
      `executor::find_on_path("graphify-mcp")`, graph path via
      `integrations::default_out_dir(root).join("graph.json")`
- [ ] 1.5 `cd src-tauri && cargo test graph_nudge::` — green

## 2. The injected text

- [ ] 2.1 Finalize `GRAPH_NUDGE` wording from the D4 draft; keep it under ~150 tokens
- [ ] 2.2 Write failing Rust test: the text contains an explicit
      grep-is-still-right clause (guards D4's second failure mode against a later trim) (RED)
- [ ] 2.3 Cross-check every tool name in the text against `graphify-mcp`'s `tools/list`
      output; a name that does not exist invalidates the block

## 3. Hook into session start

- [ ] 3.1 Write failing Rust test: composing nudge + handoff prefix puts the nudge first,
      separated by a blank line, with the user message last (RED)
- [ ] 3.2 `mod graph_nudge;` in `lib.rs`
- [ ] 3.3 In `ensure_session`, compute the nudge once (agent id from the existing
      `selected_executor` result, root from `project_root(project_hash)`) and prepend it to
      the `pending_prefix` on both new-session paths: the handoff path (~line 656, composing
      with the reinjection/transcript prefix) and the fresh-start tail (~line 684)
- [ ] 3.4 Confirm no `generate_handler!` or `src/api.ts` edit is needed — no new IPC command
- [ ] 3.5 `cd src-tauri && cargo test` — full Rust suite green (baseline 173 tests)
- [ ] 3.6 `npx tsc --noEmit` — unchanged frontend still typechecks

## 4. Manual A/B verification (D8 — the only evidence this works)

- [x] 4.1 Repair `graphify-mcp` on the test machine: it currently dies at startup with
      `ModuleNotFoundError: No module named 'mcp'`. Confirm a raw
      `initialize` + `tools/list` over stdio returns the tool list before continuing
      — DONE: `uv tool install --reinstall --with mcp graphifyy` (graphify 0.9.45).
      `tools/list` now returns all ten tools.
- [x] 4.2 Pick the target project, run `graphify` so `graphify-out/graph.json` exists, and
      record the project + commit — target is this worktree itself (the fixed prompt asks
      about its own code). `graphify extract src-tauri/src --out . --code-only` →
      1214 nodes, 3515 edges, 33 communities, at commit 1e9a05b + this change's diff.
- [x] 4.3 Baseline: gate off, fresh session, fixed prompt — **zero graph tool calls**
- [x] 4.4 Injected: gate on, fresh session, same prompt — **3 graph tool calls**
- [x] 4.5 Fixed prompt, used verbatim in both runs:
      `Which functions call ensure_session, and how does a user message reach the ACP agent?`
- [x] 4.6 **PASS.** Both runs used the same agent (Claude), the same MCP server, the same
      graph, the same allow-list, and the same prompt; the only difference was the nudge
      text prepended ahead of a `---` separator.

      | run | tools called |
      |---|---|
      | baseline | `Grep`×3, `Bash`×2, `Read`×1 — no `mcp__graphify__*` at all |
      | injected | `mcp__graphify__get_neighbors`, `mcp__graphify__query_graph`, `mcp__graphify__shortest_path`, `Read`×3, `Grep`×2 |

      The injected run kept using `Read`/`Grep` alongside the graph, which is the behavior
      D4's closing paragraph is there to preserve — the graph did not displace file reads.
      Cost was $0.66 baseline vs $0.53 injected; n=1, so that is an observation, not a
      claim about savings.
- [x] 4.7 If injected == baseline (no tool call either way), stop and revisit D4's wording
      before shipping — not triggered; the runs diverged as intended.
- [x] 4.8 In-app wiring check: the A/B above proves the *text* works, driving the agent
      directly. Confirm Palisade's own path delivers it — run the app against this project,
      send the fixed prompt in a fresh thread, and confirm graph tools are called.
      — DONE. `pnpm start`, opened this worktree as a project (Palisade wrote `.mcp.json`
      itself), fresh thread `01M07WDZH9Y5APHRY43QW1H8F2`, **go mode**, same fixed prompt.
      The thread record shows `mcp__graphify__get_neighbors` ×4 and
      `mcp__graphify__query_graph`, then `Read`/`Terminal` to confirm in the files — the
      intended split. Go mode is the case grill never covered, so this also exercises the
      both-modes half of D3. The answer it produced (5 callers of `ensure_session`) matches
      the grep baseline.

## 5. Close out

- [x] 5.1 `openspec validate graph-tool-nudge --strict` — valid
- [x] 5.2 Record the D8 verification result (project, commit, both outcomes) in this file
      — recorded in task 4 above

## Notes for whoever picks this up

- Building in a git worktree needs two gitignored inputs copied or symlinked from the main
  checkout, or `cargo` fails in the build script before compiling anything:
  `src-tauri/llama-server-aarch64-apple-darwin` and `src-tauri/resources/models`.
- `graphify watch` crashed (`exit status: 1`) during the in-app run and surfaced as a
  `harness-warning` banner. Unrelated to this change — the graph was already built — but
  it is a real, separate bug worth its own look.
