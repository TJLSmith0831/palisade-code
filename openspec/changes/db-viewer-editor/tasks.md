## 1. Backend foundation

- [x] 1.1 Add `sqlx` dependency to `src-tauri/Cargo.toml` with `any`, `postgres`, `sqlite`, and `runtime-tokio` features (D6, D13)
- [x] 1.2 Create `src-tauri/src/db.rs`: connection struct, `AnyPool` creation from a URL, one pool per saved connection created lazily on first use (D13)
- [x] 1.3 Implement connection storage: read/write `~/.palisade-code/projects/<hash>/db-connections.json` (mode `0600`), reusing `store.rs`'s `palisade_home()` (D5, D8)
- [x] 1.4 IPC: `db_add_connection`, `db_list_connections` commands + `generate_handler!` entries + `src/api.ts` wrappers (D4)
- [x] 1.5 Schema introspection: list tables/views per connection (Postgres via `information_schema`, SQLite via `PRAGMA table_info`/`sqlite_master`), behind one `db_list_tables` IPC command (D16)
- [x] 1.6 Unit tests: connection-string parsing/validation, storage file permissions, both backends' table-listing branch

## 2. Rail panel: connections + schema tree

- [x] 2.1 Add `"database"` to `PanelId` in `useAppShell.ts`
- [x] 2.2 Add `IconDatabase` rail entry to `NavRail.tsx`
- [x] 2.3 Build the docked side-panel: connection list (add/rename/remove), expandable schema tree per connection, using the existing `role="button" tabIndex={0}` row contract
- [x] 2.4 Empty state ("no connections yet") and inline connection-failure error state, matching `project-settings.json`'s malformed-file warning pattern, not a toast (D18)
- [x] 2.5 Frontend test: rail button opens/closes the panel; empty state renders with zero connections

## 3. Read path: data grid

- [x] 3.1 IPC: `db_fetch_page` (table name, page, sort, filter → rows + column metadata) with 200-row pages (D15)
- [x] 3.2 Double-clicking a table in the schema tree opens a new center-workspace tab with the grid
- [x] 3.3 Grid: column sort, column filter, pagination controls, "no rows" empty state (D14, D18)
- [x] 3.4 Grid cell rendering: NULL visually distinct from empty string
- [x] 3.5 Frontend test: sort/filter re-fetch with correct params; NULL cell renders distinctly; empty-table state

## 4. SQL editor tab

- [x] 4.1 IPC: `db_run_query` (connection, SQL string → rows or affected-row count / error)
- [x] 4.2 SQL editor tab reusing the existing CodeMirror `.sql` language wiring, results grid below
- [x] 4.3 Destructive-statement pattern match (`DELETE`/`DROP`/`TRUNCATE`/`ALTER`, or `UPDATE`/`DELETE` with no `WHERE`) → confirm dialog before execution (D12)
- [x] 4.4 Inline error display for query failures (not a toast) (D18)
- [x] 4.5 Backend test: destructive-pattern matcher against a table of statements (positive and negative cases); query error surfaces without crashing the session

## 5. Inline edit + transactional apply (riskiest — last)

- [x] 5.1 Primary-key detection at fetch time; grid marks cells read-only when no PK is present in fetched columns, with an explanatory tooltip (D9)
- [x] 5.2 Cell edit interaction: double-click to edit, Enter commits as a pending change, Esc cancels, "Set to NULL" in the cell context menu (D17)
- [x] 5.3 IPC: `db_preview_edits` — given pending edits, return the exact `UPDATE` SQL (PK + original values in WHERE) without executing (D10, D2)
- [x] 5.4 IPC: `db_apply_edits` — run all pending edits for a table in one transaction; 0-rows-affected on any statement rolls back the whole batch and reports which row conflicted (D10, D11)
- [x] 5.5 Commit-style bar on the grid ("N pending changes — Preview SQL / Apply / Discard"), echoing the diff pane's stage/commit bar
- [x] 5.6 Backend test: PK-less table stays read-only; successful apply; conflict (row changed since fetch) rolls back and is reported; multi-row batch is all-or-nothing on partial failure

## 6. Impeccable gauntlet (final polish pass)

- [x] 6.1 Run `/impeccable critique` against the new rail entry, docked panel, grid, and SQL editor tab; log findings
- [x] 6.2 Run `/impeccable audit` (accessibility, responsiveness, keyboard operability) against the same surfaces; log findings
- [x] 6.3 Run `/impeccable polish` to apply fixes from 6.1/6.2 — bringing the new surface to DESIGN.md's existing standard (Dragon Fire Green usage, mono/sans split, Mantine/Tabler-only components, focus rings, no-skipped-headings) rather than a bespoke look
- [x] 6.4 Run `/impeccable document` to refresh `.impeccable/design.json` with the new components (connection row, schema tree row, data grid, SQL editor tab) once they're built
- [x] 6.5 Manual pass in the running app: verify the panel/tab/grid look and behave consistently with Explorer/Diff/Editor before calling the change done
