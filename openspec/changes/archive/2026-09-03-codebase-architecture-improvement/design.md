# Codebase Architecture Improvement — Design

## Context

Current state: 12 latency/waste candidates identified in architecture review. ACP executor unification already merged, so no conflict with backend candidates. Project uses Rust + Tauri 2 backend, React 19 + Vite frontend. See proposal.md for motivation.

## Goals / Non-Goals

**Goals:**

- Reduce user-perceived latency on spec loading, editor/Vibe switching, app startup, typing, and streaming.
- Reduce code waste (god components, duplicate rendering, bundle bloat) to improve maintainability.
- Establish async seam for backend blocking work; establish memoization pattern for frontend render path.

**Non-Goals:**

- No new features (pure latency/waste).
- No changes to OpenSpec integration itself (the spec tab loading lags are addressed by frontend changes, not by changing how OpenSpec works).
- No session store format migration (fsync change is about how we write, not the on-disk format).
- No changes to the ACP layer (already settled from merged change).

## Decisions

### Phase 1: Frontend parallel (#4, #6, #9, #11, #12)

**#4: React.memo**

- **Decision**: Wrap ChatSurface and EventList in `React.memo`; memoize `items` array and `results` Map with `useMemo`; extract memoized `ThreadRow` for thread lists.
- **Rationale**: Zero `React.memo` anywhere in `src/` — confirmed by `grep`. ChatSurface (20+ props) and EventList re-render on every keystroke and every streamed event, causing jank. Memoization is the standard React pattern; less invasive than virtualization.
- **Alternative considered**: Virtualized list library (`react-window`). Rejected because it's more invasive and the current list sizes don't warrant it yet.

**#6: File-tree surgical invalidation**

- **Decision**: `FileTreeCache` module with `invalidate(path)` and burst-coalescing. Dual token+cache mechanism collapses into one.
- **Rationale**: Every `fs-changed` event currently wipes the whole cache + triggers full walk. React Query articles warn against "broad invalidation" and recommend targeted invalidation by path.
- **Alternative considered**: Keep blanket invalidation. Rejected because agent turns writing many files cause repeated full walks.

**#9: Duplicate Editor/Vibe rendering**

- **Decision**: Extract `ThreadList` and `WorkspacePicker` modules with variant props (`variant: "editor" | "vibe"`).
- **Rationale**: Thread lists and workspace pickers rendered twice with near-identical markup; only container differs. Deletion test: deleting one copy concentrates the markup into the other — it's a pass-through duplicate.
- **Alternative considered**: Keep duplicate rendering. Rejected because changes must be made in two places.

**#11: Bundle waste**

- **Decision**: Drop redundant markdown CSS (4 files import `@uiw/react-markdown-preview/markdown.css` alongside `@uiw/react-md-editor` which bundles its own preview CSS). Replace inline SVGs in App.tsx and CommandPalette with Tabler icons. `React.lazy(GraphPane)` to defer d3-force.
- **Rationale**: Redundant CSS adds bundle size; Tabler is already a dep; d3-force is heavy for a single feature. React docs confirm `React.lazy` + `Suspense` is the standard pattern for deferring heavy features.
- **Alternative considered**: Keep as-is. Rejected because bundle size directly affects initial load time.

**#12: localStorage debounce**

- **Decision**: Debounce `saveSession` by 500ms; flush on `beforeunload`.
- **Rationale**: ReactUse articles call out "do it on every keystroke" as the standard mistake. Author already considered this cheap, but rapid tab switching stacks sync main-thread writes.
- **Alternative considered**: Remove persistence entirely. Rejected because crash recovery is valuable.

### Phase 2: Backend seam (#1)

**#1: Async IPC seam**

- **Decision**: Make Tauri commands `async` and move blocking bodies onto `tokio::task::spawn_blocking`. Use `JoinSet::spawn_blocking` for parallel operations. Clone State before moving to blocking thread (spawn_blocking requires `'static`).
- **Rationale**: Web search confirms this is the Tauri 2 best practice. Minimal code change; keeps core logic testable without async runtime. Avoids blocking the IPC runtime thread.
- **Alternative considered**: Rewrite blocking calls to be truly async (e.g., `tokio::fs` instead of `std::fs`). Rejected because it's a larger change and the blocking pool pattern is standard.

