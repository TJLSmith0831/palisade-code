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
- **Resolved at apply time**: Codex has no MCP config that loads unconditionally per-project — `codex mcp add` only writes the global `~/.codex/config.toml`. Codex does support a project-scoped `.codex/config.toml` with its own `mcp_servers` table, but only for projects with `trust_level = "trusted"` recorded in the global config's `[projects."<path>"]` section; an untrusted project's local `.codex/` layer is silently ignored. Implemented as project-scoped `.codex/config.toml` (mirrors `.mcp.json`) plus a minimal trust entry added to the global config only when the project has no existing trust decision — never overrides a trusted/untrusted choice the user already made. Also corrected the Claude/Codex server command itself: `graphifyy` installs a dedicated `graphify-mcp` console script (wrapping `python -m graphify.serve` internally), not a bare `python -m graphify.serve` — both registrations point at the resolved `graphify-mcp` binary.

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

---

## Phase 1 implementation (layout refactor)

## D29: Left-rail collapse shortcut didn't exist yet
- **Decision**: D17's background text said the nav rail already collapsed via `⌘\`; the codebase only had `⌘J` for the right sidebar (nav rail was fixed-width, collapsing only via a viewport media query). Added a new `⌘\` handler (`leftRail.toggleCollapsed()`) rather than treating this as "wire the existing" — it's what D17's stated goal ("both sidebars become drag-to-resize and collapsible") requires.
- **Why**: Trivial correction of a stale premise, not a scope change — the target behavior (both sidebars collapsible) was never in question.
- **Source**: recommended-accepted

## D30: Right sidebar's per-tab auto-width ("wide" class) dropped
- **Decision**: The right sidebar previously auto-widened to 640px on the Code Map tab via a CSS `.wide` class swap. Now that width is user-controlled via `useResizable` (D24), that auto-behavior is dropped in favor of one persisted width regardless of active tab. Default width kept at the old base (300px).
- **Why**: D17/D24 explicitly move sidebar width to user control; keeping a tab-driven auto-width alongside user-dragged width would fight the user's own resize. Verified via screenshot that 300px doesn't clip the Code Map's controls.
- **Source**: recommended-accepted

## D31: useResizable rehydrates on storageKey change, not just on mount
- **Decision**: `useResizable`'s state now reloads from localStorage whenever `storageKey` changes (via a `useEffect` keyed on it), not only at initial mount.
- **Why**: `storageKey` includes the project hash (`floo:layout:<hash>:...`); the initial `project` is `null` on first render (auto-select is async), so the hook briefly reads the `default` key before the real project hash resolves. Without re-reading on key change, a project switch would keep showing the previous project's (or default's) width instead of the new project's persisted layout — silently breaking the "per-project" requirement in task 1.1. Caught by a test-first case before implementing.
- **Source**: recommended-accepted (implementation discovery, not user-facing surprise)
- **Amendment (same day)**: the original fix used a `useEffect` keyed on `storageKey`, which re-reads localStorage asynchronously *after* commit. That opened a real race: a drag/toggle landing between the project-switch commit and the effect's re-run got silently reverted back to the freshly-loaded project's persisted (or default) value. Surfaced as intermittent test failures under `-t`/repeated runs, not as a one-off flake. Replaced with the standard React "adjust state during render" pattern — a ref tracks the previous `storageKey` and resets `state` synchronously in the render body when it changes, so there's no window between commit and rehydration. Verified with 5 repeated runs of the previously-flaky tests plus 3 full-suite runs, all green.

## D32: Left/right sidebar toggle buttons use matching icons, not text glyphs
- **Decision**: Both `toggle-left-sidebar` and `toggle-right-sidebar` render a small inline SVG (`SidebarIcon`, App.tsx) — a rounded-rect outline with a filled column on the side being toggled — instead of the `⇤`/`⇥` unicode glyphs used in the first pass.
- **Why**: User pointed at Cursor's title bar as the reference; its panel toggles are minimal line-art icons, not text characters. Matches the codebase's existing pattern of small inline SVGs for icon buttons (e.g. the Claude glyph in the preflight-status button).
- **Source**: user

