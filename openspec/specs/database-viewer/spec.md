# database-viewer Specification

## Purpose
Lets users connect to a Postgres or SQLite database, browse its schema, view and edit table data, and run SQL queries without leaving Palisade for a separate database client.
## Requirements
### Requirement: Connect to a database by its connection details
The system SHALL let a user add a named database connection by supplying its connection details as discrete fields — for Postgres, the host, port, user, password, and database; for SQLite, a file path. The system SHALL also accept a pasted connection string as a shortcut, parsing it into those fields for review before saving. A project SHALL support multiple saved connections. The system SHALL NOT store the assembled connection string.

#### Scenario: Add a Postgres connection
- **WHEN** the user supplies a name and the host, port, user, password, and database
- **THEN** the connection is saved and its schema becomes browsable
- **AND** only the password is written to the credential store

#### Scenario: Add a SQLite connection
- **WHEN** the user supplies a name and a database file path
- **THEN** the connection is saved and its schema becomes browsable
- **AND** the credential store is not accessed, because a SQLite connection has no secret

#### Scenario: Paste a connection string
- **WHEN** the user pastes a Postgres or SQLite connection string into the shortcut field
- **THEN** its parts populate the individual fields for review
- **AND** saving stores them as fields, with the password separated from the rest

#### Scenario: Add a second connection to the same project
- **WHEN** the user adds a connection named "staging" while a connection named "dev" already exists
- **THEN** both connections are listed independently, each with its own schema tree

#### Scenario: Connection details that do not connect
- **WHEN** the user submits details the system cannot parse or connect with
- **THEN** the system surfaces an inline error explaining the failure and does not save a broken connection

### Requirement: Connection credentials never enter the target project's repository
The system SHALL store saved connection strings outside the target project's own file tree, such that they are never visible to `git status` or committable within that project. The system SHALL store the connection's secret — its password, where it has one — in the operating system's credential store where one is available, and SHALL NOT store it alongside the non-secret connection details. Where no credential store is available, the system SHALL fall back to a user-only-readable file and SHALL warn the user that credential storage is degraded — it SHALL NOT fall back silently, and SHALL NOT refuse to save the connection.

#### Scenario: Connection added inside a git-tracked project
- **WHEN** the user adds a database connection while working inside a git repository
- **THEN** `git status` in that repository shows no new or modified files as a result

#### Scenario: Connection added on a machine with a credential store
- **WHEN** the user adds a password-carrying connection and the credential store is available
- **THEN** the password is written to the credential store
- **AND** no file on disk contains the password
- **AND** the non-secret details remain readable in the connection file

#### Scenario: Connection added with no credential store available
- **WHEN** the user adds a connection and the credential store is unavailable, locked, or refused
- **THEN** the connection is still saved, to a file readable only by the current user
- **AND** the user is warned that credential storage is degraded

#### Scenario: Connection saved as a connection string by an earlier version
- **WHEN** connections saved by an earlier version are listed
- **THEN** each stored connection string is split into its fields
- **AND** its password moves to the credential store where one is available
- **AND** the file no longer contains the password

#### Scenario: Connection removed
- **WHEN** the user removes a saved connection
- **THEN** its stored credential is deleted, leaving no credential without a connection that refers to it

### Requirement: No connections yet
The system SHALL show an empty state prompting the user to add a connection when a project has none saved.

#### Scenario: First open with no connections
- **WHEN** the user opens the database panel for a project with no saved connections
- **THEN** the panel shows an empty state with a way to add a connection, not a blank or error view

### Requirement: Browse schema
For each connected database, the system SHALL display its tables and views in a browsable tree.

#### Scenario: Expand a connection
- **WHEN** the user expands a saved connection in the schema tree
- **THEN** the system lists that database's tables and views

### Requirement: View table data
Selecting a table SHALL open a paginated view of its rows and columns.

#### Scenario: Open a table
- **WHEN** the user selects a table from the schema tree
- **THEN** a data grid opens showing that table's rows, columns, and column types, fetched in pages rather than all at once

#### Scenario: Table with more rows than one page
- **WHEN** a table has more rows than fit in a single page
- **THEN** the user can navigate to subsequent pages without the system fetching the entire table into memory

#### Scenario: Empty table
- **WHEN** the user opens a table with zero rows
- **THEN** the grid shows an explicit "no rows" state rather than an empty void

