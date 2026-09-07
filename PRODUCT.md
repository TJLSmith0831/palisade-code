# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary user today is the builder: a developer driving a coding agent across two machines — a personal laptop and a work laptop — through the same harness. The harness must run unchanged on both, discovering available ACP-compatible agents and using the project or thread choice when one is made.

Eventual audience is public/OSS: other developers installing Palisade Code and pointing it at their own coding-agent subscription. Design should hold up for a first-run stranger, not just the builder's own muscle memory. A first-run onboarding screen exists (project picker, executor/model choice, clone-repo entry) and is deliberately bare of any account/sign-in UI or tier/plan badge — there is no bundled billing to represent. Beta today is still the builder alone across two machines; no external tester has installed it yet.

## Product Purpose

Palisade Code is a cross-machine IDE shell that orchestrates a coding agent through a spec-then-build cycle: spec-mode for read-only/plan exploration, go-mode for write-enabled implementation. It exists to make that spec-driven-development (SDD) cycle socratic and iterative rather than a one-shot batch generation, and to do so entirely on top of the user's own agent subscription — no bundled coding agent and no per-usage billing. A small bundled local model powers optional editor-only fill-in-the-middle completion; it does not replace or participate in agent orchestration.

Success means a developer can drive a real coding agent against a real project — explore, propose, implement, review diffs, commit — from one native-feeling desktop app, on whichever machine they're at, without the harness itself becoming a second thing to configure per machine.

## Positioning

Kiro and Antigravity both run an SDD (spec-driven-development) cycle, but Palisade Code differs on two axes its builder considers load-bearing, not incidental:

1. **Socratic, not batch.** Kiro/Antigravity generate a spec in one pass with no real mechanism to interrogate or refine it. Palisade Code's spec-mode is built around one-question-at-a-time interviews (the grill-explore → grill-propose → grill-apply → grill-archive skill chain) that force a decision log to exist before code gets written, and that log travels into go-mode as binding context.
2. **Bring-your-own-agent.** Kiro/Antigravity run their own internal models and charge per usage. Palisade Code discovers installed ACP-compatible agents, then drives the user's chosen agent and subscription. The harness is an orchestration and UI layer; its bundled completion model is deliberately limited to local editor suggestions.

A neighboring product could not truthfully copy both claims at once without either open-sourcing a socratic spec interview loop or giving up their own model's revenue.

## Operating Context

### Agent and session model

- The product has exactly two execution modes: **Spec** for plan/read-only work and **Go** for write-enabled implementation. Vibe is the chat-centric shell arrangement for Go work, not a third execution mode.
- Starting a thread is deliberate: the inline picker offers Vibe or Spec. Vibe creates no record until the first message; Spec first asks whether the work is a Feature, Bugfix, or a custom type, then uses that framing as the agent's first exploration turn.
- Spec type persists on the thread and is reinjected only when a handoff needs it. Exploration advances to proposal when the agent emits its ready marker; it is not advanced by a decorative "proceed" button.
- Agent availability comes from the ACP Registry (locally cached) plus locally installed executables. Claude Code and Codex are supported alongside any registry-listed ACP agent; adding such an agent does not require a Palisade code change.
- The agent/model selector and bypass-permissions preference are explicit UI controls. A project may set an executor override in `.palisade/project-settings.json`; changing a thread's agent, model, or bypass choice affects a future session and never mutates an in-flight one.
- A thread can hold multiple live sessions, and multiple threads can run at once. Every session has its own identity, busy state, cancellation path, provider resume handle, message/event routing, and append-only lifecycle record.
- Live-session collision warnings inform rather than block. An app restart closes an unfinished session record as interrupted; a session can be cancelled without affecting any other session.
- Assistant text streams incrementally where the provider supports it. Tool calls remain collapsed while showing live status, and reasoning visibility is a global preference rather than a per-message persistence burden.
- Session history, indexes, and completion telemetry live outside the target repository under Palisade-managed user storage. The store reconciles project indexes, appends messages in constant time, caps persisted payloads, and keeps every session's storage home explicit.

### Isolation, source control, and attribution

- A Git-backed thread receives a dedicated namespaced branch and worktree on its first session; later sessions reuse it. Concurrent threads therefore do not share a checkout or silently see one another's unstaged edits. Non-Git projects work without this isolation layer.
- Thread deletion asks for confirmation, refuses while any session on that thread is busy, removes Palisade's worktree, and moves the user to another thread. An unmerged branch with committed work is retained rather than force-deleted.
- Source control presents working and staged diffs, file status, individual hunk stage/unstage, whole-file stage/unstage, commit, branch selection/creation/deletion, fetch/pull/push, ahead/behind state, and a branch log.
- A merge gate assesses a thread branch's ahead count, clean state, and trial merge. Clean work merges back through an isolated scratch worktree; a conflict remains parked in its own worktree for normal agent-assisted resolution rather than contaminating the user's checkout.
- Session-boundary Git state is the evidence for change attribution. Committed changes are attributed exactly; concurrent uncommitted changes explicitly report ambiguity. Agent `FileEdit` paths are shown only as labeled hints, never as proof.

