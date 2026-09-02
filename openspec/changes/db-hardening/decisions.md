# Decision log — db-hardening

Source of truth for every artifact in this change. Appended as decisions
resolve, not batched. Origin: GH issue #12 (SOC 2 readiness assessment of the
database viewer/editor).

## D1: Which of issue #12's six findings are in scope?
- **Decision**: Findings 1 (no audit logging), 2 (plaintext credentials), and 6 (no query timeout). Findings 3 (transport encryption), 4 (authorization gate), and 5 (PII classification / pre-write backup) are explicit non-goals for this change.
- **Why**: Those three are real gaps on their own merits regardless of the SOC 2 framing, and all three are self-contained backend work in `db.rs`/`db_cmds.rs` with no frontend surface.
- **Source**: user

## D2: `database-viewer` is not in main specs — what does this change's delta stack on?
- **Decision**: Sync `db-viewer-editor`'s delta into `openspec/specs/database-viewer/` before writing this change's delta. This change then writes ADDED + MODIFIED against a real base.
- **Why**: A MODIFIED delta stacked on an unsynced delta has no base for `openspec validate`, and archiving the two changes out of order corrupts the merge.
- **Source**: user

## D3: What command proves this change done?
- **Decision**: `cd src-tauri && cargo test db::` green, plus the full `cargo test` gate before archive.
- **Why**: Repo convention — the `verification` spec requires a named command exiting 0 at a named commit, and `db.rs` already carries its tests inline as `mod tests`.
- **Source**: codebase (CLAUDE.md Commands; src-tauri/src/db.rs inline `mod tests`)

## D4: What does the audit log's `statement` field contain?
- **Decision**: The full statement text, verbatim. The audit file is written through the same 0600 path `save_connections` uses. `DbConnection.url` is never logged — entries carry `connectionId` and `connectionName` only.
- **Why**: An audit log that can't say what ran is not evidence; and the URL is the one field that embeds a password, so logging it would recreate finding #2 in a new file.
- **Source**: recommended-accepted

## D5: Which operations produce an audit entry?
- **Decision**: `db_add_connection`, `db_remove_connection`, `db_rename_connection`, `db_apply_edits`, and every `db_run_query` — including a `run_query` that only reads. Not `db_fetch_page`, `db_list_tables`, `db_table_columns`, or `db_preview_edits`.
- **Why**: A hand-written SELECT against a sensitive table is a read worth recording; grid paging and schema introspection fire on every scroll and sort and would drown the log without a rotation story this change doesn't have. `preview_edits` runs nothing against the database.
- **Source**: recommended-accepted

## D6: What happens when the audit write itself fails?
- **Decision**: Fail closed on writes, fail open on reads. `apply_edits` and a `run_query` that `is_destructive` abort and surface the audit error. A non-destructive `run_query` and the connection add/remove/rename operations proceed, with the audit failure written to `harness.log`.
- **Why**: An unloggable write is the case the CC7.2 evidence claim actually rests on; making a full disk brick read access to the panel is a worse trade than a gap in the read record.
- **Source**: recommended-accepted

## D7: How is a fail-closed audit entry ordered against the operation it records?
- **Decision**: The audit write happens inside the database transaction. `apply_edits`: BEGIN → every UPDATE → append the audit entry carrying the real `rowsAffected` → COMMIT, with ROLLBACK if the audit append fails. A destructive `run_query` is wrapped in the same BEGIN/COMMIT shape so it gets the same guarantee.
- **Why**: It is the only ordering that is both genuinely fail-closed and carries the outcome in one entry; a durable audit line whose transaction rolled back is the failure mode a two-phase intent/outcome scheme trades extra volume to avoid, and it can't happen here.
- **Source**: recommended-accepted
- **Note**: The fsync-then-COMMIT window is not atomic — a process kill between the audit append and COMMIT leaves a logged write that never landed. Accepted; the log records an attempt that is auditable as such, which is the safe direction to be wrong in.

## D8: What happens when the OS keychain is unavailable?
- **Decision**: Fall back to the existing 0600 `db-connections.json` storage and emit a `harness-warning` naming the degraded storage. Never silently, never a hard failure.
- **Why**: The panel has to keep working on headless Linux and in CI where there is no secret-service; the fallback is exactly today's behaviour, so the posture is no worse anywhere and better wherever a keychain exists. Silent fallback would leave the user believing a credential is in the keychain when it is in a file.
- **Source**: recommended-accepted
- **Supersedes**: `db-viewer-editor` D8, which deferred keychain integration and accepted plaintext-with-0600 as the v1 model.

