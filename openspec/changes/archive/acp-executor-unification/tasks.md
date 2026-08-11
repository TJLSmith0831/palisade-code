## 1. Worktree and dependency setup

- [ ] 1.1 Create git worktree branch `worktree/acp-unification` from main
- [ ] 1.2 Add `agent-client-protocol` v2.0.0 to `src-tauri/Cargo.toml` and verify it builds
- [ ] 1.3 Bundle the four grill skill SKILL.md files as Rust include_str resources in `executor.rs`

## 2. ACP Registry discovery and caching (TDD — one test per behavior, vertical slices)

- [ ] 2.1 RED: Write test for registry fetch — given a mock registry endpoint, fetch returns parsed `agent.json` manifests. GREEN: Implement HTTP fetch of `agent.json` via `raw.githubusercontent.com` + GitHub API contents endpoint for directory list + hardcoded fallback list
- [ ] 2.2 RED: Write test for cache hit/miss/expire — cache returns stale data after TTL, fresh data on refresh. GREEN: Implement cache at `~/.floo-network/acp-registry/` with 24h TTL and graceful fallback to cache on fetch failure
- [ ] 2.3 RED: Write test for PATH availability — a registry entry whose `cmd` is on PATH is available, one that isn't is excluded. GREEN: Implement PATH resolution for each registry entry's invocation `cmd` (reuse `find_on_path`)
- [ ] 2.4 RED: Write test for fetch-failure-with-no-cache fallback — returns empty or manual-config-only list. GREEN: Verify fallback behavior returns manual config agents or empty list

## 3. ACP client and session lifecycle (TDD — one test per behavior, vertical slices)

- [ ] 3.1 RED: Write test for ACP connect + initialize — given a mock ACP agent process, the client connects via Stdio and completes the `initialize` handshake. GREEN: Implement ACP client wrapper using `agent-client-protocol` crate
- [ ] 3.2 RED: Write test for session/new — client creates a session with the project root as cwd. GREEN: Implement session creation via `session/new`
- [ ] 3.3 RED: Write test for send (session/prompt) — sending a message calls `session/prompt` with the text. GREEN: Implement `send()` via `session/prompt`
- [ ] 3.4 RED: Write test for terminate (session/cancel) — terminating calls `session/cancel` and closes the transport. GREEN: Implement `terminate()` via `session/cancel` + transport close
- [ ] 3.5 RED: Write test for async/sync bridge — events from the crate's async loop arrive at the sync `Sink` callback. GREEN: Implement the bridge — async side on its own thread, sync side receives through a channel callback. Replace `Session` struct internals with ACP `ActiveSession` handle

## 4. ACP event mapping (TDD — one test per event type, vertical slices)

- [ ] 4.1 RED: Write test for `message_update` → `Text`/`Reasoning` mapping with ACP notification fixture. GREEN: Implement message_update mapper
- [ ] 4.2 RED: Write test for `message_update` partial → `TextDelta`/`ReasoningDelta` mapping. GREEN: Implement delta mapping for partial updates
- [ ] 4.3 RED: Write test for `tool_call_update` → `ToolCall`/`ToolResult` mapping. GREEN: Implement tool_call_update mapper
- [ ] 4.4 RED: Write test for stop reason → `Done` (normal) and `Crashed` (error) mapping. GREEN: Implement stop-reason mapper
- [ ] 4.5 RED: Write test for `usage_update` → session-status channel (not ExecutorEvent). GREEN: Implement usage_update extraction to separate status channel
- [ ] 4.6 RED: Write test that `plan_update` notifications produce no events. GREEN: Implement plan_update ignore

## 5. Permission handling (TDD — one test per policy, vertical slices)

- [ ] 5.1 RED: Write test for spec-mode auto-deny of `edit`/`delete`/`move`/`execute` tool kinds. GREEN: Implement spec-mode policy
- [ ] 5.2 RED: Write test for spec-mode auto-approve of `read`/`search`/`think`/`fetch` tool kinds. GREEN: Verify spec-mode read approval
- [ ] 5.3 RED: Write test for go-mode auto-approve of `read`/`search`/`think`/`fetch`/`edit`/`move`. GREEN: Implement go-mode policy
- [ ] 5.4 RED: Write test for go-mode prompt on `execute`/`delete`. GREEN: Implement go-mode prompt for shell/destructive
- [ ] 5.5 RED: Write test for bypass auto-approve of all tool kinds. GREEN: Implement bypass policy
- [ ] 5.6 RED: Write test for `openspec` whitelist — `execute` running `openspec` is auto-approved in spec-mode. GREEN: Implement openspec command whitelist
- [ ] 5.7 RED: Write test for non-openspec `execute` still denied in spec-mode. GREEN: Verify whitelist is scoped to openspec only
- [ ] 5.8 RED: Write test for ambiguous/`other` tool kind prompting the user. GREEN: Implement user prompt for ambiguous kinds

## 6. Grill skill injection (TDD — one test per mode, vertical slices)

- [ ] 6.1 RED: Write test that spec-mode with no change injects `grill-explore` skill instructions into the prompt. GREEN: Implement mode-to-skill mapping for spec/explore
- [ ] 6.2 RED: Write test that spec-mode with an existing change injects `grill-propose`. GREEN: Implement change-detection + grill-propose injection
- [ ] 6.3 RED: Write test that go-mode injects `grill-apply`. GREEN: Implement go-mode skill injection
- [ ] 6.4 RED: Write test that `grill-archive` UI action injects the archive skill. GREEN: Implement grill-archive as UI-triggered injection
- [ ] 6.5 RED: Write test that skill content is prepended to the user's message, not appended. GREEN: Verify prompt ordering

