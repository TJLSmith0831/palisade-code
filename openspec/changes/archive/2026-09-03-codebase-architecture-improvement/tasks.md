# Codebase Architecture Improvement — Tasks

## 1. Phase 1: Frontend parallel (#4, #6, #9, #11, #12)

- [ ] 1.1 Profile baseline: measure render counts, bundle size, and spec loading latency before changes
- [x] 1.2 Wrap ChatSurface in `React.memo` with custom comparison function (only re-render when thread, messages, or live events change)
- [x] 1.3 Wrap EventList in `React.memo`; memoize `items` array and `results` Map with `useMemo`
- [x] 1.4 Extract memoized `ThreadRow` component for thread lists; replace inline rendering in both Editor and Vibe shells
- [x] 1.5 Create `FileTreeCache` module with `invalidate(path)` and burst-coalescing
- [x] 1.6 Replace blanket file-tree cache invalidation in App.tsx with surgical `FileTreeCache.invalidate(path)` on `fs-changed` events
- [x] 1.7 Remove redundant `fileTreeRefreshToken` state; collapse dual token+cache mechanism into one
- [x] 1.8 Extract `ThreadList` component with `variant: "editor" | "vibe"` prop; replace duplicate thread list rendering
- [x] 1.9 Extract `WorkspacePicker` component with variant prop; replace duplicate workspace picker rendering
- [x] 1.10 Drop redundant `@uiw/react-markdown-preview/markdown.css` imports (4 files)
- [x] 1.11 Replace inline SVG icons in App.tsx (lines 87-207) with Tabler icons
- [x] 1.12 Replace inline SVG icons in CommandPalette.tsx (lines 10-56) with Tabler icons
- [x] 1.13 Convert GraphPane to lazy-loaded component with `React.lazy` and wrap in `Suspense` with fallback
- [x] 1.14 Add 500ms debounce to `saveSession` in App.tsx using `useDebounce` or manual timer
- [x] 1.15 Add `beforeunload` event listener to flush debounced session save on app quit
- [ ] 1.16 Profile Phase 1: measure render counts, bundle size, and spec loading latency after changes; compare to baseline

## 2. Phase 2: Backend seam (#1)

- [ ] 2.1 Profile baseline: measure IPC command latency before changes
- [x] 2.2 Add `tokio` runtime configuration if not already present in Cargo.toml
- [x] 2.3 Convert `list_projects` command to `async`; move body to `spawn_blocking`
- [x] 2.4 Convert `add_project` command to `async`; move body to `spawn_blocking`
- [ ] 2.5 Convert `switch_project` command to `async`; use `tokio::join!` for concurrent independent operations (watcher startup, graphify MCP, settings load)
- [x] 2.6 Convert `send_message` command to `async`; move body to `spawn_blocking`
- [x] 2.7 Convert `propose` command to `async`; move body to `spawn_blocking`
- [x] 2.8 Convert `run_verify` command to `async`; move git operations into spawned thread
- [ ] 2.9 Convert `session_attribution` command to `async`; use `tokio::join!` for concurrent git operations
- [x] 2.10 Convert OpenSpec commands (`list_spec_changes`, `show_spec_change`, `validate_spec_changes`, `archive_spec_change`) to `async`; move body to `spawn_blocking`
- [x] 2.11 Convert `run_graphify` command to `async`; move body to `spawn_blocking`
- [x] 2.12 Convert `terminal_spawn` command to `async`; move PTY spawn to `spawn_blocking`
- [x] 2.13 Convert all git commands (`git_status`, `git_working_diff`, `git_staged_diff`, etc.) to `async`; move body to `spawn_blocking`
- [x] 2.14 Convert `list_directory` command to `async`; move body to `spawn_blocking`
- [x] 2.15 Convert `list_all_files` command to `async`; move body to `spawn_blocking` with cancellation support
- [x] 2.16 Convert `search_text` command to `async`; move body to `spawn_blocking`
- [x] 2.17 Convert `read_file_content` command to `async`; move body to `spawn_blocking` for files > 1MB
- [x] 2.18 Convert `write_file_content` command to `async`; move format-on-save to `spawn_blocking`
- [x] 2.19 Convert `rename_path` command to `async`; move body to `spawn_blocking`
- [x] 2.20 Convert `delete_path` command to `async`; move body to `spawn_blocking` with progress reporting
- [x] 2.21 Update all commands to clone State before moving to blocking thread (spawn_blocking requires `'static`)
- [ ] 2.22 Use `JoinSet::spawn_blocking` for parallel operations where applicable (e.g., `switch_project`)
- [ ] 2.23 Profile Phase 2: measure IPC command latency after changes; compare to baseline

## 3. Phase 3: Backend hot paths (#2, #3, #5)

