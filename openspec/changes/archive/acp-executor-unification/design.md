## Context

Floo's executor layer (`src-tauri/src/executor.rs`) currently has two compiled-in agents (Claude, Codex) with proprietary stream-json parsers, a `Transport` enum (Persistent vs PerTurn), and a `KNOWN_AGENTS` table. The `agent-client-protocol` Rust crate v2.0.0 provides a mature ACP client (`Client`, `Stdio` transport, `ActiveSession`) with full JSON-RPC lifecycle. The ACP Registry (`github.com/agentclientprotocol/registry`) provides per-agent `agent.json` manifests with invocation commands. See proposal.md for motivation.

## Goals / Non-Goals

**Goals:**

- Single ACP transport replaces both proprietary parsers — one code path for all executors.
- Runtime discovery via the ACP Registry — new agents appear without recompiling Floo.
- User-switchable executor picker with mid-thread context handoff.
- ACP-native permission handling with spec/go/bypass policies.
- Context-usage visualization from ACP `usage_update`.

**Non-Goals:**

- No custom ACP agent — Floo is a client only (D10).
- No ACP registry publishing — Floo consumes, does not publish (D10).
- No model selection in Floo — agents own their models (D11).
- No offline registry bundling — fetched at runtime, cached (D10).
- No migration of existing session history — old records stay as-is (D10).
- No `plan_update` rendering — ignored in v1 (D13).

## Decisions

### D1–D4: Full unification, big bang, on a worktree

Runtime-discoverable (D1) via ACP Registry auto-scan (D2), with full unification of Claude and Codex under ACP (D3), executed as a big-bang rewrite on a git worktree (D4). The worktree branch (`worktree/acp-unification`) isolates the rewrite; main stays functional.

**Alternative considered (D3):** Keep Claude/Codex as compiled-in proprietary parsers alongside an ACP client for new agents. Rejected — the user wants one clean abstraction, not two transport types coexisting.

**Alternative considered (D4):** Incremental migration (ACP alongside, migrate one agent at a time). Rejected — the user wants the clean break, and the worktree isolates the risk.

### D5, D11: Picker becomes executor-only, user-switchable — **D11 REVERSED 2026-08-11**

The composer provider row is a dropdown of discovered ACP agents (D5). ~~The model row is removed~~ **D11 is reversed:** the composer has two menus, [Provider] [Model], and provider selection feeds the model menu. The original D11 rationale — "ACP's `session/new` doesn't take a model parameter" — was wrong about the protocol: `session/new` returns `config_options`, and an agent's `model`-category select option _is_ its model menu; `session/set_config_option` changes it. Model lists are probed live from the agent (a throwaway `session/new`), never hardcoded, so the menu only ever shows models the installed agent actually offers.

**Also corrected 2026-08-11:** "available" means _installed_, not "npx exists". Registry binary cmds are archive-relative (`./bin/devin`), so PATH probing uses the bare binary name; npx-distributed agents count only when the package is already in the local npm cache (`~/.npm/_npx/*/node_modules/<pkg>` or the global root). This is what stops never-installed registry entries from heading the list.

**Alternative considered (D11, original):** Build a per-agent model surface in Floo. Rejected at the time — ACP's `session/new` doesn't take a model parameter; model selection is the agent's responsibility. Matches Zed's external-agent picker design.

### D6–D9: Mid-thread switch with context handoff

Switching executors mid-thread starts a fresh ACP session and passes the previous turns as a raw-text transcript (D7), token-budget-bounded via ACP `usage_update` (D8), per-thread, confirmed with a warning dialog (D9).

**Alternative considered (D7):** Structured ACP `embeddedContext` or model-generated summary. Rejected — `embeddedContext` support varies by agent; summary adds cost and loses fidelity. Raw text works universally.

**Alternative considered (D8):** Fixed turn window (e.g. last 10). Rejected — blind to turn length and model context limits. Token-budget adapts to both. Uses `chars / 4` heuristic for estimation (no tokenizer dependency); the agent's `usage_update` confirms the real count after the prompt is sent.

### D12–D13: ACP permission flow and event mapping

ACP `permission_request` notifications are handled by Floo as the permission gate (D12). Spec/go/bypass become permission-response policies using ACP's tool-kind taxonomy (D15). The bypass toggle stays as "suppress all prompts." ACP `session/update` notifications map into the existing 9-variant `ExecutorEvent` enum (D13) — the frontend rendering contract is unchanged.

**Alternative considered (D12):** Pass permission config to the agent at `session/new` time. Rejected — not standardized in ACP; back to per-agent behavior.

**Alternative considered (D13):** Replace `ExecutorEvent` with ACP-native types. Rejected — breaks the `event-routing` envelope guarantee and all frontend rendering. Mapping into the existing enum means only the backend changes.

### D14, D16: Registry fetch and preflight

Registry fetched via GitHub raw URLs, cached at `~/.floo-network/acp-registry/` with 24h TTL (D14). Preflight becomes registry + PATH availability check; Floo-level `openspec`/`graphify` checks stay, per-agent skill/plugin checks dropped (D16).

**Alternative considered (D14):** Clone the registry repo. Rejected — adds a git dependency for a read-only JSON cache. Bundle a snapshot at build time. Rejected — build-time complexity, snapshot goes stale.

### D15: Mode as permission-response policy

Spec-mode: auto-approve reads, auto-deny writes/execution. Go-mode: auto-approve reads/edits/moves, prompt for execution/delete. Bypass: auto-approve everything. Grounded in research of Claude Code (`plan`/`acceptEdits`/`bypassPermissions`), Codex CLI (`read-only`/`workspace-write`/`danger-full-access`), and Devin CLI (`Normal`/`Accept Edits`/`Bypass`) — all use the same three-tier model.

