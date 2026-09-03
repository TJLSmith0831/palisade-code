## Why

GH issue #12 assessed the database viewer/editor against SOC 2 Type II and graded it F — not for code quality, but because the feature produces no operating evidence for several controls. Three of its six findings are real gaps on their own merits, independent of whether Palisade is ever in audit scope: nothing anywhere in `db.rs`, `db_cmds.rs`, or `store.rs` records that a query ran; connection strings sit in plaintext JSON (`db.rs:71`), with the Windows branch skipping even the 0600 fix; and no statement or wall-clock bound exists on query execution.

## What Changes

- **Append-only query history** — what ran against a database and when, for the person using the app rather than for an auditor (D19) — at `~/.palisade-code/projects/<hash>/db-audit.jsonl`, reusing `store::append_verification`'s write shape. Records connection add/remove/rename, every `run_query`, and every `apply_edits` — with full statement text and real `rowsAffected` (D4, D5, D13, D14).
- **Recording never blocks an operation.** The entry is appended after the fact; an append failure is warned about, not fatal. No transaction involvement, so statements that cannot run inside `BEGIN`/`COMMIT` (`VACUUM`, `CREATE INDEX CONCURRENTLY`) keep working (D6, D7 amended).
- **Connection details are stored as fields, not a URL string** (D21) — Postgres host/port/user/database in the file, the password alone in the credential store; SQLite is a path with no secret at all (D22). Listing connections therefore performs no credential-store access, so the OS prompts on first *connect* rather than on panel open (D23) — the behaviour DataGrip has. The add form becomes discrete fields with a connection-string paste shortcut (D24).
- **Credentials move to the OS keychain** — macOS Keychain, Windows Credential Manager, Windows Credential Manager via `keyring` v3. Existing connections migrate lazily on first read; when no keychain is available the current 0600 file is the fallback, with a `harness-warning` (D8, D9, D12). **BREAKING** for the on-disk shape and the `db_add_connection` IPC signature: connections are stored as fields, and the command takes fields rather than a URL. The add-connection form becomes field-based (D24), so this change now carries real frontend scope.
- **Fixed 30s query timeout** via one `tokio::time::timeout` helper across `list_tables`, `columns_of`, `fetch_page`, `run_query`, `apply_edits` (D10).
- **Prerequisite:** sync `db-viewer-editor`'s delta into `openspec/specs/database-viewer/` first — it is complete but unsynced, so this change currently has no base to modify against (D2, D11).

Explicit non-goals, all findings from issue #12 deliberately left open (D1):

- **Enforced transport encryption** (finding 3). Blocking a bare `postgres://` breaks the local-dev case that is most of this feature's use. A warning is a later change.
- **Authentication/authorization gate** (finding 4). Palisade is a single-user desktop app; the security boundary is the OS account, which already gates `~/.palisade-code` and the keychain itself. An in-app unlock protects against nothing the OS does not, and adds a lockout failure mode. A per-connection *read-only flag* is the part worth having — as a footgun guard, not a security control — and is its own change.
- **PII classification, masking, pre-write backup** (finding 5). A data-governance program, not a feature, with no tenant or operator/subject split here to govern.
- **Semantic destructive-statement detection.** `is_destructive` stays a text-shape check; `WHERE 1=1` still slips past, as already accepted in `db-viewer-editor` design.md — Risks (D12 there).
- **No UI or IPC read command for the audit log** (D13). Evidence is read off disk; a viewer carries its own redaction questions.

## Capabilities

### New Capabilities

_None._ Every change here modifies behavior the `database-viewer` capability already describes.

### Modified Capabilities

- `database-viewer`: adds requirements for an append-only audit record of connection and statement activity, and for a bounded query execution time; modifies `Requirement: Connection credentials never enter the target project's repository` to describe keychain-backed storage with a documented degraded fallback rather than plaintext-with-file-permissions.

## Impact

- **Code**: `src/api.ts` and `src/__tests__/DatabasePanel.test.tsx` lose the `DbConnection.url` field (D16); `src-tauri/src/db.rs` (storage, pooling, all query paths), `src-tauri/src/commands/db_cmds.rs` (audit call sites). No `generate_handler!` or `src/api.ts` edits — no new IPC commands.
- **Dependencies**: adds `keyring` v3 to `src-tauri/Cargo.toml`.
- **Data**: `db-connections.json` gains a migration; OS keychain entries under service `palisade-code`, account `<project-hash>:<connection-id>`.
- **Specs**: requires `db-viewer-editor` to be synced first; its D8 (keychain deferred, plaintext accepted) is superseded here.
- **Verification**: `cd src-tauri && cargo test db::` (D3).