## D33: Right sidebar stays collapsed by default; opens at a width that doesn't clip the Code Map
- **Decision**: `rightPanel` stays `defaultCollapsed: true` (Phase 1's original call, reaffirmed after a brief detour) — the right bar does not auto-open. What changes: `defaultSize` goes from 300px to 640px, so that *when the user opens it*, the Code Map's canvas and communities legend render at full size instead of the cramped 300px D30 had defaulted to. The initial complaint ("the graph hid by default") was about D30's clipped width, not about the panel's open/closed state — first correction (flip `defaultCollapsed`) overshot; this is the actual fix.
- **Why**: User: collapsed-by-default is correct (least-surprise on first launch, matches the pre-pivot app); but once opened, nothing about the graph-native premise should feel cramped. Restores the old codebase's "wide" 640px rationale (`.ds-right-sidebar.wide` comment, pre-Phase-1) as the resizable panel's default, rather than as a tab-conditional class.
- **Source**: user
- **Superseded same day**: user reverted the 640px default (too wide) and asked for a different fix — see D34.

## D34: Codebase Map's Communities legend collapses instead of the panel widening
- **Decision**: `rightPanel.defaultSize` back to 300px. The `<aside className="communities">` list in `GraphView.tsx` becomes a native `<details>`/`<summary>` (closed by default) instead of an always-visible 260px column. CSS: `.communities:not([open]) { width: auto }`, `.communities[open] { width: 260px }`. When collapsed (default), the graph canvas gets the freed width instead of the whole right sidebar needing to be wider.
- **Why**: User: 640px was too wide; the actual clipping problem (D30's original comment: "300px squeezes the canvas to nothing") is the Communities legend eating fixed width, not the panel itself. Matches the existing `<details>`/`<summary>` idiom already used for the Report section in the same file — no new JS state, native disclosure element (ladder rung 4).
- **Source**: user
- **Amendment (same day)**: first pass kept `.communities` as a flex sibling of `.graph-canvas-wrap` — open state still reserved a 220px column and squeezed the canvas, just a smaller squeeze than the original 260px. User wants it to float over the canvas instead. Changed `.graph-view` to `position: relative` and `.communities` to `position: absolute; top/right` with a border, rounded corners, and box-shadow (dropdown-card look) — canvas now always gets the full `graph-view` width; the open Communities list overlaps it instead of reflowing it. No JS/`<details>` behavior change, CSS-only.

## D36: Codebase Map fills exactly the available viewport height, no overflow
- **Decision**: Fixed two compounding bugs that let the graph pane grow taller than the window, pushing the query box and Report row below the fold with no working scroll:
  1. `.ds-right-panes` (the graph pane's direct parent) was missing `display: flex; flex-direction: column`. `.graph-pane`'s `flex: 1` had no flex container to size against, so the whole pane sized to its content instead of the viewport — the same "every ancestor needs `display:flex` + `min-height:0`" idiom already used correctly for `.messages`/`main` elsewhere in this file (App.css:979-986).
  2. `.graph-view` had `flex-shrink: 0` plus `min-height: 460px`, both explicitly there (per the removed comment) to "never let it shrink" — that blocked it from fitting into the now-properly-bounded parent even after fix #1. Changed to `flex: 1 1 0; min-height: 200px` so it fills exactly the remaining space in `.graph-body` (no more) rather than forcing a floor that overflows.
- **Why**: User: graph view height should be static to the window, not grow with content/zoom — pan/zoom the canvas instead of growing the container; the bottom of the pane (query box, Report link) needs to stay reachable. Verified via `getBoundingClientRect()`: `graph-body.scrollHeight` now equals `clientHeight` (zero overflow) at the tested window size, with query box and Report both inside the viewport.
- **Source**: user

## D37: Dragging a resize handle no longer triggers native text selection
- **Decision**: `bindDrag` (App.tsx) now: calls `preventDefault()` on the handle's `pointerdown` (suppresses the browser's compatibility mousedown that starts native text selection), and sets `document.body.style.userSelect = "none"` + a matching cursor (`col-resize`/`row-resize`, passed in by each call site) for the duration of the drag, restoring the previous values on `pointerup`.
- **Why**: User: dragging the left sidebar's resize handle was highlighting file names in the tree underneath the pointer — the classic drag-handle-without-selection-guard bug. Test-first (new `App.test.tsx` case asserting `document.body.style.userSelect` toggles to `"none"` on pointerdown and reverts on pointerup); verified live via a real swipe on the handle with no residual selection in the file tree.
- **Source**: user

## D35: Editor is the default tab, ordered first; sidebar/tab renames
- **Decision**:
  1. `chatTab` default state → `"editor"` (was `"chat"`). Tab order in `ds-editor-tabs` → Editor, Console Chat, Code Change Diff (Editor moved from 2nd to 1st). Tab label "File Editor" → "Editor".
  2. Left nav rail's thread-list section label "Active Threads" → "Threads".
  3. Right sidebar's Code Map tab + GraphPane's internal heading: "Code Map" / "Code map" → "Codebase Map" (both, for consistency between the tab and its panel content).
- **Why**: User: the editor is the primary surface now that CodeMirror is landing (D2/D3) — chat-first was a console-era default. Renames are direct product-naming requests.
- **Source**: user

---

## Phase 2 implementation (CodeMirror 6 editor migration)

## D38: FIM completion seam is the `autocompletion({ override })` array
- **Decision**: The "completion-interface seam" the code-editor spec requires (v1 ships no FIM implementation, only the seam) is CM6's own `autocompletion({ override: [...] })` config in `FileEditorPane.tsx`. v1 populates it with the built-in `completeAnyWord` document-word source. A future FIM provider is a second `CompletionSource` function added to that same array (or registered via `languageData.of({ autocomplete })` for per-language sources) — no editor rewrite needed.
- **Why**: CM6's own extension point already is the seam D12/the code-editor spec asked for; no custom abstraction layer needed on top of it (ladder rung 2/4 — reuse the library's own mechanism instead of building a wrapper "for later").
- **Source**: recommended-accepted

## D39: CM6 theming reuses the app's CSS custom properties, not a JS theme object
- **Decision**: CM6 renders unstyled by default (light theme, `.cm-editor` etc.). Instead of building an `EditorView.theme({...})` JS object, `App.css` targets CM6's own class names (`.cm-editor`, `.cm-gutters`, `.cm-activeLine`, `.cm-selectionBackground`, `.cm-tooltip-autocomplete`) scoped under `.ds-editor-body`, referencing the same `--editor-bg`/`--fg`/`--muted`/`--border`/`--accent` custom properties every other panel uses — so the editor stays in sync with the existing light/dark/auto theme toggle for free.
- **Why**: The app already drives all theming through CSS custom properties (`data-theme` attribute + `prefers-color-scheme`); a separate JS theme object would need its own light/dark branching and drift from the CSS-driven system. CSS-class override is less code and one less place to update when a theme color changes.
- **Source**: recommended-accepted

## D40: `⌘S` save moved from a window-level keydown listener to CM6's own keymap
- **Decision**: The textarea checkpoint's `window.addEventListener("keydown", ...)` for `⌘S` is gone. Save-on-`⌘S` is now a `Mod-s` binding inside the CM6 `keymap.of([...])` extension, active only while the editor has focus.
- **Why**: A window-level listener fired regardless of what was focused (including a thread's chat input). CM6's keymap only intercepts the binding when the editor itself is focused, which is the correct scope for an editor save shortcut and removes a global listener the codebase no longer needs.
- **Source**: recommended-accepted (implementation discovery, not user-facing surprise)

## D41: jsdom needs a `Range` rect polyfill to mount CM6 in tests
- **Decision**: `src/__tests__/setup.ts` now polyfills `Range.prototype.getClientRects`/`getBoundingClientRect`. Without it, mounting an `EditorView` under jsdom throws inside CM6's per-frame text measurement (`clientRectsFor`), since jsdom's `Range` has no layout engine behind it.
- **Why**: This is the standard, widely-documented fix for testing CM6 under jsdom (no layout box measurements are meaningful in jsdom anyway — CM6 just needs the calls to not throw). Applies globally to the test suite, not per-test.
- **Source**: recommended-accepted (implementation discovery)

## D42: Post-checkpoint fixes from live review (syntax color, autocomplete bg, editor remount, Cmd+S)
- **Decision**: Three issues reported after the Phase 2 checkpoint, all fixed:
  1. **No syntax color.** The mount effect never included a `HighlightStyle` extension — the language parsers alone only produce syntax *tags*, not colors. Added `syntaxHighlighting(defaultHighlightStyle, { fallback: true })` from `@codemirror/language` (added as an explicit dependency; it was already a transitive dep of the `lang-*` packages, so no new install weight). `defaultHighlightStyle` is CM6's own stdlib style, reused as-is rather than hand-building a themed one.
  2. **Autocomplete popup had no background.** `App.css`'s tooltip rules referenced `var(--panel-bg)`, a token that doesn't exist anywhere in `:root` (a latent typo, pre-existing on two other, cosmetically-invisible rules at `.ds-editor-toolbar`/`.ds-editor-save-btn` — left those alone, out of scope). Undefined custom properties resolve to nothing, so the tooltip rendered fully transparent. Fixed to `var(--surface)`, the token already used for the Communities floating card (D34) — same "floating panel over the canvas" pattern. Also discovered and fixed a second, unrelated scoping bug in the same rules: CM6 tooltips portal to `document.body`, not into `.ds-editor-body`, so the original `.ds-editor-body .cm-tooltip-autocomplete` selector never matched anything; rule now unscoped with a comment explaining why.
  3. **CM6 view remounted on every save**, losing cursor/selection/undo history. The mount effect was keyed on `[content, path]`, and `save()` calls `setContent(after)` on success — so every successful save changed a dep and tore down/recreated the `EditorView`. Re-keyed to `[path, contentLoaded]` (`contentLoaded = content !== null`), which still mounts once content finishes loading after a file switch but no longer reacts to content changing via save. Test-first: a new test asserts `.cm-content`'s DOM node identity is unchanged across an edit+save cycle.
- **"App resets" on Cmd+S — explained, not a code defect.** Investigated in parallel (direct live reproduction + a research subagent reading `src-tauri` for a native menu/accelerator). No native `Menu`/`accelerator` exists in the Rust backend (Tauri falls back to its OS-default menu, which has no Save item), and the only other `window` keydown listener (`App.tsx:433-450`) doesn't touch `s`. The CM6 `Mod-s` keymap binding is correctly first-in-list and returns `true`. Live console logs captured during this session show the real cause: `pnpm start`'s Vite dev server watches this whole repo's `src/` (only `src-tauri/**` is excluded, `vite.config.ts`), and this project is being dogfooded — edited through its own running instance. Writing a file via `writeFileContent` that's also part of the *running app's own* module graph makes Vite hot-reload; for files Fast Refresh can't cleanly patch (e.g. `GraphView.tsx`, which mixes a component export with a non-component `buildModel` export) it invalidates and the reload cascades, which presents as "the whole app resetting." This is specific to running Floo Network's own editor against Floo Network's own repo in dev mode — it doesn't happen editing any other project, and won't happen at all in a production build (no Vite dev server watching). No fix applied; flagged to the user for confirmation that it doesn't reproduce on a non-self-hosted project.
- **Source**: user (all three), root-caused via live Tauri MCP verification + a parallel research subagent for the Cmd+S report.

## D43: Per-project UI state now resets on project switch
- **Decision**: Confirmed the Cmd+S "reset" (D42) does not reproduce on other projects — ruling that out as expected/dev-mode-only. In the process, the user surfaced a real bug from the same test: switching projects (`project-picker`) left the file editor showing the *previous* project's open file, which the new project then tried (and failed) to resolve on disk. Root cause: `selectProject` (`App.tsx`) already reset `note` on switch but not `selectedFile` or `fileEdits` (the diff tab's manual-edit list) — both are per-project state, same bug class. Also found and fixed the same pattern in `FileTree.tsx`: `error`/`expanded`/`children` weren't reset when `projectHash` changed, so a stale directory-read error (or, more subtly, stale cached children under a same-named folder path) could leak across projects.
- **Fix**: `selectProject` now also calls `setSelectedFile(null)` and `setFileEdits([])`. `FileTree`'s `[projectHash]` effect now resets `error`/`expanded`/`children` before issuing the new root listing.
- **Why**: Root-cause fix over per-symptom patching — same "reset per-project UI state on switch" rule now applies everywhere project-scoped local state exists, not just the one path the user's screenshot happened to show.
- **Verified test-first**: `FileTree.test.tsx` (new) asserts a stale error clears on project switch — confirmed red before the fix. `App.test.tsx`'s new "Project switching" describe block asserts the editor no longer shows the old project's file after switching — confirmed red (editor stayed on `a.ts` under `proj-b`) before the fix, green after.
- **Source**: user

## D44: Codebase Map auto-compiles on project open, no thread required
- **Decision**: Previously, `run_graphify` (Rust command) always required a `thread_id` and unconditionally injected the run summary into that thread — the only way to get a graph.json+report was the manual "Run Graphify" button, gated by "Select a thread first" if none existed. New projects (or any project without a prior run and no thread yet) had no way to see a codebase map at all except creating a thread first, purely to unblock an unrelated feature.
  - **Rust**: `run_graphify`'s `thread_id` param is now `Option<String>`; `store::append_message` (the injection) only runs when `Some`. The extraction itself (`integrations::run_graphify`) was already thread-agnostic — this only decouples the Tauri command wrapper's injection side-effect from running Graphify at all.
  - **Frontend**: `GraphPane`'s project-load effect now falls back to `api.runGraphify(projectHash, null, "", { incremental: false, codeOnly: true, deep: false })` when `loadGraphify` finds nothing on disk, instead of just showing an empty state. Added a `cancelled` guard (same pattern as D43) so a fast project switch mid-compile doesn't clobber the next project's state. Empty-state copy now distinguishes "Compiling codebase map…" (auto-run in flight) from "No code map yet" (compile failed, e.g. `graphify` not on PATH — shown via the existing error banner).
  - The manual "Run Graphify" / "Re-run" button's existing thread-required behavior is unchanged — it still needs a thread because *that* path's whole point is injecting the summary into it (D9). Auto-compile is a separate, thread-less path that only produces the on-disk graph.json + report for the pane to render.
- **Why**: User: opening a new project (tested with a second, unrelated `toolsieve` project) showed no graph and the "select a thread" error instead of a map — the map should just be there when you open a project, per the "graph-native IDE" premise (D2/D9), independent of whether the user has created a thread yet.
- **Verified test-first**: `GraphPane.test.tsx` (new) — one test confirms auto-compile fires and skips injection (`threadId: null` sent to `run_graphify`) when no prior run exists; one confirms an existing on-disk run is shown without re-compiling. Confirmed the first test fails (falls back to the old "No code map yet" empty state) with the fix reverted, passes with it applied. Full suite: 80/80 (frontend) + 64/64 (`cargo test`), `cargo check` clean.
- **Source**: user

---

## Phase 3 implementation (PTY terminal)

## D45: Terminal is spawned lazily (on panel open), not eagerly on every project switch
- **Decision**: Unlike the `graphify watch` process (D21/D9), which `start_watcher` spawns unconditionally on every `switch_project`, the PTY terminal is spawned lazily — only when `TerminalPane` actually mounts (i.e. the user opens the terminal panel, matching D24's `defaultCollapsed: true` from Phase 1, which fully unmounts the panel's content when collapsed rather than CSS-hiding it). `terminal_spawn(project_hash)` is idempotent: if a terminal already exists for that project it's a no-op (re-attach, spec's "single terminal instance"); if one exists for a *different* project, it's killed and a new one spawned for the current one. This single command handles both "lazy first open" and "project switch while the panel was already open" — `App.tsx` doesn't need separate wiring for each; `TerminalPane`'s own `useEffect` on `[projectHash]` calls `terminal_spawn` again whenever the project changes, and the command's own project-hash check decides kill-old-vs-no-op.
- **Why**: Task 3.4 says "wire terminal lifecycle to project switch (kill old, spawn new)," which could read as "always eagerly spawn on switch, like the watcher." But `graphify watch` is a cheap background poller; a login shell is a much heavier real process (shell rc files, potential plugin frameworks like oh-my-zsh) that the terminal spec never asks to run unconditionally in the background — and the terminal panel is collapsed-by-default specifically because Phase 1 decided sidebars/panels should be user-opened, not auto-populated. Eagerly spawning a shell for every project the user merely glances at via the project picker would contradict that. Lazy-spawn-with-idempotent-reattach satisfies the same "kill old, spawn new" requirement without the always-on cost, and is simpler to implement (one code path instead of duplicating swap logic in both `switch_project` and a frontend-triggered command).
- **Source**: recommended-accepted

