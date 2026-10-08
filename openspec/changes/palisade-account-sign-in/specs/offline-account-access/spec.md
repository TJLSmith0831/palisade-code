## Purpose

Keep local work available during temporary connectivity loss while bounding the time a previously verified account can use Palisade offline.

## ADDED Requirements

### Requirement: Bounded offline access
The system SHALL permit local work for up to seven days after the last successful online account verification, limited by any earlier known authorization expiry. Offline activity, application restarts, and unsuccessful verification MUST NOT extend the deadline. Offline permission MUST NOT authorize cloud requests using expired access tokens.

#### Scenario: Offline restart within the window
- **WHEN** the same previously verified account opens Palisade offline before the deadline
- **THEN** its local profile is available and its original expiry remains unchanged

#### Scenario: Offline deadline reached
- **WHEN** the seven-day deadline is reached without successful online verification
- **THEN** the app requires online verification before new workspace operations

### Requirement: Revalidate and distinguish failure classes
The system SHALL attempt online verification on launch, resume, reconnect, and periodic use while active. Successful verification SHALL renew offline access. Transient failures SHALL retain access only within the existing window; authoritative invalidation SHALL remove access immediately. A valid refresh SHALL restore access without forcing an unnecessary interactive login.

#### Scenario: Network timeout
- **WHEN** verification times out with unexpired offline permission
- **THEN** local access continues without renewing the offline deadline

#### Scenario: Revoked credentials detected
- **WHEN** the account service authoritatively rejects the stored authorization
- **THEN** offline permission is cleared and sign-in is required

### Requirement: Safe expiry during work
Expiry or detected invalidation MUST preserve unsaved buffers and durable history. The system SHALL prevent new agent turns, terminal launches, edits, and other workspace work while allowing saving/recovery and completion or safe stopping of existing activity in the same profile. It MUST NOT switch profiles or terminate agents abruptly.

#### Scenario: Expiry with an active agent and unsaved file
- **WHEN** offline permission expires during ongoing work
- **THEN** no new work can start, the buffer can be saved, and existing output remains attributable to its original profile

### Requirement: Persist and display verification state
Durable authorization credentials and offline permission SHALL be protected through OS credential storage. Missing, corrupt, or unavailable credential storage and material clock rollback SHALL require online verification rather than granting fresh offline time. The desktop SHALL show verified online status or the offline access deadline for the active profile.

#### Scenario: Clock is moved backward
- **WHEN** persisted time observations reveal clock rollback beyond the supported skew tolerance
- **THEN** offline access is not extended and the app requires an online check

#### Scenario: Offline account status
- **WHEN** a profile is available using offline permission
- **THEN** the account UI shows its offline expiry with an understandable local date and time
