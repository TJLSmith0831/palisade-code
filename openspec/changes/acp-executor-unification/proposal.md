## Why

Floo can only use the two executors it was compiled to know about (Claude, Codex). The user has three coding agents on their laptop — Claude, Devin CLI, and OpenCode — and cannot switch between them without recompiling. The Agent Client Protocol (ACP) is now a mature standard with a registry that every major coding agent speaks, making runtime discovery of any conforming executor possible without per-agent parsers compiled into Floo.

## What Changes

- **BREAKING**: Replace the compiled-in `KNOWN_AGENTS` table and proprietary stream-json parsers (Claude, Codex) with a single ACP client. All executors are now discovered at runtime via the ACP Registry and spoken to over ACP (JSON-RPC 2.0 over stdio).
- **BREAKING**: Migrate Claude and Codex to their ACP adapters (`@agentclientprotocol/claude-agent-acp`, `@agentclientprotocol/codex-acp`). The installed `claude` and `codex` CLI binaries are no longer invoked directly.
- The top-chrome executor row becomes a user-switchable dropdown of all discovered ACP agents (reverses the prior read-only auto-detected display).
- The model picker row is removed — each ACP agent owns its own model configuration.
- Mid-thread executor switching starts a fresh ACP session with the new agent, passing the previous conversation turns as a raw-text transcript (token-budget-bounded via ACP `usage_update`) after a confirmation warning dialog.
- Spec/go/bypass modes become ACP permission-response policies: spec auto-denies writes, go auto-approves edits but prompts for shell execution, bypass auto-approves everything.
- A context-usage donut (Mantine `RingProgress`) renders `used / size` from ACP `usage_update` notifications.
- `executorOverride` in `.project-settings.json` survives as a per-project default, now resolving against ACP registry agent ids.
- Preflight drops per-agent skill/plugin checks; keeps `openspec` and `graphify` availability checks. Agent availability is derived from the ACP registry cross-referenced with PATH.
- The four grill skills (explore, propose, apply, archive) are baked into Floo and injected into every `session/prompt` based on the thread's mode — no per-agent skill installation required. `openspec` CLI commands are whitelisted for auto-approval in all modes so the grill flow works in spec-mode.

## Capabilities

### New Capabilities

- `acp-executor-transport`: ACP client lifecycle (connect, session/new, session/prompt, session/cancel), ACP Registry discovery and caching, ACP event-to-ExecutorEvent mapping, ACP permission-request handling with spec/go/bypass policies, context-usage reporting from `usage_update`, grill skill injection per mode, openspec command whitelisting.

### Modified Capabilities

- `agent-registry`: Compiled-in `KNOWN_AGENTS` table model replaced by runtime ACP registry discovery. "Byte-identical argv and parsed events" guarantee removed. "Unknown override warns" requirement amended to resolve against ACP registry agent ids. Per-agent skill/plugin preflight checks removed.
- `executor-model-switcher`: Executor row becomes user-switchable (reverses read-only rule). Model row removed (agents own their models). Bypass toggle reinterpreted as ACP permission-prompt suppressor.
- `project-settings`: `executorOverride` resolves against ACP registry agent ids instead of `KNOWN_AGENTS` ids.

## Impact

- **Rust backend** (`src-tauri/src/executor.rs`): `KNOWN_AGENTS`, `Transport` enum, `Agent` struct, both parsers (`parse_claude_line`, `parse_codex_line`), `Session` internals, `pump()`, `start()`, `send()` — all rewritten against the `agent-client-protocol` crate. `preflight()` restructured for registry-based discovery.
- **Rust backend** (`src-tauri/src/lib.rs`): `resolve_executor`, `selected_executor`, `start_session`, `ensure_session` — updated for ACP session lifecycle and per-project default resolution against discovered agents.
- **Rust backend** (`src-tauri/src/settings.rs`): `executor_override` field type/semantics unchanged but resolution target changes.
- **Frontend** (`src/App.tsx`): executor/model menu becomes executor-only dropdown with bypass toggle; model row and Claude-specific model aliases removed; context-usage `RingProgress` added; switch-confirmation modal added.
- **Frontend** (`src/api.ts`): `Preflight` type updated for registry-based agent list; new IPC for executor switching and context-usage status.
- **Dependency**: `agent-client-protocol` v2.0.0 added to `src-tauri/Cargo.toml`.
- **Tests**: 173 existing Rust tests rewritten against ACP event shapes and the new session lifecycle. Frontend tests for the executor picker updated (read-only → switchable, model row removed).
- **Git**: Work on a worktree branch (`worktree/acp-unification`); main stays functional during the rewrite.