### Project and workspace model

- Projects are selected through onboarding/workspace controls and are scoped by root. The app supports project picking, executor selection, cloning a repository, initializing a Git repository when needed, and switching among branch/worktree contexts.
- `.palisade/project-settings.json` is optional and user-gitignoreable. It supports format-on-save mappings, executor override, named verification commands, and debug/run configuration. Malformed or absent settings fall back safely.
- The application uses one mounted workspace tree in two arrangements: **Editor** (code-centric) and **Vibe** (chat-centric). The top-chrome shell toggle is independent of a thread's Spec/Go mode.
- The permanent activity rail exposes Explorer, text Search, Source Control, Workspace, Specs, Codebase Map, Run configurations, MCP Servers, Database, Agent Chains, History, and Settings. Rails and the terminal can resize, collapse, and persist their project-scoped dimensions.
- The Editor shell keeps chat in a collapsible disclosure shared with thread history and the codebase map; selecting a thread closes that disclosure so chat regains usable height.

### Files, editor, language tooling, and local execution

- Explorer supports directory traversal, create/rename/delete operations, per-file affordances, and ordinary file opening. A fuzzy file palette and find-in-files search complement the tree without replacing it.
- CodeMirror 6 provides editable file tabs, language-aware syntax highlighting, built-in completion, status information, large-file handling, image/file previews where applicable, and persistent editor sessions.
- Language-server clients surface diagnostics in the Problems panel and supply editor language integration for supported local servers. Test files expose test-gutter affordances and a Test Explorer.
- Optional local fill-in-the-middle completion displays inline ghost text after a pause, accepts through a configurable keybinding (Option+Tab by default), dismisses on Escape/cursor movement/new typing, and cancels stale requests.
- Completion uses the bundled Qwen3.5-0.8B Q4_K_M model and managed local `llama-server` sidecar with bounded prefix/suffix/generation context, indentation-preserving post-processing, health checks, one crash-restart attempt, graceful shutdown, and one-time degradation feedback when resources are missing. Local telemetry records shown/accepted/dismissed/typed-past outcomes and latency percentiles.
- The integrated terminal is a real PTY: it supports interactive programs, stdin, resize, signals, per-project terminal lifecycle, and terminal tabs rather than a simulated command-output pane.
- The run and debug surfaces keep saved run configurations, breakpoints, adapter discovery, start/stop, stepping, stack/scopes/variables, expression evaluation, output, and stop/continue events. A missing adapter explains why execution cannot start instead of implying debugger support.
- Notebook files open as editable notebook tabs: cells can be inserted, deleted, moved, have their cell type changed, run, interrupted, restarted, and closed. Kernel ownership and execution live in the backend; notebook source and outputs serialize back to the notebook document.

### Specifications and verification

- OpenSpec is the source of truth for change artifacts. Palisade calls its CLI to list, show, validate, select, archive, and link changes; it does not maintain a competing authored spec format.
- Specs are readable in a dedicated panel and in Vibe editor tabs with artifact tabs. The linked-change chip opens the actual change, and views remain read-only where OpenSpec owns the content.
- A project-defined verify command runs asynchronously from the project root, capturing stdout/stderr, exit code, command, and Git `HEAD`. Results appear in the Verify surface and are available to the spec/task flow.
- "Complete," "satisfied," and equivalent claims require a persisted passing verification result or explicit user action. Agent self-report alone is never completion evidence.

### Agent collaboration, tools, and chains

- MCP server configuration is project-scoped in `.mcp.json`, portable, and sent to agents over ACP `session/new`. The MCP panel lists, enables, disables, edits, removes, browses, and installs config-launchable servers from the official registry; entries that need Docker or a separate binary link to their own setup rather than pretending Palisade can install them.
- Graphify runs against the active target project, maintains a current code map in the background, shows failures as non-blocking warnings, and can make a bounded report available to an agent. Its MCP integration exposes the same project graph to compatible agents without replacing the human-facing map.
- Agent chains are named, reusable, project-scoped DAG definitions stored in `.palisade/chains/`. A node binds a selected installed agent, role, and instruction; its effective prompt combines node guidance, the chain seed, and upstream outputs.
- Forward chain edges hand off automatically. Loop-closing edges require either a named verification gate or human approval plus an iteration cap. Human gates allow approve, reject, or send-back-with-note; verification gates reuse persisted project verification commands.
- Chain runs have a configurable wall-clock timeout and per-node fresh-session crash retries. A missing selected agent blocks rather than substitutes. Runs can power Go execution or be invoked in chat with `|=<chain-name> <seed>`.
- While a chain runs, its DAG shows node state and grants access to each node's real transcript; the invoking thread receives a condensed completion/pause summary. In-progress chains do not automatically resume after an app restart.