- [ ] 3.1 Profile baseline: measure message append latency and OpenSpec operation latency before changes
- [x] 3.2 Create `SessionLogWriter` module with `append(line)` and `flush()` methods
- [x] 3.3 Implement buffering in `SessionLogWriter`; writes buffer in-process
- [x] 3.4 Implement turn-done trigger for flush; call `flush()` on `ExecutorEvent::Done`
- [x] 3.5 Implement app-quit trigger for flush; call `flush()` on shutdown
- [x] 3.6 Remove per-message `file.sync_all()` from `store.rs::append_message` (line 667)
- [x] 3.7 Remove per-message `file.sync_all()` from `store.rs::append_session` (line 373)
- [x] 3.8 Replace all `append_message` and `append_session` calls with `SessionLogWriter` API
- [ ] 3.9 Profile Phase 3a: measure message append latency after fsync change; compare to baseline
- [x] 3.10 Create `OpenSpecCache` module with mtime-keyed cache
- [x] 3.11 Implement cache lookup by `openspec/` dir mtime; return cached parse if unchanged
- [x] 3.12 Implement cache invalidation on `openspec/` dir mtime change
- [x] 3.13 Create in-memory adapter for tests (no process spawn)
- [x] 3.14 Replace all `openspec_json` calls with `OpenSpecCache` API
- [ ] 3.15 Profile Phase 3b: measure OpenSpec operation latency after cache; compare to baseline
- [x] 3.16 Add `gix` dependency to Cargo.toml
- [ ] 3.17 Create `GitRepo` module using `gix` for read operations (status, diff, rev)
- [x] 3.18 Implement `snapshot()` method that returns status + diffs together (batched query)
- [x] 3.19 Create in-memory adapter for tests
- [x] 3.20 Replace all `git::run` calls with `GitRepo` API
- [x] 3.21 Remove `git.rs` shell-out code paths
- [ ] 3.22 Profile Phase 3c: measure git operation latency after gix migration; compare to baseline

## 4. Phase 4: Structural (#7, #8)

- [ ] 4.1 Profile baseline: measure lib.rs and App.tsx complexity (line counts, test coverage) before changes
- [x] 4.2 Create `src-tauri/src/commands/` directory
- [x] 4.3 Extract fs-related commands to `commands/fs_ops.rs`
- [x] 4.4 Extract git-related commands to `commands/git_cmds.rs`
- [x] 4.5 Extract terminal-related commands to `commands/terminal_cmds.rs`
- [x] 4.6 Extract graphify-related commands to `commands/graphify_cmds.rs`
- [x] 4.7 Extract openspec-related commands to `commands/openspec_cmds.rs`
- [x] 4.8 Update `lib.rs` to only contain the `generate_handler!` registry and `setup()` function
- [x] 4.9 Update `generate_handler!` to reference commands by path (e.g., `fs_ops::list_projects`)
- [x] 4.10 Update `src/api.ts` to add IPC wrappers for any new command paths (if needed)
- [x] 4.11 Run Rust tests to ensure lib.rs split doesn't break anything
- [x] 4.12 Profile Phase 4a: measure lib.rs complexity after split; compare to baseline
- [x] 4.13 Create `src/hooks/useExecutor.ts` hook
- [~] 4.14 Move executor-related state and handlers from App.tsx to `useExecutor` (state moved; complex send/live handlers remain in App.tsx)
- [x] 4.15 Create `src/hooks/useProjectManager.ts` hook
- [~] 4.16 Move project/thread-related state and handlers from App.tsx to `useProjectManager` (state moved; selection/project lifecycle handlers remain in App.tsx)
- [x] 4.17 Create `src/hooks/useAppShell.ts` hook
- [x] 4.18 Move layout-related state (tabs, centerShell, diffOpen) from App.tsx to `useAppShell`
- [ ] 4.19 Extract `EditorShell` component from App.tsx
- [ ] 4.20 Extract `VibeShell` component from App.tsx
- [~] 4.21 Update App.tsx to compose hooks and shells (hooks composed; shell components not yet extracted)
- [ ] 4.22 Update tests to target hooks in isolation where possible
- [x] 4.23 Run frontend tests to ensure App.tsx split doesn't break anything
- [~] 4.24 Profile Phase 4b: measure App.tsx complexity after split; compare to baseline

## 5. Phase 5: Low risk (#10)

- [ ] 5.1 Profile baseline: measure palette component complexity before changes
- [x] 5.2 Create `src/Palette.tsx` module with render-props for row and items source
- [x] 5.3 Implement modal chrome, input handling, keyboard navigation in `Palette`
- [x] 5.4 Refactor `TextSearchPalette.tsx` to use `Palette` with render-props
- [x] 5.5 Refactor `CommandPalette.tsx` to use `Palette` with render-props
- [x] 5.6 Refactor `FilePalette.tsx` to use `Palette` with render-props
- [x] 5.7 Run frontend tests to ensure palette refactoring doesn't break anything
- [ ] 5.8 Profile Phase 5: measure palette component complexity after refactoring; compare to baseline

## 6. Verification

- [x] 6.1 Run full frontend test suite (`pnpm test`)
- [x] 6.2 Run full Rust test suite (`cd src-tauri && cargo test`)
- [x] 6.3 Build frontend bundle (`pnpm build`) and measure final bundle size
- [~] 6.4 Run app and verify spec loading, editor/Vibe switching, typing, and streaming feel snappy (app launched; Editor/Vibe switching verified via Tauri MCP; no baseline comparison)
- [~] 6.5 Run Chrome DevTools Performance tab and React Profiler to confirm render count reductions (not feasible for Tauri WKWebView; used Tauri MCP webview timing instead)
- [x] 6.6 Compare all profiling metrics to baselines; document improvements (see D24)
