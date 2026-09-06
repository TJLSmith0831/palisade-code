## Context

See proposal.md — Why. The database viewer/editor already exists and works: `db.rs` owns one lazily-created `AnyPool` per saved connection keyed by URL (`db.rs:421`), a conflict-checked transactional write path (`apply_edits`, `db.rs:698`), and plaintext connection storage at `~/.palisade-code/projects/<hash>/db-connections.json` written at mode 0600 (`save_connections`, `db.rs:71`). `db_cmds.rs` resolves a connection id to a `DbConnection` on every command, so a credential travels one way only — the frontend never holds a URL.

Two existing facts shape everything below. First, `store.rs:709` (`append_verification`) is already the repo's append-only JSONL writer: create+append, torn-line repair, `sync_all`. The audit log is that pattern applied to a second file, not a new mechanism. Second, `db-viewer-editor` D8 explicitly deferred keychain integration and accepted plaintext-with-0600 as the v1 model — this change supersedes that decision, which is why the credential requirement is MODIFIED rather than extended.

`database-viewer` was complete but unsynced when this change was written; it has been synced into `openspec/specs/database-viewer/` so this change's delta has a base (decisions.md D2, tasks 0.1).

## Goals / Non-Goals

**Goals:**
- A durable activity record of what ran against a database and when — a history the user can read back, surviving the process (D19).
- Credential storage that degrades honestly rather than failing or lying.
- Bounded query execution with no new dependency and no backend-specific branch.
- No IPC surface change: no new `#[tauri::command]`, no `generate_handler!` entry, no `src/api.ts` wrapper. The frontend is untouched.

**Non-Goals:**
- Reading the audit log — no UI, no IPC command (D13). A viewer carries its own redaction questions.
- Server-side query cancellation. The timeout abandons the future; it does not kill the statement (D10).
- Log rotation. Scoped out by excluding grid reads from the record (D5), which is what would have made volume a problem.

## Decisions

### The record is a query history, appended after the fact

The entry is appended once the operation completes, carrying its real outcome and `rowsAffected`. Nothing about it is transactional: `apply_edits` keeps its existing transaction untouched, and a destructive `run_query` is executed as-is.

An earlier revision of this design specified fail-closed auditing — the entry written *inside* the transaction, ROLLBACK if the append failed, and destructive `run_query` wrapped in BEGIN/COMMIT to inherit the guarantee. That was withdrawn (D6, D7 amended, D19). Fail-closed makes a record tamper-resistant against an actor distinct from the auditor; in a single-user IDE they are the same person, and defeating the log means deleting the file. It also carried a real regression: `VACUUM`, `CREATE INDEX CONCURRENTLY`, and some `ALTER TYPE` forms cannot run inside a transaction, so the wrapping would have removed statements the console exists to run (`db-viewer-editor` D12 — "a read-only console isn't a real console").

What the record supports is therefore narrower and honest: what did I run against this database, and when. If agents ever execute SQL through this panel, the untrusted-actor case returns and fail-closed is worth revisiting (D19).

### Full statement text, and never the connection URL

The `statement` field carries the SQL verbatim (D4). A redaction pass over literals was rejected — it preserves shape while destroying the ability to answer "which row did this delete?", which is most of the value. The consequence is that the audit file is itself sensitive, so it is written through the same 0600 path `save_connections` uses. `DbConnection.url` is never logged under any `kind`; entries carry `connectionId` and `connectionName`. Logging the URL would recreate the plaintext-credential finding in a new file. (D4, D14)

Entries are one JSON object per line: `{ ts, kind, connectionId, connectionName, backend, schema?, table?, statement?, rowsAffected?, ok, error? }`, `kind` ∈ `connection.add | connection.remove | connection.rename | query | edit`. There is no `actor` field — the app is single-user and the OS account is the actor, which is the same reasoning that makes an in-app auth gate a non-goal (proposal.md).

Grid paging, schema introspection, and `preview_edits` produce no entries (D5). `preview_edits` runs nothing against the database; the other two fire on every scroll and sort, and excluding them is what lets this change ship without a rotation story. A hand-written `SELECT` from the console *is* recorded — that is the read most worth having.

### Credentials in the keychain, with the current file as the honest fallback

