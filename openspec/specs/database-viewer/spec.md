# database-viewer Specification

## Purpose
Lets users connect to a Postgres or SQLite database, browse its schema, view and edit table data, and run SQL queries without leaving Palisade for a separate database client.
## Requirements
### Requirement: Connect to a database via connection string
The system SHALL let a user add a named database connection by supplying a connection string, for Postgres or SQLite. A project SHALL support multiple saved connections.

#### Scenario: Add a connection
- **WHEN** the user supplies a name and a valid Postgres or SQLite connection string
- **THEN** the connection is saved and its schema becomes browsable

#### Scenario: Add a second connection to the same project
- **WHEN** the user adds a connection named "staging" while a connection named "dev" already exists
- **THEN** both connections are listed independently, each with its own schema tree

#### Scenario: Invalid connection string
- **WHEN** the user submits a connection string the system cannot parse or connect with
- **THEN** the system surfaces an inline error explaining the failure and does not save a broken connection

### Requirement: Connection credentials never enter the target project's repository
The system SHALL store saved connection strings outside the target project's own file tree, such that they are never visible to `git status` or committable within that project.

#### Scenario: Connection added inside a git-tracked project
- **WHEN** the user adds a database connection while working inside a git repository
- **THEN** `git status` in that repository shows no new or modified files as a result

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
