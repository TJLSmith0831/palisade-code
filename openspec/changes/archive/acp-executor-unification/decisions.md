# Decision Log — acp-executor-unification

Harvested from `openspec/explore/executor-switcher.md` (grill-explore session, 2026-08-10).
Each entry is a resolved decision; artifacts trace to these, not to guesses.

## D1: Compiled-in table rows vs runtime-discoverable

- **Decision**: Runtime-discoverable. The user wants to plug in a new executor CLI without recompiling Floo.
- **Why**: "Any executor" is literal and ongoing, not just the three on this machine today.
- **Source**: user

## D2: Discovery mechanism — registry-backed auto-scan

- **Decision**: Auto-scan backed by the ACP Registry. Floo fetches/caches the registry, cross-references each entry's invocation against PATH, and surfaces available agents automatically. No config file for registry-known agents; manual config fallback for agents not in the registry.
- **Why**: True runtime discoverability — the user installs an ACP agent and Floo finds it without a recompile or a config edit. The registry provides the exact `cmd` + `args` to invoke ACP mode per agent.
- **Source**: recommended-accepted (confirmed viable via web research)
- **Research notes**:
  - ACP is a mature JSON-RPC 2.0 over stdio standard. Rust crate `agent-client-protocol` v2.0.0 on crates.io (Client, Stdio transport, ActiveSession, full lifecycle).
  - ACP Registry (`github.com/agentclientprotocol/registry`): one directory per agent, each with an `agent.json` manifest (`id`, `name`, `version`, `distribution` with `cmd` + `args`).
  - Registry agents: Claude (via `claude-acp` adapter), Codex (via `codex-acp` adapter), Gemini CLI (native `--acp`), OpenCode (native `acp` subcommand), Devin (native `acp` subcommand), Cursor, Copilot, Cline, Amp, and more.
  - Zed and JetBrains already consume this registry for their external-agent pickers.

## D3: Full unification under ACP

- **Decision**: Migrate Claude and Codex to their ACP adapters too. One transport (ACP), one parser, one code path. Drop the proprietary stream-json parsers and the `KNOWN_AGENTS` compiled-in table.
- **Why**: User wants a single clean abstraction, not two transport types coexisting.
- **Source**: user
- **Risk**: Claude/Codex ACP support comes via third-party adapters (`@agentclientprotocol/claude-agent-acp` wraps the Claude Agent SDK, not the `claude` CLI; `codex-acp` starts the Codex App Server, not `codex exec`). Floo becomes dependent on adapter maintenance and may lag behind native CLI features.

## D4: Migration strategy — big bang on a worktree

- **Decision**: Big bang. Rip out `KNOWN_AGENTS`, the proprietary parsers, and the `Transport` enum in one change. Ship ACP-only. Run the work on a git worktree so the main branch stays functional during the rewrite.
- **Why**: User wants the clean break, not a transitional period where two transport types coexist.
- **Source**: user

## D5: Executor is user-switchable in the global picker

- **Decision**: The top-chrome executor row becomes a dropdown of all discovered ACP agents. Switching changes the active executor. This reverses the `executor-model-switcher` spec's "executor row SHALL be read-only" requirement.
- **Why**: The user's goal is to switch between any executor freely; a read-only auto-detected display defeats the purpose.
- **Source**: user
- **Supersedes**: `executor-model-switcher` spec requirement "Top-chrome executor/model picker" (executor-row-is-read-only scenario). Model-selection and bypass-permissions-toggle requirements remain.

## D6: Mid-thread switch does a context handoff, not a cold start

