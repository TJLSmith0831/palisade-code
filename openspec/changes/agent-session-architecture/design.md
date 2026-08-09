## Context

Floo Network is a thin Tauri harness around one CLI child process: append-only JSONL with fsync and torn-line recovery, a unified `ExecutorEvent` enum with two hand-written provider parsers, real detection with a login-shell PATH fallback, 116 Rust tests and ~200 frontend tests. The `Kind`-with-`match` provider abstraction is healthier than expected for 2–5 compiled-in agents.

```
┌─────────────────────────────── React (src/) ──────────────────────────────┐
│  App.tsx (1739 lines — all state)                                          │
│    projects[] project threads[] thread messages[] live[] busy(bool)        │
│    ├── ChatSurface ── EventView.tsx: Item = plain | ExecutorEvent          │
│    ├── FileTree / FileEditorPane / DiffPane / GraphPane / TerminalPane     │
│    └── fileEdits[]  ← manual editor saves, React state only, never stored  │
│                                                                            │
│  api.ts — 50 thin invoke() wrappers + hand-written mirrors of Rust types   │
└────────────┬───────────────────────────────────────────┬──────────────────┘
             │ invoke(cmd, args)          listen("executor-event")  ← no ids
             ▼                                           ▲
┌─────────────────────────── Rust (src-tauri/src/) ──────┴──────────────────┐
│  lib.rs — 50+ #[tauri::command]                                            │
│    ensure_session() ──► resolve_executor() ──► selected_executor()         │
│    AppSink::emit  ── emits globally + reacts: crash → on_crash,            │
│                      done → pending_propose → openspec dir diff            │
│                                                                            │
│  executor.rs                                                               │
│    Kind{Claude,Codex}   preflight()   find_on_path()                       │
│    ExecutorEvent (9 variants)                                              │
│    parse_claude_line() ─┐                                                  │
│    parse_codex_line()  ─┴─► one enum ─► persist() ─► Sink::emit            │
│    Session{kind,bin,project_hash,thread_id,mode,session_id,live,busy}      │
│    Harness{ session: Mutex<Option<Session>>  ← ONE, GLOBAL                 │
│             preflight, pending_propose, watch, terminal }                  │
│                                                                            │
│  store.rs ── git.rs ── integrations.rs ── settings.rs ── terminal.rs       │
└────────────┬──────────────────────────────────────────────────────────────┘
             │ spawn / stdin JSON (Claude) │ spawn per turn (Codex)
             ▼                             ▼
        claude --print --input-format      codex exec [resume --last]
        stream-json --permission-mode X    --json --sandbox Y -C root
```

**Domain model today:**

| Entity | State | Problem this change fixes |
|---|---|---|
| Project | healthy | index/directory divergence — 92 dirs vs 6 index entries, 86 unreachable |
| Spec | a `String` on `ThreadMeta` | link is inferred by directory diff, silently dropped when ambiguous |
| Thread | persisted, provider-tainted | carries a provider-private resume handle (`executor_session_id`) |
| Session | in-memory only, cardinality 1 | dies with the process; conflates Agent+Executor+Process+Session |
| Agent | 2-variant enum | `Preflight`'s named fields make a 3rd agent a cross-cutting change |
| Executor | `match kind` at every seam | correct as-is — a real transport difference, not accidental coupling |
| Process | owned inconsistently | Codex's per-turn `Child` is unreachable from `terminate()` |

This design covers the seven capabilities in `proposal.md`; see `decisions.md` for the decision trail behind each choice below.

## Goals / Non-Goals

**Goals:**
- Make thread → {multiple concurrent sessions} structurally possible (fixes the one confirmed blocker to the product direction).
- Give every event, message, and session a durable identity so routing, attribution, and verification all have something to key off.
- Make adding a third agent a one-table-row change, not a cross-cutting one.
- Answer "what has been tested?" and "what changed?" with evidence Floo actually observed, never a model's self-report presented as fact.
- Preserve everything that already works: JSON+JSONL persistence, the `match`-based executor abstraction, the append-only message log, all 9 event variants.

