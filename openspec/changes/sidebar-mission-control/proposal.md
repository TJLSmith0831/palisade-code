## Why

Palisade's sidebar (`SessionList.tsx`) shows one accent dot per thread with no signal for what's running, what changed, or whether it collides with another thread editing the same repo. Users must hand-name every thread, rename/archive are the only affordances, and concurrent threads share one working tree with nothing but a passive text warning (`collision_warning` in [lib.rs](../../../src-tauri/src/lib.rs)) when two sessions touch the same project. As agents run longer and more threads run at once, the list needs to carry more signal without becoming a second shell, and concurrent threads need real isolation instead of a warning label.

## What Changes

- Sidebar rows gain a 3-state status dot (idle / running / attention) and a live diff stat (`+N -M`), replacing the single static accent dot.
- Threads get an agent-generated title once the first turn completes, shown with a small marker distinguishing it from a user-set name; manual rename still overrides and persists.
- Rename and archive icon buttons are preserved as hover-revealed row actions (unchanged behavior, same icons).
- Each thread gets its own git worktree and branch, created on first session start and reused for the thread's lifetime, replacing the passive `collision_warning` text with actual isolation.
- The open thread's chat header shows its branch name; a slim status strip above the composer shows live diff stat and a "View diff" link into the existing `DiffPane`.
- The diff view gains an Inline / Side by Side toggle and per-side line numbers, and opens automatically in the code area when a turn starts — the pattern Cursor and Windsurf both use, so reading the chat and watching the code are the same activity.
- **BREAKING**: `collision_warning` is removed — two threads in the same project root no longer share a working tree, so the warning condition it detected no longer occurs.

## Capabilities

### New Capabilities
- `thread-worktree-isolation`: per-thread git worktree/branch lifecycle — creation on first session start, path resolution for session spawn cwd, and cleanup on thread archive/delete.

### Modified Capabilities
- `git-diff-review`: adds an inline/side-by-side toggle with line numbers, shows a thread's worktree diff automatically while its agent works, and makes worktree review read-only.
- `concurrent-sessions`: replaces the live-session collision warning scenario with worktree-backed isolation (no more shared working tree between threads in the same project).
- `thread-deletion`: deleting/archiving a thread must also handle its worktree (remove or detach it) so worktrees don't leak.

## Impact

- **Frontend**: `src/SessionList.tsx` (row markup, status dot, diff stat, title marker), `src/api.ts` (`SessionStatus` gains diff stat + branch fields), `src/hooks/useExecutor.ts` (surfacing per-session diff stat), chat header + composer area in `src/App.tsx`.
- **Backend**: `src-tauri/src/lib.rs` (thread creation spawns a worktree, session spawn cwd resolves to it, `collision_warning` removed), `src-tauri/src/git.rs` / `git_repo.rs` (worktree create/remove helpers), `src-tauri/src/store.rs` (persist worktree path/branch on thread metadata), thread archive/delete path (worktree cleanup).
- **No new external dependencies** — `git worktree` is invoked via the existing git command layer.
