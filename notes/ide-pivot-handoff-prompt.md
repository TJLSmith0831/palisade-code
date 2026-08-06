# Handoff prompt — Floo Network IDE pivot (grill-apply)

Copy everything below the line into Claude Code (Sonnet). Run it from the repo root (`/Users/tjlsmith0831/dev/floo-network`).

---

You are implementing the `ide-pivot` OpenSpec change in the Floo Network repo. This is a grill-apply session: the decision log is binding context.

## Before you start

1. **Stash or commit the current working-tree changes first.** There are uncommitted edits to `src/App.tsx`, `src/App.css`, `src/EventView.tsx`, `src/FileEditorPane.tsx`, `src/__tests__/App.test.tsx`, `src/__tests__/EventView.test.tsx`, `src-tauri/src/executor.rs`, and `CLAUDE.md`. Do not blow them away. Suggested: `git stash push -m "pre-ide-pivot in-flight work"` — you can recover it later. Confirm `git status` is clean before implementing.
2. **Read these files in order, completely, before writing any code:**
   - `openspec/changes/ide-pivot/decisions.md` — **binding.** 28 decisions (D1–D28). Every "why" lives here. Do not re-decide what's already decided.
   - `openspec/changes/ide-pivot/proposal.md` — what and why.
   - `openspec/changes/ide-pivot/specs/*/spec.md` — 7 capability specs. Each requirement has WHEN/THEN scenarios; these are your acceptance tests.
   - `openspec/changes/ide-pivot/design.md` — the how, with alternatives considered and architecture sketches.
   - `openspec/changes/ide-pivot/tasks.md` — 53 tasks in 8 groups, sequenced.
   - `AGENTS.md` and `CLAUDE.md` — project rules and gotchas.
3. Verify the toolchain: `pnpm install` (frontend), `cd src-tauri && cargo test` (Rust), `pnpm build` (typecheck). Fix nothing yet — just confirm they run.

## How to implement

- **One task at a time.** Mark `- [ ]` → `- [x]` in `tasks.md` as you complete each. Run `openspec status --change ide-pivot` to confirm progress.
- **Follow the task order in tasks.md.** It's sequenced per D28: layout refactor first (everything mounts inside it), then CodeMirror, then terminal, then git, then palette, then graphify-MCP, then settings, then notes removal last. Do not reorder.
- **Verify per task against its spec scenarios.** Each task's spec has WHEN/THEN scenarios — those are your done-condition. The project uses TDD (see `AGENTS.md` and global rules): write a failing test, implement, watch it pass. Frontend tests are Vitest + RTL in `src/__tests__/`; Rust tests in `src-tauri/tests/` and inline `#[cfg(test)]`.
- **Run the narrowest check that proves the task** (single test file), then the full gate before marking a group done: `pnpm build` (tsc) + `cd src-tauri && cargo test` + relevant `pnpm vitest` files.

## Grill-apply rules (binding)

- **Hitting an `> Open:` marker in an artifact** — resolve it before implementing the task it touches. One question to the user with a recommended answer, unless the codebase answers it. Log the resolution as a new D-entry in `decisions.md`, remove the marker.
- **Implementation contradicts a decision** — STOP. One question to the user with what you found and what you recommend. The outcome is an *amended* D-entry (not a silent workaround), then update the affected artifact, then the code. Log first, always.
- **Implementation forces a decision nobody made** — if it's consequential (data shape, failure behavior, API surface), ask the user with a recommendation; if trivial, decide and log with `Source: recommended-accepted`.
- **Ordinary coding choices** (names, file org, loop constructs) are not decisions. Don't bloat the log.
- **Never implement against a decision.** D14 says format-on-save only (no spec-workflow hooks) — don't add them. D7 says agent stays in the chat pane — don't build inline agent edits. D22 says full notes removal — don't leave dead store code.

## Key constraints from the decision log (read decisions.md for the full trail)

- **D3:** CodeMirror 6 (not Monaco, not textarea). Textarea checkpoint is commit `f8dd81d` — recoverable if CM6 blocks.
- **D4:** Real PTY (`portable-pty` + `xterm.js`), not a command-runner.
- **D6:** Git tier B — working-tree diff + hunk stage/unstage + commit box. No branch/blame/log.
- **D7:** Agent stays in chat pane. No inline agent-edit protocol.
- **D8:** Keep Spec/Go, OpenSpec+Grill, Graphify. Cut Notes.
- **D9:** Graphify tier C — keep GraphPane for humans + expose MCP server to the executor. Remove the existing summary-injection path.
- **D14:** Format-on-save only via `project-settings.json`. No slash commands, no spec-workflow hooks, no agent-action hooks.
- **D17:** Terminal = bottom panel (default) with toggle to right sidebar. Both sidebars drag-to-resize + collapsible.
- **D19:** Use `diff` (npm) + custom rendering. Drop `react-diff-viewer-continued`.
- **D20:** Shell out to `git` CLI. No `gix`/`git2`.
- **D21:** Auto-register Graphify MCP on project load, idempotent, project-scoped `.mcp.json` for Claude. Codex shape is an `> Open:` — verify against a real Codex install.
- **D22:** Full notes removal — UI, IPC, store functions.
- **D24:** Layout persists in localStorage (`floo:layout:<hash>`), not `project-settings.json`.
- **D25:** Keep the lazy file tree; add fuzzy `⌘P` palette.
- **D26:** `project-settings.json` in project root.
- **D27:** Commit box = message + commit only.
- **D28:** Task order is layout → editor → terminal → git → palette → graphify-MCP → settings → notes removal.

## Existing code to reuse (don't reinvent)

- `read_file_content` / `write_file_content` Tauri commands (`src-tauri/src/lib.rs`) — the editor saves via these.
- `child_path_env()` (`src-tauri/src/executor.rs:70-75`) — use for any spawned child (terminal shell, git) so it gets the login-shell PATH, not launchd's minimal one.
- `diffStyles` tokens (`src/EventView.tsx:9-38`) — reuse for the new custom diff renderer (D19).
- `start_watcher` (`src-tauri/src/lib.rs:56-77`) — extend for Graphify MCP auto-registration (D21).
- `floo_home()` (`src-tauri/src/store.rs:22-26`) — session store outside repos; don't hardcode.
- The `Harness` struct (`src-tauri/src/lib.rs`) holds one session per thread; terminal adds an analogous one-per-project owner.

## When you're done

- Run `openspec status --change ide-pivot` — should show 53/53.
- Run the full gate: `pnpm build`, `cd src-tauri && cargo test`, `pnpm vitest`.
- Show the user: tasks completed, any D-entries added or amended during implementation, and point at `/grill-archive`.
- Do not commit unless the user asks. Do not push.

## Communication style

The user has ADHD — be brief, use bullet points, one thing at a time. Don't dump walls of text. When you pause for a decision, pose one question with a recommended answer.
