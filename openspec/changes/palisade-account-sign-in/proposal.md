## Why

Palisade needs required account registration before release to track sign-ups and establish a stable identity for future subscription features. Authentication should use a hosted service without a mandatory monthly platform payment before user traction.

## What Changes

- **BREAKING**: Require a Palisade account before using the app; coding-agent authentication remains separate.
- Use Clerk with Google, GitHub, and one-time email-code sign-in, all completed in the system browser.
- Use existing Mantine components for the desktop sign-in gate, waiting, retry, error, and account states.
- Restore sign-in safely across app restarts using OS credential storage.
- Permit bounded offline local use after successful online verification, with a proposed seven-day window and invalidation on local sign-out or detected revocation.
- Preserve local data and in-progress work during authentication transitions.
- Separate local profiles by immutable account identity, including project lists, chat history, workspace continuity, personal preferences, saved database connections, and their credentials.
- Show profile name/avatar/email and online/offline verification status. Require safe restart to switch accounts.
- Offer explicit import of the existing unclaimed workspace, with a recovery copy and a start-fresh option.
- Use Clerk's user records for launch sign-up tracking. Billing, marketplace features, cloud sync, and Railway feature flags are outside this change.

## Capabilities

### New Capabilities

- `palisade-account-auth`: Required browser-based Clerk registration/sign-in, secure desktop return, account status, and sign-out.
- `offline-account-access`: Session restoration and bounded offline access with safe expiry and online revalidation.
- `local-account-profiles`: Account-specific local state, profile identity/preferences, recoverable workspace import, and restart-only account switching.

### Modified Capabilities

None. Existing workspace and agent features are retained behind the new account gate.

## Impact

Frontend app initialization, workspace persistence, personal settings, and account UI; Rust account state, profile-specific store paths, database credential namespaces, startup reconciliation, and browser callback handling; desktop restart/quit handling; Clerk production configuration, Google/GitHub credentials, hosted email-code flow, and signup reporting. Profile stores remain outside target repositories under the existing Palisade home. Coding-agent credentials remain managed by their tools. Implementation must verify Clerk's free-tier support for the selected native flow and distinguish OAuth tokens from web session tokens before adopting a concrete integration. Local profile export/deletion and cloud sync are deferred.
