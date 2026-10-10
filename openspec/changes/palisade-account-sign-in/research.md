# Sign-in and offline session research

Researched 2026-10-07. Confirmed scope: required Google, GitHub, or email sign-in; local use remains available offline after successful sign-in, subject to bounded expiry.

## Proposed launch policy

- Use the provider's short-lived access tokens and refresh behavior; never accept an expired access token for a cloud request. Do not extend JWT lifetime to support offline use.
- Allow local work for seven days after the last successful online session verification. Seven days is a Palisade product recommendation, not an OAuth standard. Local activity, failed refreshes, restarts, and network outages do not extend this deadline.
- On launch, resume, and reconnect, attempt provider session verification. A successful refresh/verification can renew offline access; a timeout or service failure cannot. An authoritative revoked/expired session response clears offline access and requires sign-in.
- Local sign-out clears stored credentials and offline permission immediately. Remote sign-out, account deletion, or security-event revocation takes effect when detected online; an offline device cannot discover remote revocation immediately.
- After the offline deadline, require an online check. A valid refresh can restore access without an interactive login; an invalid session requires interactive sign-in.
- Expiry must not delete local data, discard unsaved changes, or abruptly kill running agents. The specs/design now define restricted save/recovery and existing-work drain behavior while blocking new work.
- Store durable credentials and offline state through the existing Rust/OS credential storage. Detect material clock rollback and require an online check rather than letting it extend offline access. Local gating is not tamper-proof licensing.
- Offline permission covers local features only. Future purchases and cloud operations require online authorization; subscription entitlement caching is a separate future decision.

## Standards and provider findings

[RFC 8252](https://www.rfc-editor.org/info/rfc8252/) recommends native OAuth authorization through an external browser and requires PKCE for public native clients. Palisade's Mantine account UI can launch this flow; provider login should not be embedded in the Tauri webview.

[RFC 9700, section 4.14](https://www.rfc-editor.org/rfc/rfc9700.html#section-4.14) requires refresh-token rotation or sender constraint for public clients, recommends expiry after inactivity, and permits revocation for security events such as password changes and provider logout. It does not prescribe a universal offline duration.

[Supabase sessions](https://supabase.com/docs/guides/auth/sessions) recommends the default one-hour access-token expiry. Sessions are indefinite by default; time-boxing and inactivity controls require Pro or above and are evaluated on refresh. Do not assume a free-tier session has an inactivity deadline.

[Clerk session options](https://clerk.com/docs/guides/secure/session-options) documents a default seven-day maximum session lifetime. Custom maximum lifetime and production inactivity controls require a paid plan. [Clerk's architecture](https://clerk.com/docs/guides/how-clerk-works/overview) uses 60-second session tokens, so the access token itself cannot supply a useful offline window.

Clerk is the selected provider: Supabase was rejected because free-project pausing and the $25/month production commitment do not fit launch plans. Future Railway feature flags are outside this change. Clerk's web session defaults alone do not implement Palisade's proposed offline policy.

All three authentication methods will run in the system browser. [Clerk's first-party CLI reference](https://github.com/clerk/cli-auth-example) documents a public-client PKCE flow with a dynamic loopback callback and OS credential storage. The design selects this protocol pattern for the Rust desktop integration; production Free-plan availability and actual OAuth lifecycle/revocation behavior must be checked before implementing dependent features. The reference is not a production SDK and its local logout omits provider revocation, so it must not be copied uncritically. [Clerk OAuth documentation](https://clerk.com/docs/guides/configure/auth-strategies/oauth/how-clerk-implements-oauth) explicitly distinguishes public-client PKCE configuration from secret-bearing clients.

Per-account local profiles, restart-only switching, profile identity/workspace/preferences/status, and explicit recoverable legacy import are confirmed launch requirements. See design.md and the delta specs for the complete policy.
