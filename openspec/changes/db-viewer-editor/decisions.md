# Decision log: DB viewer/editor

Seeded from the confirmed `/impeccable shape` brief (this session) plus codebase harvest. Not yet an OpenSpec change — will move into `<changeRoot>/decisions.md` once the change is created.

## D1: Where does the surface live in the shell?
- **Decision**: Rail button (`NavRail.tsx`, new `PanelId: "database"`, `IconDatabase`) opens a docked side-panel (same mechanism as Explorer/Search/Git) holding a connections list + schema tree. Double-clicking a table opens it as a new center-workspace tab (alongside Editor/Console Chat/Diff) with a data grid; the SQL query editor reuses the existing CodeMirror instance already wired for `.sql`.
- **Why**: Reuses two mechanisms that already exist (`ds-side-panel` docking, the tab bar) rather than inventing a third; matches PyCharm's Database tool-window split (narrow tree docked, wide grid in the main editor area) which the user explicitly referenced.
- **Source**: user (shape brief, confirmed "dock-in-place is right")

## D2: V1 scope
- **Decision**: Read + query + inline edit. Inline cell edit generates and previews the `UPDATE`/`INSERT` SQL before executing (mirrors the git-diff stage/commit pattern).
- **Why**: User chose full scope over the lower-risk read+query-only option when asked directly.
- **Source**: user (shape brief)

## D3: Connection source (v1)
- **Decision**: Manual connection string (paste a Postgres/MySQL/SQLite URL), not auto-detection from `.env`/docker-compose/prisma files.
- **Why**: User chose manual over auto-detect when asked directly; less magic, fewer edge cases for v1.
- **Source**: user (shape brief)

## D4: IPC command pattern
- **Decision**: Every new backend capability follows the repo's existing three-edit rule: `#[tauri::command]` fn in a new `src-tauri/src/db.rs`, its name added to `generate_handler!` in `lib.rs`, and a typed wrapper in `src/api.ts`.
- **Why**: Documented repo convention; skipping the third edit silently breaks the frontend.
- **Source**: codebase (CLAUDE.md "Gotchas")

## D5: Where NOT to store connection strings
- **Decision**: `project-settings.json` (project-root, user-gitignoreable but not enforced) is the wrong home for connection strings — they can carry embedded credentials. The established pattern for machine-local, per-project data that must never touch the target repo is `~/.palisade-code/projects/<project-hash>/...`, the same home the session store already uses.
- **Amended during apply**: the concrete path is `~/.palisade-code/projects/<hash>/db-connections.json`, not `~/.palisade-code/<hash>/...`. `store.rs` already puts every per-project sidecar under a `projects/` level (`project_dir()`); writing beside it rather than one level up reuses that helper instead of inventing a second layout. Same home, same guarantee — only the literal path in the artifacts moves.
- **Why**: `project-settings.json`'s own spec says the user "MAY gitignore" it — that's opt-in, not guaranteed, and a leaked credential is a worse failure mode than a leaked layout preference. `~/.palisade-code` is structurally outside any target repo, so there's no gitignore dependency at all.
- **Source**: codebase (`src-tauri/src/store.rs:23` — `palisade_home()`; `openspec show project-settings --type spec`)

## D6: Database engines for v1
- **Decision**: Postgres + SQLite via `sqlx`'s `postgres` and `sqlite` feature flags. MySQL deferred.
- **Why**: Postgres covers most hosted-DB workloads; SQLite covers local/embedded dev and doubles as the easiest engine to write tests against. MySQL adds a third driver surface and dialect without a named need yet.
- **Source**: user

## D7: Multiple connections per project
- **Decision**: A project can have multiple saved, user-named connections (e.g. "dev", "staging"). The rail panel lists every saved connection; each expands into its own schema tree.
- **Why**: Matches real workflow (an FSE flips between dev/staging/prod) rather than forcing one-at-a-time replacement.
- **Source**: user

