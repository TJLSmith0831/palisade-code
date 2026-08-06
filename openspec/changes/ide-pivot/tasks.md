## 1. Layout refactor (riskiest first — everything mounts inside it)

- [x] 1.1 Add a `useResizable` hook (pointer drag → width/height state → persist on pointer-up) with localStorage per-project (`floo:layout:<hash>`)
- [x] 1.2 Refactor `App.tsx` three-column flex: add drag handles to left and right sidebar borders; widths read from/hydrated by the hook
- [x] 1.3 Add a vertical split in the center column with a drag handle for the bottom terminal panel region (panel content mounts in task 3; for now it's an empty resizable slot)
- [x] 1.4 Wire the existing `⌘\` / `⌘J` collapse shortcuts to the new resizable layout (collapse = width 0 or flag; restore = persisted width)
- [x] 1.5 Verify chat / spec-go / GraphPane / file tree still render correctly inside the new layout (no behavior change, only structure)
- [x] 1.6 Add a frontend test that layout widths persist across remount and that collapse/restore works

## 2. CodeMirror 6 editor migration

- [ ] 2.1 Add `@codemirror/*` dependencies: `codemirror`, `@codemirror/state`, `@codemirror/view`, `@codemirror/autocomplete`, `@codemirror/commands`, and language packages (`lang-rust`, `lang-javascript`, `lang-python`, `lang-go`, `lang-json`, `lang-markdown`, `lang-css`)
- [ ] 2.2 Rewrite `FileEditorPane.tsx` as a thin React wrapper around a CM6 `EditorState` + `EditorView`; select language extension by file extension; plain-text fallback for unrecognized types
- [ ] 2.3 Wire `@codemirror/autocomplete` with a document-word completion source (the seam for a future FIM provider — no FIM implementation)
- [ ] 2.4 Wire save (`⌘S` + Save button) to the existing `write_file_content` IPC; derive dirty state from CM6 `docChanged` transactions; show "Save *" dirty indicator
- [ ] 2.5 Verify viewport virtualization handles multi-thousand-line files without UI freeze
- [ ] 2.6 Update `FileEditorPane.test.tsx` to cover: open from tree, open via palette (once palette exists in task 5), edit + save, dirty indicator, unrecognized file type as plain text, autocomplete trigger + dismiss
- [ ] 2.7 Remove the textarea checkpoint's CSS classes that are no longer used (`.ds-code-textarea` etc.); keep any reused by the CM6 wrapper

## 3. PTY terminal

- [ ] 3.1 Add `portable-pty` to `src-tauri/Cargo.toml`
- [ ] 3.2 Create a `terminal.rs` module: `Terminal` struct owning a `PtyPair`; `spawn(project_root)` launches `$SHELL` (fallback `/bin/zsh`) with `child_path_env()` for PATH; holds the writer for input
- [ ] 3.3 Add Tauri commands: `terminal_spawn`, `terminal_input(bytes)`, `terminal_resize(cols, rows)`, `terminal_kill`; emit `terminal-output` events for PTY stdout/stderr
- [ ] 3.4 Wire terminal lifecycle to project switch (kill old, spawn new) and app shutdown
- [ ] 3.5 Add `xterm.js` dependency; create a `TerminalPane.tsx` component that mounts an xterm `Terminal`, subscribes to `terminal-output`, sends input via `terminal_input`, forwards resize to `terminal_resize`
- [ ] 3.6 Mount `TerminalPane` in the bottom panel (default) with a toggle control to move it to the right sidebar
- [ ] 3.7 Verify: interactive TUI (`vim`, `top`), ANSI colors, Ctrl-C interrupt, Tab completion, resize redraws TUI apps
- [ ] 3.8 Add a frontend test for the terminal placement toggle (bottom ↔ sidebar) and single-instance re-attach

## 4. Git diff + hunk staging

- [ ] 4.1 Add the `diff` npm dependency; remove `react-diff-viewer-continued`
- [ ] 4.2 Create a `git.rs` Rust module: `working_tree_diff(root)`, `staged_diff(root)`, `status(root)`, `stage_hunk(root, patch)`, `unstage_hunk(root, patch)`, `commit(root, message)` — all shell out to `git` with `child_path_env()`
- [ ] 4.3 Register the git Tauri commands in `lib.rs`; handle "git not on PATH" with a clear error
- [ ] 4.4 Create a `DiffPane.tsx` component: fetch working-tree + staged diffs, use `diff` (npm) to compute hunks per file, render with the existing Dragon Fire `diffStyles` tokens (EventView.tsx:9-38)
- [ ] 4.5 Add per-hunk stage/unstage controls; reconstruct hunk patches and call `stage_hunk`/`unstage_hunk`; add a "stage all" control per file
- [ ] 4.6 Add a commit box (textarea + commit button) calling `commit`; refuse on empty message or nothing staged
- [ ] 4.7 Mount `DiffPane` in the diff tab (replacing the current `react-diff-viewer-continued` usage for working-tree review; agent `fileEdit` events in chat/diff tabs stay via `EventView` per D7)
- [ ] 4.8 Verify: view uncommitted changes, stage/unstage individual hunks, commit staged changes, empty-state when clean, git-missing error
- [ ] 4.9 Add tests: hunk stage/unstage round-trip, commit refuses on empty message / nothing staged, empty state

## 5. Fuzzy file-open palette

- [ ] 5.1 Add a `FilePalette.tsx` component: `⌘P` trigger, text input, fuzzy-match against project file paths, keyboard + mouse selection, Escape to dismiss
- [ ] 5.2 Build the file list source — reuse `list_directory` recursively on first open (cached) or add a `list_all_files` Tauri command that walks the project root (respecting `.gitignore` basics)
- [ ] 5.3 Wire palette selection to open the file in the editor (same path as file-tree selection)
- [ ] 5.4 Verify: `⌘P` opens palette, fuzzy match ranks results, selection opens file, Escape dismisses
- [ ] 5.5 Add a test for palette open/select/dismiss

## 6. Graphify MCP auto-registration

- [ ] 6.1 Extend `start_watcher` (lib.rs:56) or add a sibling `ensure_graphify_mcp` step on project load: if `graphify` is on PATH, register its MCP server with the detected executor
- [ ] 6.2 Implement Claude registration: write/merge a project-root `.mcp.json` pointing at `python -m graphify.serve graphify-out/graph.json` (stdio); idempotent (no-op if already registered)
- [ ] 6.3 Implement Codex registration: write the equivalent Codex MCP config (verify exact shape against a real Codex install at apply time — Open question D21)
- [ ] 6.4 Remove the existing summary-injection path (`run_graphify` → inject into thread in integrations.rs); keep the GraphPane manual run/query/path/explain UI for humans
- [ ] 6.5 Verify: agent turn can call graph tools; GraphPane still works unchanged; idempotent re-registration; graphify-missing skips cleanly
- [ ] 6.6 Add a test for the idempotent registration (register twice = one config entry)

## 7. project-settings.json

- [ ] 7.1 Create a `settings.rs` module: `load(project_root) -> ProjectSettings` with `#[serde(default)]` on all fields; `formatOnSave: HashMap<String, String>`, `executorOverride: Option<Kind>`; handle malformed JSON with a non-fatal warning + defaults
- [ ] 7.2 Wire `executorOverride` into `selected_executor` (lib.rs:216) — checked before auto-detection; warn + fall back if override names an executor not on PATH
- [ ] 7.3 Wire `formatOnSave` into the editor save path — match saved file path against globs, run the matched command, surface output in the terminal pane or a toast
- [ ] 7.4 Read `project-settings.json` from project root on `switch_project` (lib.rs:43)
- [ ] 7.5 Verify: settings present → applied; absent → defaults; malformed → warning + defaults; override to missing executor → warning + auto-detect; format-on-save runs + output surfaces; gitignoreable
- [ ] 7.6 Add tests: load with all fields, load with empty file, load with malformed JSON, override resolution (set/missing/fallback), format-on-save glob match + no-match

## 8. Notes removal (last, isolated)

- [ ] 8.1 Remove the Notes UI from the right sidebar (tab + related state/handlers in `App.tsx`)
- [ ] 8.2 Remove `create_note`/`list_notes`/`read_note`/`write_note` Tauri commands from `lib.rs` and their registrations in the invoke handler
- [ ] 8.3 Remove `store::create_note`/`list_notes`/`read_note`/`write_note` and the `project_root` helper if it becomes unused (check other callers first — it's used by `write_file_content`)
- [ ] 8.4 Remove the `api.ts` note functions and any note-related tests
- [ ] 8.5 Verify existing `.md` note files in projects remain openable as regular files in the editor
- [ ] 8.6 Run `pnpm build` and `cd src-tauri && cargo test` to confirm no dangling references
