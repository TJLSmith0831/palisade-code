## Purpose

Require a Palisade identity through hosted browser authentication while keeping local account access separate from coding-agent authentication.

## ADDED Requirements

### Requirement: Required hosted sign-in
The system SHALL require successful Palisade sign-in or valid previously established offline access before exposing project state or accepting workspace operations. It SHALL offer Google, GitHub, and one-time email codes through the system browser, without password or embedded-webview authentication.

#### Scenario: First launch without credentials
- **WHEN** a person opens Palisade without prior sign-in
- **THEN** the desktop presents an accessible sign-in prompt and opens the hosted authentication experience on request
- **AND** workspace commands and project history remain unavailable until authentication succeeds

#### Scenario: Browser sign-in fails or is abandoned
- **WHEN** browser authentication fails, times out, or is cancelled
- **THEN** Palisade remains signed out and offers retry with a useful error message without creating a profile

### Requirement: Authenticate the desktop return
The system MUST accept an authentication return only for its pending login attempt, validate the returned identity, and prevent interception or replay from unlocking the app. Secrets MUST NOT appear in logs, project files, browser success pages, or frontend persistent storage.

#### Scenario: Unsolicited or replayed callback
- **WHEN** a callback has the wrong state, belongs to an expired attempt, or has already been consumed
- **THEN** the app rejects it without changing the signed-in account

### Requirement: Hosted account service
Clerk SHALL be the account service. Signup tracking SHALL use distinct Clerk account records rather than installations or individual sign-in events. Google/GitHub/email identities SHALL follow Clerk's verified identity-linking behavior; the app MUST NOT merge accounts using an unverified email address.

#### Scenario: Returning user signs in again
- **WHEN** an existing Clerk account signs in on another launch
- **THEN** Palisade resolves the same account identity without counting it as another signup

### Requirement: Local sign-out
Signing out SHALL immediately clear local authentication credentials and offline permission, preserve local profile data, and require sign-in before new workspace operations. Provider token revocation SHALL be attempted when reachable without preventing local sign-out on network failure.

#### Scenario: Sign-out while offline
- **WHEN** a person signs out without internet
- **THEN** local account access is removed and profile files remain intact
- **AND** cached credentials cannot silently sign that person back in
