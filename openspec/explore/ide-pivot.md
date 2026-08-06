# Explore: Floo Network → AI-native IDE

**Topic:** Pivot Floo Network from a Rust+Tauri agent harness/orchestrator into an AI-native IDE — "Kiro but not suck."

**Started:** 2026-08-06

## Context (carried in from the review)

What exists today (the agent-orchestration half of an IDE):
- Rust + Tauri (WKWebView, not Electron) — structural performance advantage over Kiro/Cursor.
- Two-mode toggle: Spec (read-only/plan) ↔ Go (write-enabled), permission flags per executor.
- Executor abstraction: Claude (persistent stdin JSON) + Codex (per-turn `exec resume`), unified `ExecutorEvent` stream.
- OpenSpec + Grill skills (explore→propose→apply→archive). `grill-propose` is one-question-at-a-time — direct counter to Kiro's "one-line vibe" requirements failure.
- Graphify code maps (report generator + dependency graph, always-on watcher).
- Append-only JSONL session store in `~/.floo-network/`, outside repos.
- Notes in project root. Diff viewer (display-only). File tree (one-dir-per-IPC). FileEditorPane (49-line read-only viewer).

What an AI-native IDE needs that Floo does not have:
- A real editor (syntax highlighting, multi-cursor, find/replace, virtualization).
- LSP (diagnostics, go-to-def, hover, rename).
- Tab/multi-line autocomplete (the Cursor/Windsurf killer feature).
- Integrated terminal.
- Git UX (blame, diff, staging).
- Hunk-level diff apply/accept/reject.
- Hooks (event → agent/command triggers).
- Parallel agents in sandboxes.
- Retrieval index (embedding-based semantic search), not just a dependency graph.
- Context-window / usage visibility.
- Steering files as scoped context, not global injection.

Kiro's documented failures this pivot should avoid:
- Performance lag with many files (Issue #4056, 4+ months unfixed) — Electron/VS Code fork.
- Requirements generation skips Socratic gathering → AI slop downstream.
- Spec/vibe counting opaque + inconsistent; billing surprises.
- Session corruption / broken resume (mutation problem).
- Steering docs injected into every call → context pollution.
- Infinite output loops, frozen output, duplicate commands (stability).

## Decisions

<!-- Entries appended as things settle. Format:
## D<n>: <question, one line>
- **Decision**: <what was settled>
- **Why**: <one sentence>
- **Source**: user | codebase (<path:line>) | recommended-accepted
-->

## D1: Where do explore notes live?
- **Decision**: `openspec/explore/<topic>.md`, with `openspec/` removed from `.gitignore` so the whole openspec tree is tracked.
- **Why**: User chose to un-ignore openspec entirely rather than negation-pattern just the explore subdir; simpler, and specs/changes become committable too.
- **Source**: user

## D2: Scope of v1
- **Decision**: Middle path — "agent-first, graph-native" IDE. v1 ships: chat pane (have), file editor (in progress), code-diff review pane with git polishing, terminal. Skip LSP and autocomplete for now; both land later alongside a self-trained FIM model that ships with the app.
- **Why**: User wants to differentiate on agent + graph, not on editor-feature parity with Cursor; LSP/autocomplete are deferred to a v2 that's built around the FIM model rather than bolted on.
- **Source**: user

## D3: Editor substrate
- **Decision**: CodeMirror 6. Textarea checkpoint committed (f8dd81d) and recoverable if needed.
- **Why**: The FIM plan requires an editor that can render inline ghost-text completions; a `<textarea>` cannot. CM6 is the only option that supports inline completions/diagnostics without importing Monaco's WKWebView performance problem (Kiro's failure mode). Cost: rewrite the in-progress FileEditorPane now and learn CM6's state-driven extension model.
- **Source**: user

## D4: Terminal
- **Decision**: Real PTY terminal — `portable-pty` (Rust) + `xterm.js` (frontend), bytes over a Tauri channel.
- **Why**: A command-runner can't host vim/top/ssh and is the first thing devs notice; building it twice costs more than building PTY once.
- **Source**: user

## D5: Grilling style
- **Decision**: Brief, flowy, bullet points. One question at a time. Treat reader as ADHD.
- **Why**: User asked.
- **Source**: user

