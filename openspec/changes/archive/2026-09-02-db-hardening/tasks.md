## 0. Spec prerequisite

- [x] 0.1 Sync `db-viewer-editor`'s `database-viewer` delta into `openspec/specs/database-viewer/spec.md` so this change's MODIFIED delta has a base; confirm `openspec validate --specs database-viewer` passes (D2)

## 1. Credential storage: OS keychain

Riskiest first (D11) — new dependency, data migration, three OS backends. Settles `DbConnection`'s final shape before the audit log records connection events.

- [x] 1.1 Add `keyring` v3 to `src-tauri/Cargo.toml`; confirm a build with no `libsecret` present still compiles, gating the dependency per-target if it does not (design.md — Open Questions)
- [x] 1.2 In `db.rs`, add `keychain_get`/`keychain_set`/`keychain_delete` over service `palisade-code`, account `<project-hash>:<connection-id>`, each returning a "store unavailable" outcome distinct from "not found" (D8, D12)
- [x] 1.3 Make `DbConnection.url` `Option<String>` on the wire to disk (`#[serde(skip_serializing_if)]`), keeping the in-memory struct's `url` resolved and non-optional so no call site outside `db.rs` changes (D9)
- [x] 1.4 Route `add_connection` through the keychain, falling back to the existing 0600 `save_connections` path and emitting a `harness-warning` when the store is unavailable — never silently, never a hard failure (D8)
- [~] 1.5 (superseded by 5.6) Migrate lazily in `list_connections`: any entry still carrying a `url` is written to the keychain and the JSON rewritten without it; a run with no keychain leaves the entry unmigrated for the next run (D9)
- [x] 1.6 Delete the keychain entry in `remove_connection` so removal leaves no credential without a connection referring to it (D9)
- [x] 1.7 Verify `pool_for`/`forget_pool` still key on the resolved URL and need no change (design.md — Decisions)
- [x] 1.8 Strip `url` from the serialized `DbConnection`; remove it from the `DbConnection` type in `src/api.ts` and the fixture in `src/__tests__/DatabasePanel.test.tsx` (D16)
- [x] 1.9 Tests: add-then-read round-trip against a keychain stub; fallback path writes the 0600 file and warns; lazy migration strips `url` from the JSON; a second `list_connections` is a no-op; `remove_connection` deletes the credential

## 2. Query history (audit log)

A record for the person using the app — "what did I run" — not compliance evidence (D19). Appended after the fact, never blocking (D6/D7 amended).

- [x] 2.1 Add the `AuditEntry` struct in `db.rs`: `{ ts, kind, connectionId, connectionName, backend, schema?, table?, statement?, rowsAffected?, ok, error? }` (D14)
- [x] 2.2 Add `append_audit(home, hash, &entry)` writing `~/.palisade-code/projects/<hash>/db-audit.jsonl`, copying `store::append_verification`'s shape (create+append, torn-line repair, `sync_all`) and `save_stored`'s 0600 mode (D4, D13)
- [x] 2.3 Assert in code and test that no `AuditEntry` path can carry `DbConnection.url` (D4)
- [x] 2.4 Log `connection.add` / `connection.remove` / `connection.rename` from `db_cmds.rs` (D5)
- [x] 2.5 Log `query` for every `db_run_query`, reads included, with the outcome (D5)
- [x] 2.6 Log `edit` after `apply_edits` returns, carrying its real `rowsAffected`. The existing transaction is untouched — no append inside it, no rollback path (D7 amended)
- [x] 2.7 An append failure surfaces via `harness-warning` and never changes the operation's result (D6 amended)
- [x] 2.8 Confirm `fetch_page`, `list_tables`, `columns_of`, and `preview_edits` append nothing (D5)
- [x] 2.9 Tests: an applied edit appends one entry with the true `rowsAffected`; a failing append leaves the result unchanged; paging and sorting append nothing; no entry contains the connection URL

## 3. Query timeout

- [x] 3.1 Add a 30s `tokio::time::timeout` helper in `db.rs` reporting timeout distinctly from a query error (D10)
- [x] 3.2 Wrap `list_tables`, `columns_of`, `fetch_page`, `run_query`, `apply_edits` in it
- [x] 3.3 Tests: a statement past the bound reports a timeout, and the same connection serves the next statement without reconnecting

## 5. Connection model: fields, not a URL string (D21-D25)

Supersedes the whole-URL-in-keychain model from task 1. The vault module, fallback, and `spawn_blocking` plumbing are reused unchanged; only what is stored narrows to the password.

- [x] 5.1 Replace `DbConnection.url` with typed details: `Postgres { host, port, user, database }` / `Sqlite { path }`, plus an in-memory `password` for Postgres (D21, D22)
- [x] 5.2 Add `to_url(&self, password: Option<&str>)` assembling the sqlx connection string, and `parse_url(&str)` splitting one into fields for the paste shortcut (D24)
- [x] 5.3 Store non-secret details in `db-connections.json`; keep only the password in the vault, keyed as today (D21)
- [x] 5.4 `list_connections` reads the file only — no vault access, no migration side effect (D23)
- [x] 5.5 Resolve the password in `pool_for`, so the credential store is touched on connect and nowhere else (D23)
- [x] 5.6 Migration: an entry still holding a `url` is parsed into fields, its password moved to the vault, on first *connect* rather than on list (D23, supersedes 1.5)
- [x] 5.7 Frontend: replace the single connection-string input with Host/Port/User/Password/Database (Postgres) and Path (SQLite), plus a paste box that populates them (D24)
- [x] 5.8 `db_add_connection` takes the fields rather than a URL; update `src/api.ts` and `DatabasePanel.tsx`
- [x] 5.9 Tests: a SQLite connection never touches the vault; listing performs no vault read; a pasted URL round-trips to fields and back; a legacy URL entry migrates on connect; the password never appears in `db-connections.json` or an audit entry
- [x] 5.10 Verify live: open the panel with no OS prompt, then connect and see exactly one

## 4. Close out

- [x] 4.1 `cd src-tauri && cargo test db::` green (D3)
- [x] 4.2 Full gate: `cd src-tauri && cargo test` and `pnpm test` — the frontend is untouched, so this is a regression check, not new coverage
- [x] 4.3 Record the verification run and commit; note in `db-viewer-editor/decisions.md` that its D8 is superseded here (D8)
