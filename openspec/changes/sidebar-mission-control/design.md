## Context

Three rounds of HTML mockups were built and reviewed with the user before this change: a full "mission control" dashboard (rejected as too large — "essentially a third/fourth shell"), three minimal sidebar-row variants (user picked **Variant A**: upgraded 3-state status dot + diff stat, kept everything else unchanged), and three full-shell variants built on Variant A that only differ in where git-worktree info is shown. See proposal.md for the "why."

Today, `SessionStatus` (`src/api.ts`) carries `{id, threadId, agentId, mode, busy}` — no diff stat, no branch. Concurrent threads in one project share a single working tree; `collision_warning` (`src-tauri/src/lib.rs`) only warns, it does not isolate.

## Goals / Non-Goals

**Goals:**
- Ship the sidebar/chat UI changes (status dot, diff stat, auto-title, hover actions) as one coherent visual layer on top of real worktree data — not mock data.
- Give each thread a real, working-tree-isolated git worktree, so the diff stat and status strip reflect that thread's own uncommitted changes only.

**Non-Goals:**
- No new dashboard/grid page, no PR-review workflow, no cross-thread diff comparison — deliberately ruled out by the earlier "too far" correction.
- No worktree pooling, reuse across threads, or cleanup-on-idle policy — one worktree per thread, created once, removed on delete.
- No change to how sessions/threads/agents are modeled beyond adding a worktree path + branch to thread metadata.

## Decisions

**UI variant: ship "both + status strip" (mockup window 3).** Branch name shown as a line under the sidebar row *and* as a header pill in the open thread, plus a status strip above the composer with live diff stat and a "View diff" link into the existing `DiffPane`. Chosen over sidebar-only (window 1, isolation invisible once a thread is open) and header-only (window 2, isolation invisible from the list) because "git isolation like superset" was an explicit ask and the strip reuses `DiffPane` rather than inventing new UI. Rationale documented here since the user had not picked a specific window when this change was proposed — revisit only if user feedback says the strip is one control too many.

**Worktree layout: sibling directory keyed by thread id**, e.g. `<project>/.git/palisade-worktrees/<thread-id>` via `git worktree add -b <branch> <path>`, branch name `palisade/<thread-id-short>`. Avoids collisions with user branch names and keeps worktrees out of the visible project tree (under `.git/`, already git-ignored by definition). Alternative considered: a sibling folder next to the project root (`<project>-<thread-id>/`) — rejected because it pollutes the user's filesystem view outside the repo and complicates relative-path assumptions elsewhere in the app (file navigation, terminal cwd).

**Worktree created lazily on first session start, not on thread creation.** A thread created but never run (no session started) shouldn't leave a worktree/branch behind. Matches existing lazy-session-start pattern in `lib.rs`'s `start_session`.

**Diff stat computed against the thread's own worktree**, reusing `git.rs`'s existing status/diff plumbing (already scoped to one tree at a time — see `SourceControlPanel.tsx`/`gitDiff.ts`), just pointed at the worktree path instead of the project root.

**Auto-generated titles**: derived from the agent's own summary of the first completed turn (already available as assistant text in the transcript — no new model call). Manual rename sets a `titleSource: "manual"` flag on thread metadata so a later auto-generation pass never overwrites a user-chosen name.

**`collision_warning` is deleted, not deprecated.** Its only job was warning about a condition (shared working tree) that worktree isolation makes structurally impossible for thread-vs-thread collisions. Non-git projects still fall back to the shared project root (see `thread-worktree-isolation` spec's fallback requirement) — that residual case gets no warning either, since it was already the pre-existing behavior for non-git projects before this change.

## Risks / Trade-offs

- **Disk usage grows with thread count** (each worktree is a full checkout) → Mitigation: worktree removed on thread delete (already required by `thread-deletion` spec delta); archiving leaves it on disk deliberately (so archived-then-restored threads keep uncommitted work), documented as an accepted trade-off rather than solved here.
- **Branch/worktree name collision on restore from an older thread record** (pre-change threads have no worktree) → Mitigation: `thread-worktree-isolation`'s "first session start" requirement treats absence of a recorded worktree path as "not yet created," so old threads get one lazily on their next session, no migration script needed.
- **`git worktree add` failing mid-flight** (disk full, locked index, detached HEAD) → Mitigation: explicit fallback requirement in the spec — session still starts, in the project root, with a surfaced warning instead of a hard failure.
- **Losing the passive warning's non-git-project signal is a behavior change some users relied on** → Mitigation: none needed; the warning only ever fired for git projects, so non-git behavior is unchanged (see spec scenario "Non-git project").

## Migration Plan

- Backend: add `worktree_path` / `worktree_branch` (both `Option<String>`) to thread metadata; absent means "not yet created," no migration of existing thread files required.
- No data migration for existing threads — they gain a worktree lazily on next session start, per the "created lazily" decision above.
- Frontend and backend land together (same change); no feature flag — `SessionStatus` gains new optional fields the frontend reads once available, degrading gracefully (no diff stat / no branch pill) while a thread's worktree hasn't been created yet.