## D9: How do already-saved connections migrate to the keychain?
- **Decision**: Lazily, inside `list_connections`. Any entry still carrying a `url` is written to the keychain and the JSON rewritten without it. `DbConnection.url` becomes `Option<String>` on disk (absent once migrated) while the in-memory struct resolves it from the keychain.
- **Why**: No startup I/O across every project, no keychain prompt before the user has opened the DB panel, and it self-heals — a run where the keychain was unavailable (D8) migrates on the next run that has one.
- **Source**: recommended-accepted
- **Note**: The keychain entry is keyed service `palisade-code`, account `<project-hash>:<connection-id>`. `remove_connection` must delete the keychain entry too, or removal leaks a credential that no longer has a UI.

## D10: What bounds query execution time?
- **Decision**: One `tokio::time::timeout` helper at a fixed 30s, wrapping `list_tables`, `columns_of`, `fetch_page`, `run_query`, and `apply_edits`. Not configurable. Postgres `SET statement_timeout` via `after_connect` is the named upgrade path, not built here.
- **Why**: Identical on both backends with no new dependency and no backend branch; dropping the future returns the pool slot, which is the resource finding #6 is actually about.
- **Source**: recommended-accepted
- **Correction to issue #12**: `run_query`/`fetch_page` cannot hold a pool slot indefinitely today — sqlx's `acquire_timeout` already defaults to 30s, so an unbounded query starves *new* acquirers after 30s rather than forever. The gap is real but narrower than the issue states.
- **Note**: The timeout abandons the future; it does not cancel the query server-side. A runaway statement keeps burning database CPU until the server ends it.

## D11: What order are the three pieces built in?
- **Decision**: Task 0 syncs `db-viewer-editor`'s delta into main specs (D2). Then: keychain storage → audit log → query timeout.
- **Why**: Riskiest first. The keychain is the only piece carrying a new dependency, a data migration, and three OS backends; settling `DbConnection`'s final shape before the audit log records connection events avoids rewriting those fields.
- **Source**: recommended-accepted

## D12: Which dependency provides keychain access?
- **Decision**: `keyring` v3 — macOS Keychain, Windows Credential Manager, Linux secret-service behind one API.
- **Why**: It is the only maintained cross-platform option, and the three-backend coverage is exactly the matrix D8's fallback is written against.
- **Source**: recommended-accepted
- **Open**: pin the exact version at implementation time and confirm its Linux feature flags don't force a hard `libsecret` link on a headless build — that would break D8's fallback at compile time rather than at runtime.

## D13: Where does the audit log live, and is there a UI for it?
- **Decision**: `~/.palisade-code/projects/<hash>/db-audit.jsonl`, following the `verify.jsonl` convention and reusing `store::append_verification`'s write shape (create+append, torn-line repair, `sync_all`). No UI, no IPC read command in this change.
- **Why**: D1 scoped this change to backend work with no frontend surface; the log is evidence to be read off disk, and a viewer is a separate change with its own redaction questions.
- **Source**: codebase (src-tauri/src/store.rs:709 `append_verification`), plus D1

## D14: Audit entry shape
- **Decision**: `{ ts, kind, connectionId, connectionName, backend, schema?, table?, statement?, rowsAffected?, ok, error? }` — one JSON object per line. `kind` is one of `connection.add`, `connection.remove`, `connection.rename`, `query`, `edit`.
- **Why**: Covers the actor/timestamp/connection/statement set issue #12 names as the CC7.2 minimum, in the flat one-line-per-event form the existing JSONL readers already parse. No `actor` field — the app is single-user and the OS account is the actor (see the non-goal on finding #4).
- **Source**: recommended-accepted, derived from D4/D5

## D15: Which `keyring` backends are compiled in? (resolves design.md — Open Questions)
- **Decision**: Per-target features, following the `[target.'cfg(target_os = "macos")'.dependencies]` block Cargo.toml already uses: `apple-native` on macOS, `windows-native` on Windows, no backend on Linux. Linux therefore always takes the D8 file fallback.
- **Why**: `keyring` v3 enables **no** backend by default — every platform store is opt-in (`cargo add keyring@3 --dry-run`), so the feared hard `libsecret` link does not exist and cannot break a headless build. Palisade ships macOS aarch64 `.dmg` only (`tauri.conf.json` bundle targets; AGENTS.md:71), so a Linux backend would be untestable code for a platform that has no release artifact. `windows-native` costs nothing per-target and keeps D12's stated matrix honest where it ships.
- **Source**: codebase (src-tauri/Cargo.toml:54 per-target block; src-tauri/tauri.conf.json bundle.targets; AGENTS.md:71)