## D8: Credential storage at rest
- **Decision**: Connection strings stored as plaintext JSON under `~/.palisade-code/projects/<hash>/db-connections.json` (see D5's amendment), file permissions `0600`. No OS keychain in v1.
- **Why**: No keychain dependency exists in the codebase today (`Cargo.toml` has none); adding one is real scope for a later, isolated change. Plaintext-with-file-permissions matches the trust model of `~/.ssh` and keeps v1 shippable.
- **Source**: user

## D9: Tables without a primary key
- **Decision**: A table with no primary key (or whose PK isn't among the fetched columns) renders read-only in the grid — cells are non-editable, with a tooltip explaining why.
- **Why**: A generated `UPDATE` needs a WHERE clause that uniquely identifies exactly one row; without a PK there's no safe way to guarantee that, and matching on all columns can silently multi-update duplicate rows.
- **Source**: user

## D10: Optimistic-concurrency conflict detection
- **Decision**: Generated `UPDATE`'s WHERE clause matches the primary key AND every original column value fetched into the grid. If the query reports 0 rows affected, the row changed underneath the user since fetch — surface a conflict error, don't silently overwrite, don't retry automatically.
- **Why**: Detects concurrent edits from elsewhere (another session, another tool) without needing a version/timestamp column the schema may not have.
- **Source**: user

## D11: Batch apply transactionality
- **Decision**: "Apply" runs every pending row edit inside one database transaction. If any statement errors or hits a conflict (D10), the whole transaction rolls back — no partial writes.
- **Why**: Matches the diff pane's stage/commit mental model this feature deliberately echoes; a partial-success state ("3 of 5 rows saved") is a harder UI to explain and a harder bug surface than all-or-nothing.
- **Source**: user

## D12: SQL editor scope
- **Decision**: The free-form SQL editor tab runs arbitrary SQL (SELECT, INSERT, UPDATE, DELETE, DDL). Any statement that looks destructive (DELETE/DROP/TRUNCATE/ALTER, or an UPDATE/DELETE with no WHERE clause) requires a confirm step before executing.
- **Why**: A read-only console isn't a real DataGrip replacement; gating only the dangerous shapes keeps the common case (SELECT, scoped UPDATE) frictionless while catching the actually costly mistakes.
- **Source**: user

## D13: Driver integration — sqlx::Any, not tauri-plugin-sql
- **Decision**: Use `sqlx`'s `Any` driver (`AnyPool`/`AnyConnection`, runtime driver selection by URL scheme — `postgres://` or `sqlite://`) in a hand-rolled `src-tauri/src/db.rs`, not the official `tauri-apps/tauri-plugin-sql` plugin.
- **Why**: `tauri-plugin-sql` only allows one database driver feature compiled in at a time (its own docs: "Only one driver feature can be active at a time"), which is incompatible with D6/D7 (Postgres + SQLite, multiple named connections in one app). Its JS API is also shaped for app-defined queries against a known schema (a todo-app style helper), not generic schema introspection — no "list tables/columns" capability. `sqlx::Any` compiles once and selects the concrete driver per-connection at runtime, which matches this feature's actual shape.
- **Source**: context7 (`/websites/rs_sqlx` — `AnyConnection::connect`; `/tauri-apps/tauri-plugin-sql` — single-driver-feature constraint)

## D14: Grid baseline UX (table stakes from DataGrip)
- **Decision**: The result/table grid supports column sort and filter, distinguishes NULL from empty string visually (not just text), and paginates rather than fetching full tables. Out of scope for v1: Tree/Text/Transpose view modes, per-connection color coding, CSV/export.
- **Why**: Sort/filter/pagination and NULL-vs-empty are baseline expectations for any data grid claiming to replace DataGrip for browsing; the omitted items are real DataGrip features but add UI surface without which the tool is still usable for the core job (browse, query, edit).
- **Source**: WebSearch (JetBrains DataGrip docs — Database Explorer, Data editor and viewer)

## D15: Pagination page size
- **Decision**: Fixed 200 rows per page, not user-configurable in v1.
- **Why**: A setting for a value nobody has asked to tune is speculative scope; 200 is a reasonable default matching typical grid tools. Add a page-size control when someone actually wants a different number.
- **Source**: recommended-accepted (ponytail default)

## D16: Schema tree scope
- **Decision**: Tree shows tables and views only. Indexes, triggers, functions, and sequences are not shown in v1.
- **Why**: Matches D14's table-stakes cut — tables/views cover "browse and edit data," the stated job; the rest is DataGrip surface this feature isn't trying to match yet.
- **Source**: recommended-accepted (ponytail default, consistent with D14)

## D17: Cell edit interaction
- **Decision**: Double-click a cell to edit inline; Enter commits the pending change (marks the row dirty per D11's batch-apply model), Esc cancels. A cell's right-click context menu has one extra action, "Set to NULL" — the one thing a plain text input can't express, since NULL must render/behave differently from an empty string per D14.
- **Amended during apply**: the open cell editor also carries a "Set to NULL" (∅) control next to its input, and a focused cell opens with Enter as well as double-click. A right-click menu is not reachable from the keyboard, so NULL — a value the spec requires the user to be able to set — would otherwise be mouse-only. The context menu stays; it gained a peer.
- **Why**: Standard data-grid interaction (no new pattern to learn); NULL needs an explicit action because typing nothing and typing NULL must not be the same edit.
- **Source**: recommended-accepted (ponytail default)

## D18: Error and empty states
- **Decision**: No connections yet → empty state in the rail panel with an "Add connection" prompt. Connection failure → inline error in the rail panel (not a toast), same pattern as `project-settings.json`'s malformed-file warning. Query/apply errors → shown inline in the results/grid area, not a toast. Zero-row result → "No rows" text in the grid, not a blank void.
- **Why**: Matches the repo's existing convention (project-settings spec: malformed settings surface a non-fatal warning inline, not a toast) rather than inventing a new notification pattern.
- **Source**: codebase (`openspec show project-settings --type spec`) + recommended-accepted

## D19: Final task-list phase — impeccable gauntlet
- **Decision**: tasks.md ends with a dedicated final phase running the shipped feature through `/impeccable` (`critique` + `audit`, then `polish`) against the confirmed DESIGN.md before the change is considered done — not a design pass up front, a finishing pass after the functional slices are built and verified.
- **Why**: User asked explicitly, after design was approved, to bake an impeccable pass into tasks so the new surface (rail entry, docked panel, schema tree, grid, SQL editor tab) matches the rest of the shell's visual system rather than shipping as functionally-correct-but-visually-untuned.
- **Source**: user

## D20: How values cross the IPC boundary
- **Decision**: Every cell value travels as text with `null` for SQL NULL. `fetch_page` casts every column to text in SQL (`CAST(col AS TEXT)`), and a generated `UPDATE` casts each bind back to the column's own type on Postgres (`CAST($1 AS int4)`), reading that type from the catalog it already queries for the primary key.
- **Why**: `sqlx::Any` only decodes a small set of primitive types, so a `uuid`, `timestamptz` or `jsonb` column would fail to decode at all — the grid would be unusable on real schemas. Text is the one representation both backends can produce for any column type, and it makes NULL-vs-empty-string (D14) a type distinction rather than a rendering convention.
- **Source**: recommended-accepted (forced by D13's driver choice; no artifact covered it)

## D21: What happens to pending edits when the view changes
- **Decision**: While a table has pending edits, paging, sorting and filtering are disabled, with the control saying why. Applying or discarding re-enables them.
- **Why**: All three refetch the page, which would silently throw typed-in edits away. The alternatives were a confirm dialog on every sort click or losing the work — a disabled control that explains itself costs the user one extra click and never loses an edit.
- **Source**: recommended-accepted

## D22: Database tabs and the reopen stack
- **Decision**: Closing a table or SQL tab does not push it onto the Cmd+Shift+T reopen stack.
- **Why**: A tab key alone can't rebuild one (a table tab also carries its connection's display name), and both are one click away in the database panel. Reopening a half-formed tab is worse than not reopening it.
- **Source**: recommended-accepted

## Open questions carried into grilling
(none — every question raised during grilling and during apply is logged above)

## D23: Critique gauntlet — fixes applied
- **Decision**: `/impeccable critique` scored the built feature 28/40. All 6 flagged issues were fixed: (1) the "Set to NULL" cell control is now keyboard-activatable (`onClick` alongside the existing `onMouseDown`); (2) focus returns to the grid cell after a keyboard commit or Escape-cancel, instead of dropping to `<body>`; (3) the filter input now shows and lets the user pick its target column instead of silently defaulting to the first one; (4) the staged-cell background no longer reuses `--twilight-glow` (DESIGN.md scopes that token to the Spec Mode banner/chat avatar only) — it uses `color-mix(in oklab, var(--accent), transparent 90%)`, the same recipe as diff-add/diff-remove; (5) all three new error `Alert`s use `color="red"` instead of `color="yellow"`, matching every other error surface in the app; (6) the SQL editor's destructive-statement confirm modal now shows the actual SQL text, mirroring the grid's own Preview-SQL pattern.
- **Why**: dual-agent critique (design review + detector) found these as concrete, checkable breaches of DESIGN.md and PRODUCT.md's keyboard-first standard, not taste opinions — logged here rather than silently patched so the archived change shows what the gauntlet actually caught.
- **Source**: user (critique review), findings from `/impeccable critique` (see `.impeccable/critique/2026-08-21T21-12-22Z__database-viewer-editor.md`)

## D11 (amended): Apply now requires confirmation
- **Amended during apply**: the critique flagged that Apply had zero confirmation at any batch size, inconsistent with the SQL tab's own destructive-statement gate for functionally the same risk (a write against the user's real database). Asked directly, the user chose to require a confirm step on every Apply, not just large batches. `DataGridTab.tsx` now shows a confirm modal (row count, connection name) before running `db_apply_edits`, whether reached from the commit bar or from the Preview-SQL modal.
- **Why**: D11's original "batch-apply is deliberately one click" framing optimized for momentum; the critique showed that leaves the single highest-stakes action in the feature (an actual database write) less guarded than a read-only-adjacent SQL statement. A confirm step costs one click on the common case and closes that gap.
- **Source**: user

## D24: Audit — one more P1 found and fixed
- **Decision**: `/impeccable audit` (accessibility/performance/theming/responsive/integrity) scored 15/16 applicable. It surfaced one real gap the critique's persona pass named but didn't turn into a numbered issue: the right-click "Revert this cell" menu item is mouse-only and unreachable once a cell is in its open (double-clicked) editing state — the only place a staged edit can be undone from the keyboard was Escape, which cancels the whole edit session, not "go back to the original value." Added a keyboard-reachable Revert (↩) control next to "Set to NULL" in the open cell editor, wired the same onMouseDown+onClick pair as the NULL fix (D23) for the same input-blur race.
- **Why**: WCAG 2.1.1 (keyboard operable) — an action that exists in the UI but has no keyboard path is a real accessibility failure, not a nice-to-have.
- **Source**: recommended-accepted (audit finding, fixed inline rather than deferred — small, isolated, same pattern as an already-fixed sibling bug)

## D25: Manual pass found 3 real UI bugs — all fixed
- **Decision**: Live manual testing (Tauri MCP, real SQLite demo DB) surfaced three defects the automated gauntlet couldn't catch — none were in scope for D23/D24, all fixed on sight:
  1. The connection row's rename/SQL-editor/remove action icons rendered rotated 90° into a vertical stack. Cause: Mantine's `NavLink` treats any `rightSection` as its default expand/collapse chevron and auto-rotates it on `opened` unless told otherwise. Fix: `disableRightSectionRotation` on the `NavLink` in `DatabasePanel.tsx`.
  2. SQL keywords rendered in CodeMirror's stock highlight-style purple — low contrast, visually inconsistent with every other code surface in the app. Cause: `SqlQueryTab.tsx` only wired the SQL language pack, not the app's own token-color theme (`codeHighlightStyle`/`codeColorTheme`, previously private to `FileEditorPane.tsx`). Fix: exported both and applied them in the SQL editor's extensions.
  3. The SQL editor was capped at `max-height: 45%` with `overflow: auto` on the host div, which both wasted space and clipped CodeMirror's own popups (autocomplete, etc.) against the container's overflow boundary. Fix: `flex: 1; min-height: 0` on the host (the same pattern `FileEditorPane`'s own CM host already uses) plus `.cm-editor { height: 100% }`, letting CodeMirror's internal `.cm-scroller` own both-axis scrolling instead of a second, conflicting scroll container.
  4. The line-number gutter rendered in CodeMirror's default white/light styling, clashing with the dark editor around it. Cause: only `.cm-editor`'s own background was themed; `.cm-gutters`, active-line, selection and cursor were left at CM's defaults. Fix: mirrored `FileEditorPane`'s full token set (`--editor-bg`/`--muted`/`--border`/`--fg`/`--accent`) onto `.ds-db-sql` — since these are the same CSS custom properties DESIGN.md's light/dark mirror already flips, no separate light-mode rule was needed.
- **Why**: none of these were visible from source review, the critique's screenshots-less agents, or unit tests — they only showed up driving the real running app. Logged here because the gauntlet's own task list (6.5, "manual pass in the running app") exists specifically to catch this category of bug.
- **Source**: user (live manual review)
