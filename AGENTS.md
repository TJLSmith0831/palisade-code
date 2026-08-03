# Day 23 — Floo Network — AGENTS.md
Cross-machine agent harness: one executor (Claude Code or Codex) drives both spec-mode (read-only/plan, grill-explore/grill-propose) and go-mode (write-enabled, grill-apply), keeping project threads, session history, and Graphify code maps in sync.

## Stack
Rust + Tauri · TypeScript (frontend) · pnpm · Browserbase (web search) · Graphify (code maps) · Claude Code / Codex CLI

## Commands (verified 2026-08-03)
- `pnpm install` — install frontend dependencies (run from the repo root; this day is a pnpm workspace member)
- `cd src-tauri && cargo test` — run Rust backend tests
- `pnpm start` (= `pnpm tauri dev`) — start the Tauri dev window
- `pnpm build` — typecheck (`tsc`) and build the frontend bundle
- `pnpm tauri build` — create the release binary

## Verifying UI flows
Playwright cannot drive this app: it targets Chromium/Firefox/WebKit browsers,
not the WKWebView that Tauri embeds on macOS. Use the Tauri MCP instead — the
debug-only `tauri-plugin-mcp-bridge` is registered under `cfg(debug_assertions)`
and serves a WebSocket bridge on `127.0.0.1:9223` once `pnpm start` is running,
which drives the real binary against the real Rust backend.

## Concept
Two-mode harness that moves from spec to tested code, both modes driven by the same detected executor (Claude Code or Codex). Spec-mode (default) runs the executor in a read-only/plan permission mode (`--permission-mode plan` for Claude, `--sandbox read-only` for Codex) and focuses on grill-explore / grill-propose skills, note-taking, and research — no implementation writes. Go-mode runs the executor in a write-enabled permission mode (`--permission-mode default` for Claude, `--sandbox workspace-write` for Codex) and focuses on grill-apply or direct implementation. `/go` terminates the spec-mode executor process and spawns a fresh go-mode executor with the conversation history carried forward (no summarization call — the executor already has the full thread context). Project-level detection lets one harness instance carry many threads; session history persists across restarts.

## Gotchas
- **Executor detection is machine-specific.** Personal laptop expects `claude`; work laptop expects `codex`. Detection must tolerate aliases, PATH variations, and missing executables. If both are present, prefer `claude`; if neither, warn and stay in chat-only mode.
- **Graphify maps the active project, not the harness.** Always pass the detected project root as the working directory; never run it against `day-23-floo-network/`.
- **Browserbase key lives in `.env`.** Load with `dotenv`; never commit the key or read `.env` contents into logs.
- **Session store must live outside target repos.** Default to a dotdir under the user's home (e.g. `~/.floo-network/sessions/`) so project git histories stay clean.
- **Notes are files inside the project.** The harness proposes a path under the project root; the user confirms before any write. Never create files outside the project root.
- **Two modes share the executor but differ in permission mode and skill focus.** Spec-mode runs the executor read-only/plan (`--permission-mode plan` for Claude, `--sandbox read-only` for Codex) and focuses on grill-explore/grill-propose. Go-mode runs the executor write-enabled (`--permission-mode default` for Claude, `--sandbox workspace-write` for Codex) and focuses on grill-apply. `/go` terminates the spec-mode executor and spawns a fresh go-mode executor with conversation history carried forward — no summarization call.
- **Tool permissions are enforced by the executor, not a harness dispatcher.** With a full executor CLI, the executor runs its own internal tool loop — the harness can't easily intercept individual tool calls. Enforcement shifts to the executor's built-in `--permission-mode`/`--sandbox`. The custom `create_note` approval gate and bash two-tier policy from the earlier Gemma-based design are no longer harness-side; whether they can be restored via executor-level hooks (Claude Code hooks, Codex plugins) is an open question for grill-apply.
- **Ponytail is a plugin installed inside Claude Code/Codex, not a binary the harness invokes.** It's a one-time per-machine setup (`/plugin install ponytail@ponytail` in each tool), not a handoff-time step. Before dispatching a handoff, the harness should check that the detected executor has Ponytail installed and warn if it's missing, since the harness itself has no way to install it into another program's plugin system.
