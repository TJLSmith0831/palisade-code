# Codebase Architecture Improvement

## Why

User-perceived lags on spec loading, editor/Vibe switching, and app startup contradict Tauri's speed promise. Inline completion AI (auto-tab like Devin Desktop/Cursor) is coming soon and needs the app running as fast as possible before adding that load.

## What Changes

- **Frontend render-path latency**:
  - Wrap ChatSurface and EventList in `React.memo`; memoize `items` array and `results` Map with `useMemo`; extract memoized `ThreadRow` for thread lists.
  - Surgical file-tree cache with `invalidate(path)` and burst-coalescing instead of blanket cache wipe on every `fs-changed` event.
  - Collapse duplicate Editor/Vibe rendering: extract `ThreadList` and `WorkspacePicker` modules with variant props.
  - Trim bundle waste: drop redundant markdown CSS, replace inline SVGs with Tabler icons, `React.lazy(GraphPane)` to defer d3-force.
  - Debounce `saveSession` by 500ms; flush on `beforeunload`.

- **Backend latency**:
  - Draw async seam under every Tauri command: make commands `async` and move blocking bodies onto `tokio::task::spawn_blocking`. Use `JoinSet::spawn_blocking` for parallel operations.
  - Buffered session-log writer that flushes + fsyncs only on turn-done (no timer), replacing per-message fsync.
  - Mtime-keyed OpenSpec cache with two adapters (real CLI in prod, in-memory in tests).
  - Replace git shell-outs with `gix` (pure Rust git library) to eliminate process spawns.

- **Structural waste**:
  - Split lib.rs (2214 lines) into `commands/` modules by domain (`fs_ops`, `git_cmds`, `terminal_cmds`, `graphify_cmds`, `openspec_cmds`).
  - Split App.tsx (3428 lines, 30+ `useState`) into `useExecutor`, `useProjectManager`, `useAppShell` hooks and `EditorShell`/`VibeShell` components.
  - Extract shared `Palette` module with render-props for the three palettes (TextSearch, Command, File).

## Capabilities

_None — this is a performance/waste change with no spec-level behavior changes._

## Impact

- **Frontend**: React 19 + Vite, no new dependencies. Bundle size reduced via lazy-loading and deduplication.
- **Backend**: Rust + Tauri 2. New dependency: `gix` (pure Rust git library). Removal: git shell-out code paths.
- **No spec changes**: Behavior unchanged; only latency and code organization improve.
