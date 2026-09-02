## MODIFIED Requirements

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

## ADDED Requirements

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
