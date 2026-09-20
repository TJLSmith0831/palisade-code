# Palisade Code

An Agentic Development Environment (ADE): one shell that drives several ACP coding agents (Claude Code, Codex, and others) in parallel, each in its own isolated worktree, through a spec-then-build cycle, then reviews their diffs and gates merge on verification evidence. Sessions are concurrent — a thread can hold more than one, and two threads can run at once.

Built with Rust + Tauri 2 on the backend and React 19 + TypeScript (Vite) on the frontend, using pnpm.

## Getting started

```bash
pnpm install
pnpm start
```

`pnpm start` runs `tauri dev` and opens the app window.

## Commands

| Command | Purpose |
|---|---|
| `pnpm install` | Install frontend deps (standalone repo, not a workspace member) |
| `pnpm test` | Run all frontend tests (vitest) |
| `npx vitest run src/__tests__/errors.test.ts` | Run one frontend test file |
| `npx tsc --noEmit` | Typecheck only |
| `pnpm build` | `tsc && vite build` |
| `cd src-tauri && cargo test` | Run all Rust tests |
| `cd src-tauri && cargo test git::` | Run one Rust module's tests |
| `pnpm start` | Launch the dev window (`tauri dev`) |

See [tester releases](docs/tester-releases.md) for the GitHub-only release
process. Local `package.sh` builds never publish updates.

## Project layout

- `src/App.tsx` — the IDE shell: panes, threads, chat, routing
- `src/api.ts` — typed wrapper over every Tauri IPC command
- `src-tauri/src/lib.rs` — IPC command layer (`generate_handler!` registry at the bottom)
- `src-tauri/src/executor.rs` — executor detect/spawn, stdout JSON-line parsing for both CLIs
- `src-tauri/src/store.rs` — append-only session store under `~/.palisade-code`
- `src-tauri/src/git.rs`, `terminal.rs`, `settings.rs` — git ops, PTY, MCP wiring, `.project-settings.json`
- `src/__tests__/*` — frontend tests, one per source file; Rust tests live inline as `mod tests`

## How it works

- **Fleet board is home.** Every thread and its isolated worktree shows up as a fleet row: status (attention, running, idle), agent, diff stat, verify evidence, merge readiness, and overlap with other running threads.
- **Review is a first-class lane.** A thread's diff, per-file viewed state, and verify evidence sit together; merge stays disabled until a named verify command passes, or a human explicitly overrides it.
- **Agents are discovered at runtime, not compiled in.** `acp_registry.rs` fetches agent manifests from the ACP Registry (24h cache) and speaks to every agent over ACP (JSON-RPC 2.0 on stdio). Adding a new agent means it's listed in the registry and its CLI is on `PATH` — no code change.
- **Thread vs. Session.** A Thread owns messages, mode intent, and the spec link. A Session owns the process, busy state, agent identity, and the provider resume handle. A thread may hold a live spec session and a live go session at once.
- **Two modes only: spec and go.** They differ by permission flag (`--permission-mode` / `--sandbox`) and skill focus, not by model.
- **OpenSpec is authoritative for specs.** Palisade shells out to `openspec list/show/validate --json` and never writes a spec file itself.
- **Verification is the only evidence of done.** A spec is complete because a named `verify` command exited 0 at a named commit — never because a model said so.

## Notes

- No headless test mode — the app uses WKWebView, not Chromium, so Playwright can't drive it. Use the Tauri MCP against the debug-only bridge on `127.0.0.1:9223`.
- `.agents/` and `.claude/` are gitignored; in-repo skills exist locally but aren't committed.
- See [AGENTS.md](AGENTS.md) for packaging and per-machine codesigning, and [PRODUCT.md](PRODUCT.md) for product intent and positioning.