## D12 (amended): Which dependency provides keychain access?
- **Amendment**: Linux secret-service is **not** compiled in — see D15. `keyring` v3 still provides macOS Keychain and Windows Credential Manager behind one API; Linux resolves through D8's fallback unconditionally rather than attempting a store.
- **Why amended**: The original entry assumed keyring shipped platform backends by default. It does not, and Linux is not a release target, so enabling one would add untestable surface.

## D16: `db_list_connections` serializes the connection URL into the webview
- **Decision**: Strip `url` from the serialized `DbConnection`. Remove it from the `DbConnection` TS type in `src/api.ts` and from the one fixture in `src/__tests__/DatabasePanel.test.tsx`. The in-memory Rust struct keeps `url` resolved.
- **Why**: Found during task 1.2 — every saved connection string is shipped into the webview on every panel open, and nothing reads it: `DatabasePanel.tsx` uses `url` only as local form state for the add input (line 53), never `conn.url`. Same credential-exposure class as issue #12 finding 2, in a place the audit did not look. It also makes `db_cmds.rs:1`'s claim that "a credential only ever travels one way" true rather than aspirational.
- **Source**: user

## D1 (amended): Which of issue #12's six findings are in scope?
- **Amendment**: The change is no longer strictly backend-only. D16 adds a ~4-line frontend diff (type field + test fixture). Scope of *findings* is unchanged; only the "no frontend surface" boundary moves.
- **Why amended**: The exposure D16 closes is part of finding 2, and deferring it would leave credentials flowing to the webview for the sake of a boundary rather than a requirement.

## D17: Keychain I/O must not run on the async runtime
- **Decision**: Every command that touches the credential store runs its work through `tokio::task::spawn_blocking`, matching the idiom `lib.rs` already uses for store I/O (56 call sites, e.g. `lib.rs:70`). `db_cmds.rs` had not adopted it.
- **Why**: Found by running the app during task 1. `keyring` is blocking sync I/O and on macOS can raise a modal OS authorization prompt — an unsigned dev build re-prompts on every rebuild, since the binary's keychain ACL changes. Calling it directly from an `async` command pins a tokio worker thread for as long as that dialog is on screen.
- **Source**: codebase (src-tauri/src/lib.rs:70 idiom), found during implementation

## D18: A macOS keychain prompt is expected on first access, and on every dev rebuild
- **Decision**: Accepted, not worked around. The user sees a one-time "allow access" prompt per signed build; "Always Allow" persists it. Dev builds re-prompt because each rebuild produces a new unsigned binary.
- **Why**: Observed live during task 1 — the panel spun until the prompt was answered, then resolved normally. This is inherent to OS credential storage and is the cost D8 accepted; suppressing it would mean not using the keychain. Release builds are signed and notarized (AGENTS.md), so a real user sees it once.
- **Source**: recommended-accepted, observed during implementation

## D6 (amended): What happens when the audit write itself fails?
- **Amendment**: Fail open, always. The operation runs regardless; an append failure goes to `harness.log`. The original fail-closed-on-writes rule is withdrawn.
- **Why amended**: Fail-closed exists to make the record tamper-resistant *evidence*, which presumes an actor distinct from the auditor. In a single-user IDE they are the same person, and anyone wanting to defeat the log can delete the file. It defended against an adversary that does not exist, at real cost (see D7).
- **Source**: user

## D7 (amended): How is the audit entry ordered against the operation?
- **Amendment**: Appended after the operation completes, carrying its real outcome. No transaction involvement. `apply_edits` keeps its existing transaction untouched; a destructive `run_query` is **not** wrapped in BEGIN/COMMIT.
- **Why amended**: The wrapping was a regression, not just complexity. `VACUUM`, `CREATE INDEX CONCURRENTLY`, and some `ALTER TYPE` forms cannot execute inside a transaction, so D7 as written would have broken statements the console is explicitly meant to run (`db-viewer-editor` D12: "a read-only console isn't a real console"). Serving a compliance property nobody audits by removing real console capability is the wrong trade.
- **Source**: user