**Non-Goals (see `proposal.md` Impact for the full list):**
- A plugin system or dynamic agent loading — the user chose compiled-in.
- Preventing concurrent writes to the same file — Floo warns; git remains the arbiter; worktree-per-session isolation is deliberately deferred.
- A `Spec` entity in Floo's own store — the filesystem and the `openspec` CLI stay authoritative.
- SQLite, an event bus, `trait Executor`, harness-side tool interception, or refactoring `App.tsx` for its own sake.

## Decisions

### 1. Session model: `HashMap<SessionId, Session>`

```
┌──────────────────────────── UI ─────────────────────────────┐
│  sessionsByThread: Map<thread_id, SessionView[]>            │
│  each SessionView: { id, agent, mode, busy, live[] }        │
└────────────────────────────┬────────────────────────────────┘
                             │ listen("executor-event") → Envelope
                             │   { session_id, thread_id, event }
┌────────────────────────────┴────────────────────────────────┐
│  Harness {                                                   │
│    sessions: Mutex<HashMap<SessionId, Session>>,   ← (1)     │
│    preflight, pending_propose, watch, terminal               │
│  }                                                           │
│                                                              │
│  Session { id, thread_id, project_hash, agent: &'static      │
│            Agent, mode, floo_home, provider_handle,   ← (3)  │
│            live, busy, stopping }                            │
│                                                              │
│  KNOWN_AGENTS: &[Agent]  ← const table                ← (2)  │
└─────────────────────────────┬───────────────────────────────┘
                              ▼
  ~/.floo-network/projects/<hash>/threads/
     <ulid>.meta.json     ← loses executor_session_id
     <ulid>.jsonl         ← messages (unchanged)
     <ulid>.sessions.jsonl ← NEW: SessionRecord append-only  ← (4)
```

`ensure_session` becomes `start_session(thread, agent, mode) -> SessionId` plus `find_live_session(thread, mode)`. Per-session `busy` and `terminate` replace the single global boolean. `executor_status` returns a list, not `Option<(String, bool)>`.

**The honest cost of concurrency:** two agents can write the same file with no coordination — Floo cannot prevent this, the executor owns its own tool loop (already stated in `CLAUDE.md`/`PRODUCT.md`). The mitigation is a one-line warning naming the other live session when starting a session in an already-occupied `project_hash`, not a lock. Git remains the arbiter.

### 2. Ownership split — Thread vs. Session

| Concern | Owner | Rationale |
|---|---|---|
| Messages | **Thread** | already true; the durable record survives every agent |
| Execution state (`busy`, child, stdin) | **Session** | dies with the process |
| Agent identity | **Session** | a thread may use several agents over its life |
| Provider resume handle | **Session** | provider-private; putting it on Thread is what taints Thread today |
| Mode intent | **Thread** | user intent, survives restart |
| Mode enforcement | **Session** | the actual `--permission-mode`/`--sandbox` flag |
| Spec reference | **Thread** | the durable link |

**Lifecycle:** create → `start_session` writes an open `SessionRecord`. Resume with the same agent may pass the previous session's `provider_handle` (Claude `--resume`; unchanged from today's `/go` behavior). Resume with a *different* agent is impossible via provider handles — Claude's `--resume` and Codex's `resume --last` are private to their own CLIs — so an agent switch mid-thread starts a fresh session with, optionally, a bounded transcript replay as the first prompt. End: `Done`→`done`, `Crashed`→`crashed` (existing recovery unchanged), `terminate()`→`cancelled`. Restart: any record with no `ended_at` closes as `interrupted`; no process survives an app restart.

### 3. Event model: one envelope, no new event types

All nine existing `ExecutorEvent` variants are kept as-is. The only addition:

```rust
struct Envelope { session_id: String, thread_id: String, event: ExecutorEvent }
```

Producer: `Sink::emit`. Consumer: the frontend router. Not persisted separately — `session_id` becomes a field on the persisted `Message`.