## D46: Terminal output crosses the Tauri IPC boundary as base64, not UTF-8 text
- **Decision**: `terminal-output` events carry base64-encoded raw PTY bytes (`BASE64_STANDARD.encode(&bytes)` in `terminal_spawn`'s output callback), not a lossy `String::from_utf8_lossy` conversion. The frontend decodes back to a `Uint8Array` and hands it directly to `xterm.write()`. Terminal *input* (keyboard → PTY) stays a plain string — xterm's `onData` always emits proper JS string content (including control chars like `\x03` for Ctrl-C), never raw/possibly-invalid bytes, so no encoding round-trip is needed on that side.
- **Why**: PTY reads happen in fixed 4096-byte chunks; a multi-byte UTF-8 character (any non-ASCII output — box-drawing chars in `top`, colored/unicode prompts, non-ASCII filenames) can land split across a chunk boundary. Converting each chunk to a string independently in Rust would corrupt any character split that way. `xterm.write(Uint8Array)` uses xterm's own stateful UTF-8 decoder, which correctly reassembles sequences split across separate `write()` calls — base64 is the simplest lossless way to carry arbitrary bytes over Tauri's JSON-based event system to get them there unmodified.
- **Source**: recommended-accepted (implementation discovery — the codebase's existing event emitters all carry JSON-native data, so "how do raw bytes cross this boundary" was a real gap no prior artifact addressed)

## D47: Top-chrome terminal toggle button + `⌘\`` shortcut
- **Decision**: Added a third `ds-icon-btn` in the top chrome (next to the existing left/right sidebar toggles), matching their exact visual pattern (`TerminalIcon`, same 16×16 frame as `SidebarIcon`, `ds-icon-btn` class, `data-testid`, tooltip listing the shortcut). Bound to `⌘\`` (backtick), the common IDE convention (VS Code, etc.) for toggling the integrated terminal, alongside the existing `⌘\` (left)/`⌘J` (right) shortcuts. The handler is placement-aware: toggles the bottom panel's collapse state directly, or — when the user has moved the terminal to the sidebar (D-adjacent to the placement toggle) — switches the right sidebar to the Terminal tab and ensures the sidebar itself isn't collapsed, since `terminalPanel.collapsed` doesn't control visibility in that placement.
- **Why**: User asked for a terminal toggle button matching the left/right sidebar ones. The keyboard shortcut was a natural, low-risk extension of the same already-existing keydown handler (not separately requested, but directly mirrors the two sibling toggles that already have one).
- **Source**: user (button) + recommended-accepted (shortcut, matching sibling pattern)

## D48: `graphify watch` orphan leak on `tauri dev` restart — cleaned up, then root-caused and fixed
- **Found while live-verifying Phase 3**: 20 orphaned `graphify watch` Python processes (11 for floo-network, 9 for toolsieve), each consuming 83-90% CPU continuously, some running since Wednesday. Root cause: `start_watcher` (`lib.rs`) relies on `Watcher`'s `Drop` impl (`integrations.rs`) to kill the child `graphify watch` process when a project switch replaces it — but `pnpm start`'s `tauri dev` hard-restarts the whole Rust binary on every backend source change (this session edited `lib.rs`/`executor.rs`/`terminal.rs` many times), and that restart does not run the old process's Drop glue, so each restart's watcher was orphaned instead of killed. All had `ppid 1` (reparented to init) except the one legitimately owned by the currently-running app instance.
- **Immediate cleanup**: killed the 20 orphaned processes (`kill <pid>`, verified via `ps -eo pid,ppid,etime,command`, careful to exclude the one live process's actual child) — user's explicit choice ("kill them now, fix later") when first asked.
- **Root-cause fix (user asked to fix it in the same session)**: added `pidguard.rs` — a small PID-file mechanism. `Watcher::spawn` now writes the child's PID to `<project-root>/graphify-out/.watch.pid` and, *before* spawning, calls `pidguard::reap_stale` on that same path: if it names a still-running process whose command line contains `"graphify watch"`, kill it first. `Watcher::terminate` clears the file on a clean stop. Because every dev-restart re-runs `start_watcher` for the last-active project on launch, this makes the leak self-limiting to at most one orphan at a time (the next restart reaps the previous one) instead of accumulating unboundedly.
- **Deliberately not applied to the PTY `Terminal`**: same exposure in principle (a dev-restart could orphan a spawned shell), but `pidguard::reap_stale`'s safety net — verifying the live PID's command line still looks like what we spawned before killing it — only works because `"graphify watch <path>"` is a distinctive, safely-matchable command line. A bare login shell (`zsh -l`) is not: after a PID is reused, "does this process's command line look like a shell" would match `zsh -l`, `bash -l`, or effectively **any of the user's own terminal windows**, real ones nothing to do with Floo Network. Applying the same reap-on-spawn pattern there risks killing an unrelated, real terminal session the user has open elsewhere — an unacceptable trade for a dev-mode convenience. Left as a known, intentionally-unfixed gap; a leaked idle shell is also far less harmful than the measured 85%+ CPU `graphify watch` orphans were.
- **Verified**: 3 new `pidguard` tests (reaps a matching live process; leaves a live process alone when the command doesn't match; missing-file is a no-op) — `cargo test`: 69/69.
- **Source**: user (both the initial "kill now, fix later" choice and the follow-up "fix the bug")

## D49: Terminal theme colors resolved via computed style, not raw CSS var strings
- **Decision**: `TerminalPane`'s xterm `theme` option (background/foreground/cursor/selectionBackground) is built by `resolveCssColor()` — appending a throwaway element with `style.color = "var(--editor-bg)"` etc., reading back `getComputedStyle(el).color`, then removing the element — instead of reading `getComputedStyle(document.documentElement).getPropertyValue("--editor-bg")` directly. Also added a `MutationObserver` on `<html data-theme>` plus a `prefers-color-scheme` listener so an in-session light/dark toggle re-themes the already-open terminal instead of only picking up the right colors at next mount.
- **Why**: Confirmed live (screenshot, light theme) that the terminal rendered with xterm's own default black-on-white regardless of the app's actual theme. Root cause: this app's design tokens are `oklch(...)` colors (App.css `:root`), and xterm's canvas renderer's `fillStyle` doesn't accept `oklch()` strings the same way `getPropertyValue` returns them raw/unresolved — the browser only resolves a custom property to its canonical, universally-parseable `rgb()`/`rgba()` form when queried through computed style *on an element*, not through the property lookup itself. Matches D39's precedent (CM6 theming) in spirit — reuse the app's existing tokens rather than hardcode terminal-specific colors — but needed one extra resolution step because canvas, unlike CSS-class-based styling, can't consume the custom property directly.
- **Source**: user (screenshot showing the mismatch), root-caused live

## D50: `TERM` explicitly set for the spawned shell
- **Decision**: `Terminal::spawn` now sets `cmd.env("TERM", "xterm-256color")` alongside the existing `PATH` fix.
- **Why**: Found live during task 3.7 verification — `top` refused to start ("TERM environment variable not set"), and `clear` silently failed the same way. Root cause: this app is launched by launchd (Finder/`open`), which — like the `PATH` gap `child_path_env` already works around — doesn't set `TERM` either, since launchd isn't a terminal. Every curses/ncurses-based TUI program (`top`, `vim`, `less`) needs `TERM` to look up its terminfo entry and refuses to run without it. `xterm-256color` matches what xterm.js itself speaks and is present in macOS's default terminfo database.
- **Verified live**: `top` renders full-screen with correct columnar layout and live updates; resizing to 60×15 via `terminal_resize` while `top` was running correctly reflowed its column set and row count (real `SIGWINCH`-driven redraw). ANSI 3-color test (`printf` with `\033[31m`/`\033[32m`/`\033[34m`) rendered in the right colors. `sleep 30` interrupted cleanly by Ctrl-C (`^C`, prompt returned immediately, next command ran — proving the shell wasn't left blocked). Tab completion expanded `echo RE` → `echo README.md` correctly.
- **Known unresolved observation (not blocking, not chased further per user)**: `vim`, tested only in the sidebar placement (narrow ~700px column), rendered a blank pane with no visible output, and the console logged repeated `ResizeObserver loop completed with undelivered notifications` warnings around that time. Not reproduced in the default bottom-panel placement, where `top` (a comparable full-screen curses app) rendered correctly. Left as-is at the user's direction ("everything seems functional... put phase 3 to rest") — worth a look if a real vim-in-sidebar report surfaces later, but not confirmed as an actual defect (could be a screenshot-timing artifact, a very-small computed terminal size in the narrow sidebar, or something else).
- **Source**: user (live verification), root-caused and fixed live

---

## Phase 4 grilling (before implementation)

## D51: Diff pane stays an editor-tab; no commit graph in v1
- **Decision**: Before starting Phase 4, considered moving the diff/stage/commit UI into a new right-sidebar tab (VS Code/Cursor convention — their Source Control panel lives in the sidebar) and adding a commit-history graph view. Researched via web search: VS Code's Source Control panel has two parts, a Changes/Staged-Changes list (already Phase 4's whole scope) and a separate Graph view for commit/branch history; Cursor keeps the same shape with AI additions (generate commit message, resolve-conflict-in-chat). User chose to keep both as originally scoped: diff pane stays the existing "Code Change Diff" editor-tab (not relocated to the right sidebar), and no commit graph — D6's v1 boundary ("no branch switching, blame, or log graph in v1") stands unchanged.
- **Why**: User's explicit choice after seeing the tradeoff — the graph is real added scope (typically the most complex part of any git UI) that D6 already deliberately deferred as "polish, not v1 load-bearing"; no reason surfaced to reopen that now. Placement change wasn't worth it without the graph motivating it.
- **Source**: user

---

## Phase 4 implementation (git diff + hunk staging)

## D52: Shared diff-line renderer replaces `react-diff-viewer-continued` everywhere
- **Decision**: `react-diff-viewer-continued` is gone (task 4.1). In its place: a pure `rowsFromChange`/`rowsFromHunk` pair (`src/diffLines.ts`, test-first) normalizing either a before/after string pair (via jsdiff's `diffLines`) or a parsed unified-diff hunk (via jsdiff's `StructuredPatchHunk.lines`) into one shared `DiffRow[]` shape, rendered by one presentational `<DiffRows>` component. `EventView.tsx`'s existing per-edit `fileEdit` rendering (agent turns + manual editor saves, D7 — unchanged placement/behavior) now uses `rowsFromChange` + `<DiffRows>` instead of the library. The new `DiffPane` (git working-tree hunks) uses `rowsFromHunk` + the same `<DiffRows>` — one visual renderer, two data sources, matching the Dragon Fire diff tokens (App.css `.diff-row`/`.diff-rows`, translated from the old `diffStyles` object's color mapping) in both places instead of duplicating diff-rendering + styling logic.
- **Why**: Task 4.1 required removing the library (needed for hunk-owning staging, D19); EventView's existing diff view used the same library for an unrelated (read-only, no staging) purpose. Building one shared renderer avoids maintaining two diff-rendering implementations with the same visual language.
- **Source**: recommended-accepted

## D53 (amends D20): per-hunk unstage uses `git apply --cached --reverse`, not `git restore --staged`
- **Decision**: `git.rs::unstage_hunk` reverse-applies the hunk's own patch against the index (`git apply --cached --reverse -`). `git restore --staged` is still used, but only for whole-file "stage all" convenience (`stage_file` uses `git add --`; an equivalent whole-file unstage via `git restore --staged` was not wired to a UI control in v1 — per-hunk unstage buttons cover it).
- **Why**: D20 listed both commands without specifying which handles which granularity. `git restore --staged <path>` unstages an entire file/diff — it has no hunk-scoped mode. Reverse-applying the same patch text used to stage a hunk is the standard technique (the same one `git add -p`/`git gui` use internally) for undoing exactly one hunk's staging without touching the rest of the file's staged state.
- **Verified test-first**: `git.rs`'s `stage_hunk_then_unstage_hunk_round_trips` test (real tempdir git repo) — stages a single-hunk change, confirms it appears in `staged_diff` and disappears from `working_tree_diff`, then unstages and confirms the reverse.
- **Source**: recommended-accepted (mechanical git-plumbing detail, not a product tradeoff — reverse-apply is the only correct way to unstage one hunk)

## D54: `parsePatch("")` returns a bogus entry — filtered centrally in `parseFilePatches`
- **Decision**: `src/gitDiff.ts` now exports `parseFilePatches(diffText)`, which calls jsdiff's `parsePatch` and filters out any entry with zero hunks, instead of every caller calling `parsePatch` directly. `DiffPane` uses this for both the working-tree and staged diffs.
- **Why**: Caught test-first while writing `DiffPane.test.tsx` — a clean repo's `git diff`/`git diff --cached` output is `""`, and jsdiff's `parsePatch("")` returns a one-element array (a degenerate `StructuredPatch` with no filename and `hunks: []`), not `[]`. Any code checking `.length > 0` to mean "there are changes" — which is exactly how `DiffPane` decides whether to show the "Staged Changes" section or enable the Commit button — got a false positive on a perfectly clean working tree. Confirmed directly: `parsePatch("").length === 1`.
- **Verified test-first**: `gitDiff.test.ts` asserts the raw `parsePatch("")` quirk (documenting why the wrapper exists) and that `parseFilePatches("")` correctly returns `[]`. `DiffPane.test.tsx`'s empty-state and commit-button-disabled tests failed against the false positive before this fix, pass after.
- **Source**: recommended-accepted (implementation discovery, not user-facing surprise — a library quirk, not a product decision)

## D55 (supersedes D6's branch-switching exclusion): branch list/checkout/create + pull/push added to v1
- **Decision**: D6 explicitly excluded branch switching from v1 ("Tier B... no branch switching, blame, or log graph in v1"). User overrides this mid-Phase-4: branch visibility + switching, plus pull/push, are now required, modeled on how VS Code/Cursor/Kiro actually expose them (a branch indicator near the workspace/project picker for viewing + switching + creating branches; Pull/Push actions living with the rest of the git surface, i.e. `DiffPane`). Blame and a commit-history graph remain excluded (D51 already settled the graph question this same phase; blame was never asked for here either).
- **Conflict/dirty-tree behavior**: git's own default — refuse with git's own error message, no auto-stash. User explicitly chose this over silently stashing/restoring, reasoning from how real IDEs behave (git itself already refuses a checkout/pull that would overwrite uncommitted changes; Floo surfaces that error as-is rather than working around it).
- **Push with no upstream**: first push of a new local branch auto-sets the upstream (`git push --set-upstream origin <branch>` retried after a plain `git push` fails specifically for "no upstream") — matches VS Code's own first-push behavior, not a new invention.
- **Scope (the full day-to-day inner-loop set, not just the three named)**: list branches (local + remote-tracking, current marked), checkout an existing branch, create+checkout a new branch, delete a (non-current) local branch, fetch, pull, push, discard a file's changes back to HEAD (the everyday "undo this" next to a changed file — distinct from unstage; destructive, needs a confirm), and Initialize Repository as a one-click affordance when a project isn't a git repo yet (Floo lets you add any folder as a project; DiffPane needs *something* to show instead of a raw "not a git repository" error). Deliberately still out: amend (already excluded, D27 — not re-litigated here), stash, a commit-log/history view (adjacent to D6/D51's graph exclusion, not asked for), merge/rebase UI, remote add/remove, force-push, tags — none were asked for and several (force-push, remote management) are a materially different risk profile than the rest of this set.
- **Source**: user

## D56: Two real bugs found and fixed during D55's live verification
- **`discard_file` on an untracked directory** — `git status` reports a wholly-untracked directory as one entry (e.g. `"graphify-out/"`, matching `git`'s own porcelain output), but `discard_file`'s untracked branch called `std::fs::remove_file`, which only deletes a single file and fails with "Operation not permitted" on a directory. Fixed: check `full.is_dir()` and use `remove_dir_all` for that case. Reproduced live (clicking Discard on an untracked `graphify-out/` folder), fixed, added a regression test (`discard_file_deletes_an_untracked_directory`), reverified live.
- **`ahead_behind` on a repo with zero commits** — the "no upstream" fallback matched specific git stderr substrings (`"no upstream"`, `"unknown revision"`), but a freshly-`git init`'d repo (no commits yet, so `HEAD` itself doesn't exist) fails with a *different* message — `"fatal: no such branch: 'HEAD...'"` — which matched neither, so the error propagated instead of returning `None`. Broke the live "Initialize Repository" flow (D55) end-to-end: `DiffPane`'s `refresh()` would fail immediately after a successful init. Fixed by replacing string-matching with explicit preconditions (`git rev-parse --verify -q HEAD` succeeds only once there's a commit; `git rev-parse @{u}` succeeds only once an upstream is configured) — more robust than pattern-matching stderr text that varies by situation and potentially by git version/locale. Reproduced live (Initialize Repository → immediate error), fixed, added a regression test (`ahead_behind_is_none_on_a_freshly_initialized_repo_with_no_commits_yet`), reverified live end-to-end (init → clean empty-repo UI, no error).
- Both found through the live-verification pass explicitly planned for exactly this reason (task 4.15) — neither was caught by the unit tests written alongside the original implementation, since neither test suite had exercised "a repo with literally zero commits" as a starting state.
- **Source**: found live, root-caused and fixed in the same session

---

## Phase 5 grilling (before implementation)

## D57 (amends D17): left sidebar becomes a File Explorer only; Workspace + Threads move to the right sidebar
- **Decision**: D17 put "sessions" (Workspace project picker + Threads) in the left sidebar and Codebase Map/terminal-when-docked in the right. User asked to restructure this, modeled on Devin Desktop's layout (screenshot: a VS Code-style Explorer on the left, the agent session panel on the right):
  1. **Left sidebar** keeps only the file tree (`FileTree`) — a clean, VS Code/Devin-style Explorer. Still resizable/collapsible via the existing `leftRail` hook and `⌘\`, unchanged mechanics, just narrower content.
  2. **Right sidebar** gains Workspace (project picker, branch indicator, Add/Rename, `+ New Thread`) pinned above the tab bar — always visible regardless of which tab is active, since project context is relevant no matter what you're looking at — and Threads becomes a new tab alongside Codebase Map / Notes / Terminal.
  3. **Threads is the new default right-tab** (was Codebase Map) — matches the Devin screenshot, where the session/chat panel is what's showing by default, not something you click into.
- **Consequence, decided without a separate question (recommended-accepted)**: `rightPanel`'s `defaultCollapsed` flips from `true` to `false`. It was collapsed-by-default in Phase 1 (D33/D34) because its only content back then (Codebase Map) was optional/secondary. Now that it holds Workspace + Threads — project switching and the thread list, both load-bearing, previously always-visible in the left rail with no expand action needed — leaving it collapsed by default would hide primary navigation on every launch. This follows directly from the two choices above; a user who asked for Threads to be the prominent default tab would clearly not want that tab hidden behind a collapsed panel.
- **Why**: User's explicit direction, grounded in a concrete reference screenshot (Devin Desktop). Two sub-placements were confirmed via clarifying questions rather than assumed: Workspace moves with Threads (not staying left with the file tree), and Threads becomes the default tab (not staying secondary to Codebase Map).
- **Source**: user (placement + default-tab choices); recommended-accepted (the `defaultCollapsed` flip, a direct consequence not separately asked)

---

## Phase 5 implementation (file palette + layout restructure)

## D58: Live-review fixes on the D57 right-sidebar layout
- **Decision**: Four issues found live-driving the running app after the D57 restructure landed, all fixed:
  1. **User chip / "think" toggle footer dropped.** The pinned Workspace panel's bottom row (avatar, "tjlsmith", show-thinking checkbox) was removed outright, not relocated — user pointed at a screenshot and said drop it. `showThinking` becomes a plain `localStorage`-read constant (no more setter/checkbox); its value is now fixed at whatever was last set before this change, since there's no remaining UI to change it.
  2. **"+ New Thread" moved from the pinned Workspace panel to inside the Threads tab pane**, directly below the tab row — mirrors the Notes tab's own existing "+ Create note" pattern (a tab-scoped action lives inside that tab's pane, not in the always-visible Workspace header). Consequence: the button is now only visible when the Threads tab is active, not from every tab like Workspace's other controls.
  3. **File palette recolored to one solid surface.** The palette's `<input>` was inheriting the app's global `input { background: var(--surface-warm) }` while the `.commandbar` card around it uses `var(--bg)` — a visible two-tone seam. `.file-palette input` now overrides to `var(--bg)` with no border/radius, and `.file-palette-results` explicitly matches, so the whole palette reads as one flush surface (Cursor/VS Code command-palette convention) instead of a boxed input floating on a different-toned card.
  4. **DiffPane's Fetch/Pull/Push + commit box made `position: sticky`.** Root cause: `.diff-pane` had a dead `overflow-y: auto` (it was never height-bounded, so it never actually scrolled) while its real ancestor `.messages` was the sole scrolling box — meaning the sync bar and commit textarea, both near the top of `DiffPane`, scrolled away with everything else the moment the Changes/Staged diff (or the separate Turn History section below it) grew past one screen. User: "I need to be able to write commits and stuff. This is unusable." Fixed: dropped the dead `overflow-y: auto`; wrapped the sync bar + commit box in `.diff-sticky-controls` (`position: sticky`, negative-margined to bleed into `.diff-pane`'s own padding so it renders as one flush, solid toolbar rather than an inset card with visible seams at its edges) so those controls stay reachable throughout the scroll. `.messages` also gained an explicit `background: var(--editor-bg)` (it and `.diff-pane` were rendering fully transparent, relying on `.main`'s paint showing through).
     - **Follow-up A**: first pass used `top: -10px` on the sticky element (meant to feel "flush" but actually delays when it catches by 10px — sticky's `top` is the offset from the scrolling ancestor's padding edge at which it freezes, not a bleed amount). That reintroduced exactly the gap it was meant to close, letting a scrolled-past line peek through above the toolbar every time. Fixed to `top: 0` (the negative *margin*, not `top`, is what handles the padding bleed).
     - **Follow-up B**: even at `top: 0`, computed geometry proved the box was flush (`getBoundingClientRect()` matched `.messages`'s padding edge exactly) yet a live screenshot still showed a stale sliver of the previous scrolled line painted above it — a known WKWebView issue where a `position: sticky` element's paint can lag its own computed position during scroll. Added `transform: translateZ(0)` to force its own compositing layer; when that alone still wasn't enough on a re-test, added `box-shadow: 0 -40px 0 var(--editor-bg)` as a guaranteed solid backstop — `.messages`'s own `overflow-y: auto` clips the shadow to the scrollport, so it can't bleed onto the breadcrumb bar above. Verified live at multiple scroll depths (top, mid-diff, deep into Turn History): no sliver, breadcrumb bar clean.
- **Why**: All four surfaced from the user live-driving the just-shipped D57 layout in their own real project (not a throwaway test repo) — direct visual/functional feedback on running code, not planning-stage decisions. (4) escalated from a polish nit to a correctness fix once framed as "unusable," and needed two follow-up rounds because the first fix's own remaining artifact ("text popping through") was reported as a fresh issue before it was traced back to the same sticky toolbar.
- **Source**: user (all four, via live screenshots, including two rounds of follow-up on (4))
