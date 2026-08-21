## Context

See proposal.md - Why. Palisade's existing panel/tab mechanisms (the left icon rail → docked side-panel pattern in `NavRail.tsx`/`useAppShell.ts`/`App.tsx`, and the center-workspace tab bar) already do the docking and resizing this feature needs — see [decisions.md](decisions.md) D1. The repo has no existing database connectivity, no credential-storage mechanism, and no `sqlx` (or any DB driver) dependency today.

## Goals / Non-Goals

**Goals:**
- Connect to Postgres and SQLite from one binary, at runtime, by connection-string URL scheme.
- Never let a database credential land inside the target project's own repo.
- Make row edits provably safe: no edit ever targets more than one row, and no edit ever silently overwrites a concurrent change.

**Non-Goals:**
- MySQL support (deferred — D6).
- OS keychain / encrypted credential storage (deferred — D8; v1 uses file permissions).
- Multi-driver builds beyond Postgres+SQLite, ER diagrams, visual query builder, CSV export, Tree/Text/Transpose grid modes (D14, D16) — see proposal.md for the full v1/non-v1 cut.

## Decisions

### Driver: `sqlx::Any`, hand-rolled module — not `tauri-plugin-sql`
`sqlx`'s `Any` driver selects the concrete backend (Postgres or SQLite) per-connection at runtime from the URL scheme, compiled once with the `any`, `postgres`, and `sqlite` features. The official `tauri-apps/tauri-plugin-sql` was considered and rejected: it only allows one driver feature compiled in per build (incompatible with supporting both engines at once — D6/D7), and its API is shaped for an app's own predefined queries against a known schema, not generic runtime schema introspection (listing tables/columns for an arbitrary connected database). A new `src-tauri/src/db.rs` module owns connection pooling (one `AnyPool` per saved connection, lazily created on first use) and schema introspection, following the repo's three-edit IPC convention (command fn → `generate_handler!` → `src/api.ts` wrapper) for each new capability: add connection, list connections, list tables/views, fetch page, run query, preview edit SQL, apply edits. (D13)

### Credential storage: plaintext JSON under `~/.palisade-code/`, not `project-settings.json`
Connection strings (which may embed a password) are stored at `~/.palisade-code/projects/<hash>/db-connections.json`, mode `0600`, reusing `store.rs`'s existing `palisade_home()` path convention — the same reasoning that keeps session history outside target repos applies directly to credentials. `project-settings.json` was rejected as the storage location because it lives inside the project root and is only *optionally* gitignored by the user (per its own spec) — a credential leak is a worse failure mode than a leaked layout preference. OS keychain integration was considered and deferred: it's a new dependency and a larger first slice than this change needs; the plaintext-with-file-permissions model matches the trust level Palisade already extends to `~/.ssh`-style local secrets, and upgrading to keychain later doesn't change the IPC surface. (D5, D8)

### Row targeting: primary key required, WHERE matches PK + original values
A table is only inline-editable when its primary key column(s) are present among the fetched columns; otherwise cells render read-only (checked in `db.rs` at fetch time, using each driver's catalog — `information_schema` for Postgres, `PRAGMA table_info` for SQLite). Every generated `UPDATE`'s `WHERE` clause matches the primary key **and** every other original column value fetched into the grid, not the primary key alone. A rejected alternative — matching on all fetched columns without a PK, to support "editable" rows on PK-less tables — was rejected because it can silently multi-update duplicate rows; a rejected alternative for the WHERE clause — PK-only — was rejected because it can't detect a concurrent change from elsewhere. Zero rows affected by an `UPDATE` is therefore unambiguous: the row changed since fetch, surfaced as a conflict rather than treated as a no-op success. (D9, D10)

### Batch apply: one transaction, all-or-nothing
Multiple pending row edits on a table apply inside a single database transaction (`BEGIN` … each `UPDATE` … `COMMIT`, or `ROLLBACK` on any failure/conflict). An independent-per-row alternative (each edit its own transaction, partial success allowed) was rejected: it produces a harder-to-explain UI state ("3 of 5 saved") and a harder bug surface, for a case (mixed success/failure within one user-initiated batch) that isn't a named requirement. The "preview" step (Requirement: Preview and apply pending edits) renders the same SQL the transaction will run, before it runs, so the user never applies unseen statements. (D11)

### SQL editor: full power, gated confirmation on destructive shapes
The query editor executes any SQL the user writes — no SELECT-only restriction — because a read-only console isn't a real console. Statement text is pattern-matched before execution for the destructive shapes named in the spec (`DELETE`/`DROP`/`TRUNCATE`/`ALTER`, or `UPDATE`/`DELETE` with no `WHERE` clause); a match blocks execution behind a confirm step. This is a text-shape check, not a query planner — it can't reason about `WHERE 1=1` or a CTE that resolves to no rows, and that's an accepted gap (see Risks). (D12)

## Risks / Trade-offs

- **[Risk] Plaintext credential storage** → file permissions `0600` limit exposure to the local user account; documented as a v1 limitation, with OS keychain as the named upgrade path once there's a concrete need (D8).
- **[Risk] Destructive-statement detection is pattern-based, not semantic** → a cleverly-written but effectively-unbounded statement (e.g. `WHERE 1=1`, or a DDL statement inside a stored procedure call) can slip past the confirm gate. Mitigation: the gate covers the common accidental cases (forgot the WHERE clause, fat-fingered DROP); full semantic analysis is out of scope for a first pass.
- **[Risk] `sqlx::Any` schema introspection differs per backend** → Postgres and SQLite expose table/column metadata through different catalogs (`information_schema` vs `PRAGMA`), so `db.rs`'s introspection code has two backend-specific branches under one interface, not one shared query. Mitigation: tested against both engines in the task-level test plan.
- **[Trade-off] All-or-nothing batch apply** → a user who intentionally wants partial application of a mixed batch (some rows known-safe, some speculative) has no way to get that in v1; they can instead apply edits in smaller batches. Accepted per D11.

## Migration Plan

None — this is a net-new capability with no existing data, schema, or IPC surface to migrate. First run creates `~/.palisade-code/projects/<hash>/db-connections.json` on demand (first "add connection"), matching how `store.rs` lazily creates its own per-project directories today.