## D19: What is the audit log actually for?
- **Decision**: A query history for the person using the app — "what did I run against this database, and when" — not compliance evidence. Same file, same fields; the claim it supports is narrower.
- **Why**: Honest reframing of the reader. Nothing in a single-user IDE consumes CC7.2 evidence; a solo developer with a SQL console genuinely does want to see what they ran an hour ago. The record earns its place on that basis without the fail-closed machinery.
- **Trigger to revisit**: if agents ever execute SQL through this panel, "did the user or the agent run this?" becomes a real question with a genuinely untrusted actor, and fail-closed auditing (original D6/D7) is worth building then. Agents today have no path to these IPC commands.
- **Source**: user

## D20: The credential store's OS prompt is not something Palisade can verify for the user
- **Decision**: Live verification of the query history against the running app is left to the user; the automated evidence is the unit suite plus the observed keychain migration.
- **Why**: Reading a credential raises a macOS authorization prompt that only the person at the keyboard can answer (D18), and answering it on their behalf is not an approval an agent should give. Every rebuilt dev binary re-prompts.
- **Source**: recommended-accepted, observed during implementation

---

# Scope change: the JetBrains connection model (2026-09-02)

## D21: Credentials are split from connection details, DataGrip-style
- **Decision**: A connection is stored as discrete fields — Postgres: host, port, user, database (non-secret, in `db-connections.json`) with the **password alone** in the credential store; SQLite: a file path and nothing else. The whole-URL-in-keychain model from D9 is withdrawn.
- **Why**: DataGrip explicitly warns against its own "URL only" connection type because credentials embedded in a URL are stored in plain text and leak into the IDE log, and directs users to discrete fields instead. Palisade's URL-only model forced the entire connection string into the keychain, which in turn made `list_connections` read the keychain **just to render a list of names** — an OS auth prompt on panel open, even for a user who never clicks a connection. DataGrip touches the credential store only on connect.
- **Source**: user, informed by JetBrains DataGrip documentation (data-sources-and-drivers-dialog, reference-ide-settings-password-safe)

## D22: SQLite connections never touch the credential store
- **Decision**: A SQLite connection is a file path with no secret component. It is stored entirely in `db-connections.json` and resolves with no credential-store access.
- **Why**: SQLite has no host, user, or password to protect. Under D21 this falls out for free and removes the prompt entirely for every SQLite connection.
- **Source**: codebase (`Backend::Sqlite`, `backend_of` in db.rs)

## D23: Listing connections must not read the credential store
- **Decision**: `list_connections` returns names, backend, host, user, and database from the file alone. The password is resolved only when a pool is opened (`pool_for`) — i.e. when the user clicks a connection or runs a statement.
- **Why**: This is the actual fix for the friction. One prompt on first connect per signed build, matching DataGrip, instead of one on panel open. Falls out of D21 rather than needing its own mechanism.
- **Source**: user

## D24: The add-connection form is fields, with URL paste as a shortcut
- **Decision**: Host / Port / User / Password / Database inputs for Postgres, a file-path input for SQLite, plus a paste box that parses a connection string into those fields. The URL is never stored.
- **Why**: Keeps the paste-and-go flow the current form has while splitting the secret automatically; the parsed fields stay visible and editable, so a malformed connection is diagnosable instead of an opaque failure.
- **Source**: user

## D25: This lands in `db-hardening` rather than a new change
- **Decision**: Fold the model change into `db-hardening`, superseding its own D9 and amending the credential requirement already modified there.
- **Why**: Nothing has shipped. A change archived describing whole-URL-in-keychain — a model that never reached a release before being replaced — is churn in the spec history. The keychain plumbing (vault module, fallback, `spawn_blocking`, lazy migration) is reused unchanged; only what it stores narrows.
- **Source**: recommended-accepted

## D26: A record with neither fields nor a URL is recoverable, not dropped
- **Decision**: `list_connections` shows such a record with placeholder details instead of skipping it; `with_secret` recovers the connection string from the credential store on connect, splits it into fields, and rewrites the file. A record with nothing recoverable anywhere fails with a message naming the connection and telling the user to re-enter its details.
- **Why**: Found by running the app — the `demo` connection vanished from the panel. Its record had been migrated by the intermediate whole-URL-in-keychain build, so it had no `path` and no `url` on disk, and the first draft of `list_connections` silently dropped anything it could not parse. Silently dropping a saved connection is wrong for any unreadable record, not just this one.
- **Source**: recommended-accepted, found during implementation