### Phase 3: Backend hot paths (#2, #3, #5)

**#2: Buffered session-log writer**

- **Decision**: `SessionLogWriter` module that buffers writes and flushes + fsyncs only on turn-done (no timer). Crash window bounded by turn duration.
- **Rationale**: Per-message fsync (store.rs:667) causes disk barrier per streamed event. Timer adds complexity for a rare edge case.
- **Alternative considered**: Remove fsync entirely. Rejected because durability is important; turn-done flush is a reasonable compromise.

**#3: OpenSpec cache**

- **Decision**: Mtime-keyed cache with two adapters (real CLI in prod, in-memory in tests). Cache invalidates on `openspec/` dir mtime change.
- **Rationale**: Every list/show/validate spawns a process + busy-waits 25ms. Cache hit = sub-millisecond. Two adapters justify the seam.
- **Alternative considered**: Keep openspec process alive as daemon. Rejected because adds process management complexity.

**#5: Git via gix**

- **Decision**: Use `gix` (pure Rust git library) instead of shell-outs. Eliminates process spawns entirely; no C dependency; better cross-compilation.
- **Rationale**: Web search showed Cargo migrating FROM libgit2 TO CLI for fetching, and Turborepo removing git2 entirely (25s C compilation cost). `gix` is the modern pure-Rust recommendation.
- **Alternative considered**: Shell-out with batching. Rejected because `gix` eliminates process spawns entirely and is future-proof.

### Phase 4: Structural (#7, #8)

**#7: lib.rs split**

- **Decision**: Split lib.rs (2214 lines) into `commands/` modules by domain (`fs_ops`, `git_cmds`, `terminal_cmds`, `graphify_cmds`, `openspec_cmds`). lib.rs keeps only the registry + `setup()`.
- **Rationale**: Interface as wide as implementation; deletion test: deleting the file concentrates nothing. Commands become thin async wrappers after Phase 2, making the split natural.
- **Alternative considered**: Keep as god object. Rejected because violates single responsibility and hard to navigate.

**#8: App.tsx split**

- **Decision**: Extract `useExecutor`, `useProjectManager`, `useAppShell` hooks; extract `EditorShell` and `VibeShell` as siblings. App composes.
- **Rationale**: 3428 lines, 30+ `useState`. The 3537-line test file mounts the whole component, making tests slow and brittle. Hooks own state; shells own layout.
- **Alternative considered**: Keep as god component. Rejected because impossible to reason about in isolation; any change risks unrelated breakage.

### Phase 5: Low risk (#10)

**#10: Palettes**

- **Decision**: `Palette` module with render-props for row and items source. Each palette becomes a thin config.
- **Rationale**: Three palettes reimplement modal chrome, input handling, keyboard nav, and list rendering. Shared seam, but diverged enough to be speculative.
- **Alternative considered**: Keep duplicate implementations. Rejected because keyboard-nav bugs would need to be fixed in three places.

## Risks / Trade-offs

- **Risk**: `gix` is still maturing; some write paths (push) aren't ready. Palisade only needs read operations (status, diff, rev), so this is acceptable.
- **Risk**: Memoization can introduce bugs if comparison functions are wrong. Mitigation: use shallow comparison for props, deep comparison only for computed values (items, results Map).
- **Risk**: Debouncing localStorage may lose data if app crashes before flush. Mitigation: flush on `beforeunload` adds a safety net.
- **Trade-off**: Buffered fsync bounds crash window to turn duration instead of per-message. Acceptable because turns are usually seconds, not minutes.
- **Trade-off**: Surgical file-tree invalidation is more complex than blanket wipe. Acceptable because the UX win (no repeated full walks) is significant.

## Migration Plan

No migration — this is a performance/waste change with no data model changes. Phased rollout:

1. Phase 1 (frontend parallel) — deploy and verify via profiling.
2. Phase 2 (backend seam) — deploy and verify.
3. Phase 3 (backend hot paths) — deploy and verify.
4. Phase 4 (structural) — deploy and verify.
5. Phase 5 (low risk) — deploy and verify.

Rollback strategy: Each phase is independently revertable via git revert if profiling shows regression.

## Open Questions

None.
