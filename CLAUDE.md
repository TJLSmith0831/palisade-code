# Palisade Code — CLAUDE.md

Cross-machine IDE shell that drives coding agents (Claude Code or Codex) through a spec-then-build cycle. Sessions are concurrent: a thread can hold more than one, and two threads can run at once. Rust + Tauri 2 backend, React 19 + TS frontend (Vite), pnpm.

## Commands (verified 2026-09-25)

- `pnpm install` — frontend deps (standalone repo, not a workspace member)
- `pnpm test` — all frontend tests (vitest, 92 files / 1,475 tests, ~65s)
- `npx vitest run src/__tests__/errors.test.ts` — one frontend test file
- `npx tsc --noEmit` — typecheck only; `pnpm build` = `tsc && vite build`
- `cd src-tauri && cargo test` — all Rust tests (860: 859 pass, 1 ignored, ~7s after build)
- `cd src-tauri && cargo test git::` — one Rust module's tests
- `pnpm start` (= `tauri dev`) — dev window; see run skill below before driving it

## Map

- `src/App.tsx` (~7.3k lines) — the entire IDE shell: panes, threads, chat, routing. `src/App.css` is ~5.9k lines; `src-tauri/src/lib.rs` ~4.5k. Grep for the symbol and read a line range — never open one of these whole.
- `src/api.ts` — typed wrapper over every Tauri IPC command
- `src-tauri/src/lib.rs` — IPC command layer; the `generate_handler!` registry is at the bottom
- `src-tauri/src/executor.rs` — executor detect/spawn, stdout JSON-line parsing for both CLIs
- `src-tauri/src/store.rs` — append-only session store under `~/.palisade-code`
- `src-tauri/src/{git,terminal,mcp,settings}.rs` — git ops, PTY, MCP server config, `.project-settings.json`
- `src/__tests__/*` — frontend tests, one per source file; Rust tests are inline `mod tests`

## Gotchas

- **New IPC command = three edits:** the `#[tauri::command]` fn, its name in `generate_handler!` in `lib.rs`, and a wrapper in `src/api.ts`. Miss the third and the frontend silently can't call it.
- **No headless mode.** Playwright can't drive this (WKWebView, not Chromium). Use the Tauri MCP against the debug-only bridge on `127.0.0.1:9223`.
- **Agents are discovered at runtime, not compiled in.** `acp_registry.rs` fetches agent manifests from the ACP Registry (24h-cached), and every agent is spoken to over ACP (JSON-RPC 2.0 on stdio) via `acp_client.rs`/`acp_events.rs`. There is no `KNOWN_AGENTS` table and no per-agent parser — adding an agent means the registry lists it and its CLI is on PATH, not a code change. Never hardcode an agent name outside brand artwork.
- **Executor resolution** (`selected_executor` in `lib.rs`, D9/D18): the thread's own picker choice wins, then `.project-settings.json`'s `executorOverride`, then auto-detection (first installed agent from the cached registry preflight). An unknown id warns via `harness-warning` and falls back — it never drops the rest of the settings file. None installed → chat-only, `/go` disabled.
- **Thread vs Session.** A Thread owns messages, mode *intent*, and the spec link. A Session owns the process, `busy`, the agent identity, and the provider resume handle. `/go` no longer kills the spec session — a thread may hold a live spec session and a live go session at once, and `spec_mode` only sets the thread's default. Stopping is per session.
- **`ExecutorEvent::Done` ends a turn, not a session.** A session record closes `done` only when Palisade releases it idle at app quit (a thread switch keeps it alive for its auth state), `crashed`/`cancelled`/`interrupted`/`switched` otherwise. So `ended_at` is not "when the turn finished" — the Fleet board's Unreviewed band uses the newest agent message instead (`store::last_agent_activity`).
- **Every emitted event is an `Envelope{session_id, thread_id, event}`.** The frontend keys live state by session id; a bare event has nowhere to go.
- **Preflight checks user-level installs**, not repo files: `~/.claude/skills/grill-apply` (or `~/.agents/...` for Codex) and the Ponytail plugin. Missing ones surface as warnings, not errors.
- **Session history is append-only.** Never mutate past messages; truncate by copying forward.
- **`.agents/` and `.claude/` are gitignored** — in-repo skills exist locally but aren't committed.
- **Two modes only** (spec / go). They differ by permission flag (`--permission-mode` / `--sandbox`) and skill focus — not by model. No third mode.
- **OpenSpec is authoritative for specs.** Palisade shells out to `openspec list/show/validate --json` and never writes a spec file. No Palisade-computed "% complete": task checkboxes are agent self-reports and must be labeled as such.
- **Verification is the only evidence.** A spec is green because a named `verify` command exited 0 at a named commit — never because a model said so. No UI string may claim complete/satisfied/implemented on any other basis.

