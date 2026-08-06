# Decision log — ide-pivot

Carried forward from `openspec/explore/ide-pivot.md` (grill-explore, 2026-08-06).
New decisions appended here as Phase 1 grilling resolves them.

---

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

---

## Phase 1 grilling (proposal → design → tasks)

## D13: Audience
- **Decision**: Personal tool now, open source planned for near future. Not commercial in v1.
- **Why**: Built on personal laptop with work-laptop variant, self-signed packaging, `.env` keys — that's a personal/OSS profile, not a commercial one. Plan to OSS shapes docs/install/onboarding bar but not pricing/auth.
- **Source**: user

## D14: Harness hooks — v1 scope (revised)
- **Decision**: v1 ships **format-on-save only**, configured via a settings file (e.g. `settings.json` or `.floo/settings.json`), Cursor-style. No spec-workflow triggers, no slash commands, no `agent` action type, no executor-event hooks. Spec/Go mode behavior stays exactly as-is — hooks don't touch it.
- **Shape**: a settings entry mapping file globs/regex to a shell command run after the CodeMirror editor saves a matching file. E.g. `{ "formatOnSave": { "\\.rs$": "cargo fmt", "\\.tsx?$": "prettier --write" } }`. Output goes to the terminal pane or a toast.
- **Why**: User flagged the broader hooks system as overcomplicated for v1. Format-on-save is the one gesture worth shipping; everything else (spec-workflow automation, agent prompt injection, tool-event hooks) is scope creep that risks cluttering the spec/go flow users already have.
- **Source**: user (revised from earlier recommendation)

## D15: Settings file
- **Decision**: Project-level settings live in `project-settings.json` (name TBD, user suggested this direction). It's a protected, first-class config the IDE reads on project load — not a loose hook file. Format-on-save mappings (D14) live here. IDE works without it (fallbacks) but treats it as the authoritative project config when present.
- **Why**: User wants the settings surface to feel like a real project config (protected, must-be-set-able, IDE-shaping) rather than a peripheral hook file. Fallbacks ensure the IDE still works on projects without one.
- **Source**: user
- **v1 residents**: format-on-save mappings (D14) + executor override (force `claude`/`codex` per-project instead of machine-specific auto-detect). Other settings (graphify MCP toggle, default mode, terminal shell, ignored paths) move in as features land.

## D16: Definition of done
- **Decision**: The change is complete when all of the following are true:
  1. CodeMirror 6 editor replaces the textarea `FileEditorPane`; opens/saves files via existing `read_file_content`/`write_file_content` IPC; `@codemirror/autocomplete` wired.
  2. PTY terminal pane (`portable-pty` Rust + `xterm.js` frontend, bytes over Tauri channel); handles resize + Ctrl-C.
  3. Diff pane shows working-tree changes vs HEAD; per-hunk stage/unstage; commit box. No branch/blame/log.
  4. Graphify MCP server registered with the detected executor so the agent gets the 10 graph tools mid-turn. GraphPane behavior unchanged for humans.
  5. `project-settings.json` read on project load with fallbacks; v1 keys = format-on-save mappings + executor override.
  6. Notes feature removed (UI + IPC + store paths).
  7. Chat / spec-go toggle / OpenSpec+Grill / GraphPane behavior unchanged.
- **Source**: recommended-accepted

