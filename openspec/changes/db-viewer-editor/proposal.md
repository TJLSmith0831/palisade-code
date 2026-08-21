## Why

FSEs and data engineers using Palisade today have to leave the app and open DataGrip whenever they need to inspect or edit a database — Palisade's `.sql` support is syntax highlighting only, with no connection, schema browsing, or query execution. This closes that gap for the common case (Postgres/SQLite, one table or query at a time) without trying to fully replace a dedicated DB IDE.

## What Changes

- New `IconDatabase` entry in the left icon rail (`NavRail.tsx`) opens a docked side-panel listing saved, user-named connections; each expands into a schema tree of tables/views.
- New backend module (`src-tauri/src/db.rs`) using `sqlx::Any` to connect to Postgres and SQLite from one binary at runtime (URL-scheme-selected driver).
- Connection strings stored as plaintext JSON at `~/.palisade-code/projects/<hash>/db-connections.json` (0600 permissions) — never in the target repo, never in `project-settings.json`.
- Double-clicking a table opens it as a new center-workspace tab (alongside Editor/Console Chat/Diff): a paginated (200 rows/page), sortable/filterable data grid.
- A separate SQL editor tab reuses the existing CodeMirror `.sql` wiring to run arbitrary SQL, with a confirm step before any statement that looks destructive (DELETE/DROP/TRUNCATE/ALTER, or an UPDATE/DELETE with no WHERE).
- Inline cell editing in the grid, gated to tables with a primary key in the fetched columns. Edits stage as pending row changes; "Apply" runs them as one all-or-nothing transaction, previewing the generated SQL first. Each row's `UPDATE` matches on primary key + original column values, so a 0-row-affected result surfaces a conflict (someone else changed the row) instead of silently overwriting.

## Capabilities

### New Capabilities
- `database-viewer`: Connect to Postgres/SQLite databases, browse schema (tables/views) in a rail-docked panel, view/sort/filter/paginate table data in a workspace-tab grid, run arbitrary SQL in a query editor tab, and edit table rows inline with a previewed, transactional, conflict-checked write path.

### Modified Capabilities
(none — `editor-collapsible-rail` and `resizable-layout` govern panel *mechanics* generically; adding a new panel to the existing rail/tab inventory doesn't change either spec's requirements)

## Impact

- **Frontend**: `src/NavRail.tsx` (new rail entry), `src/hooks/useAppShell.ts` (new `PanelId`), `src/App.tsx` (new side-panel content, new center-workspace tab), new components for the connection list/schema tree, data grid, and SQL editor result pane.
- **Backend**: new `src-tauri/src/db.rs`; new `sqlx` dependency with `any`, `postgres`, and `sqlite` features; three new-or-more `#[tauri::command]`s registered in `generate_handler!` (`lib.rs`) with matching `src/api.ts` wrappers, per the repo's three-edit IPC convention.
- **Storage**: new file `~/.palisade-code/projects/<hash>/db-connections.json`, following the existing `palisade_home()` pattern in `store.rs`.
- **No changes** to existing specs, session store format, or `project-settings.json` schema.
