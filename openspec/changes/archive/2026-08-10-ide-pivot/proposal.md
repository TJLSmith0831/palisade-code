## Why

Floo Network is an agent orchestrator today, not an IDE. The pivot to an "agent-first, graph-native" IDE fills the gap between "I can talk to an agent about my code" and "I can edit, run, and commit that code without leaving the app." The motivation is Kiro's documented failures — performance lag, opaque billing, session corruption, context pollution — each of which Floo's existing architecture (Rust+Tauri, user-owned executor, append-only sessions, Socratic spec flow) already structurally avoids. Shipping the editor/terminal/git/diff surface turns that structural advantage into a usable product.

## What Changes

- **CodeMirror 6 editor** replaces the textarea-based `FileEditorPane`. Adds syntax highlighting (Rust, JS/TS, Python, Go, JSON, Markdown, CSS), `@codemirror/autocomplete`, and a completion-interface seam for a future FIM model. Existing `read_file_content`/`write_file_content` IPC reused.
- **PTY terminal pane** — real pseudo-terminal via `portable-pty` (Rust) + `xterm.js` (frontend), bytes over a Tauri channel. One terminal, `$SHELL` with `/bin/zsh` fallback. Docked as a resizable bottom panel with a toggle to move it to the right sidebar.
- **Resizable layout** — both sidebars (sessions left, codemap/terminal right) become drag-to-resize and collapsible; widths persist per-project in localStorage. Center column gains a resizable bottom split for the terminal.
- **Interactive git diff pane** — working-tree diff vs HEAD, per-hunk stage/unstage, commit box (message + commit only). Drops `react-diff-viewer-continued`; uses `diff` (npm) for hunk computation + custom rendering with existing Dragon Fire diff tokens. Git ops via shell-out to `git` CLI from Rust.
- **Fuzzy file-open palette** (`⌘P`) — the real file-navigation gesture; the existing lazy one-dir-per-IPC `FileTree` stays for browsing.
- **Graphify MCP auto-registration** — on project load, Floo idempotently registers Graphify's MCP server (10 graph tools) with the detected executor so the agent queries the code graph mid-turn. Extends the existing per-project `graphify watch` startup path. Project-scoped `.mcp.json` for Claude; equivalent for Codex.
- **`project-settings.json`** — project-root config read on load with fallbacks. v1 keys: `formatOnSave` (file-glob → shell command, runs after editor save) and `executorOverride` (force `claude`/`codex` per-project instead of machine-specific auto-detect).
- **BREAKING: Notes removed** — right-sidebar Notes tab, `create_note`/`list_notes`/`read_note`/`write_note` IPC commands, and `store::create_note`/`list_notes`/`read_note`/`write_note` functions deleted. Existing `.md` note files in projects remain on disk as regular files the editor can open.
- **Unchanged**: chat pane, Spec/Go toggle, OpenSpec+Grill skills, GraphPane (human-facing code map), append-only session store, executor abstraction.

## Capabilities

### New Capabilities
- `code-editor`: CodeMirror 6-based file editor with syntax highlighting, autocomplete, and a completion-interface seam for a future FIM model.
- `integrated-terminal`: PTY-backed terminal pane with xterm.js rendering, resizable/dockable placement, single shell instance.
- `resizable-layout`: Drag-to-resize collapsible sidebars and terminal panel with per-project persisted widths.
- `git-diff-review`: Working-tree diff vs HEAD with per-hunk stage/unstage and commit box; shell-out to git CLI.
- `file-navigation`: Fuzzy file-open palette (`⌘P`) for fast file switching; existing file tree retained for browsing.
- `graphify-mcp`: Auto-registration of Graphify's MCP server with the detected executor on project load.
- `project-settings`: Project-root `project-settings.json` with format-on-save mappings and executor override.

### Modified Capabilities
<!-- No existing specs in openspec/specs/ — this is the first change to introduce spec'd capabilities. -->

## Impact

- **Frontend**: `App.tsx` layout refactor (three-column → column with resizable bottom split + drag handles); `FileEditorPane.tsx` rewritten on CodeMirror 6; new terminal, diff, and palette components; `EventView.tsx` diff rendering moves to custom hunk-based renderer; `react-diff-viewer-continued` dependency removed.
- **Rust backend**: new `portable-pty` dependency + terminal Tauri commands; new git shell-out commands; `integrations.rs` gains Graphify MCP auto-registration alongside the existing watcher; `store.rs` notes functions removed; `executor.rs` preflight reads `executorOverride` from `project-settings.json`.
- **New dependencies**: `@codemirror/*` (editor + language packages + autocomplete), `xterm.js`, `portable-pty`, `diff` (npm). Removed: `react-diff-viewer-continued`, `@uiw/react-md-editor` usage in notes (MDEditor stays for chat/graph report).
- **Project files**: `project-settings.json` and `.mcp.json` may appear in project roots (user-gitignoreable).
- **Existing behavior preserved**: chat, Spec/Go, OpenSpec+Grill, GraphPane, session store, executor event stream.
