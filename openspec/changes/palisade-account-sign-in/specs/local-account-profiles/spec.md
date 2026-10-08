## Purpose

Separate each Palisade account's local history and preferences while preserving existing work through explicit import and safe restart-only account switching.

## ADDED Requirements

### Requirement: Account-specific profile state
The system SHALL associate local profiles with immutable verified account identity. Project lists, chat/session history, workspace restoration, account-specific caches, personal theme/editor/notification preferences, saved database connections, and database credentials SHALL remain separate across profiles. Source repositories, repository settings, installed tools, and coding-agent credentials SHALL remain governed by the OS user and existing tools.

#### Scenario: Another account signs in
- **WHEN** account B starts Palisade after account A has used it
- **THEN** B does not receive A's project list, history, preferences, saved connections, or resumed workspace
- **AND** B can explicitly open a source repository accessible to the same OS user without importing A's Palisade history

#### Scenario: Email address changes
- **WHEN** an account's verified email changes without changing its identity
- **THEN** its existing local profile remains available

### Requirement: Visible identity and continuity
The active profile SHALL show the account's name, avatar, and email with usable fallbacks for missing fields. Returning to a profile SHALL restore its workspace and personal preferences without restoring invalid authentication or silently starting agents.

#### Scenario: Return to an existing profile
- **WHEN** a person signs into a previously used account after restart
- **THEN** the matching local projects, chat history, open tabs, and personal preferences are restored
- **AND** no other profile's identity or workspace is displayed

### Requirement: Restart-only switching
The system SHALL require a whole-app restart to change the active profile. It SHALL offer save/discard/cancel for unsaved changes and wait for running work to finish or obtain explicit permission to stop it safely before completing the switch. Cancelling a switch SHALL preserve the current profile and session.

#### Scenario: Switch requested with work in progress
- **WHEN** a person selects Switch account with dirty files or running agents in any window
- **THEN** the app settles those items before clearing local auth and restarting into sign-in
- **AND** every window and background task retains its original profile until shutdown

#### Scenario: Switch cancelled
- **WHEN** a person cancels the save or running-work decision
- **THEN** account credentials and the current profile remain active

### Requirement: Explicit recoverable workspace import
An authenticated person encountering an unclaimed legacy workspace SHALL be offered Import existing local workspace into this profile or Start fresh. Import SHALL require explicit confirmation, create a recovery copy, and transfer relevant history, saved connections, workspace state, and preferences without deleting source repositories or claiming another profile's data. Ownership SHALL commit only after successful import; repeat launches and interrupted imports MUST NOT duplicate or lose data.

#### Scenario: Import accepted
- **WHEN** a person confirms importing the unclaimed workspace
- **THEN** the existing local workspace is assigned to that profile after successful verification of the import and a recovery copy is retained

#### Scenario: Fresh profile chosen
- **WHEN** a person selects Start fresh
- **THEN** the profile starts empty and the legacy workspace remains unclaimed and recoverable

#### Scenario: Import interrupted
- **WHEN** import fails or the app exits before ownership commits
- **THEN** the original workspace remains recoverable and subsequent startup can safely retry or abandon the incomplete import
