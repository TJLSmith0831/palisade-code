# Explore: Switch Between Any Executor

**Topic:** Let the user switch between any executor on their system (e.g. Claude, Devin CLI, OpenCode) — not just the two compiled into `KNOWN_AGENTS` today, and not just the read-only auto-detected display the current picker shows.

**Started:** 2026-08-10

## Context

What exists today:

- `KNOWN_AGENTS` in `executor.rs:83` is a compiled-in `&[Agent]` with two rows: `CLAUDE` and `CODEX`. Each row carries id, bin, transport (Persistent | PerTurn), skill/plugin dirs, permission fn, argv fn, parser fn.
- `agent-registry` spec already establishes the table model: "adding a third agent touches only the table and its parser."
- `executor-model-switcher` spec explicitly says the executor row in the UI picker is **read-only, auto-detected, cannot be manually overridden** — "the executor row SHALL be a read-only display of the auto-detected executor." The model row is user-selectable; the executor is not.
- `project-settings` spec has `executorOverride` — a string id resolved against `KNOWN_AGENTS`. So per-project override to a _known_ agent exists, but only via JSON editing, no UI, and unknown ids warn + fall back.
- `resolve_executor` (`lib.rs:312`) implements: override-id → known-and-installed → use it; known-but-missing → warn + auto; unknown → warn + auto. Auto = first row in table order with a path.
- `preflight()` (`executor.rs:278`) builds one `AgentStatus` per `KNOWN_AGENTS` row, picks `selected` = first with a path.

What the user has on this machine (all on PATH):

- `claude` 2.1.227 — Claude Code. Persistent stdin JSON (`--print --output-format stream-json`).
- `codex` 0.146.0 — Codex CLI. Per-turn `codex exec --json`.
- `devin` 2026.8.18 — Devin CLI. Has `-p/--print`, `--permission-mode` (auto/accept-edits/smart/dangerous), `--sandbox`, `--model`, `-r/--resume <id>`, `acp` (ACP over stdio), skills/plugins/rules.
- `opencode` — OpenCode. TUI-first; `opencode run [msg] --format json` (raw JSON events), `-c/--continue`, `-s/--session`, `-m provider/model`, `--agent`, `acp` (ACP over stdio), `serve` (headless HTTP).

Key architectural fact: **Devin CLI and OpenCode both speak ACP (Agent Client Protocol) over stdio.** Claude and Codex do not (they have their own stream-json formats). This creates a fork in how "any executor" gets added.

## Decisions

<!-- Entries appended as things settle. Format:
## D<n>: <the question, one line>
- **Decision**: <what was settled>
- **Why**: <one sentence>
- **Source**: user | codebase (<path:line>) | recommended-accepted
-->

## D1: Compiled-in table rows vs runtime-discoverable

- **Decision**: Runtime-discoverable. The user wants to plug in a new executor CLI without recompiling Floo.
- **Why**: "Any executor" is literal and ongoing, not just the three on this machine today.
- **Source**: user
- **Tradeoff**: This rules out option A (add Devin/OpenCode as compiled-in `KNOWN_AGENTS` rows). It points toward a shared transport that any conforming CLI can speak without a per-agent parser compiled into Floo. ACP (Agent Client Protocol) over stdio is the only such standard present — both Devin CLI and OpenCode expose `acp` subcommands; Claude and Codex do not.

## D2: Discovery mechanism — registry-backed auto-scan

- **Decision**: Auto-scan backed by the ACP Registry. Floo fetches/caches the registry, cross-references each entry's invocation against PATH, and surfaces available agents automatically. No config file for registry-known agents; manual config fallback for agents not in the registry.
- **Why**: True runtime discoverability — the user installs an ACP agent and Floo finds it without a recompile or a config edit. The registry provides the exact `cmd` + `args` to invoke ACP mode per agent, solving the "how do I know which flag/subcommand starts ACP?" problem without probing every binary on PATH.
- **Source**: recommended-accepted (confirmed viable via web research)
- **Research notes**:
  - ACP (Agent Client Protocol) is a mature JSON-RPC 2.0 over stdio standard. Published schema, Rust crate (`agent-client-protocol` on crates.io), TypeScript/Kotlin/Java/Python SDKs.
  - `initialize` handshake returns `{ info: { name, title, version }, capabilities, authMethods }` — enough to populate a picker without spawning a full session.
  - **ACP Registry** (`github.com/agentclientprotocol/registry`): one directory per agent, each with an `agent.json` manifest. Entries include `id`, `name`, `version`, `distribution` (either `npx` package or platform-specific `binary` with `cmd` + `args` + `sha256`).
  - Registry agents confirmed: Claude (via `claude-acp` adapter), Codex (via `codex-acp` adapter), Gemini CLI (native `--acp`), OpenCode (native `acp` subcommand), Devin (native `acp` subcommand), Cursor (via `cursor-agent-acp`), GitHub Copilot CLI, Cline, Amp, and many more.
  - Zed and JetBrains already consume this registry for their external-agent pickers — Floo would be following a proven pattern, not inventing one.
  - Each agent's `agent.json` tells Floo exactly how to invoke ACP mode: e.g. OpenCode = `["opencode", "acp"]`, Claude = `["npx", "@agentclientprotocol/claude-agent-acp"]`, Gemini = `["gemini", "--acp"]`.
