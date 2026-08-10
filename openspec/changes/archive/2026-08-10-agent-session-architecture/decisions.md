# Decision log — agent-session-architecture

Carried forward from the architecture evaluation session (`~/.claude/plans/you-are-acting-as-composed-lynx.md`, 2026-08-08). That evaluation was read-only against the repo and the live `~/.floo-network` store; every decision below was made by the user during that session unless noted otherwise.

---

## D1: Concurrency model
- **Decision**: Truly concurrent sessions — `Harness.sessions: Mutex<HashMap<SessionId, Session>>`, not "durable history, one live process at a time."
- **Why**: The product direction requires a thread to run multiple sessions (same or different agents), and switching threads mid-turn today silently kills the running agent. A single-live-session model would only paper over the identity problem, not fix it.
- **Source**: user

## D2: BYOA scope
- **Decision**: Compiled-in `KNOWN_AGENTS` const table. No plugin system, no user-declarable agents in config.
- **Why**: Nothing in the repo needs a process boundary between Floo and an adapter; a plugin loader is speculative complexity for a 2–5 agent ceiling.
- **Source**: user

## D3: Verification behavior
- **Decision**: Floo runs verify commands itself and persists exit codes. Not display-only, not agent-self-reported.
- **Why**: A spec's completeness must be evidence ("a named command exited 0 at a named commit"), never a model's self-report about its own work.
- **Source**: user

## D4: Naming — no all-caps `AGENTS` identifier
- **Decision**: The const table is named `KNOWN_AGENTS`, not `AGENTS`.
- **Why**: The all-caps spelling `AGENTS` is reserved for `AGENTS.md`; reusing it as a Rust identifier collides with that convention.
- **Source**: user (see `~/.claude/projects/-Users-tjlsmith0831-dev-floo-network/memory/no-all-caps-agents-identifier.md`)

## D5: Agent table shape — data, not polymorphism
- **Decision**: `KNOWN_AGENTS: &[Agent]` as a const table of function pointers (`args: fn(...)`, `parse: fn(...)`, `write_turn: fn(...)`). No `trait Executor`, no `Box<dyn>`, no registry.
- **Why**: Claude (persistent stdin) and Codex (per-turn spawn) have a genuine transport difference. A trait general enough to cover both would hide that difference behind an abstraction; an explicit `match` on table data keeps it visible and is smaller besides.
- **Source**: evaluation finding, confirmed against D2

## D6: Concurrent-write mitigation — warn, don't lock
- **Decision**: When a session starts in a project another live session already occupies, Floo surfaces a one-line warning naming the other session. No lock, no queue, no blocking.
- **Why**: The executor owns its own tool loop; Floo cannot prevent two agents writing the same file without changing that ownership (already documented in `CLAUDE.md`/`PRODUCT.md`). A lock would be a promise Floo can't keep. Git remains the arbiter of what actually happened.
- **Source**: evaluation finding, consistent with D1

## D7: Worktree-per-session isolation — deferred
- **Decision**: Not built in this change. The honest mitigation for D6 is a warning; worktree-per-session is the real long-term answer but is explicitly out of scope.
- **Why**: Only real concurrent use will show whether warning is sufficient or a worktree/lock is needed (see Open Question 2 in `design.md`). Building isolation speculatively risks solving the wrong problem.
- **Source**: evaluation finding

## D8: Persistence substrate — stay JSON + JSONL
- **Decision**: No SQLite. Keep the existing append-only JSONL + sidecar JSON idiom for the two new record types (`SessionRecord`, `VerificationRun`).
- **Why**: The store is 548 KB after months of use, appends are fsync'd, torn-line recovery is already tested, and no query in the product needs an index. SQLite would add a dependency and a migration story for a problem that doesn't exist.
- **Source**: evaluation finding

