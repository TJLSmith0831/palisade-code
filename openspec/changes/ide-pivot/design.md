## Context

Floo Network today is a Rust+Tauri agent console: three-column flex layout in `App.tsx` (sessions left, chat+diff+editor tabs center, codemap+notes right), with a textarea-based `FileEditorPane`, display-only `react-diff-viewer-continued` diff, lazy one-dir-per-IPC `FileTree`, and a Graphify integration that shells out and injects a bounded summary into threads. The executor abstraction (Claude/Codex), Spec/Go toggle, OpenSpec+Grill skills, append-only session store, and Graphify watcher are stable and unchanged by this change.

This design covers the seven new capabilities in `proposal.md`. See `proposal.md` for motivation and `decisions.md` (D1–D28) for the full decision trail; this document explains the *how* behind each choice and the cross-cutting architecture.

## Goals / Non-Goals

**Goals:**
- Turn the console into a usable IDE on the four dimensions users hit first: edit, run, review, commit.
- Preserve the structural advantages that distinguish Floo from Kiro (Rust+Tauri performance, user-owned executor, append-only sessions, Socratic spec flow).
- Make the agent graph-native by giving the executor graph tools, not by mediating graph access through the harness.
- Keep the editor substrate ready for a future FIM model without building FIM plumbing now.