- **Tradeoff**: Floo now depends on a network fetch of the registry (cacheable, refreshable on demand). Agents not in the registry need a manual config entry. The `agent-registry` spec's "compiled-in table" model is superseded for ACP agents — Claude/Codex proprietary parsers may coexist or be migrated (see D3).

## D3: Full unification under ACP

- **Decision**: Migrate Claude and Codex to their ACP adapters too. One transport (ACP), one parser, one code path. Drop the proprietary stream-json parsers and the `KNOWN_AGENTS` compiled-in table.
- **Why**: User chose B — the user wants a single clean abstraction, not two transport types coexisting. Simpler executor layer, every agent discovered the same way.
- **Source**: user
- **Tradeoff / risk**: This is a big rewrite. It supersedes the `agent-registry` spec's "compiled-in table" model and breaks its "byte-identical argv and parsed events" guarantee. The 173 Rust tests that depend on the current parsers need rewriting against ACP event shapes. Additionally, Claude and Codex ACP support comes via **third-party adapters** (`@agentclientprotocol/claude-agent-acp` wraps the Claude Agent SDK, not the `claude` CLI; `codex-acp` starts the Codex App Server, not `codex exec`) — Floo becomes dependent on adapter maintenance and may lag behind native CLI features. The user's installed `claude` 2.1.227 CLI binary is no longer what runs; the adapter's SDK version is.

## D4: Migration strategy — big bang on a worktree

- **Decision**: Big bang. Rip out `KNOWN_AGENTS`, the proprietary parsers, and the `Transport` enum in one change. Ship ACP-only. Run the work on a git worktree so the main branch stays functional during the rewrite.
- **Why**: User wants the clean break, not a transitional period where two transport types coexist. The worktree isolates the rewrite — main keeps working, the worktree branch is the one that's broken until the ACP client is complete.
- **Source**: user
- **Note**: Worktrees are already a pattern in this repo (`.claude/worktrees/agent-session-architecture` exists). The worktree branch should be named to reflect the rewrite, e.g. `worktree/acp-unification`.

## D5: Executor is user-switchable in the global picker

- **Decision**: The top-chrome executor row becomes a dropdown of all discovered ACP agents. Switching changes the active executor. This reverses the `executor-model-switcher` spec's "executor row SHALL be read-only, cannot be manually overridden" requirement.
- **Why**: The user's goal is to switch between any executor freely; a read-only auto-detected display defeats the purpose. The prior read-only rule was a design decision, not a constraint — this change overturns it explicitly.
- **Source**: user
- **Supersedes**: `executor-model-switcher` spec requirement "Top-chrome executor/model picker" (the executor-row-is-read-only scenario). The model-selection and bypass-permissions-toggle requirements of that spec remain.

## D6: Mid-thread switch does a context handoff, not a cold start