### Requirement: Sort and filter table data
The data grid SHALL support sorting by column and filtering rows by column value.

#### Scenario: Sort by a column
- **WHEN** the user sorts the grid by a column
- **THEN** the displayed rows reorder according to that column's value, refetching pages as needed

#### Scenario: Filter by a column value
- **WHEN** the user applies a filter on a column
- **THEN** the grid shows only rows matching that filter

### Requirement: NULL is visually distinct from empty string
The data grid SHALL render a NULL cell value distinguishably from an empty string.

#### Scenario: Row with a NULL column
- **WHEN** a fetched row has a NULL value in some column
- **THEN** the grid renders that cell with a visibly distinct treatment from a cell containing an empty string

### Requirement: Edit table data inline
For a table whose primary key is among the fetched columns, the system SHALL let the user edit cell values directly in the grid. For a table with no primary key in the fetched columns, cells SHALL be read-only.

#### Scenario: Edit a cell on a table with a primary key
- **WHEN** the user edits a cell's value on a table whose primary key column is present in the grid
- **THEN** the cell shows a pending-change indicator and the edit is held, not yet written to the database

#### Scenario: Attempt to edit a cell with no primary key available
- **WHEN** the user attempts to edit a cell on a table with no primary key in the fetched columns
- **THEN** the cell is not editable and the system explains why

#### Scenario: Set a value to NULL
- **WHEN** the user chooses to set a cell to NULL
- **THEN** the pending change is distinguishable from setting the cell to an empty string

### Requirement: Preview and apply pending edits as one transaction
The system SHALL let the user preview the SQL that pending edits would run, then apply all pending edits for a table together, as a single all-or-nothing transaction.

#### Scenario: Preview before applying
- **WHEN** the user has one or more pending cell edits and requests a preview
- **THEN** the system shows the exact SQL statements that would run, before any of it executes

#### Scenario: Apply succeeds
- **WHEN** the user applies pending edits and every statement succeeds
- **THEN** all edits are committed together and the grid reflects the new values with no pending-change indicators remaining

#### Scenario: One statement in the batch fails
- **WHEN** the user applies multiple pending edits and any one of the underlying statements fails or reports a conflict
- **THEN** none of the batch's edits are committed, and the failure is surfaced with which row caused it

### Requirement: Detect edits made elsewhere since the row was fetched
When applying a pending edit, the system SHALL detect whether the target row's current values in the database differ from the values the edit was based on, and treat a mismatch as a conflict rather than overwriting.

#### Scenario: Row unchanged since fetch
- **WHEN** the user applies an edit and the row's current database values match what was originally fetched
- **THEN** the edit applies normally

#### Scenario: Row changed by another source since fetch
- **WHEN** the user applies an edit but the row's current database values no longer match what was originally fetched
- **THEN** the system reports a conflict for that row instead of silently overwriting it

### Requirement: Run arbitrary SQL
The system SHALL provide a query editor where the user can write and run arbitrary SQL against a connected database, with results (or affected-row counts) displayed after execution.

#### Scenario: Run a SELECT
- **WHEN** the user writes a `SELECT` query and runs it
- **THEN** the results display as a grid

#### Scenario: Run a query with an error
- **WHEN** the user runs SQL that the database rejects
- **THEN** the system displays the database's error message inline, not as a transient toast

### Requirement: Confirm before a destructive-looking statement
The system SHALL require explicit confirmation before executing a statement that deletes or restructures data without a narrowing condition: `DELETE`, `DROP`, `TRUNCATE`, `ALTER`, or an `UPDATE`/`DELETE` with no `WHERE` clause.

#### Scenario: Run a DELETE with no WHERE clause
- **WHEN** the user runs a `DELETE` statement with no `WHERE` clause
- **THEN** the system requires explicit confirmation before executing it

#### Scenario: Run a scoped UPDATE
- **WHEN** the user runs an `UPDATE` statement that includes a `WHERE` clause
- **THEN** the system executes it without requiring extra confirmation

### Requirement: Listing connections does not read the credential store
The system SHALL list a project's saved connections, with their names and non-secret connection details, without accessing the operating system credential store. A stored secret SHALL be read only when a connection is actually opened.

#### Scenario: Opening the database panel
- **WHEN** the user opens the database panel
- **THEN** every saved connection is listed with its name and non-secret details
- **AND** no credential-store access occurs, so the operating system does not prompt for authorization

