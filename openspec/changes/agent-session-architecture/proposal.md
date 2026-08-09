## Why

Floo Network's product direction is `Project → Spec → Thread → Session → Agent → Changes → Verification`, but four of those seven are not real entities in the codebase today: Spec is a string, Session is an unpersisted in-memory struct, Changes are React state, Verification does not exist. Three specific defects block the direction:

1. **One global session.** `Harness.session: Mutex<Option<Session>>` (`executor.rs:789`) means one executor for the entire app; `ensure_session` kills the previous session on any thread/mode/agent mismatch (`lib.rs:335-337`). Concurrent sessions are structurally impossible.
2. **Events carry no identity.** `AppSink::emit` publishes a bare `ExecutorEvent` on a global channel (`lib.rs:198`); the frontend appends every event to one array (`App.tsx:731-737`). Routing is impossible without a `session_id`/`thread_id`.
3. **Session is not persisted.** `executor::Session` (`executor.rs:459-475`) dies with the process. The only trace is a provider-private handle overwritten on `ThreadMeta` (`store.rs:161`), which taints the provider-independent Thread with provider state.

Everything else — BYOA friction, spec integration, verification, attribution — is downstream of those three. A confirmed live data-integrity bug is also fixed here: 86 orphaned project directories in `~/.floo-network/projects/` (one leaked per `cargo test` run) because the Codex send path hardcodes `store::floo_home()` instead of carrying the session's own home.

## What Changes

- **`Harness.sessions: Mutex<HashMap<SessionId, Session>>`** replaces the single `Option<Session>`. Sessions get per-session `busy`/`terminate`; two threads (or two agents on one thread) can run concurrently. A live-session warning (not a lock) fires when a new session starts in a project another live session already occupies — Floo cannot arbitrate concurrent file writes and does not pretend to.
- **`Envelope { session_id, thread_id, event }`** wraps every emitted `ExecutorEvent`. The frontend's single `live` array becomes `Map<session_id, ExecutorEvent[]>`. All nine existing event variants are kept unchanged; no new event types are added.
- **`SessionRecord`** is appended (open + close) to a new `<ulid>.sessions.jsonl` per thread — id, agent, mode, provider handle, outcome (`done`/`crashed`/`cancelled`/`interrupted`), git HEAD before/after, touched paths. `ThreadMeta.executor_session_id` (a provider-private handle sitting on a provider-independent entity) is removed; a read-time shim synthesizes one closed `claude` record from any legacy value.
- **`KNOWN_AGENTS: &[Agent]`** — a compiled-in const table of function pointers (transport, argv, parser, permission mapping) replaces the two-variant `Kind` enum and `Preflight`'s named `claude`/`codex` fields. Adding a third agent becomes one table row plus one parser, with no changes to `lib.rs` matches or the TS boundary. Explicitly not a plugin system and not `dyn Executor` — the user chose compiled-in over dynamic dispatch.
- **`openspec list --json` / `openspec change show --json`** replace the directory-diff inference (`newly_added_change`) that silently drops the spec link when two changes appear in one turn. A read-only spec pane is added; Floo never writes spec files.
- **`verify` command map** in `.project-settings.json` (sibling to the existing `formatOnSave`), run the same way `run_format_on_save` already runs commands. Results persist to a new `verify.jsonl` (`VerificationRun`: command, exit code, git HEAD, output tail). Floo runs verification itself and persists the result — a spec is never "complete" because a model said so.
- **Git-anchored attribution**: `git rev-parse HEAD` + `git status --porcelain` recorded at session open/close give an exact committed-changes set and an uncommitted-changes delta, both labeled ambiguous when concurrent sessions share a project root. `FileEdit` paths remain a labeled hint, never proof.
- **Store-integrity fixes** (prerequisite to everything above): `Session` carries its own `floo_home` so the Codex send path stops writing into the real store during tests; `list_projects` reconciles orphaned `project.json` directories back into the index instead of leaving them permanently invisible; `append_message`'s per-append full-log re-read is replaced with a cached next-seq; persisted `FileEdit`/`ToolResult` payloads are capped (64 KB) with a truncation marker, while the live-rendered event stays whole.

## Capabilities

### New Capabilities
- `store-integrity`: session-owned `floo_home`, project-index reconciliation, O(1) append sequencing, capped persisted payloads.
- `event-routing`: `Envelope{session_id, thread_id, event}` wrapping every executor event end to end.
- `concurrent-sessions`: `HashMap<SessionId, Session>`, per-session lifecycle, `SessionRecord` persistence, live-session collision warning.
- `agent-registry`: `KNOWN_AGENTS` const table replacing the `Kind` enum and `Preflight`'s per-provider fields.
- `spec-reference`: `openspec` CLI as the source of change names/task counts, replacing directory-diff inference; read-only spec pane.
- `verification`: project-configured verify commands, run by Floo, persisted with exit code and git HEAD.
- `change-attribution`: git HEAD pair + porcelain delta per session as the evidence layer for "what changed," with `FileEdit` paths labeled as a hint.

### Modified Capabilities
<!-- No existing specs in openspec/specs/ overlap with this change's surface (session/event/agent/spec/verification model). -->

## Impact

- **Rust backend**: `executor.rs` (`Session`, `Harness`, `Kind` → `Agent`/`KNOWN_AGENTS`, `Preflight`), `lib.rs` (`ensure_session` → `start_session`/`find_session`, `resolve_executor`, `selected_executor`, `propose`, `AppSink`), `store.rs` (`SessionRecord` API, `list_projects` reconciliation, seq cache), `settings.rs` (`verify` map, `executor_override: Option<String>`), `git.rs` (`rev_parse_head`, `porcelain_snapshot`), new `verify` runner reusing `run_format_on_save`'s execution pattern.
- **Frontend**: `App.tsx` (`live` → `Map<session_id, ...>`, per-session busy state, agents iterated from a list instead of named), `api.ts` (typed wrappers for the above, no `"claude" | "codex"` union), `EventView.tsx` (agent-driven avatar rendering), new read-only spec pane.
- **New IPC/data shapes**: `Envelope`, `SessionRecord`, `VerificationRun`, `AgentStatus`, `Preflight.agents: Vec<AgentStatus>`. Each new IPC command needs its three edits (command fn, `generate_handler!`, `api.ts` wrapper) per this repo's convention.
- **Persistence layout**: two new append-only files per project/thread (`<ulid>.sessions.jsonl`, `verify.jsonl`); `<ulid>.meta.json` loses `executorSessionId` (tolerated on disk via a read-time shim); `Message` gains `session_id: Option<String>`. Stays JSON + JSONL — no SQLite.
- **Non-negotiable**: no migration step deletes a file. The 86 orphaned project directories are adopted into the index or reported in `harness.log`, never removed automatically.
- **Explicitly not built**: `trait Executor`/`Box<dyn>`, a plugin/dynamic-agent loader, an event bus or actor framework, SQLite, a `Spec` entity in Floo's store, a computed "% complete," harness-side tool interception, a parallel git model, a `Status`/`Verification`/generic `ProviderEvent` event, a second filesystem watcher, worktree-per-session isolation, or an `App.tsx` refactor for its own sake.