- **Decision**: Switching executors mid-thread starts a fresh ACP session with the new agent, but Floo passes the previous conversation turns + the new message into the new agent's first prompt. A warning is shown to the user before the handoff ("this agent can't resume the previous session — your history will be passed as context").
- **Why**: A cold start wastes the thinking already done; passing the transcript as context gives the new agent a running start without pretending it's a real resume. The warning makes the limitation honest — it's context injection, not session continuity.
- **Source**: user
- **Flow**: N previous turns with agent A → user switches to agent B → Floo shows warning → user confirms → Floo opens a new ACP session with B and sends the first prompt containing the formatted transcript of the previous turns + the user's new message.
- **Note**: This is not ACP `session/load` (which is agent-scoped and can't cross agents). It's a one-way context transfer via the new agent's first `session/prompt`. The old messages stay in Floo's append-only store, visible in chat history; the new agent ingests them as text context, not as native session state.

## D7: Transcript format — raw text

- **Decision**: The previous turns are formatted as a readable text transcript (`User: ...\nAssistant: ...\n` etc.) and sent as the first prompt's text to the new agent, followed by the user's new message.
- **Why**: Universal compatibility — every ACP agent accepts text prompts, while `embeddedContext` support and shape vary by implementation. Keeps the unification clean (no per-agent formatting logic).
- **Source**: recommended-accepted

## D8: Transcript windowing — token-budget-bounded, adaptive to the model

- **Decision**: Pass as many previous turns as fit within the new agent's context window, most-recent-first, dropping older turns when the budget is hit. The budget is derived from the agent's own reported context window size (via ACP `usage_update`), not a hardcoded number.
- **Why**: A fixed turn count is blind to turn length and model context limits; a token budget adapts to both. The user wants this adaptive and visualized like Devin Desktop's context-usage pie chart.
- **Source**: user
- **Research — the right approach (confirmed via web research 2026-08-10)**:
  - **ACP `usage_update` is stabilized** (June 2026). Agents send `session/update` notifications with `sessionUpdate: "usage_update"`, carrying `used` (tokens in context) and `size` (total context window in tokens), plus optional `cost`. This is the authoritative source for context usage — Floo doesn't guess the window size, the agent reports it.
  - **For the live pie chart**: Floo consumes `usage_update` notifications and renders `used / size` as a donut/ring. No local tokenizer needed — the agent's own count is authoritative. Agents that can't report usage simply don't send `usage_update` (per spec: "if an agent cannot provide a meaningful context window size, it should not send `usage_update`"), and the chart shows "unknown."
  - **For the handoff transcript budgeting**: Floo opens the new ACP session (`session/new`), receives the first `usage_update` with `size`, then estimates the transcript's token count locally to decide how many turns fit. The estimate uses a `chars / 4` heuristic (the universal cheap fallback used by `tt-tokenize`, `agentfit`, and `polaris-ai` for unknown models) — precise enough for "how many turns fit" without a tokenizer dependency. Turns are included most-recent-first until `estimated_transcript_tokens + reserved_for_new_message + system_overhead` approaches `size`. After the prompt is sent, the agent's `usage_update` confirms the real count and the pie chart reflects actual usage.
  - **Why not a real tokenizer (tiktoken-rs / tiktoken crate)?** The `tiktoken` crate (pure-Rust, 15-40x faster than tiktoken-rs) supports OpenAI/Llama/DeepSeek/Qwen/Mistral but not Claude or Gemini natively. Claude uses `cl100k_base` as an approximation. The handoff budgeting decision doesn't need exact counts — being off by 10% means one turn more or less, and the agent's `usage_update` corrects the display immediately. A `chars / 4` heuristic avoids a tokenizer dependency for a decision where precision doesn't change the outcome. If precision matters later (e.g. showing a pre-send token estimate), upgrade to the `tiktoken` crate.
  - **Devin Desktop's pie chart** is a donut/ring showing `usedTokens / windowTokens` as a percentage, with breakdown by prompt/completion/reasoning. Floo's version: a Mantine `RingProgress` (per the UI-components-only rule) showing `used / size`, with color thresholds (green < 60%, amber 60-85%, red > 85%). Hover tooltip shows absolute token counts.
- **Tradeoff**: Agents that don't send `usage_update` get no pie chart and no adaptive budgeting — the handoff falls back to a fixed turn window (e.g. last 10) for those. This is acceptable since the major agents (Claude, Codex, Gemini, OpenCode, Devin) all support `usage_update` per the stabilized RFD.

## D9: Switch is per-thread, confirmed with a warning dialog

- **Decision**: Switching executors affects only the current thread. Before the handoff, a modal warning dialog explains the consequence ("Your N turns with <old agent> will be passed as text context to <new agent>. The new agent starts a fresh session — this can't be undone.") and requires explicit confirmation.
- **Why**: Per-thread because the handoff (transcript + fresh ACP session) is inherently per-thread — a global switch would trigger handoffs on every thread simultaneously. A confirmation dialog because the context transfer is one-way and irreversible — the user must know what they're committing to before the old session is released and the new one starts.
- **Source**: user

## Open questions

(none — all scope questions settled)
