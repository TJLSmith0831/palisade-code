# Floo Network — CLAUDE.md
Cross-machine agent orchestrator: one executor (Claude Code or Codex) drives both spec-mode (read-only/plan, grill-explore/grill-propose) and go-mode (write-enabled, grill-apply). Project threads, session history, and Graphify code maps are first-class.

## Verified facts (as of 2026-08-03)
- The harness is built with Rust + Tauri for speed and small footprint.
- The harness must run unchanged on personal (Claude Code) and work (Codex) laptops.
- The executor (Claude Code or Codex) is the only model in both modes. Spec-mode and go-mode differ by the executor's permission mode/sandbox flag and skill focus, not by model.
- Graphify maps the active project, not the harness itself.
- Browserbase provides web search; the key lives in `.env`.
- Session storage lives outside any target repo.

## Operating rules
- Read before writing: trace the real flow before editing; grep callers before changing a shared function.
- Reuse before writing: search for an existing helper/pattern in this repo before adding one. Match local idiom over general best practice.
- Shortest working diff: no speculative abstractions, no unrequested refactors, no drive-by cleanups. One concern per change.
- Targeted reads: open the specific files/sections you need, not whole directories. Search first, read second.
- Scoped verification: run the narrowest check that proves the change (single test file > full suite) — then the full gate only before done.
- Claim only what you ran: "done" means executed and observed. If not run, say "not run".
- When a task is ambiguous, state your assumption in one line and proceed; don't build both interpretations.

## Project-specific constraints
- **Two modes only:** spec-mode (default) and go-mode. No third mode in v1. Both modes use the same detected executor; they differ by the executor's permission mode/sandbox flag and skill focus, not by model.
- **Executor selection is by detection, not config.** Detect `claude` or `codex` on PATH; prefer `claude` if both are present. If neither, warn and operate in chat-only mode.
- **Project root is detected from cwd** unless overridden by `--project` or a UI picker. All notes, Graphify runs, and executor handoffs are scoped to that root.
- **Session history is append-only.** Never mutate past messages; truncate by copying forward if needed.
- **Graphify runs in its own process.** Shell out and parse output; do not embed it.
- **Tool permissions are enforced by the executor's built-in permission system** (`--permission-mode` for Claude, `--sandbox` for Codex), not a harness-side tool dispatcher. The harness can't easily intercept individual tool calls inside the executor's own loop.
- **Web search results are citations, not answers.** Pass them to the executor as context; don't render raw HTML.

## Do not touch
- `.env` files (gitignored, contain secrets)
- `node_modules/`, `dist/`, `target/`, and `src-tauri/target/` (generated)
- Session store path (configured at first run; don't hardcode)

## Pointers
- Day-level stack and gotchas: `AGENTS.md`
- Grill-spec skills and handoff protocol: `.agents/skills/grill-apply/SKILL.md` and siblings