`keyring` v3 covers macOS Keychain and Windows Credential Manager behind one API (D12, amended by D15). Its backends are opt-in features rather than defaults, so they are gated per-target the way Cargo.toml already gates `cocoa`/`objc`; Linux compiles no backend and always takes the fallback below. Entries are keyed service `palisade-code`, account `<project-hash>:<connection-id>`.

When the keychain is unavailable, locked, or refused, storage falls back to today's 0600 `db-connections.json` and emits a `harness-warning` (D8). Hard-failing was rejected: it breaks the panel entirely on headless Linux and in CI, and turns a locked keychain into a dead feature. Silent fallback was rejected as worse than the status quo — the user would believe a credential is in the keychain when it is in a file. The posture is therefore never worse than today, and better wherever a keychain exists.

Migration is lazy, inside `list_connections` (D9): any entry still carrying a `url` is written to the keychain and the JSON rewritten without it. `url` becomes `Option<String>` on disk. Eager startup migration was rejected — it adds I/O across every project and raises a keychain prompt at launch, before the user has opened the DB panel. Lazy migration also self-heals: a run without a keychain simply migrates on the next run that has one. `remove_connection` must delete the keychain entry, or removal leaks a credential with no UI that refers to it.

Note that `pool_for` keys its pool map on `conn.url` (`db.rs:421`). Resolution now happens through the keychain, but the key is still the resolved URL, so pooling and `forget_pool` are unaffected.

### One `tokio::time::timeout` at 30s, not a per-backend statement timeout

A single helper wraps `list_tables`, `columns_of`, `fetch_page`, `run_query`, and `apply_edits` (D10). It is identical on both backends, adds no dependency, and dropping the future returns the pool slot — the resource the finding is actually about. Postgres `SET statement_timeout` via `AnyPoolOptions::after_connect` was considered and deferred: it gives real server-side cancellation but adds a backend branch in `pool_for` with no SQLite equivalent. A per-connection configurable bound was rejected as a settings surface nobody has asked for.

Worth recording against issue #12's framing: `run_query`/`fetch_page` cannot hold a pool slot *indefinitely* today — sqlx's `acquire_timeout` already defaults to 30s, so an unbounded query starves new acquirers after 30s rather than forever. The gap is real, but narrower than the issue states.

## Risks / Trade-offs

- **[Risk] Process killed between COMMIT and the append** → a write lands with no record. Accepted (D7 amended): the log is a history, not evidence, and the alternative cost real console capability.
- **[Risk] The audit log is now a second sensitive artifact** → written at 0600 through the same path as the credential file, and it never contains a connection URL (D4). It does contain whatever PII the user's own SQL contains; that is the deliberate cost of it being evidence.
- **[Resolved] `keyring` v3 backends are opt-in, not default** → the feared hard `libsecret` link does not exist; no backend compiles unless a feature names it. Backends are gated per-target (`apple-native` / `windows-native`), and Linux — not a release target — always takes the D8 file fallback (D15).
- **[Trade-off] Timeout without cancellation** → a runaway statement keeps burning database CPU after Palisade stops waiting for it. Accepted; `statement_timeout` is the named upgrade path (D10).
- **[Trade-off] No audit-log viewer** → reading the evidence means opening a JSONL file by hand. Accepted per D13; the panel's own UI is unchanged by this whole change, which is what keeps it backend-only.
- **[Resolved] `is_destructive` no longer decides a fail mode** → with recording fail-open for every operation (D6 amended), the text-shape gap inherited from `db-viewer-editor` D12 gains no new consequence here.

## Migration Plan

1. Sync `database-viewer` into main specs before anything else (D2) — done as task 0.1; the delta in this change has no base otherwise.
2. Ship keychain storage first (D11). It is the only piece with a new dependency, a data migration, and three OS backends, and it settles `DbConnection`'s final shape before the audit log records connection events.
3. Existing installs need no user action: the first `list_connections` after upgrade migrates in place. There is no version gate — an entry with a `url` is unmigrated, an entry without one is migrated.
4. Rollback: an older build reading a migrated `db-connections.json` finds no `url` and lists connections it cannot open. Recovery is re-entering the connection string, not data loss — the databases themselves are untouched, and the credential remains in the keychain for a re-upgraded build to find.

