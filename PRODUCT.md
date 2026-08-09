# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary user today is the builder: a developer driving a coding agent (Claude Code or Codex) across two machines — a personal laptop and a work laptop — through the same harness. The harness must run unchanged on both, detecting whichever executor is present.

Eventual audience is public/OSS: other developers installing Floo Network and pointing it at their own coding-agent subscription. Design should hold up for a first-run stranger, not just the builder's own muscle memory, even though no onboarding flow has been built yet.

## Product Purpose

Floo Network is a cross-machine IDE shell that orchestrates a coding agent (Claude Code or Codex) through a spec-then-build cycle: spec-mode for read-only/plan exploration, go-mode for write-enabled implementation. It exists to make that spec-driven-development (SDD) cycle socratic and iterative rather than a one-shot batch generation, and to do so entirely on top of the user's own agent subscription — no bundled or internal model, no per-usage billing.

Success means a developer can drive a real coding agent against a real project — explore, propose, implement, review diffs, commit — from one native-feeling desktop app, on whichever machine they're at, without the harness itself becoming a second thing to configure per machine.

## Positioning

Kiro and Antigravity both run an SDD (spec-driven-development) cycle, but Floo Network differs on two axes its builder considers load-bearing, not incidental:

1. **Socratic, not batch.** Kiro/Antigravity generate a spec in one pass with no real mechanism to interrogate or refine it. Floo Network's spec-mode is built around one-question-at-a-time interviews (the grill-explore → grill-propose → grill-apply → grill-archive skill chain) that force a decision log to exist before code gets written, and that log travels into go-mode as binding context.
2. **Bring-your-own-agent.** Kiro/Antigravity run their own internal models and charge per usage. Floo Network never embeds a model — it detects and drives the user's already-installed Claude Code or Codex, using whatever subscription they already pay for. The harness is an orchestration and UI layer only.

A neighboring product could not truthfully copy both claims at once without either open-sourcing a socratic spec interview loop or giving up their own model's revenue.

## Operating Context

- Two modes only, both driven by the same detected executor: spec-mode (default, read-only/plan — `--permission-mode plan` for Claude, `--sandbox read-only` for Codex) and go-mode (write-enabled — `--permission-mode default` for Claude, `--sandbox workspace-write` for Codex). `/go` kills the spec-mode executor process and spawns a fresh go-mode one with conversation history carried forward, no summarization call.
- Executor selection is by detection, not config: prefer `claude` if both `claude` and `codex` are on PATH; warn and fall back to chat-only if neither is found. Personal laptop today resolves to Claude Code, work laptop to Codex.
- Project root is detected from cwd (overridable via `--project` or a UI picker); all notes, Graphify runs, and executor handoffs are scoped to that root.
- Session history is append-only and stored outside any target repo (default `~/.floo-network/sessions/`), so project git histories stay clean. History persists across restarts; one harness instance carries many project threads, and each thread carries its own concurrent sessions. Floo does not coordinate two agents writing the same file — it warns and names the other live session; git remains the arbiter.
- Graphify (codebase-map) runs as its own out-of-process tool, shelled out to and parsed, always pointed at the active target project — never at the harness's own repo.
- Browserbase provides web search; results are passed to the executor as citations/context, never rendered as raw HTML or treated as answers on their own.
- The workspace UI itself (file tree, CodeMirror editor, git diff/staging, PTY terminal, agent chat/diff console, force-directed codebase-map) is documented visually in DESIGN.md — this file covers product truth, not visual design.

## Capabilities and Constraints

- Tool permissions are enforced by the executor's own built-in permission system (`--permission-mode` for Claude, `--sandbox` for Codex) — the harness does not and cannot easily intercept individual tool calls inside the executor's own agentic loop. Restoring finer-grained harness-side gating (e.g. a create_note approval gate) via executor-level hooks is an open question, not a current capability.
- Notes are files inside the target project; the harness proposes a path under the project root and the user confirms before any write. The harness never creates files outside the project root it's scoped to.
- Ponytail (the laziness-discipline plugin) is installed per-machine directly into Claude Code/Codex, not invoked by the harness. Before a handoff, the harness should check the detected executor has it installed and warn if missing — it has no way to install it into another program's plugin system.
- Playwright cannot drive this app (Tauri's WKWebView isn't a browser Playwright targets); UI verification goes through the Tauri MCP bridge (`tauri-plugin-mcp-bridge`, debug-only, WebSocket on `127.0.0.1:9223`) instead.
- Do-not-touch at the repo level: `.env` files (secrets), `node_modules/`, `dist/`, `target/`, `src-tauri/target/` (generated), and the session store path (configured at first run, never hardcoded).
- No third mode planned for v1 beyond spec-mode/go-mode.

## Brand Commitments

Name is "Floo Network" (Harry Potter's fireplace travel network — the cross-machine, jump-between-places metaphor is intentional and load-bearing; don't genericize it to something like "Agent Harness"). Visual identity (Dragon Fire Green accent, dark workbench field) is recorded in DESIGN.md, not here.

## Product Principles

1. **Socratic beats batch.** Any spec/plan-generation surface should interrogate one decision at a time and leave a decision log, not dump a finished document for the user to edit after the fact.
2. **Bring-your-own-agent, always.** Never design a flow that assumes or requires an embedded/internal model. The product's job is orchestration and visibility around the user's own Claude Code/Codex subscription.
3. **Two modes, resist a third.** Every new capability should slot into spec-mode or go-mode's existing permission posture rather than inventing a new mode to hold it.
4. **Cross-machine by construction, not by config.** Behavior differences between the personal and work laptop come from executor detection, never from a settings file the user has to remember to sync.
5. **The harness is a thin, honest layer.** It shells out to and displays real tool state (executor permission mode, Graphify, git, the terminal) rather than reimplementing or abstracting over it — trust comes from showing the real thing.

## Accessibility & Inclusion

Keyboard-first is the working standard (every focusable control gets a visible focus ring; tree/list rows are keyboard-operable, already true per DESIGN.md). No hard screen-reader-support mandate has been set — this is a dense power-user IDE tool for sighted developers, not a general-audience app. Revisit if the public/OSS audience surfaces a real accessibility requirement.
