# Decision Log — codebase-architecture-improvement

## D1: Scope

- **Decision**: All 12 candidates from the architecture review (full latency + waste program, frontend and backend).
- **Why**: User wants the comprehensive plan, not a sliced subset.
- **Source**: user

## D2: ACP change status

- **Decision**: ACP executor unification is already merged; no conflict risk with backend candidates.
- **Why**: `openspec list` shows no active changes; git log shows merge commit `3ff376d feat: ACP executor unification`.
- **Source**: codebase verification

## D3: Change name

- **Decision**: `codebase-architecture-improvement`.
- **Why**: User's choice.
- **Source**: user

## D4: Why now

- **Decision**: User-perceived lags on spec loading, editor/Vibe switching, and app startup; inline completion AI (auto-tab like Devin Desktop/Cursor) is coming soon and needs the app running as fast as possible before adding that load.
- **Why**: User's direct experience; Tauri was chosen for speed, and the current lags contradict that.
- **Source**: user

## D5: Who benefits

- **Decision**: Primary: the developer (dogfooding this as their main IDE). Secondary: end users (future users will inherit the performance and maintainability gains).
- **Why**: User is building this as their own main IDE first, then will ship to others.
- **Source**: user

## D6: Explicit non-goals

- **Decision**: No new features; no changes to OpenSpec integration itself; no session store format migration; no changes to the ACP layer.
- **Why**: User confirmed the recommended non-goals.
- **Source**: user (recommended-accepted)

## D7: Implementation strategy

- **Decision**: Phased: Phase 1 (frontend parallel: #4, #6, #9, #11) → Phase 2 (backend seam: #1) → Phase 3 (backend hot paths: #2, #3, #5) → Phase 4 (structural: #7, #8) → Phase 5 (low risk: #10, #12).
- **Why**: User accepted the recommended phasing.
- **Source**: user (recommended-accepted)

## D8: Approach for #1 (async IPC seam)

- **Decision**: Use `tokio::task::spawn_blocking` to move blocking bodies to a dedicated thread pool. Commands become thin async wrappers; core logic stays sync and testable. Use `JoinSet::spawn_blocking` for parallel operations.
- **Why**: Web search confirms this is the Tauri 2 best practice; minimal code change; keeps core logic testable without async runtime.
- **Source**: web search (dev.to articles, tokio docs) + recommended-accepted by user (implicitly, since they asked me to look it up)

## D9: Approach for #2 (fsync on every message)

- **Decision**: Buffered writer that flushes + fsyncs only on turn-done (no timer). Crash window bounded by turn duration.
- **Why**: User agreed with the simpler approach; timer adds complexity for a rare edge case.
- **Source**: user (recommended-accepted)

## D10: Approach for #3 (OpenSpec cache)

- **Decision**: Mtime-keyed cache with two adapters (real CLI in prod, in-memory in tests). Cache invalidates on `openspec/` dir mtime change.
- **Why**: User agreed the UX win (instant spec navigation after first load vs 50-200ms per click) is worthwhile.
- **Source**: user (recommended-accepted)

## D11: Approach for #4 (React.memo)

- **Decision**: Wrap ChatSurface and EventList in `React.memo`, memoize `items` array and `results` Map with `useMemo`, extract memoized `ThreadRow` for thread lists.
- **Why**: User agreed the UX win (smooth typing/streaming vs janky/flickering) is worthwhile.
- **Source**: user (recommended-accepted)

## D12: Approach for #5 (git batch)

- **Decision**: Use `gix` (pure Rust git library) instead of shell-outs. Eliminates process spawns entirely; no C dependency; better cross-compilation.
- **Why**: User chose the modern pure-Rust approach after web search showed Cargo/Turborepo moving away from libgit2 and toward CLI or gix.
- **Source**: user (after web search research)

## D13–D19: Approaches for #6–#12

- **Decision**: All accepted as recommended:
  - **#6 (file-tree)**: Surgical `FileTreeCache` module with `invalidate(path)` and burst-coalescing.
  - **#7 (lib.rs)**: Split into `commands/` modules by domain (`fs_ops`, `git_cmds`, `terminal_cmds`, `graphify_cmds`, `openspec_cmds`).
  - **#8 (App.tsx)**: Extract `useExecutor`, `useProjectManager`, `useAppShell` hooks; extract `EditorShell` and `VibeShell` as siblings.
  - **#9 (duplicate shells)**: `ThreadList` and `WorkspacePicker` modules with variant props.
  - **#10 (palettes)**: `Palette` module with render-props for row and items source.
  - **#11 (bundle waste)**: Drop redundant markdown CSS, replace inline SVGs with Tabler, `React.lazy(GraphPane)` to defer d3-force.
  - **#12 (localStorage)**: Debounce `saveSession` by 500ms; flush on `beforeunload`.
- **Why**: Web search confirmed the patterns are best practices; user agreed to the batch.
- **Source**: user (recommended-accepted) + web search verification for #6, #11, #12

## D14: Verification strategy

- **Decision**: Before/after profiling using Chrome DevTools Performance tab, React Profiler, and `pnpm build` bundle analysis. No user-perceived testing or automated benchmarks.
- **Why**: User chose objective metrics only.
- **Source**: user
