## 0. Stop the bleeding (store-integrity)

Fixes confirmed live data-integrity defects before any structural change lands on top of them. No dependencies.

- [ ] 0.1 Add `floo_home: PathBuf` to `Session`; `send()`'s Codex branch uses it instead of calling `store::floo_home()` (fixes the leak polluting the real `~/.floo-network/projects/` on every `cargo test` run)
- [ ] 0.2 `list_projects` reconciles the index against `projects/*/project.json` on read, adopting any directory with a valid `project.json` that's missing from `projects.json`
- [ ] 0.3 Add a next-seq cache to `Harness` (keyed on resolved log path) so `append_message` stops re-reading the entire log per append; fall back to a re-read when the cache is absent
- [ ] 0.4 Cap persisted `FileEdit.before`/`after` and `ToolResult.output` at 64 KB with a truncation marker in `persist()`; the emitted (live-rendered) event keeps the full payload
- [ ] 0.5 Test: a Codex fixture session with a tempdir `floo_home` writes only into that tempdir — assert the real `~/.floo-network` is untouched
- [ ] 0.6 Test: `list_projects` surfaces a project directory whose `project.json` exists but whose index entry was removed
- [ ] 0.7 Test: 500 appends produce correct monotonic `seq` and read back in order
- [ ] 0.8 Test: a `FileEdit` with a 1 MB `after` persists truncated with a marker while the emitted event stays whole
- [ ] 0.9 Verify `cd src-tauri && cargo test` leaves `~/.floo-network/projects`'s directory count unchanged before/after the run

## 1. Event envelope (event-routing)

Every event carries `session_id` and `thread_id`. Depends on: Phase 0.

- [ ] 1.1 Add `Envelope { session_id, thread_id, event }`; change `Sink::emit` to take `&Envelope`
- [ ] 1.2 `pump()` wraps every emitted event in an `Envelope`
- [ ] 1.3 `AppSink`'s `Crashed`/`Done` side effects (`on_crash`, `pending_propose`) read ids from the envelope rather than fields captured at construction
- [ ] 1.4 `Message` gains `#[serde(default)] session_id: Option<String>`; writer sets it, legacy rows parse with `None`
- [ ] 1.5 `api.ts`: typed `Envelope` wrapper for the `executor-event` listener
- [ ] 1.6 `App.tsx`: `live` becomes `Map<session_id, ExecutorEvent[]>`; chat surface renders the sessions belonging to the active thread
- [ ] 1.7 Test: every emitted event carries the originating session's id
- [ ] 1.8 Test: events from session A do not appear in a view scoped to session B
- [ ] 1.9 Test: a persisted message records its `session_id`; a legacy message without one still parses
- [ ] 1.10 Confirm `mergeDeltas` and `itemsFromMessages` (`EventView.tsx`) stay untouched — only their inputs change

## 2. Session as a first-class entity (concurrent-sessions)

Sessions are identified, persisted, listable, and concurrent. Depends on: Phase 1 (routing must exist before two sessions can run).

- [ ] 2.1 `Harness.sessions: Mutex<HashMap<SessionId, Session>>` replaces `Mutex<Option<Session>>`
- [ ] 2.2 New `SessionRecord` type + store API: written open on `start_session`, closed with outcome (`done`/`crashed`/`cancelled`/`interrupted`) to `<ulid>.sessions.jsonl`
- [ ] 2.3 `provider_handle` moves off `ThreadMeta` onto `SessionRecord`; `ThreadMeta.executor_session_id` field is removed
- [ ] 2.4 Legacy-shim: on read, a thread with an old `executorSessionId` and no `sessions.jsonl` synthesizes one closed record with `agent_id: "claude"`
- [ ] 2.5 `ensure_session` → `start_session(thread, agent, mode) -> SessionId` + `find_live_session(thread, mode)`
- [ ] 2.6 Per-session `busy`; `executor_status` returns a list instead of `Option<(String, bool)>`
- [ ] 2.7 Fix Codex turn cancellation: keep the per-turn `Child` reachable via `Arc<Mutex<Option<Child>>>` shared with the pump thread so `terminate()` can kill it
- [ ] 2.8 Warn (not block) when starting a session while another live session shares the project root
- [ ] 2.9 Audit every `harness.session.lock()` call site (including the double-acquire at the current `ensure_session` call path) for re-entrancy under the new map
- [ ] 2.10 `delete_thread`'s busy guard checks *all* of a thread's sessions, not one
- [ ] 2.11 `api.ts` / `App.tsx`: per-session busy state, session list per thread
- [ ] 2.12 Test: two sessions on one thread with different agents both run; events route correctly
- [ ] 2.13 Test: two sessions on different threads run concurrently
- [ ] 2.14 Test: a session record is written on open and closed with the correct outcome for done/crashed/cancelled
- [ ] 2.15 Test: restart marks a record with no `ended_at` as `interrupted`
- [ ] 2.16 Test: a thread with only a legacy `executorSessionId` yields exactly one synthesized `claude` record
- [ ] 2.17 Test: cancelling a Codex turn actually kills the process
- [ ] 2.18 Test: `delete_thread`'s busy guard refuses when any of the thread's sessions is busy
- [ ] 2.19 Verify `pnpm test` and `cargo test` both green