#### Scenario: Connecting for the first time
- **WHEN** the user opens a connection's schema or runs a statement against it
- **THEN** its stored secret is read at that point

### Requirement: Connection and statement activity is recorded
The system SHALL append a durable, append-only record of database activity for each project, covering every connection added, removed, or renamed; every statement run from the query console; and every applied set of row edits. Each record SHALL identify when it happened, which saved connection it applied to, the statement or edit text, its outcome, and — for a statement that changes data — the number of rows affected. A record SHALL NOT contain the connection string. Recording SHALL NOT affect whether an operation runs: a failure to record SHALL be reported through the application's warning channel and SHALL NOT abandon or alter the operation.

#### Scenario: A query is run
- **WHEN** the user runs any statement from the query console, whether it reads or writes
- **THEN** a record of that statement, its connection, and its outcome is appended

#### Scenario: Row edits are applied
- **WHEN** a set of pending row edits is applied
- **THEN** a record is appended carrying the applied statements and the number of rows affected

#### Scenario: A connection is added, renamed, or removed
- **WHEN** the user adds, renames, or removes a saved connection
- **THEN** a record of that action is appended
- **AND** the record identifies the connection without containing its connection string

#### Scenario: Recording fails
- **WHEN** an operation completes and its record cannot be written
- **THEN** the operation's result is unaffected
- **AND** the failure is reported through the application's warning channel

#### Scenario: Browsing does not produce records
- **WHEN** the user pages through a table, sorts or filters the grid, or expands the schema tree
- **THEN** no record is appended

### Requirement: Query execution is time-bounded
The system SHALL abandon any database operation that has not completed within a fixed bound, releasing the connection it held, and SHALL report the timeout distinctly from a query error.

#### Scenario: A query exceeds the bound
- **WHEN** a statement runs longer than the execution bound
- **THEN** the operation is abandoned and reported as timed out
- **AND** the connection it held is available for the next operation

#### Scenario: Further queries after a timeout
- **WHEN** a statement has timed out
- **THEN** the user can run another statement on the same connection without reconnecting

## Decisions

- Connections are discrete fields (host/port/user/database, or a SQLite path), never a stored connection string — DataGrip warns that a password embedded in a URL cannot be separated from the rest and leaks into logs. Only the password reaches the credential store. (2026-09-02, db-hardening)
- Listing connections reads no secret, so opening the panel raises no OS authorization prompt; the prompt belongs on first connect. This is why credential resolution lives in `pool_for` and not in the list path. (2026-09-02, db-hardening)
- SQLite connections never touch the credential store — a file path has no secret to protect. (2026-09-02, db-hardening)
- No credential store available falls back to a 0600 file *with a warning* — never silently (the user would believe a secret is in the keychain) and never as a refusal to save (that breaks headless Linux and CI, where no backend is compiled in at all). (2026-09-02, db-hardening)
- The activity record is a query history for the person using the app, not compliance evidence. Fail-closed auditing was rejected: it defends against an actor distinct from the auditor, which a single-user IDE does not have, and wrapping destructive statements in BEGIN/COMMIT to achieve it would break `VACUUM` and `CREATE INDEX CONCURRENTLY`. (2026-09-02, db-hardening)
- History entries carry statement text verbatim and never the credential; the file is 0600 for the same reason the connection file is. A redaction pass over literals was rejected — it preserves shape while destroying the ability to answer which row a statement touched. (2026-09-02, db-hardening)
- Schema browsing, paging, sorting and edit previews are deliberately not recorded; they fire on every scroll and would need a log-rotation story this feature does not have. A hand-written SELECT from the console *is* recorded. (2026-09-02, db-hardening)
- Query execution is bounded at a fixed 30s. The bound abandons the future and returns the pool slot; it does not cancel the statement server-side, so a runaway query keeps burning database CPU. Postgres `statement_timeout` is the named upgrade path. (2026-09-02, db-hardening)
- A saved connection whose details cannot be read is listed and repaired on connect, never silently dropped from the panel. (2026-09-02, db-hardening)
- Deliberately not done: enforced transport encryption, an in-app authentication/authorization gate, and PII classification or pre-write backups. The OS user account is the security boundary for a single-user desktop app — it already gates `~/.palisade-code` and the keychain — so an in-app unlock protects against nothing it does not, and adds a lockout failure mode. (2026-09-02, db-hardening)