- **Decision**: Switching executors mid-thread starts a fresh ACP session with the new agent, but Floo passes the previous conversation turns + the new message into the new agent's first prompt. A warning is shown before the handoff.
- **Why**: A cold start wastes prior thinking; passing the transcript as context gives the new agent a running start without pretending it's a real resume.
- **Source**: user
- **Note**: This is not ACP `session/load` (agent-scoped, can't cross agents). It's a one-way context transfer via the new agent's first `session/prompt`.

## D7: Transcript format — raw text

- **Decision**: The previous turns are formatted as a readable text transcript (`User: ...\nAssistant: ...\n`) and sent as the first prompt's text to the new agent, followed by the user's new message.
- **Why**: Universal compatibility — every ACP agent accepts text prompts, while `embeddedContext` support varies by implementation.
- **Source**: recommended-accepted

## D8: Transcript windowing — token-budget-bounded, adaptive to the model

- **Decision**: Pass as many previous turns as fit within the new agent's context window, most-recent-first, dropping older turns when the budget is hit. The budget is derived from the agent's own reported context window size via ACP `usage_update`.
- **Why**: A fixed turn count is blind to turn length and model context limits; a token budget adapts to both.
- **Source**: user
- **Research notes**:
  - ACP `usage_update` is stabilized (June 2026). Agents send `session/update` with `sessionUpdate: "usage_update"`, carrying `used` (tokens in context) and `size` (total context window). Authoritative — Floo doesn't guess.
  - Live pie chart: consume `usage_update` → render `used / size` as a Mantine `RingProgress`. Color thresholds: green < 60%, amber 60-85%, red > 85%. Agents that don't send `usage_update` show "unknown."
  - Handoff budgeting: open new ACP session → get `size` from first `usage_update` → estimate transcript tokens with `chars / 4` heuristic → include turns most-recent-first until budget approached → send prompt → agent's next `usage_update` confirms real count.
  - No tokenizer dependency for v1 (`chars / 4` is sufficient; upgrade to `tiktoken` crate later if pre-send estimates are needed).

## D9: Switch is per-thread, confirmed with a warning dialog

- **Decision**: Switching executors affects only the current thread. Before the handoff, a modal warning dialog explains the consequence and requires explicit confirmation.
- **Why**: Per-thread because the handoff is inherently per-thread. Confirmation because the context transfer is one-way and irreversible.
- **Source**: user

## D10: Non-goals

- **Decision**: The following are explicitly out of scope:
  1. No custom ACP agent — Floo is a client only.
  2. No ACP registry publishing — Floo consumes the registry, does not publish itself.
  3. No model selection in Floo — agents own their models (see D11).
  4. No offline registry bundling — fetched at runtime, cached locally.
  5. No migration of existing session history — old `SessionRecord`s stay as-is.
- **Why**: The point of this change is to let the user switch between any coding agent on their laptop (Claude, Devin CLI, OpenCode). Everything else is out of scope to keep the rewrite focused.
- **Source**: user

## D11: Agents own their models — model picker removed

- **Decision**: Drop the model row from the top-chrome picker. Each ACP agent uses whatever model it's configured with (Devin: `--model`/config; OpenCode: `-m provider/model`; Claude adapter: SDK default). The user configures models in each agent's own settings, not in Floo.
- **Why**: ACP's `session/new` doesn't take a model parameter — model selection is the agent's responsibility, not the client's. Floo's job is switching between agents, not duplicating their config surfaces. Matches how Zed's external-agent picker works.
- **Source**: recommended-accepted
- **Supersedes**: `executor-model-switcher` spec requirement "Top-chrome executor/model picker" (model row). The bypass-permissions-toggle requirement remains.

## D12: ACP permission flow replaces CLI flags; bypass toggle stays as "suppress all prompts"

- **Decision**: Floo handles ACP `permission_request` notifications as the permission gate. In spec-mode, write/edit/delete/execute tool requests are auto-denied; in go-mode they're auto-approved; anything ambiguous prompts the user. The existing bypass-permissions toggle stays in the UI — when enabled, it suppresses all permission prompts and auto-approves every request for that session, regardless of mode.
- **Why**: ACP's permission-request flow is the standardized way to handle tool approvals across all agents. Floo gets real control instead of passing a CLI flag and hoping the executor honors it. The bypass toggle is preserved because the user wants the "skip all approvals" escape hatch for trusted sessions.
- **Source**: user
- **Replaces**: the CLI-flag pass-through (`--dangerously-skip-permissions` / `--dangerously-bypass-approvals-and-sandbox`) with ACP-native permission handling. The `executor-model-switcher` bypass-toggle UI requirement survives, reinterpreted as an ACP permission-prompt suppressor.

## D13: ACP events map into the existing ExecutorEvent enum

- **Decision**: Keep the 9 `ExecutorEvent` variants. Map ACP `session/update` notifications into them: `message_update` → `Text`/`Reasoning` (and delta variants for partials); `tool_call_update` → `ToolCall`/`ToolResult`; stop reason → `Done` or `Crashed`. ACP `usage_update` feeds the pie chart via a separate session-status channel, not as an `ExecutorEvent`. ACP `plan_update` is ignored in v1.
- **Why**: `ExecutorEvent` is the frontend's rendering contract — `event-routing` guarantees its shape, and all chat/diff/tool-call rendering depends on it. Mapping ACP into it means the frontend doesn't change; only the backend parser does (one parser instead of two, which is the point of unification).
- **Source**: recommended-accepted

## D14: Registry fetch — HTTP via GitHub raw URLs, cache in ~/.floo-network/

- **Decision**: Fetch `agent.json` manifests via `raw.githubusercontent.com` URLs. Cache at `~/.floo-network/acp-registry/` with a 24h TTL. On refresh, re-fetch and update cache. If fetch fails, use cached copy; if no cache, show only manually-configured agents. The agent directory list comes from the GitHub API contents endpoint (`/repos/agentclientprotocol/registry/contents/`), with a hardcoded fallback list of popular agent IDs for first-run when the API is unreachable.
- **Why**: Simplest approach that works — HTTP fetch of small JSON files, local cache with TTL, graceful fallback. No git dependency, no build-time bundling. The registry is small (a few KB per agent).
- **Source**: recommended-accepted

## D15: Mode becomes a permission-response policy, aligned with industry patterns

- **Decision**: Spec/go modes become Floo's permission-response policies for ACP `permission_request` notifications, using ACP's tool-kind taxonomy. The mapping aligns with how the major coding agents already work:
  - **Spec-mode** (maps to Claude `plan`, Codex `read-only`, Devin `Plan/Ask`): auto-approve `read`/`search`/`think`/`fetch`; auto-deny `edit`/`delete`/`move`/`execute`. The agent investigates and proposes but cannot modify files.
  - **Go-mode** (maps to Claude `acceptEdits`, Codex `workspace-write`, Devin `Accept Edits`): auto-approve `read`/`search`/`think`/`fetch`/`edit`/`move`; prompt for `execute` (shell commands) and `delete`. This matches the industry pattern — go-mode auto-approves file edits within the workspace but still gates shell execution and destructive operations.
  - **Bypass** (maps to Claude `bypassPermissions`, Codex `danger-full-access`, Devin `Bypass`): auto-approve everything, suppress all prompts.
  - **Ambiguous/other**: prompt the user.
- **Why**: Research across Claude Code, Codex CLI, and Devin CLI/Desktop shows a consistent tiered model: read-only (plan) → accept-edits (workspace writes auto, shell prompts) → bypass (everything auto). Floo's spec/go/bypass maps cleanly onto this. ACP's `tool_call_update` `kind` field gives Floo the information to implement this policy uniformly across all agents.
- **Source**: recommended-accepted (grounded in research of Claude Code permission-modes, Codex CLI sandbox modes, Devin CLI/Desktop permissions — 2026-08-10)
- **Research notes**:
  - **Claude Code**: `default` (reads only, prompt for rest) → `acceptEdits` (reads + file edits + filesystem commands like mkdir/touch/rm/mv/cp auto-approved) → `plan` (reads + classifier-approved commands) → `bypassPermissions` (everything). Shift+Tab cycles default → acceptEdits → plan.
  - **Codex CLI**: `read-only` (inspect only, approval for edits/commands) → `workspace-write` (read + edit in workspace + routine commands, approval for network/outside-workspace) → `danger-full-access` (no restrictions). Approval policy is separate from sandbox mode (`on-request` vs `never`).
  - **Devin CLI/Desktop**: `Normal` (reads auto, writes/bash prompt) → `Accept Edits` (workspace edits auto, shell/outside-workspace prompt) → `Smart` (fast model judges safety) → `Bypass` (everything auto) → `Autonomous` (sandbox-enforced). Plan mode is a separate axis (read-only research + plan file).
  - **Common pattern**: all three distinguish "read-only/research" from "accept workspace edits" from "bypass everything." Floo's existing spec/go/bypass maps to this three-tier model. The key insight: go-mode should auto-approve file edits but still prompt for shell execution — this is what `acceptEdits`/`workspace-write`/`Accept Edits` all do.

## D16: Preflight becomes registry + ACP availability check

- **Decision**: The new preflight: (1) loads the cached registry, (2) for each registry entry, checks whether the invocation `cmd` resolves on PATH, (3) returns a list of available agents with registry metadata (id, name, version). The `openspec` and `graphify` checks stay (Floo-level, not agent-level). The `grill-apply` and `ponytail` checks are dropped — those were per-agent skill/plugin checks that don't apply to ACP agents (each agent has its own skill system; Floo doesn't install skills into them).
- **Why**: Agent-specific checks (skills, plugin, binary path) are obsolete under ACP — agents are discovered via the registry, not compiled-in rows. But the Floo-level tool checks (`openspec`, `graphify`) are useful upfront signals the user needs before starting a session.
- **Source**: recommended-accepted