## 3. Agent table / BYOA (agent-registry)

Adding an agent becomes one table row. Depends on: Phase 2 (so `agent_id` lands on `SessionRecord` in its final form).

- [ ] 3.1 Define `Agent` struct + `Transport` enum + `KNOWN_AGENTS: &[Agent]` const table, replacing `enum Kind`
- [ ] 3.2 `Preflight.agents: Vec<AgentStatus>` replaces the named `claude`/`codex` fields; `AgentStatus{id, label, path, skills_ok, plugin_ok}`
- [ ] 3.3 `resolve_executor`/`selected_executor` iterate `KNOWN_AGENTS` instead of `match`ing named fields
- [ ] 3.4 `executor_override: Option<String>` (was `Option<Kind>`), resolved against `KNOWN_AGENTS` by id; unknown name warns and falls back instead of dropping the whole settings file to defaults
- [ ] 3.5 `tool_event()` becomes private to the Claude parser; `parse_codex_line` stops hardcoding `"Bash"` and uses Codex's actual tool naming
- [ ] 3.6 `ensure_graphify_mcp`'s match stays as-is (per-provider MCP config formats are a real difference, not BYOA friction)
- [ ] 3.7 `api.ts` / `EventView.tsx`: iterate `agents` from `Preflight` instead of naming `claude`/`codex`; no `"claude" | "codex"` union type remains
- [ ] 3.8 Test: a synthetic third agent added to `KNOWN_AGENTS` (plus its parser) is detected, selectable, spawnable against the fake-executor stub, and rendered — with no diff outside the table and that parser
- [ ] 3.9 Test: an `executorOverride` naming an unknown agent warns and falls back, leaving `formatOnSave` intact
- [ ] 3.10 Test: existing Claude and Codex argv and parsed-event output are unchanged (pin against the pre-existing fixtures)

## 4. Spec reference via the OpenSpec CLI (spec-reference)

Stop inferring the spec link; ask the CLI. Independent of phases 1–3; sequenced here as lower priority.

- [ ] 4.1 `newly_added_change` replaced: shell out to `openspec list --json` before/after, take the added name
- [ ] 4.2 Two changes appearing during one propose turn surfaces a user-visible prompt instead of returning `None` silently
- [ ] 4.3 New read-only spec pane: `openspec list --json` + `openspec change show <name> --json` + `openspec change validate`, cached per project, invalidated on the existing `graphify-updated`-style event or on demand
- [ ] 4.4 Guard the CLI call with the existing preflight `openspec` flag and a timeout; missing binary degrades to today's directory listing without erroring
- [ ] 4.5 Confirm nothing is written to `~/.floo-network` by the spec pane
- [ ] 4.6 Test: parsing a captured real `openspec list --json` payload
- [ ] 4.7 Test: a missing `openspec` binary degrades gracefully
- [ ] 4.8 Test: two changes appearing during one propose turn produces a user-visible prompt, not silence

## 5. Verification and git-anchored attribution

Answer "what has been tested?" and "what changed?" with evidence. Depends on: Phase 2 (runs attach to a session id).

- [ ] 5.1 `verify` command map in `.project-settings.json`, `#[serde(default)]`
- [ ] 5.2 Verify runner reusing `run_format_on_save`'s exact execution pattern (`sh -c`, cwd = project root, capture stdout/stderr + exit status), run detached so it doesn't block the UI thread
- [ ] 5.3 `VerificationRun` type + store API, persisted to new `projects/<hash>/verify.jsonl`
- [ ] 5.4 `SessionRecord` records `git_head_before`/`git_head_after` via `git.rs`'s existing `git::run` helper (new `rev_parse_head`, `porcelain_snapshot`)
- [ ] 5.5 UI panel shows command + exit code + commit per verification run; no aggregate "complete"/"satisfied" claim anywhere in the UI
- [ ] 5.6 Attribution: session → committed changes (exact, via HEAD pair); session → uncommitted changes (porcelain delta); labeled "ambiguous while N sessions are live" when sessions overlap
- [ ] 5.7 Test: a passing command records exit 0; a failing one records non-zero with its output tail, never swallowed
- [ ] 5.8 Test: filenames/commands with shell metacharacters cannot break out (mirrors the existing quoting test)
- [ ] 5.9 Test: a session that commits records distinct before/after HEADs; one that commits nothing records identical ones
- [ ] 5.10 Test: attribution is reported as ambiguous when two sessions share a project root

## 6. Definition of done (global gate, run after all phases)

- [ ] 6.1 `cargo test` and `pnpm test` green; `pnpm build` (tsc) clean
- [ ] 6.2 No file under `~/.floo-network` was deleted by any migration in this change
- [ ] 6.3 `AGENTS.md` / `CLAUDE.md` / `PRODUCT.md` updated where this change contradicts them — specifically the "one executor" framing and the thread/session distinction
- [ ] 6.4 `Preflight` exposes `agents: Vec<AgentStatus>`; `api.ts` contains no `"claude" | "codex"` union
- [ ] 6.5 No UI string asserts a spec is complete, satisfied, or implemented on any basis other than an exit code or an explicit user action