### D17: Session internals replaced with ACP ActiveSession

The `Session` struct keeps identity fields (`id`, `thread_id`, `project_hash`, `mode`, `busy`) but replaces process internals (`Child`, `ChildStdin`, `turn_child`, `pump`) with an ACP `ActiveSession` from the `agent-client-protocol` crate. The crate's async event loop runs on its own thread; callbacks bridge to Floo's sync `Sink` trait. `terminate()` calls `session/cancel` + closes transport. `send()` calls `session/prompt`.

**Alternative considered:** Keep the raw process model, implement ACP JSON-RPC by hand. Rejected — reimplements what the crate already provides (request/response correlation, notification dispatch, cancellation).

### D18: executorOverride as per-project default

`executorOverride` in `.project-settings.json` survives as a per-project default, resolving against ACP registry agent ids. New threads default to the override; the picker can override per-thread.

### D19–D20: Grill skills baked into Floo, openspec whitelisted

The four grill skills (explore, propose, apply, archive) are built into Floo as bundled resources, not installed in each ACP agent's skill system (D19). Floo injects the relevant skill's instructions into every `session/prompt` based on the thread's mode — spec-mode gets `grill-explore`/`grill-propose`, go-mode gets `grill-apply`, archive is a UI action. The agent receives skill content as prompt text; no reliance on native skill systems. `openspec` CLI commands are whitelisted for auto-approval in all modes (D20), including spec-mode, because the grill skills cannot function without shelling out to `openspec`.

**Alternative considered (D19):** Per-agent skill installation with preflight warnings. Rejected — the user wants grill skills to work with every ACP agent without installing anything. Each agent has its own skill system; Floo can't install into it. Prompt injection is the only universal approach.

## Risks / Trade-offs

- **[Adapter dependency]** Claude and Codex run via third-party ACP adapters (`@agentclientprotocol/claude-agent-acp`, `@agentclientprotocol/codex-acp`), not their native CLIs. New CLI features ship in the CLI first, then the SDK, then the adapter — Floo may lag behind. → _Mitigation:_ the adapters are maintained by the ACP project (Zed Industries, Anthropic, JetBrains, OpenAI collaborate). Monitor adapter releases; pin adapter versions in the registry cache and surface update availability.

- **[Async/sync bridge]** The `agent-client-protocol` crate uses `async-io`/`async-process` (smol runtime); Floo's current code is sync std threads. The ACP event loop runs on its own thread and calls back into the sync `Sink` trait. → _Mitigation:_ the bridge is a single callback boundary — the async side collects events, the sync side receives them through a channel. No async leaks into Floo's sync architecture.

- **[Registry network dependency]** First-run requires a network fetch of the ACP Registry. If offline with no cache, only manually-configured agents appear. → _Mitigation:_ 24h cache TTL; hardcoded fallback list of popular agent IDs (claude-acp, codex-acp, opencode, gemini, devin) for first-run when the GitHub API is unreachable; manual config fallback for fully offline use.

- **[Token estimation inaccuracy]** The `chars / 4` heuristic for transcript budgeting can be off by 10-20% for non-English or code-heavy content. → _Mitigation:_ the estimate only affects how many turns are included in the handoff — being off by one turn is acceptable. The agent's `usage_update` confirms the real count immediately after the prompt is sent, and the donut chart corrects.

- **[Test rewrite scale]** 173 existing Rust tests depend on the current parsers and session model. The big-bang rewrite invalidates all of them. → _Mitigation:_ the worktree isolates the rewrite. Tests are rewritten against ACP event shapes using the crate's example/test patterns. The `agent-client-protocol` crate's own test suite validates the transport layer; Floo's tests focus on event mapping and permission policy.

- **[ACP agent auth variability]** Different ACP agents handle authentication differently (ChatGPT login, API key, Google login). Floo's `initialize` handshake receives `authMethods` but doesn't handle the auth flow itself. → _Mitigation:_ agents own their auth (same as Zed's model). Floo surfaces auth-required states to the user; the agent's own login flow handles the rest. This is an open question if auth flows prove problematic in practice.

## Migration Plan

1. Create worktree branch `worktree/acp-unification` from main.
2. Add `agent-client-protocol` v2.0.0 to `src-tauri/Cargo.toml`.
3. Implement the ACP registry fetch/cache module.
4. Implement the ACP client (connect, session lifecycle, event mapping, permission handling).
5. Replace `executor.rs` internals — remove `KNOWN_AGENTS`, `Transport`, parsers, `pump`; rewrite `Session`, `start`, `send`, `terminate` against ACP.
6. Update `lib.rs` — `resolve_executor`, `selected_executor`, `start_session`, `ensure_session`, `preflight`.
7. Update `settings.rs` — `executor_override` resolution against discovered agents.
8. Update `App.tsx` — executor dropdown, remove model row, bypass toggle, context-usage donut, switch-confirmation modal.
9. Update `api.ts` — new `Preflight` type, new IPC for switching and usage status.
10. Rewrite Rust tests against ACP event shapes; update frontend tests.
11. Merge worktree to main when all tests pass.

**Rollback:** The worktree branch is disposable. If the rewrite doesn't converge, abandon the branch — main is untouched and functional.

## Open Questions

- **ACP agent auth flows:** Different agents authenticate differently (ChatGPT, API key, Google). Floo surfaces auth-required states but doesn't handle the login itself. If auth flows prove problematic in practice (e.g. an agent's auth requires interactive input that Floo can't relay), this may need a follow-up to handle auth prompts in the UI. Deferrable — the major agents (Claude, Codex, Devin, OpenCode) handle auth in their own CLIs/configs before ACP mode is entered.