**Explicitly rejected** (each would create a second source of truth): a separate `FileChange` event (`FileEdit` already covers it), a `Status`/`Busy` event (derivable from send/`Done`/`Crashed`), a generic `ProviderEvent{raw: Value}` escape hatch (would become the union of every provider's schema), a `Verification` event (verification runs are Floo-initiated, not agent-emitted — they get their own record, see §6).

**Sizing (P10):** persisted `FileEdit.before`/`after` and `ToolResult.output` are capped at 64 KB with a truncation marker; live rendering keeps the full payload. One-line change in `persist()`.

### 4. Agent table: data, not polymorphism

```rust
pub enum Transport { Persistent, PerTurn }

pub struct Agent {
    pub id: &'static str,              // "claude" | "codex" | "amp"
    pub bin: &'static str,
    pub label: &'static str,
    pub transport: Transport,
    pub skill_prefix: &'static str,
    pub skill_dir: &'static str,       // ".claude/skills" | ".agents/skills"
    pub plugin_dir: &'static str,
    pub permission: fn(mode: &str) -> &'static str,
    pub args: fn(&SpawnCtx) -> Vec<String>,
    pub write_turn: fn(&mut Session, &str) -> Res<()>,
    pub parse: fn(&Value, &dyn Fn(&str) -> String) -> Vec<ExecutorEvent>,
}

pub const KNOWN_AGENTS: &[Agent] = &[CLAUDE, CODEX];
```

A const table of function pointers — no trait objects, no registry, no dynamic dispatch beyond `fn`. This single change deletes five of the sixteen BYOA touchpoints identified in evaluation (the hardcoded binary/skill-dir probes in `preflight()`, `Preflight`'s named fields, and their two downstream `match`es in `resolve_executor`/`selected_executor`).

```rust
pub struct AgentStatus { id, label, path: Option<String>, skills_ok: bool, plugin_ok: bool }
pub struct Preflight { agents: Vec<AgentStatus>, selected: Option<String>, openspec: bool, graphify: bool, ready: bool, warnings: Vec<String>, checked_at: String }
```

`tool_event()`'s literal `"Write"`/`"Edit"`/`"Bash"` matching moves into `parse_claude_line`'s private scope; the shared `ExecutorEvent::ToolCall.name` becomes "the agent's own tool name, displayed verbatim" — Codex's `"Bash"` hardcode (currently impersonating Claude's naming) is fixed to whatever Codex actually calls it.

**Rejected:** `trait Executor` with `Box<dyn>`. Two implementations with genuinely different process shapes (persistent stdin vs. per-turn argv) are better served by an explicit `match` on a data-driven table than a trait general enough for both.

### 5. Spec architecture: filesystem authoritative, Floo reads

| Concern | Owner |
|---|---|
| `proposal.md`, `design.md`, `tasks.md`, `decisions.md`, `specs/*/spec.md` | **OpenSpec + the filesystem** |
| Creating/editing those files | **the agent**, via the grill skills |
| Which change a thread is working on | **Floo** — one reference string on `ThreadMeta` |
| Which sessions ran against that change | **Floo** — via `SessionRecord.thread_id` |
| Task completion counts, validation | **the `openspec` CLI**, queried live |

`openspec list --json` (verified working against this repo: returns `{name, completedTasks, totalTasks, lastModified, status}`) replaces `newly_added_change`'s before/after directory diff. When more than one change appears in a propose turn, the ambiguity is surfaced to the user instead of silently dropping the link. A read-only spec pane shells out to `openspec list --json` / `openspec change show <name> --json`, cached per project, invalidated like the existing `graphify-updated` event. **Nothing is written to `~/.floo-network`**; if a task checkbox becomes clickable later, it edits the real `tasks.md` in place.

### 6. Verification: Floo runs it, persists the exit code

Reuses the existing pattern verbatim (`settings::run_format_on_save`, `settings.rs:73-102`: `sh -c`, cwd = project root, capture stdout/stderr and exit status).

```json
{ "formatOnSave": {}, "executorOverride": null,
  "verify": { "test": "cd src-tauri && cargo test", "typecheck": "pnpm build", "frontend": "pnpm test" } }
```

```rust
struct VerificationRun { id, project_hash, thread_id: Option<String>, session_id: Option<String>,
                         name, command, exit_code: i32, output_tail: String,
                         git_head: String, at: String }
```

Persisted to `projects/<hash>/verify.jsonl`. **The rule this encodes:** a spec is never "complete" because a model said so — it is green because a named command exited 0 at a named commit. Floo displays the command, the exit code, and the commit; nothing else counts. A long-running `verify` runs detached and streams its result, the same way `pump` already does — it must not block the UI thread.

### 7. Change attribution: git HEAD pair + labeled hints

`FileEdit` events are already timestamped and persisted, giving *session → paths the agent's file tools touched* — but this misses edits made through `Bash` (no path extraction), human edits in the CodeMirror editor (`write_file_content` persists nothing today), and anything a build step writes. The cheap fix that produces real evidence: record `git rev-parse HEAD` and `git status --porcelain` (via the existing `git::run` helper) at session open and close.

- **Session → committed changes:** exact, via the HEAD pair.
- **Session → uncommitted changes:** exact for "dirty now that wasn't before" when sessions don't overlap; **not exact when they do** — with concurrent sessions enabled, overlap is now normal, and the UI must say "attribution is ambiguous while N sessions are live" rather than heuristically splitting the dirty set.
- **Session → `FileEdit` paths:** a hint, always rendered as "agent-reported," never as proof.
- **Thread/Spec → changes:** the union over sessions/threads.

**Rejected:** a parallel git object model, per-line attribution, a filesystem watcher diffing the tree, any inference presented as fact.

### 8. Persistence: keep JSON + JSONL

The store is 548 KB after months of real use; appends are fsync'd, torn trailing lines are detected/closed on write and dropped-with-logging on read (tested), backward compatibility already works via `#[serde(default)]` (tested). No query in the product needs an index. SQLite would add a dependency, a schema-migration story, and a binary file to solve a problem that does not exist.

```
~/.floo-network/
  projects.json                        index (reconciled against dirs on read)
  harness.log                          corruption + diagnostics
  projects/<sha256>/
    project.json                       authoritative per-project copy
    verify.jsonl                       NEW — VerificationRun, append-only
    threads/
      <ulid>.meta.json                 ThreadMeta (loses executorSessionId)
      <ulid>.jsonl                     messages, append-only  (+ session_id field)
      <ulid>.sessions.jsonl            NEW — SessionRecord, append-only
```

### 9. Migration — nothing is deleted, everything degrades gracefully

| Structure | Migration | Data-loss risk | Rollback |
|---|---|---|---|
| Orphan `projects/<hash>/` dirs (86 today) | one-time scan on first launch; adopt those with a `project.json`, list the rest in `harness.log` | **none — read-only adoption** | clean |
| `<ulid>.meta.json` | `executorSessionId` field removed from the type, tolerated on disk via `#[serde(default)]` precedent | none | old build ignores new fields |
| `<ulid>.jsonl` | `+ session_id: Option<String>`, defaults to `None` on old rows | none | old build ignores the field |
| `<ulid>.sessions.jsonl`, `verify.jsonl` | created lazily | none | old build ignores the file |
| `.project-settings.json` | `+ verify`, `#[serde(default)]` | none | old build ignores `verify` |
| `executorOverride` | `Option<Kind>` → `Option<String>`, same JSON strings | **improved**: unknown name now warns instead of dropping the whole settings file to defaults | clean |

**The `executorSessionId` shim, stated honestly:** a thread with a legacy handle and no `sessions.jsonl` gets one synthesized closed record with `agent_id: "claude"` (since `ensure_session` wrote the field unconditionally even for Codex, where it was never used — only Claude can consume such a handle). If the user's next session is Codex, the handle is ignored, which is already today's behavior.

## Open Questions

Carried from evaluation — none block starting Phase 0/1, but should be resolved before the phase named:

1. Codex success-path schemas (`agent_message.text`, `command_execution.*`, `file_change.*`) remain unverified against a real authenticated Codex turn — Phase 3's "existing behavior unchanged" guarantee is only as good as these guesses. Closing it needs one authenticated Codex session, not a design decision.
2. When two concurrent sessions edit the same file: warn only (this design), block the second session, or offer a worktree? Only real use will tell — revisit after Phase 2 ships.
3. How much transcript to replay when a thread switches agents — a product judgment, not a code question.
4. Should manual editor saves (currently invisible to the domain) become first-class `FileEdit` records? Makes attribution complete but persists the user's own keystroke-level edits into thread history — a privacy/volume call.
5. Is `current_mode` still a thread-level concept once sessions are concurrent? A thread could have a live spec session and a live go session at once. Worth deciding before Phase 2 (`concurrent-sessions`) lands.