## 7. Mid-thread executor switch with context handoff (TDD — one test per step, vertical slices)

- [ ] 7.1 RED: Write test for transcript formatting — previous turns render as `User: ...\nAssistant: ...\n`. GREEN: Implement transcript formatter
- [ ] 7.2 RED: Write test for token-budget bounding — transcript exceeding `size` drops oldest turns first. GREEN: Implement `chars / 4` estimation + most-recent-first inclusion
- [ ] 7.3 RED: Write test for handoff — old session closed, new ACP session opened, transcript + new message sent as first `session/prompt`. GREEN: Implement the handoff flow
- [ ] 7.4 RED: Write test for switch with no previous turns — no confirmation, no transcript, fresh session. GREEN: Implement no-turns shortcut
- [ ] 7.5 RED: Write test for switch-confirmation dialog — warning shown with turn count and target agent before proceeding. GREEN: Implement confirmation modal (Mantine `Modal`)

## 8. Preflight and executor resolution (TDD — one test per behavior, vertical slices)

- [ ] 8.1 RED: Write test for preflight returning registry-discovered agents with PATH availability. GREEN: Rewrite `preflight()` for registry-based discovery
- [ ] 8.2 RED: Write test for preflight keeping `openspec`/`graphify` checks. GREEN: Verify Floo-level tool checks remain
- [ ] 8.3 RED: Write test for `resolve_executor` with valid override — returns the overridden agent. GREEN: Rewrite resolve_executor for ACP registry ids
- [ ] 8.4 RED: Write test for `resolve_executor` with unknown override — warns and falls back to first available. GREEN: Implement fallback warning
- [ ] 8.5 RED: Write test for `selected_executor` returning discovered agent metadata + invocation command. GREEN: Rewrite selected_executor return type

## 9. Remove old executor code (after new code passes its tests)

- [ ] 9.1 Remove `KNOWN_AGENTS`, `CLAUDE`, `CODEX` const definitions, `Transport` enum, `Agent` struct
- [ ] 9.2 Remove `parse_claude_line` and `parse_codex_line` parsers
- [ ] 9.3 Remove `pump()` function and `PumpCtx` struct
- [ ] 9.4 Remove `find_on_path`/`login_shell_path` if no longer used (check for other callers first)
- [ ] 9.5 Remove `SpawnCtx` struct and the old `Spawn` struct's agent-specific fields
- [ ] 9.6 Verify no remaining references to removed types compile

## 10. Frontend — executor picker (TDD — one test per behavior, vertical slices)

- [ ] 10.1 RED: Write test that the executor dropdown lists discovered ACP agents and allows selection. GREEN: Replace executor/model menu with executor-only dropdown
- [ ] 10.2 RED: Write test that the model row is absent from the menu. GREEN: Remove model row, `MODEL_ALIASES`, `MODELS`, model preference storage
- [ ] 10.3 RED: Write test that the bypass toggle still works and is visually distinct when enabled. GREEN: Wire bypass toggle to ACP permission-prompt suppressor
- [ ] 10.4 RED: Write test that selecting a different executor with existing turns shows a confirmation modal. GREEN: Add Mantine `Modal` switch-confirmation component
- [ ] 10.5 RED: Write test that preflight status button shows registry-discovered agents. GREEN: Update preflight status button
- [ ] 10.6 RED: Write test that executor picker is switchable (not read-only). GREEN: Update the existing read-only test to expect switchable behavior

## 11. Frontend — context usage donut (TDD — one test per state, vertical slices)

- [ ] 11.1 RED: Write test that the donut renders `used / size` percentage from `usage_update` data. GREEN: Add context-usage state + Mantine `RingProgress` donut
- [ ] 11.2 RED: Write test that color thresholds are correct (green < 60%, amber 60-85%, red > 85%). GREEN: Implement color threshold logic
- [ ] 11.3 RED: Write test that "unknown" state shows when no `usage_update` is received. GREEN: Implement unknown state
- [ ] 11.4 RED: Write test that hover tooltip shows absolute token counts. GREEN: Add tooltip

## 12. Frontend — API and IPC updates (TDD — one test per change, vertical slices)

- [ ] 12.1 RED: Write test that `Preflight` type matches the new registry-based agent list shape. GREEN: Update `Preflight` type in `api.ts`
- [ ] 12.2 RED: Write test for the executor-switch IPC command — takes thread id + target agent id. GREEN: Add IPC command + api.ts wrapper + register in `generate_handler!`
- [ ] 12.3 RED: Write test for the context-usage IPC command — returns `used`/`size` per session. GREEN: Add IPC command + api.ts wrapper + register in `generate_handler!`
- [ ] 12.4 Remove obsolete IPC commands and api.ts wrappers (model-related if any)

## 13. Settings update (TDD — one test per behavior, vertical slices)

- [ ] 13.1 RED: Write test that `executor_override` resolves against discovered ACP registry agent ids. GREEN: Update resolution in `settings.rs`
- [ ] 13.2 RED: Write test that unknown override warns and falls back without discarding other settings. GREEN: Verify fallback behavior
- [ ] 13.3 RED: Write test that no override defaults to first available discovered agent. GREEN: Verify default behavior

## 14. Full test gate

- [ ] 14.1 Run `cd src-tauri && cargo test` — all Rust tests pass
- [ ] 14.2 Run `pnpm test` — all frontend tests pass
- [ ] 14.3 Run `npx tsc --noEmit` — typecheck passes
- [ ] 14.4 Run `pnpm build` — build succeeds
- [ ] 14.5 Manually verify: switch between Claude, Devin, and OpenCode in the picker; confirm context handoff; confirm permission prompts in spec/go/bypass; confirm grill skills inject per mode; confirm usage donut renders