## D6: Git polishing scope
- **Decision**: Tier B — working-tree diff + per-hunk stage/unstage + commit box. No branch switching, blame, or log graph in v1.
- **Why**: Closes the edit→review→commit loop without leaving the app; branch/blame/log are polish, not v1 load-bearing. Cost: diff pane becomes interactive (per-hunk controls), likely needs moving beyond display-only react-diff-viewer-continued.
- **Source**: user

## D7: Agent's place in the IDE
- **Decision**: Agent stays in the chat pane (model A). No special inline-edit protocol for the agent — CodeMirror handles inline editing natively for the human; agent edits surface in the diff tab as today.
- **Why**: User wants the editor to be a real editor (CodeMirror), not an agent-output review surface. Keeps the agent/console boundary clean; avoids coupling editor state to executor event stream.
- **Source**: user

## D8: Existing console features in the IDE
- **Decision**: Keep Spec/Go toggle, OpenSpec+Grill, Graphify. Cut Notes from v1.
- **Why**: Spec/Go + OpenSpec/Grill are the differentiators (agent-permission safety + Socratic requirements vs Kiro). Graphify is the "graph-native" claim. Notes were a console-era substitute for editing files — the IDE editor + terminal + git obsoletes them.
- **Source**: recommended-accepted

## D9: Retrieval / Graphify integration
- **Decision**: Tier C — keep the GraphPane for humans AND expose Graphify's MCP server (10 graph tools) to the executor so the agent queries the graph mid-turn. No embeddings (Graphify's thesis: code is the wrong shape for similarity; AST edges + traversal + provenance tags instead).
- **Why**: "Graph-native IDE" means the agent has graph tools, not a graph report. MCP is the agent-native path Graphify already ships; the pane is the visible differentiator. C is both surfaces, one graph. Less Rust mediation than the current shell-out+inject-summary path.
- **Source**: user, grounded in graphify.com + DeepWiki research (2026-08-06)
- **Research notes**:
  - Graphify = tree-sitter AST → typed edges (calls/imports/defines/references), traversed hop-by-hop. No vectors, no RAG.
  - Edge provenance: EXTRACTED (AST, deterministic) / INFERRED (LLM) / AMBIGUOUS (unresolved) — the trust model.
  - Agent paths: CLI (`query`/`path`/`explain`/`prs`) + MCP server (`python -m graphify.serve graphify-out/graph.json`, 10 tools, stdio or HTTP).
  - Watch mode is AST-only, zero LLM cost. Floo already runs this.
  - 36 languages, on-device, Apache 2.0, no telemetry.
  - Current Floo integration = weak (shell-out + inject bounded summary into thread; agent never touches graph). C replaces mediation with MCP registration.
- **Tradeoff**: per-executor MCP config (Claude vs Codex differ) — config work, not core code.

## D10: Hooks
- **Decision**: Harness-level hooks for v1. Fire on editor saves + executor events. Defer executor-level (block-tool-mid-turn) — harness can't intercept inside the executor's loop anyway (AGENTS.md gotcha).
- **Why**: The IDE gesture people want is "on save, do X" (format/test/agent-on-save). Saves happen in Floo's editor, which the executor never sees — only harness-level hooks can catch them.
- **Source**: recommended-accepted

## D11: Parallel agents
- **Decision**: Defer to v2. v1 stays one-agent-per-thread.
- **Why**: The four v1 features (editor, diff+git, terminal, chat) don't require parallelism. Pool + sandboxes + multi-agent UI is real work with no v1 payoff. Ship one reliable agent first.
- **Source**: recommended-accepted

## D12: FIM model + executor + autocomplete
- **Decision**: Three orthogonal things, not competing:
  1. **Executor** (claude/codex) — stays the chat/agent engine. Unchanged.
  2. **CodeMirror autocomplete** (`@codemirror/autocomplete`) — ship in v1. This is CM6's built-in completion source, NOT a FIM model. User clarified: earlier "CodeMirror completion = FIM" was a misread.
  3. **FIM model** (user-trained, ships with app) — deferred. Build the editor with a completion-interface seam now; implement when the model exists.
- **Why**: Orthogonal systems. Executor drives chat/spec flow; CM6 autocomplete is editor-local word/symbol completion; FIM is a future model-backed inline completion. No wasted plumbing now, no premature model-loading infra.
- **Source**: user (corrected earlier misspeak)

## Open questions

(none — all v1 scope questions settled)
