# Product

<!-- impeccable:product-schema 1 -->

## Platform

MacOS Desktop

## Users

Palisade is for developers who have multiple ACP-compatible coding agents installed on their machine and want to use them from one coherent development environment. The primary job is to choose, direct, combine, and supervise those agents against real local projects without learning a separate workflow for each provider.

Users are expected to be comfortable with software-development concepts such as repositories, diffs, terminals, tests, databases, and agent permissions. The product should remain understandable to someone opening it for the first time, but it is a dense professional tool rather than a simplified chat client.

## Product Purpose

Palisade is an Agentic Development Environment (ADE): one shell that drives several ACP-compatible coding agents in parallel, each in its own isolated worktree, reviews what they produce, and gates merge on recorded verification evidence rather than agent narration.

The shell surrounds that fleet of agents with the tools needed to inspect and complete real development work: a fleet board of concurrent runs, per-thread diff review, source editing, Git, integrated terminals, specifications and verification, run and debug configurations, notebooks, database access, previews, and MCP connections.

Success means a developer can run several agents at once, see at a glance which runs need attention, review and merge the ones that are done, and drop into any single thread's editor and terminal when hands-on work is needed, all without leaving one project-aware environment.

## Positioning

Palisade is an Agentic Development Environment: one shell that drives N parallel ACP agents in isolated worktrees, reviews their output, and gates merge on verification evidence. It is not an AI IDE built around a single chat pane, and not a chat client with a file tree bolted on.

Its core advantage is not access to one proprietary model; it is a common orchestration layer over the developer's installed ACP agents, including concurrent sessions in isolated worktrees, provider-aware session continuity, explicit handoffs, and reusable multi-agent playbooks. The fleet board is home: every thread and worktree in one list, with status, agent, diff stat, verify evidence, merge readiness, and cross-thread file overlap, so a developer supervising several agents can tell what needs attention without opening each thread.

Review is a first-class lane, not an afterthought. A thread's diff, per-file viewed state, and verify evidence sit together, and merge stays disabled until a named verify command has actually passed (or a human explicitly overrides it).

It pairs that orchestration with a capable local workbench instead of reducing the experience to chat. The same application exposes the repository, editor, terminal, Git state, OpenSpec changes, verification results, run/debug tools, notebooks, databases, previews, and project-scoped MCP servers as a "Workbench" a developer reaches from any thread or diff, demoted in priority behind the fleet and review surfaces but not removed.

Privacy is legible rather than implied. Fill-in-the-middle completion and small editor-assistance tasks use a bundled local model, so Palisade does not silently send a code index to a cloud service for those features. A developer-selected agent or MCP server may still communicate with its own external service; Palisade must make those choices and boundaries visible rather than claiming the entire workflow is offline.

Cross-machine consistency is useful, but it is not the primary product claim. Competitive rationale and the market survey behind this positioning are recorded in `docs/research/ade-market-survey-2026-09.md`; that survey is not itself a claim this document makes.

## Operating Context

### Agents, threads, and sessions

- Agents are discovered through the ACP Registry and locally available launch commands. Palisade communicates with them over ACP rather than maintaining provider-specific chat implementations.
- Agent authentication follows the methods each agent advertises. Palisade supports both agent-owned and terminal-based sign-in flows without assuming one provider's account model.
- A thread owns the conversation and work intent. Sessions are separate agent processes with their own identity, agent, mode, busy state, cancellation path, and provider resume handle.
- Multiple sessions and threads can run concurrently. Changing an agent, model, or permission preference applies to a future session rather than mutating an in-flight one.
- Session history is append-only and stored under Palisade-managed user storage outside the target repository.

### Agent orchestration

- The fleet board is home: every thread and its worktree, with status (attention, running, idle), agent, diff stat, verify evidence, merge readiness, and cross-thread file overlap in one list.
- The review lane pairs a thread's diff with per-file viewed state and its verify evidence; merge stays disabled until a named verify command has passed at that commit, or a human explicitly overrides it.
- Named playbooks are project-scoped directed graphs of agent runs, launched from the fleet board. Each node selects an installed agent and gives it a role and instruction; upstream outputs become downstream context. A playbook run appears on the fleet board like any other thread.
- Playbooks support automatic handoffs, verification gates, human approval gates, iteration caps, timeouts, fresh-session crash retries, and inspection of each node's transcript. Scheduling and event triggers are not yet built.
- Palisade does not silently substitute an unavailable agent selected by a playbook.
- MCP server configuration is project-scoped and passed to compatible agents through ACP. Stdio works as the common baseline; remote transports are gated by the capabilities an agent advertises.

### Development workflow

- Spec and Go are the two execution modes. Spec work is constrained to planning and OpenSpec artifacts; Go work permits implementation while retaining prompts for execution and destructive operations unless the user explicitly enables bypass.
- OpenSpec is the source of truth for change artifacts. Palisade reads, validates, links, and archives OpenSpec changes rather than inventing a competing specification format.
- Verification is evidence of completion: a named command must exit successfully at a recorded Git commit. Agent self-report alone is not proof that work is done.
- Every thread runs in its own dedicated branch and worktree for isolation. Merge checks and conflict handling avoid contaminating the user's main checkout.
- Source control includes working and staged diffs, hunk and file staging, commits, branches, remote synchronization, history, and change attribution with explicit ambiguity when concurrent uncommitted work prevents certainty.