## D9: Event model — one envelope, no new event types
- **Decision**: Add exactly one wrapper, `Envelope{session_id, thread_id, event}`. Keep all nine existing `ExecutorEvent` variants unchanged. Do not add `FileChange`, `Status`/`Busy`, a generic `ProviderEvent{raw}`, or a `Verification` event.
- **Why**: Each rejected addition would create a second source of truth for something already derivable (`FileEdit` already covers file changes; busy/status is derivable from send/`Done`/`Crashed`; a generic escape hatch becomes the union of every provider's schema over time; verification runs are Floo-initiated, not agent-emitted, and belong in their own record).
- **Source**: evaluation finding

## D10: Payload sizing for persisted events
- **Decision**: Cap persisted `FileEdit.before`/`after` and `ToolResult.output` at 64 KB with a truncation marker. Live-rendered events keep the full payload; only the durable log is capped.
- **Why**: Unbounded content (a full-file rewrite, verbose build output) written verbatim into permanent thread history is an unforced growth risk with no offsetting benefit — nothing reads the truncated tail from the durable log today.
- **Source**: evaluation finding

## D11: Spec architecture — filesystem authoritative, Floo never writes
- **Decision**: Replace `newly_added_change`'s directory-diff inference with `openspec list --json` / `openspec change show --json`. Floo never writes `proposal.md`/`design.md`/`tasks.md`/`decisions.md`/`specs/*/spec.md`. No `Spec` entity in Floo's own store, no Floo-computed "% complete."
- **Why**: `openspec` is installed and its JSON output is verified working against this repo; duplicating what it already answers would be a second, competing source of truth. Task checkboxes are agent-authored self-reports and must be labeled as such, never aggregated into a claim of completeness.
- **Source**: evaluation finding, aligned with D3

## D12: Spec-link ambiguity is surfaced, not silently dropped
- **Decision**: When more than one OpenSpec change appears during a single propose turn, the user is shown the ambiguity. Today's behavior (`newly_added_change` returns `None` and silently records nothing) is a defect, not an acceptable simplification.
- **Why**: Silent data loss on a durable reference (which spec a thread is working on) is worse than asking once.
- **Source**: evaluation finding

## D13: Attribution — evidence with explicit ambiguity, never a guess presented as fact
- **Decision**: Record `git rev-parse HEAD` + `git status --porcelain` at session open/close as the attribution mechanism. `FileEdit` paths remain a labeled hint. When sessions overlap, the UI states "attribution is ambiguous while N sessions are live" rather than heuristically splitting the dirty set.
- **Why**: A parallel git object model, per-line attribution, or a filesystem watcher would all be more code in service of a precision the data doesn't actually support once concurrency (D1) makes overlapping sessions normal.
- **Source**: evaluation finding

## D14: Provider resume handles cannot cross agents
- **Decision**: `provider_handle` moves from `ThreadMeta` onto `SessionRecord`. Switching agents mid-thread cannot resume via a provider handle (Claude `--resume` and Codex `resume --last` are private to their own CLIs) — it starts a fresh session, optionally with a bounded transcript replay as the first prompt.
- **Why**: Pretending a Claude UUID means something to Codex (today's actual behavior — the field is written unconditionally) is the root cause of Thread carrying provider-private state. Stating the limitation honestly is cheaper than building cross-provider session translation.
- **Source**: evaluation finding

## D15: Legacy `executorSessionId` migration shim
- **Decision**: A thread with a legacy `executorSessionId` and no `sessions.jsonl` gets exactly one synthesized closed `SessionRecord` with `agent_id: "claude"` and `provider_handle: Some(id)`.
- **Why**: Only Claude can consume such a handle (Codex never used the UUID `ensure_session` generated for it). Assuming `claude` never fabricates a resumable session that doesn't exist; if the user's next session is Codex, the handle is simply ignored, matching today's actual behavior.
- **Source**: evaluation finding

## D16: Migration is strictly additive — nothing is deleted
- **Decision**: No migration step in this change deletes a file. The 86 orphaned `~/.floo-network/projects/<hash>/` directories are adopted into `projects.json` (if they have a valid `project.json`) or listed in `harness.log` — never removed automatically.
- **Why**: These directories hold real thread history from real (if leaked) test runs; deleting them destructively without explicit user instruction would be an unrequested, irreversible action outside this change's scope.
- **Source**: user (carried from evaluation handoff), consistent with repo-wide operating rules

## D17: Phase ordering
- **Decision**: Store-integrity fixes (Phase 0) land before the event envelope (Phase 1), which lands before concurrent sessions (Phase 2), before the agent table (Phase 3). Spec-reference (Phase 4) is independent and lower priority; verification + attribution (Phase 5) depends on Phase 2 (`SessionRecord` must exist for `VerificationRun`/git-HEAD-pair to attach to).
- **Why**: Phase 0 fixes confirmed live data-integrity defects (leaking test writes into the real store) that would otherwise corrupt data written by every later phase. Phase 1 (routing) is a prerequisite for Phase 2 (concurrency) — you cannot tell two sessions' events apart without it.
- **Source**: evaluation finding

## D18: Next-seq cache lives in `store.rs`, not on `Harness`
- **Decision**: The append-sequence cache is a private `static SEQ_CACHE: Mutex<Option<HashMap<PathBuf, (len, next_seq)>>>` inside `store.rs`, keyed on the resolved log path and validated against the file's length. `tasks.md` 0.3 originally said "add a next-seq cache to `Harness`".
- **Why**: `append_message`'s hottest caller is `executor::persist`, reached from `pump()` — a detached `std::thread` that holds no `Harness` handle and never could without threading one through `Spawn`, `start`, `send`, and `pump`. Keying on the absolute log path gives identical isolation (each test's tempdir is a distinct key) for none of that plumbing. The recorded file length is the validity check: any write this process didn't make invalidates the entry and the seq is recomputed from disk, so the torn-line and external-writer paths behave exactly as before.
- **Source**: recommended-accepted (Phase 0 implementation)

## D19: Mode is enforced per session; the thread keeps it only as intent
- **Decision**: `ThreadMeta.current_mode` survives as the thread's *default* — what a new session starts as and what the UI preselects. A thread MAY hold a live spec session and a live go session simultaneously; `find_live_session(thread, mode)` keys by mode. `/go` no longer terminates the spec session, it starts a go session alongside it. `spec_mode` stops meaning "kill the executor" and becomes "set the thread's default back to spec"; killing is an explicit per-session stop.
- **Why**: Resolves Open Question 5 in `design.md`, which the design flagged as needing an answer before Phase 2 lands. It is the reading design.md §2's Intent/Enforcement ownership table already implies, and the only one under which task 2.12 ("two sessions on one thread with different agents both run") is buildable. The alternatives either contradict D1 (one live session per thread) or delete mode intent's ability to survive a restart.
- **Cost accepted**: today's "switching back to spec terminates the executor" behavior goes away, and `stop_executor` becomes session-scoped.
- **Source**: user

## D20: `Done` ends a turn, not a session — `done` is written when an idle session is released
- **Decision**: Amends `design.md` §2's lifecycle line (`Done`→`done`). `ExecutorEvent::Done` only clears `busy`; the session record stays open and the session keeps accepting turns. A session closes `done` when Floo releases it with no work outstanding: on app shutdown, and when the user leaves a thread whose session is idle. `crashed` / `cancelled` / `interrupted` are unchanged.
- **Why**: Discovered building Phase 2. `Done` is a turn boundary in both transports — Claude's process is persistent across turns, and Codex carries the conversation forward with `resume --last` — so closing on `Done` would mark a live, resumable session ended and leave the next turn appending under a closed id. The alternative readings either collapse a session into a single turn (which contradicts D19 and task 2.5's `find_live_session`: there would be no live session between turns to find) or delete the `done` outcome the `concurrent-sessions` spec requires.
- **Source**: user (recommended, accepted)