## D17: Terminal placement + sidebar resizing
- **Decision**:
  1. **Terminal** = bottom panel in the center column (VS Code/Cursor model), resizable via drag handle, with a toggle to move it to the right sidebar for users who want it there.
  2. **Sidebars** = both left (sessions) and right (codemap/terminal-when-docked) become drag-to-resize and collapsible. Today they collapse via `⌘\` / `⌘J` (App.tsx) but have fixed widths (260px / 340px); v1 makes widths user-controllable.
- **Why**: Bottom panel is the universal IDE mental model (editor + terminal visible together). Sidebar resizing is a basic IDE expectation that the current fixed-width cockpit doesn't meet. The terminal-to-sidebar option covers users who want a wider editor + terminal-on-the-side layout.
- **Source**: user
- **Tradeoff**: Biggest layout change in the pivot — App.tsx's three-column flex becomes a column with a resizable bottom split, plus drag handles on both sidebars. Resizable panels need persistent widths (localStorage or project-settings).

## D18: Terminal count + default shell
- **Decision**: One terminal pane for v1 (no multi-tab/split). Default shell = `$SHELL`, fallback `/bin/zsh` on macOS. Per-project shell override deferred (not in v1 `project-settings.json` per D15).
- **Why**: Multi-terminal adds tab bar + per-PTY management + focus tracking with low v1 payoff. `$SHELL` matches the user's normal terminal; zsh fallback covers the launchd-minimal-env case Floo already handles for executor PATH (executor.rs:88-105).
- **Source**: recommended-accepted

## D19: Diff pane component
- **Decision**: Use `diff` (npm) for hunk computation + custom React rendering with per-hunk stage/unstage buttons. Drop `react-diff-viewer-continued`. Reuse the Dragon Fire diff tokens already in `EventView.tsx`'s `diffStyles`. Stage/unstage via reconstructed hunk patches → `git apply --cached` / `git restore --staged`.
- **Why**: Hunk staging requires owning hunk boundaries to reconstruct patches for `git apply --cached`. `react-diff-viewer-continued` hides internals and wasn't built for per-hunk interaction. `diff` gives raw hunks; custom render reuses the existing design system. Implementation will use the ponytail skill.
- **Source**: user
- **Tradeoff**: Throws away `react-diff-viewer-continued`; net-new diff renderer (hunk → added/removed rows → styled). Not huge but real frontend code.

## D20: Git operations approach
- **Decision**: Shell out to `git` CLI from Rust Tauri commands. Same pattern as graphify/executor/login_shell_path. v1 commands: `git diff`, `git diff --cached`, `git status`, `git apply --cached`, `git restore --staged`, `git commit -m`.
- **Why**: Already the codebase's pattern; git CLI output is stable and parseable for the narrow v1 command set. `gix`/`git2` add a dependency + learning curve with no v1 payoff. Library starts paying off at tier C (blame/log) — deferred.
- **Source**: recommended-accepted
- **Tradeoff**: git must be on PATH (true on every dev machine); parse text output. Edge cases (binary files, renames, mode changes) handled as encountered.

## D21: Graphify MCP registration
- **Decision**: Floo auto-registers the Graphify MCP server with the detected executor on project load, idempotently. Extends the existing per-project `graphify watch` startup path (lib.rs:56-77) to also ensure MCP registration. User doesn't configure MCP manually — the "graph-native" benefit is automatic.
- **Mechanics (per executor)**:
  - Claude: write/merge project-scoped `.mcp.json` in project root pointing at `python -m graphify.serve graphify-out/graph.json` (stdio).
  - Codex: equivalent config mechanism for Codex MCP registration.
- **Why**: The differentiator is "agent has graph tools" — making the user manually configure MCP defeats it. Idempotent registration is safe to run every load. Project-scoped `.mcp.json` is committable and doesn't touch the user's home config.
- **Source**: recommended-accepted
- **Tradeoff**: Writes a file into the user's project root (`.mcp.json`). Project-scoped + committable mitigates this, but it's a side effect Floo currently avoids. User can gitignore it if unwanted.
- **Open**: exact Codex MCP config shape needs verification at apply time (D9 tradeoff noted per-executor config differs).

## D22: Notes removal
- **Decision**: Full removal — delete the right-sidebar Notes tab, the `create_note`/`list_notes`/`read_note`/`write_note` IPC commands, and the `store::create_note`/`list_notes`/`read_note`/`write_note` functions. Existing `.md` note files in projects stay on disk (accessible via the file editor).
- **Why**: Dead code rots. The store functions are small and recoverable from git if ever needed. Notes were a console-era substitute for editing files — the IDE editor makes them redundant. Existing notes become regular files the editor can open.
- **Source**: recommended-accepted

## D23: CodeMirror language support
- **Decision**: v1 ships the common web/system set: `@codemirror/lang-rust`, `lang-javascript` (covers TS/TSX), `lang-python`, `lang-go`, `lang-json`, `lang-markdown`, `lang-css`. Add more as needed.
- **Why**: Covers Floo's own languages + what an early user opens (Graphify is Python). Each lang package is ~10-30KB. A (Rust+JS only) breaks on the first Python file; C (lazy broad) is over-engineering for v1.
- **Source**: recommended-accepted

## D24: Resizable panel persistence
- **Decision**: localStorage per-project (`floo:layout:<hash>`). Not in `project-settings.json` — layout is personal preference, not project config.
- **Source**: recommended-accepted

## D25: File tree + navigation
- **Decision**: Keep the lazy one-dir-per-IPC `FileTree` for v1 (it works). Add a fuzzy file-open palette (`⌘P`) as the real navigation gesture. Full workspace index deferred to v2.
- **Source**: recommended-accepted

## D26: project-settings.json location
- **Decision**: Project root (one file, easy to find, gitignore-able). Not a `.floo/` subdir.
- **Source**: recommended-accepted

## D27: Commit box scope
- **Decision**: Message + commit only. Amend/author/signoff deferred to v2.
- **Source**: recommended-accepted

## D28: Task sequencing
- **Decision**: Riskiest first. Order:
  1. Layout refactor (D17) — reshapes App.tsx, everything lives inside it
  2. CodeMirror editor migration (D3, D23)
  3. PTY terminal (D4, D17, D18)
  4. Git diff + hunk staging (D6, D19, D20)
  5. Graphify MCP auto-registration (D9, D21)
  6. project-settings.json + format-on-save + executor override (D14, D15)
  7. Notes removal (D22) — last, smallest, isolated
- **Why**: Layout first because every other feature mounts inside it; CodeMirror second because it's the highest-risk rewrite; notes last because it's isolated and low-risk.
- **Source**: recommended-accepted