## D17: Session internals replaced with ACP ActiveSession

- **Decision**: The `Session` struct keeps its public identity fields (`id`, `thread_id`, `project_hash`, `mode`, `busy`) but replaces the process internals (`Child`, `ChildStdin`, `turn_child`, `pump`) with an ACP `ActiveSession` handle from the `agent-client-protocol` crate. The crate handles JSON-RPC transport and notification dispatch; its async event loop runs on its own thread and calls back into Floo's sync `Sink` trait, bridging the async/sync boundary at the callback. `terminate()` calls ACP `session/cancel` + closes the transport. `send()` calls `session/prompt`. The `pump` function is removed — the crate's event loop replaces it.
- **Why**: The `agent-client-protocol` crate v2.0.0 is purpose-built for this — `Client::builder().connect_with(Stdio, ...)` gives the full lifecycle. Reimplementing JSON-RPC correlation by hand is unnecessary work. The crate uses `async-io`/`async-process` (smol runtime); Floo's current code is sync std threads, but the ACP event loop runs independently and bridges to sync at the `Sink` callback.
- **Source**: recommended-accepted

## D18: executorOverride stays as per-project default, resolved against ACP registry

- **Decision**: `executorOverride` in `.project-settings.json` survives as a per-project _default_ — when a new thread is created, it defaults to the override (or the first available ACP agent if no override). The user can still switch per-thread via the picker (D5/D9). The field's type changes from a `KNOWN_AGENTS` id to an ACP registry agent id (e.g. `"devin"`, `"opencode"`, `"claude-acp"`), resolved against discovered agents. Unknown/unavailable overrides warn and fall back to the first available agent.
- **Why**: Different projects may warrant different agents (a Rust project might prefer Claude, a Python one Devin). Keeping the override as a default that the picker can override per-thread is the least surprising behavior. The resolution logic changes from `agent_by_id` to "found in discovered agents."
- **Source**: recommended-accepted
- **Amends**: `project-settings` spec requirement "Executor override" — the override still exists but resolves against ACP registry agents, not `KNOWN_AGENTS`.