- **Preview is a native child webview, not an iframe** (`commands/preview_cmds.rs`, one per window, placed over the placeholder `PreviewPane` measures). Needs tauri's `unstable` feature. Once a window hosts it Tauri stops treating that window as a `WebviewWindow`: use `tauri::Window`/`Webview` args and `app.windows()`/`get_window()` — never `WebviewWindow`, `webview_windows()` or `get_webview_window()` (quit's unsaved-changes prompt and every native-menu shortcut silently broke). A native view draws above all HTML, so `nativeOverlay.ts` hides it under overlays and `hide_preview_on_reload` hides it when a frontend reloads.
- **No link may navigate Palisade's own window.** `linkRouting.ts` intercepts every `<a>` document-wide: http(s) opens in Preview, ⌘/Ctrl-click opens the default browser, relative links are swallowed. Before it, clicking a URL in an agent's message replaced the whole app with that page.
- **A native view shows a refused connection as a blank white page.** `PreviewPane` therefore calls `preview_probe` first (loopback hosts only) and shows an error with auto-retry until the server answers.
- **The Tauri MCP bridge is blind while a preview view exists** (it uses `webview_windows()`): `manage_window list` returns `[]` and JS/screenshot calls fail. Set the app up first, then drive it with OS-level input.
- **Nothing opens Preview by scraping output.** Terminal output and agent messages/tool results only feed status-bar chips (`useDevServers` → `DevServerTracker`) and ⌘-click terminal links; Preview auto-opens only for a server the Run shortcut just started. A URL becomes a chip only once `preview_probe` (a silent TCP connect, never an HTTP request — it would fill the user's server log) finds something listening, and the chip goes away when it stops answering.
- **Each project has its own preview browser** (`preview:<window>:<project>` label + `data_store_identifier`, so cookies/storage never cross projects; macOS < 14 silently shares one store). Closing the Preview tab or switching project calls `preview_close` — a merely hidden view is still a running page.
- **Preview and terminals are per window/project, not per thread.** Open tabs (Preview included) are window state and survive a thread switch; only a project switch closes them. Terminal ids are `${projectHash}:N` and spawn in the project root, not a thread's isolated worktree.
- **Terminal attach protocol:** `TerminalPane` listens first, then `terminal_spawn` returns a scrollback backlog plus an offset; live chunks below that offset are dropped. A shell that exits emits `terminal-exit` and restarts on the next key.

## Do not touch

- Generated: `node_modules/`, `dist/`, `src-tauri/target/`, `src-tauri/gen/schemas`
- Machine-local and gitignored: `.mcp.json`, `.project-settings.json` (the app rewrites these)

## Operating rules

- Read before writing: trace the real flow before editing; grep callers before changing a shared function.
- Reuse before writing: search for an existing helper/pattern in this repo before adding one. Match local idiom over general best practice.
- Shortest working diff: no speculative abstractions, no unrequested refactors, no drive-by cleanups. One concern per change.
- Targeted reads: open the specific files/sections you need, not whole directories. Search first, read second.
- Scoped verification: run the narrowest check that proves the change (single test file > full suite) — then the full gate only before done.
- Claim only what you ran: "done" means executed and observed. If not run, say "not run".
- When a task is ambiguous, state your assumption in one line and proceed; don't build both interpretations.
- **Never pattern-kill processes.** No `pkill`/`killall` — resolve the exact PID and verify its `cwd` first. Pattern-kills have twice destroyed unrelated agents' work in this repo.
- **`impeccable detect` exits `0` even when it reports findings.** Assert on its `--json` output; exit code alone is not a pass signal in CI.
- **UI components only:** Use Mantine components and Tabler icons exclusively. No custom CSS components or inline SVGs unless absolutely necessary.

## Pointers

- Running/screenshotting/driving the app: `.agents/skills/run-palisade-code/SKILL.md`
- Packaging + per-machine codesigning: `AGENTS.md`
- Product intent and positioning: `PRODUCT.md`
- Changes in flight and their decision logs: `openspec/changes/`