### Data, preview, and database workspaces

- A Preview tab opens manually from the tab bar or automatically when the terminal or an agent prints a local development URL. It accepts URL navigation, reload, a failure hint, and external-browser open even when inline embedding fails; it behaves the same in both shell arrangements.
- The Database panel stores named Postgres and SQLite connection strings outside the project repository. It browses connections, schemas, tables, and views; opens paginated table grids; sorts and filters; and distinguishes `NULL` from an empty string.
- Rows with an available primary key support staged inline edits. The user previews exact SQL and applies pending edits as one transaction; optimistic conflict detection prevents overwriting a row changed since fetch.
- A SQL tab runs arbitrary queries and renders results or affected-row counts inline. Destructive-looking SQL (`DELETE`, `DROP`, `TRUNCATE`, `ALTER`, or unscoped `UPDATE`/`DELETE`) requires confirmation.

## Capabilities and Constraints

- Agent permission handling combines an executor's own policy with an inline Palisade gate. A pending tool call offers Allow, Deny, or Allow for the rest of that session, pauses only that session, and fails closed if it ends unanswered. Bypass requires explicit confirmation and remains thread-scoped.
- All executor events carry both session and thread identity before reaching the frontend or persistence layer. This is required for correct concurrent UI state, messages, permission prompts, live output, and attribution.
- Notes, OpenSpec changes, chain definitions, and settings are scoped to the project root by their respective contracts. Database credentials, session logs, and completion telemetry must not leak into target repositories or Git status.
- This is a Tauri desktop product backed by a WKWebView. Playwright cannot drive its native UI; end-to-end UI verification uses the debug-only Tauri MCP bridge on `127.0.0.1:9223`.
- The supported development stack is Rust + Tauri 2, React 19, TypeScript, Vite, pnpm, Mantine, Tabler icons, CodeMirror, ACP JSON-RPC over stdio, and project-local shell tools such as Git, OpenSpec, Graphify, language servers, debuggers, and notebook kernels.
- The application targets Apple Silicon for packaged builds. The bundled inference sidecar needs hardened-runtime entitlements for JIT and its own dynamic libraries.
- Generated/dependency/secrets paths are not product content: `.env`, `node_modules`, `dist`, `target`, and `src-tauri/target` stay outside normal editing and product records. No third execution mode is planned.

## Brand Commitments

Name is "Palisade Code" (Harry Potter's fireplace travel network — the cross-machine, jump-between-places metaphor is intentional and load-bearing; don't genericize it to something like "Agent Harness"). Visual identity (Dragon Fire Green accent, dark workbench field) is recorded in DESIGN.md, not here.

## Product Principles

1. **Socratic beats batch.** Any spec/plan-generation surface should interrogate one decision at a time and leave a decision log, not dump a finished document for the user to edit after the fact.
2. **Bring-your-own-agent, always.** Never design an orchestration flow that assumes or requires an embedded/internal coding agent. The product's job is orchestration and visibility around the user's chosen installed agent; local completion stays a constrained editor assist.
3. **Two modes, resist a third.** Every new capability should slot into spec-mode or go-mode's existing permission posture rather than inventing a new mode to hold it.
4. **Cross-machine by construction, not by config.** Behavior differences between the personal and work laptop come from executor detection, never from a settings file the user has to remember to sync.
5. **The harness is a thin, honest layer.** It shells out to and displays real tool state (executor permission mode, Graphify, git, the terminal) rather than reimplementing or abstracting over it — trust comes from showing the real thing.

## Evidence on Hand

- The runnable product, its typed frontend/backend implementation, and focused frontend and Rust tests live in `src/`, `src-tauri/src/`, and their adjacent test modules.
- Authoritative behavioral records live in `openspec/specs/`, including agent chains, preview, concurrent sessions, project settings, database viewing, verification, source control, and local completion.
- `README.md` documents the supported development and verification commands; `AGENTS.md` documents packaging, signing, and the cross-machine operating constraints.

## Accessibility & Inclusion

Keyboard-first is the working standard (every focusable control gets a visible focus ring; tree/list rows are keyboard-operable, already true per DESIGN.md). No hard screen-reader-support mandate has been set — this is a dense power-user IDE tool for sighted developers, not a general-audience app. Revisit if the public/OSS audience surfaces a real accessibility requirement.