## D19: Grill skills are baked into Floo, injected per-mode — no per-agent installation

- **Decision**: The four grill skills (explore, propose, apply, archive) are built into Floo, not installed in each ACP agent's own skill system. Floo injects the relevant skill's instructions into every `session/prompt` based on the thread's mode: spec-mode injects `grill-explore` (or `grill-propose` if a change exists); go-mode injects `grill-apply`. The user doesn't type a skill prefix — the mode determines the skill. `grill-archive` is triggered by a UI action when a change is ready to archive. The ACP agent receives the skill instructions as part of the prompt text; it never sees a "skill" construct. General skills (user-installed, per-agent) are out of scope.
- **Why**: The user wants the Socratic grilling + OpenSpec spec-driven development flow to work with every ACP agent without installing anything. Making skills per-agent (the old model) would break this — each agent has its own skill system and Floo can't install into it. Baking them into Floo and injecting per-mode is the only way they work universally.
- **Source**: user
- **Replaces**: the `skill_prefix` and `skill_dir` fields on the `Agent` struct, the per-agent skill preflight checks (already dropped in D16), and the concept of Floo relying on the agent's native skill system for grill skills.

## D20: openspec CLI commands are whitelisted in all modes

- **Decision**: Floo auto-approves ACP permission requests for `openspec` commands (list, show, validate, new, status) in all modes, including spec-mode where `execute` tool kinds are normally auto-denied. The grill skills cannot function without running `openspec`, and `openspec` operations are read-only/validate by design.
- **Why**: Spec-mode auto-denies `execute` (D15), but the grill skills need to shell out to `openspec` to read/validate changes. Without the whitelist, spec-mode would block the very tools it's supposed to enable.
- **Source**: recommended-accepted

## D21: All implementation follows TDD (Red-Green-Refactor, vertical slices)

- **Decision**: Every task in the implementation is built test-first, one test at a time, using vertical slices (one test → one implementation → repeat). No horizontal slicing (all tests then all implementation). Each test describes behavior through public interfaces, not implementation details. Tests must survive internal refactors.
- **Why**: The user explicitly requires TDD for all tasks. Vertical slices produce tests that verify actual behavior, not imagined behavior. The global rules mandate a failing test before implementation logic, and every feature must have at least one corresponding test.
- **Source**: user
- **Binding for grill-apply**: The implementer SHALL write a failing test for each task before writing the implementation. The test gate (task group 14) is the final verification, not the only verification — each task group has its own tests written as part of that group's Red-Green cycle.
