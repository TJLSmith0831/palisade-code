# Floo Network — CLAUDE.md

Cross-machine IDE shell that drives one coding agent (Claude Code or Codex) through a spec-then-build cycle. Rust + Tauri 2 backend, React 19 + TS frontend (Vite), pnpm.

## Commands (verified 2026-08-08)

- `pnpm install` — frontend deps (standalone repo, not a workspace member)
- `pnpm test` — all frontend tests (vitest, 20 files / 189 tests, ~2s)
- `npx vitest run src/__tests__/errors.test.ts` — one frontend test file
- `npx tsc --noEmit` — typecheck only; `pnpm build` = `tsc && vite build`
- `cd src-tauri && cargo test` — all Rust tests (116)
- `cd src-tauri && cargo test git::` — one Rust module's tests
- `pnpm start` (= `tauri dev`) — dev window; see run skill below before driving it

## Map

- `src/App.tsx` (~1.7k lines) — the entire IDE shell: panes, threads, chat, routing
- `src/api.ts` — typed wrapper over every Tauri IPC command
- `src-tauri/src/lib.rs` — IPC command layer; the `generate_handler!` registry is at the bottom
- `src-tauri/src/executor.rs` — executor detect/spawn, stdout JSON-line parsing for both CLIs
- `src-tauri/src/store.rs` — append-only session store under `~/.floo-network`
- `src-tauri/src/{git,terminal,integrations,settings}.rs` — git ops, PTY, Graphify+MCP wiring, `.project-settings.json`
- `src/__tests__/*` — frontend tests, one per source file; Rust tests are inline `mod tests`

## Gotchas

- **New IPC command = three edits:** the `#[tauri::command]` fn, its name in `generate_handler!` in `lib.rs`, and a wrapper in `src/api.ts`. Miss the third and the frontend silently can't call it.
- **No headless mode.** Playwright can't drive this (WKWebView, not Chromium). Use the Tauri MCP against the debug-only bridge on `127.0.0.1:9223`.
- **Executor resolution:** `.project-settings.json`'s `executorOverride` wins; otherwise PATH detection, preferring `claude` over `codex`. Neither found → chat-only, `/go` disabled.
- **Preflight checks user-level installs**, not repo files: `~/.claude/skills/grill-apply` (or `~/.agents/...` for Codex) and the Ponytail plugin. Missing ones surface as warnings, not errors.
- **Graphify runs against the active project, never this repo**, in its own process; output lands in that project's `graphify-out/`.
- **Session history is append-only.** Never mutate past messages; truncate by copying forward.
- **`.agents/` and `.claude/` are gitignored** — in-repo skills exist locally but aren't committed.
- **Two modes only** (spec / go). They share the detected executor and differ by its permission flag (`--permission-mode` / `--sandbox`) and skill focus — not by model. No third mode.

## Do not touch

- Generated: `node_modules/`, `dist/`, `src-tauri/target/`, `src-tauri/gen/schemas`, `graphify-out/`
- Machine-local and gitignored: `.mcp.json`, `.project-settings.json` (the app rewrites these)

## Operating rules

- Read before writing: trace the real flow before editing; grep callers before changing a shared function.
- Reuse before writing: search for an existing helper/pattern in this repo before adding one. Match local idiom over general best practice.
- Shortest working diff: no speculative abstractions, no unrequested refactors, no drive-by cleanups. One concern per change.
- Targeted reads: open the specific files/sections you need, not whole directories. Search first, read second.
- Scoped verification: run the narrowest check that proves the change (single test file > full suite) — then the full gate only before done.
- Claim only what you ran: "done" means executed and observed. If not run, say "not run".
- When a task is ambiguous, state your assumption in one line and proceed; don't build both interpretations.
- **UI components only:** Use Mantine components and Tabler icons exclusively. No custom CSS components or inline SVGs unless absolutely necessary.

## Pointers

- Running/screenshotting/driving the app: `.agents/skills/run-floo-network/SKILL.md`
- Packaging + per-machine codesigning: `AGENTS.md`
- Product intent and positioning: `PRODUCT.md`
- Changes in flight and their decision logs: `openspec/changes/`
