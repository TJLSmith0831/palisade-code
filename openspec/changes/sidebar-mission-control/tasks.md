## 1. Backend: worktree lifecycle

- [x] 1.1 Add `worktree_path` / `worktree_branch` (`Option<String>`) to thread metadata struct and its serialization (`store.rs`)
- [x] 1.2 Add `create_worktree(project_root, thread_id) -> Result<(path, branch)>` helper in `git.rs`/`git_repo.rs`, running `git worktree add -b palisade/<short-id> <project>/.git/palisade-worktrees/<thread-id>`
- [x] 1.3 Add `remove_worktree(path)` helper in `git.rs`/`git_repo.rs`, running `git worktree remove`
- [x] 1.4 In `start_session` (`lib.rs`), before spawning: if thread has no recorded worktree and project root is a git repo, call `create_worktree`, persist the result on thread metadata, and use it as the session's cwd; on failure, log a warning and fall back to project root
- [x] 1.5 If thread already has a recorded worktree path, use it directly as session cwd without re-creating
- [x] 1.6 Remove `collision_warning` and its call site/event (`lib.rs`)
- [x] 1.7 Wire worktree removal into thread deletion path: call `remove_worktree` when a thread with a recorded worktree is deleted
- [x] 1.8 Rust tests: worktree created on first session, reused on second; deletion removes it; non-git project falls back without warning; two threads in one project get distinct worktrees

## 2. Backend: diff stat + branch surfaced in status

- [x] 2.1 Add `git::diff_stat(bin, root) -> (added, removed)` counting tracked edits via `--numstat` plus untracked files as additions
- [x] 2.2 Add a thread-keyed `thread_worktrees(project_hash)` IPC command returning `{threadId, branch, added, removed}` per thread that has a worktree.
      **Deviation from plan:** originally scoped onto `SessionStatus`/`executor_status`. That command returns only *live sessions* and is called on prefs-menu open, never polled — so a thread's diff stat would disappear the moment its session ended, which is exactly when it matters. Keyed by thread instead; serves both the sidebar and the chat header from one call.

## 3. Backend: agent-generated thread titles

- [x] 3.1 Add `title_source: "manual" | "auto"` field to thread metadata, defaulting existing threads to `"manual"` (no destructive rename)
- [x] 3.2 Generate the title with the **bundled local Qwen model** (`CompletionServer::title`, the same sidecar inline completion uses) on the thread's first turn; trimming the prompt (`store::derive_title`) is the fallback when the sidecar isn't warm. Verified live: "add a due date field to each todo" → "Add due date field".
- [x] 3.3 Manual rename (existing IPC path) sets `title_source: "manual"` so auto-generation never overwrites it afterward

## 4. Frontend: IPC wiring

- [x] 4.1 Add `WorktreeStatus` type + `threadWorktrees()` wrapper in `src/api.ts`; extend `ThreadMeta` with `worktreePath`/`worktreeBranch`/`titleSource`
- [x] 4.2 Load worktrees in `App.tsx` as a `Map<threadId, WorktreeStatus>`, polled every 4s only while a thread is busy (kept out of `useExecutor.ts` — that hook holds event-driven state, this is a fetch)

## 5. Frontend: sidebar row (Variant A)

- [x] 5.1 Replace the single accent dot in `SessionList.tsx` with a 3-state status dot (idle / running / attention), driven by `busy` + turn outcome
- [x] 5.2 Add diff-stat text (`+N -M`) next to the row title when `diffStat` is present
- [x] 5.3 Add a sparkle marker next to auto-generated titles (`title_source === "auto"`); no marker for manual titles
- [x] 5.4 Keep rename/archive icon buttons, hover-revealed, unchanged behavior
- [x] 5.5 Add a branch line under the row (mono font) when `branch` is present

## 6. Frontend: chat shell (window 3: branch pill + status strip)

- [x] 6.1 Add a branch pill to the open thread's chat header, reading `branch` for the active session
- [x] 6.2 Add a status strip above the composer showing live `diffStat` and a "View diff" link
- [x] 6.3 Wire "View diff" to open the existing `DiffPane` scoped to the thread's worktree path
- [x] 6.4 Hide branch pill / status strip entirely when the thread has no worktree (non-git project fallback)

## 8. Diff review in the code area (added mid-implementation, at user request)

- [x] 8.1 Add `pairRows` + per-side line numbers to `diffLines.ts`; a removed run zips against the added run that replaces it
- [x] 8.2 Add a `view` prop to `DiffRows.tsx` rendering either unified rows or a two-column grid
- [x] 8.3 Add an Inline / Side by Side `SegmentedControl` to `DiffPane.tsx`, persisted in localStorage
- [x] 8.4 Add optional `threadId` to `git_status` / `git_working_diff` / `git_staged_diff` so reads target a thread's worktree; writes stay on the project root
- [x] 8.5 Make `DiffPane` read-only when a `threadId` is set (no stage/unstage/discard)
- [x] 8.6 Auto-open the diff in the code area on the idle→busy edge in Vibe; stays closed if the user closes it mid-turn
- [x] 8.7 Bump the diff refresh token on the worktree poll so the diff follows the agent's edits live

## 7. Verification

- [x] 7.1 `cd src-tauri && cargo test` — full Rust suite green, including new worktree/title/diff-stat tests
- [x] 7.2 `pnpm test` — full frontend suite green
- [x] 7.3 Manual: start two threads in the same project, confirm distinct worktrees/branches, distinct diff stats, no collision warning anywhere
- [x] 7.4 Manual: archive a thread with uncommitted worktree changes, confirm worktree persists on disk; delete a different thread, confirm its worktree is removed (`git worktree list` no longer shows it)