### Built-in workbench

- The file workspace includes a tree, fuzzy file navigation, text search, editable CodeMirror tabs, language-aware highlighting, diagnostics, test navigation, image/file previews, and persistent editor state.
- A real PTY terminal supports interactive programs, input, resize, signals, and multiple tabs.
- Run and debug surfaces support saved configurations, breakpoints, adapter discovery, start/stop, stepping, stack and variable inspection, evaluation, and output.
- Jupyter notebook files open as cell-based documents backed by local kernel processes and can be edited, run, interrupted, restarted, and saved.
- Postgres and SQLite connections support schema browsing, paginated data grids, SQL queries, staged row edits, SQL previews, transactional application, optimistic conflict checks, and confirmation for destructive-looking statements.
- Local development URLs can open in an embedded preview surface or the external browser.

## Capabilities and Constraints

- The product is a Tauri 2 desktop application with a React 19 and TypeScript interface, a Rust backend, and a WKWebView rendering surface.
- ACP JSON-RPC over stdio is the agent interoperability boundary. Functionality varies with the capabilities, models, commands, authentication methods, and MCP transports each agent advertises.
- Palisade uses the user's installed agents and their existing accounts or subscriptions. It does not bundle a hosted coding agent or hide provider usage behind Palisade billing.
- Optional fill-in-the-middle completion, thread-title suggestions, and commit-subject suggestions run through the managed local `llama-server` sidecar and installed GGUF model. Completion telemetry is stored locally.
- Palisade does not upload a repository index for local completion. Network access can still occur when fetching the ACP registry or updates, installing the local model, using Git remotes, searching the MCP registry, or invoking a user-selected agent or MCP server.
- Project-local configuration lives in `.palisade/project-settings.json`, `.palisade/chains/`, and `.mcp.json`. Session logs, completion telemetry, and database connection records live outside target repositories under Palisade-managed user storage.
- Database passwords use the operating-system credential store when available. Any fallback to a user-only local file must be disclosed rather than occurring silently, and secrets must not cross frontend IPC or enter logs.
- File operations are scoped to the selected project root. Concurrent agent events retain both thread and session identity so output, permissions, and attribution reach the correct UI.
- The packaged application currently targets Apple Silicon macOS. Its local inference sidecar requires hardened-runtime entitlements for JIT and bundled dynamic libraries.
- The Tauri WKWebView cannot be driven by ordinary Playwright browser automation. End-to-end UI verification uses the debug-only Tauri MCP bridge.
- Cross-machine behavior must not depend on hidden machine-specific configuration. Agent availability is detected locally, and missing capabilities should degrade honestly rather than being fabricated.

## Brand Commitments

The product name is **Palisade**. Product language should present it as a serious development workbench and orchestration environment, not as a generic chatbot or a proprietary-model wrapper. Some surfaces (the app window title, `README.md`, the repository name) still say "Palisade Code" until they are renamed.

No additional durable voice, visual, licensing, pricing, customer, or market claims are confirmed. Future work must not invent them.

## Evidence on Hand

- The runnable frontend and backend live in `src/` and `src-tauri/src/`, with focused frontend and Rust tests beside the implementation.
- Behavioral specifications live in `openspec/specs/`, covering agent discovery, concurrent sessions, playbooks, verification, source control, editor behavior, local completion, databases, previews, and workspace structure.
- `README.md` documents the current architecture and development commands.
- `docs/ACP-AUTH.md` records observed authentication behavior across installed ACP agents.
- `docs/PREVIEW.md` documents the agent-to-preview contract.
- `AGENTS.md` records build, packaging, signing, and runtime constraints.
- There is no confirmed evidence for testimonials, external adoption, pricing, performance claims, or comparative benchmarks; future product work must not fabricate them.

## Product Principles

1. **ACP is the center.** Prefer protocol-level interoperability and advertised capabilities over provider-specific assumptions.
2. **Agents work better together.** Make agent selection, parallel sessions, handoffs, playbooks, gates, and transcripts understandable and controllable.
3. **Local by default where Palisade owns the computation.** Keep editor assistance and Palisade metadata on-device, and make every external boundary attributable to a chosen integration.
4. **The workbench shows real state.** Surface actual files, diffs, processes, permissions, specs, tests, and database actions instead of replacing them with optimistic agent narration.
5. **Verification outranks confidence.** Completion claims require recorded evidence or an explicit human decision.

## Accessibility & Inclusion

Keyboard operation and visible focus are required throughout the dense desktop interface. Native menu commands, palettes, trees, panes, dialogs, and custom controls should preserve predictable focus and keyboard access.

A broader assistive-technology target has not yet been confirmed. This remains an open product decision rather than grounds for assuming screen-reader support is unnecessary.