**Non-Goals:**
- LSP, diagnostics, go-to-definition, hover, rename (v2, alongside FIM).
- The FIM model itself (v2; editor has the seam only).
- Branch switching, blame, log graph (v2 git tier C).
- Parallel agents / multi-agent sandboxes (v2).
- Multi-terminal tabs/splits (v2).
- Embedding-based semantic retrieval (Graphify's thesis rejects embeddings; a separate Rust-native index is a v2 question tied to FIM).
- Executor-level hooks (PreToolUse blocking) — harness can't intercept inside the executor's loop.

## Decisions

### D3/D23 — CodeMirror 6 over Monaco or textarea
**Choice:** CodeMirror 6 as the editor substrate, with `@codemirror/lang-{rust,javascript,python,go,json,markdown,css}` and `@codemirror/autocomplete`.

**Why over alternatives:**
- *Textarea (current)* — cannot render ghost-text completions or inline decorations; would be rebuilt when FIM lands. Paying for the editor twice.
- *Monaco* — VS Code's editor; heaviest (~5MB), built for Electron/Chromium, fights Tauri's WKWebView on sizing/IME/focus. Picking Monaco imports Kiro's documented performance failure (Issue #4056).
- *CodeMirror 6* — lean (~150KB gzipped for a lean config), modular, built for embedding, works well in WKWebView, first-class `@codemirror/autocomplete` API, inline decorations for future diagnostics, viewport virtualization for large files. The only option that supports inline completions without importing Monaco's performance problem.

**Architecture:** `FileEditorPane` becomes a thin React wrapper around a CM6 `EditorState` + `EditorView`. Language extensions are selected by file extension at open time. The completion source uses CM6's `autocompletion` API with a document-word source for v1; the same API is the seam a future FIM provider plugs into. Save (`⌘S`) calls the existing `write_file_content` IPC; dirty state is derived from CM6's `docChanged` transactions.

### D4/D17/D18 — PTY terminal via portable-pty + xterm.js
**Choice:** Real PTY (`portable-pty` Rust crate) + `xterm.js` frontend, bytes over a Tauri event channel. One terminal, `$SHELL` with `/bin/zsh` fallback. Bottom panel by default, toggleable to right sidebar.

**Why over shell-out stream:** A command-runner can't host `vim`/`top`/`ssh` and is the first thing developers notice. Building it twice (runner now, PTY later) costs more than building PTY once.

**Architecture:**
- Rust: a `Terminal` struct owns a `portable-pty::PtyPair`. A Tauri command `terminal_spawn(project_hash)` starts the shell in the project root, using `child_path_env()` (executor.rs:70-75) so the launched shell sees the login-shell PATH (same fix as the executor — launchd's minimal PATH would otherwise break `nvm`/`~/.local/bin` shells). Output bytes are emitted as `terminal-output` events; a `terminal_input` command writes bytes to the PTY's writer; `terminal_resize(cols, rows)` calls `set_size`. `terminal_kill` drops the PTY on project switch or app shutdown.
- Frontend: an `xterm.js` `Terminal` instance subscribes to `terminal-output`, writes input via `terminal_input`, and forwards its `resize` event to `terminal_resize`. The xterm container is mounted in the bottom panel (D17) or right sidebar (toggle).
- Single instance: the harness holds one `Terminal` per active project; opening the panel when one exists re-attaches rather than respawning.

### D17/D24 — Resizable layout with per-project persistence
**Choice:** Both sidebars and the terminal panel become drag-to-resize via handles. Widths/heights persist per-project in localStorage (`floo:layout:<hash>`), not in `project-settings.json`.

**Why localStorage over project-settings:** Layout is personal preference (where I like my panels), not project config (how the project builds). Mixing them forces team-shared settings to encode one developer's panel widths.

**Architecture:** `App.tsx`'s three-column flex gains: (a) drag handles on both sidebar borders, (b) a vertical split in the center column with a drag handle above the terminal panel. A small `useResizable` hook tracks pointer drag → updates a width/height state → persists to localStorage on pointer-up. On project load, the layout state hydrates from localStorage (or defaults). The existing `⌘\` / `⌘J` collapse shortcuts stay; collapsing sets width to 0 (or a flag), restoring returns to the persisted width.

### D6/D19/D20 — Git diff with hunk staging via `diff` lib + shell-out
**Choice:** `diff` (npm) for hunk computation + custom React rendering with per-hunk stage/unstage controls. Drop `react-diff-viewer-continued`. Git ops via shell-out to `git` CLI from Rust.

**Why over alternatives:**
- *Overlay on `react-diff-viewer-continued`* — it wasn't built for per-hunk interaction and hides the hunk boundaries needed to reconstruct patches for `git apply --cached`.
- *`diff2html`* — heavier, brings its own rendering opinions that fight the Dragon Fire tokens.
- *`diff` + custom render* — gives raw hunks; we render with the existing `diffStyles` tokens (EventView.tsx:9-38) and own the patch reconstruction. Reuses the design system, gives staging the control it needs.
- *Rust git library (`gix`/`git2`)* — real dependency + learning curve; the v1 command set (`diff`, `diff --cached`, `status`, `apply --cached`, `restore --staged`, `commit -m`) is simple via CLI. A library pays off at tier C (blame/log) — deferred.

**Architecture:**
- Rust: new `git.rs` module with `working_tree_diff(root)`, `staged_diff(root)`, `status(root)`, `stage_hunk(root, patch)`, `unstage_hunk(root, patch)`, `commit(root, message)`. `stage_hunk` writes the hunk patch to a temp file and runs `git apply --cached < tmpfile`; `unstage_hunk` runs `git restore --staged` with the equivalent. All commands use `child_path_env()` for PATH consistency.
- Frontend: a new `DiffPane` component fetches `working_tree diff` + `staged diff`, uses `diff` (npm) to compute hunks per file, renders hunks with stage/unstage buttons. The commit box is a textarea + commit button calling `commit`. The existing `EventView` diff rendering (for agent `fileEdit` events) stays separate — agent edits still surface in the chat/diff tabs as today (D7).

### D9/D21 — Graphify MCP auto-registration
**Choice:** On project load, idempotently register Graphify's MCP server with the detected executor. Extends the existing `graphify watch` startup path (lib.rs:56-77). Project-scoped `.mcp.json` for Claude; equivalent for Codex.

**Why over manual setup or keeping the summary-injection status quo:** The differentiator is "agent has graph tools." Making the user manually configure MCP defeats it. The current shell-out + inject-bounded-summary path (integrations.rs:42-101) is the *weak* integration — the agent never touches the graph. MCP is the *strong* path Graphify already ships (`python -m graphify.serve graphify-out/graph.json`, 10 tools, stdio).

**Architecture:** `start_watcher` (lib.rs:56) gains a sibling step: after ensuring the watcher, ensure MCP registration. For Claude, write/merge a project-root `.mcp.json` pointing at the graphify MCP server command. For Codex, write the equivalent Codex MCP config. Registration is idempotent — if the config already points at graphify, do nothing. The existing summary-injection path (`run_graphify` → inject into thread) is **removed**; the GraphPane's manual run/query/path/explain UI stays for humans. The watcher stays (it keeps `graph.json` fresh for the MCP server to serve).

### D14/D15/D26 — project-settings.json with format-on-save + executor override
**Choice:** `project-settings.json` in project root, read on load with fallbacks. v1 keys: `formatOnSave` (glob → command) and `executorOverride` (`claude`|`codex`).

**Why project root over `.floo/` subdir:** One file, easy to find, gitignoreable for personal-only or committable for team-shared. Matches the `.vscode/`-adjacent mental model.

**Architecture:**
- Rust: a `settings.rs` module with `load(project_root) -> ProjectSettings` (serde with `#[serde(default)]` on each field for fallbacks). `preflight()` (executor.rs:139) and the editor save path consult it. `executorOverride` is checked before auto-detection: if set and the named executor is on PATH, use it; if set but missing, warn and fall back to auto-detect. `formatOnSave` is a `HashMap<String, String>` (glob → command); the editor save Tauri command matches the saved file's path against the globs and runs the command, surfacing output in the terminal pane or a toast.
- Frontend: a settings UI is **not** in v1 scope (the file is hand-edited). A future change can add a settings panel.

### D22 — Notes removal
**Choice:** Full removal — right-sidebar Notes tab, `create_note`/`list_notes`/`read_note`/`write_note` IPC commands, `store::create_note`/`list_notes`/`read_note`/`write_note` functions.

**Why full removal over keeping store code:** Dead code rots. The functions are small and recoverable from git. Existing `.md` notes become regular files the editor can open — the pivot's whole premise is that an editor replaces the notes substitute.

## Risks / Trade-offs

- **[CodeMirror learning curve]** CM6's state-driven extension model is genuinely different from imperative DOM editing. → Mitigation: start with a minimal config (one language + autocomplete), add languages incrementally; the textarea checkpoint (commit f8dd81d) is recoverable if CM6 blocks progress.
- **[PTY edge cases on macOS]** IME composition, focus races, resize-during-exit can take iterative debugging. → Mitigation: `portable-pty` handles OS-specific PTY allocation; xterm.js handles rendering. Risk is polish time, not architecture.
- **[Layout refactor is the biggest change]** App.tsx's three-column flex becomes a column with a resizable bottom split + drag handles. Every other feature mounts inside it. → Mitigation: D28 sequences layout first; verify the existing chat/spec-go/graphify-pane still render correctly inside the new layout before building anything on top.
- **[`.mcp.json` written into user's project]** A side effect Floo currently avoids. → Mitigation: project-scoped (not home config), gitignoreable, idempotent. Document it in the README when the change ships.
- **[Codex MCP config shape unverified]** D21 notes per-executor config differs; exact Codex shape not yet confirmed. → Mitigation: verify at apply time with a real Codex install; flagged as `> Open:` in `graphify-mcp/spec.md`.
- **[Diff pane rebuild]** Dropping `react-diff-viewer-continued` means net-new diff rendering. → Mitigation: reuse the existing `diffStyles` tokens (EventView.tsx:9-38) so the visual system carries over; the `diff` lib gives raw hunks so rendering is straightforward.
- **[Git shell-out parsing edge cases]** Binary files, renames, mode changes produce output the simple parser may not handle. → Mitigation: v1 command set is narrow; handle edge cases as encountered during apply. Defer to a Rust git library only if parsing becomes a maintenance burden.

## Migration Plan

This is a single-branch, single-user change with no deployed users (D13: personal tool, OSS planned). No phased rollout or rollback strategy is needed beyond git:

1. Implement in dependency order per D28 (layout → editor → terminal → git → graphify-MCP → settings → notes removal).
2. After each capability, verify against its spec scenarios before moving to the next.
3. The breaking change (Notes removal) is last and isolated; existing notes files remain on disk as regular files.
4. The textarea editor checkpoint (commit f8dd81d) is the rollback point if CodeMirror migration blocks.

## Open Questions

- **Codex MCP config shape** — exact format to be verified at apply time with a real Codex install (D21). Does not change the approach or task breakdown; only the contents of the config file written for Codex.
- **`formatOnSave` glob syntax** — glob vs regex. Recommendation: globs (via the `glob` crate on Rust side or a small matcher) for familiarity (`.rs$`-style regex in examples is illustrative; actual matching likely glob). Resolvable at apply time without changing specs.
