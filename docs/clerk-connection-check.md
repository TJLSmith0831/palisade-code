# Live Clerk connection check

The development app is open at `http://localhost:1420/?account-connect`. Click **Continue in browser**, finish Clerk sign-in and consent, then return to Palisade. A successful check displays the identity returned by Clerk's authenticated userinfo endpoint, access-token lifetime if returned, and whether a refresh token was issued. No token is sent to React or persisted; this check does not unlock, import, or switch a workspace.

## Verified on 2026-10-07

- Issuer: `https://absolute-buffalo-554.clerk.accounts.dev`; public client: `RUv8YrVdhDqnXszY`.
- Registered redirect reported by the user: `http://127.0.0.1/callback`; Public and Require PKCE enabled in supplied screenshots.
- Live discovery advertises authorization-code/refresh grants, public token authentication (`none`), S256 PKCE, and authorization-response issuer identification.
- A live authorization request with a random callback port was accepted and redirected to the Clerk-hosted sign-in page. Requested scopes match the configured client: `profile email offline_access`.
- In the real Tauri window, Continue opened a loopback callback listener and the browser-wait screen. Cancel returned to sign-in and closed the callback listener. Rejected alternate page origin was corrected to the configured `localhost` development origin without widening IPC permissions.
- Rust checks cover the RFC PKCE vector, secure random state, state/issuer/path/method/duplicate parameter rejection, rejection without consuming the pending request, one-shot callback closure, cancellation and timeout.
- Frontend checks cover late results after cancellation, retry and verified identity presentation. The existing complete mock flow still passes after extracting the shared sign-in card.
- Full native suite: 890 passed, 1 ignored. Both focused frontend flow tests passed. Frontend production build, native readiness build and Rust release compilation check passed. The development issuer's commands fail closed in release builds.

## Morning verification

Complete a real sign-in and confirm **You're connected to Clerk** displays the right identity. The browser may retain its own Clerk session; Back to sign-in clears only this connection-check result. Google, GitHub, email-code sign-in and explicit selection of a different account still need real browser verification. Do not paste passwords, email codes, refresh tokens, or Clerk secret keys into this chat.

The first complete browser round trip is a prerequisite to the remaining integration: auth-specific OS credential storage, serialized refresh/rotation and revocation, seven-day offline enforcement, immutable account profiles and IPC gates, recoverable legacy import, whole-app save/drain/restart transitions, production configuration and packaged verification. The current application is **not release-gated by this check**; the full implementation tasks remain open.

## Reopen the isolated native check

From the repository root, run the frontend and native build in separate terminals:

```sh
pnpm dev --host 127.0.0.1
```

```sh
cd src-tauri
cargo build --offline --features readiness-test
PALISADE_TEST_DIR=/private/tmp/palisade-account-ui-preview ./target/debug/palisade-code
```

Use the Tauri debug bridge to navigate the native webview to `http://localhost:1420/?account-connect`. The readiness build uses the isolated directory above, preserving the existing personal workspace. It is a development build, not an installer.

## References

[Clerk's native loopback/PKCE example](https://clerk.com/blog/adding-clerk-auth-to-your-cli) documents registering the portless loopback redirect and supplying an ephemeral port at runtime. [Clerk's OAuth SSO reference](https://clerk.com/docs/guides/configure/auth-strategies/oauth/single-sign-on) documents bearer-authenticated userinfo and its immutable `sub` identity. This app does not adopt the CLI example's plaintext credential fallback.


## Successful live sign-in — 2026-10-08

The user completed sign-in, and the native Tauri screen was inspected without exposing account identifiers or credentials. The screen reports **You're connected to Clerk** / **Browser sign-in verified**, access-token lifetime **86,399 seconds**, and **Refresh token: issued**. This proves the browser callback, PKCE code exchange, and authenticated userinfo path for one sign-in. The user confirmed **GitHub** was used. Google and email-code sign-in, explicit account selection, token refresh/rotation and revocation remain open. No refresh credential was retained by this development proof, so it cannot retroactively establish a persistent session.

## Production registration — 2026-10-08

Verified all five Clerk DNS records in the production dashboard. HTTPS discovery now succeeds with normal certificate verification, reporting issuer `https://clerk.palisade-code.dev`, S256 PKCE, public token authentication (`none`), refresh grants, and authorization-response issuer support.

After explicit user confirmation, created the **Palisade Desktop** public OAuth client: `4UYQqtTciDiVQvni`. Scopes: `email profile offline_access`; consent enabled; device grant disabled. Registered and saved `http://127.0.0.1/callback`. Production instance already requires S256 PKCE. No client secret is needed or stored for the public desktop flow.

Production email sign-up verification and sign-in both use one-time codes. Google and GitHub connections are enabled but still show **Setup required**: the user must supply their own provider credentials directly in Clerk. Both provider callback URLs are `https://clerk.palisade-code.dev/v1/oauth_callback`, distinct from the desktop loopback callback. Production login has not yet been tested; the native proof still uses the development issuer/client.

Subsequent dashboard verification: the user entered and saved both provider credentials. GitHub and Google now both show **Used for sign-in**, and Google details report **Enabled / Users can authenticate with this provider**. Google Cloud's Audience page still reports **Testing**, **External**, one test user (the user's own account), and says Branding configuration must be completed to publish. Production end-to-end login remains unverified; Google public availability is pending publishing/any required verification.

## Production integration — 2026-10-08

Production issuer: `https://clerk.palisade-code.dev`; public desktop client:
`4UYQqtTciDiVQvni`. No secret is embedded. Google and GitHub use their own
production credentials stored only in Clerk, with provider callback
`https://clerk.palisade-code.dev/v1/oauth_callback`. Email uses verified codes.
The desktop redirect registered in Clerk is `http://127.0.0.1/callback`; the
native listener selects an ephemeral port. Domain/DNS/SSL are configured.
Google's audience is published; branding approval is separate. Privacy and
terms are live at `/privacy` and `/terms` on `https://palisade-code.dev`.

The production Google identity returned through PKCE and userinfo and opened
the desktop workspace. Access/refresh credentials remain native; only identity
and local-permission status cross IPC. The prior `?account-connect` feasibility
route is retired; normal startup now uses the real account gate. Mock screens
remain development-only at `?account-preview`.

Clerk's documented OAuth access lifetime is one day; refresh grants do not
expire automatically. Palisade therefore enforces a separate seven-day local
permission lease from successful online identity verification. Activity,
restart, refresh rotation alone and network failures never extend it. Known
authorization expiry can shorten it; rollback exceeding five minutes blocks
local work. Launch, focus/reconnect and a fifteen-minute timer verify online,
with native serialization and thirty-second throttling. An authoritative
invalid grant or unauthorized userinfo response ends local permission.
See https://clerk.com/docs/guides/configure/auth-strategies/oauth/how-clerk-implements-oauth.

Auth credentials use a dedicated OS keychain service. Storage failures are
errors; no plaintext auth fallback exists. Reads run outside the UI thread.
Native sign-out writes a durable non-secret marker before deleting credentials,
then attempts public-client revocation. JWT access tokens can remain valid
until their server expiry; offline clients cannot observe remote revocation
until verification. This is local permission, never proof for future cloud APIs.

Profiles hash the configured issuer and immutable Clerk subject. Personal
files and browser preferences use that profile; database keychain entries
include the profile too. Installed models and ACP registry remain shared.
Profiles prevent accidental in-app disclosure, not access by another process
running as the same OS user. Source repos, repo settings, external-agent auth,
and any referenced worktree paths remain shared filesystem resources.

Import preserves originals and an atomic recovery copy under the machine
home's `recovery/<profile>/`, verifies staged file contents and copied database
secrets, and records ownership last. Browser preference originals remain;
scoped copies are verified before native ownership is committed. A failed
import can retry; a nonempty target is never overwritten. To recover manually,
quit Palisade and retain the original/recovery trees before changing profiles.
No background job can change the immutable profile root in a running process.

Clerk Users reports distinct signed-up accounts, not installations or login
counts. Future marketplace flags, Railway services and billing are excluded.
No Supabase dependency or mandatory paid auth upgrade was added. Free-plan
production behavior and pricing remain subject to Clerk's current limits.

Remaining release verification: email-code and production GitHub round trips,
explicit browser account choice, second-account restart, native multiwindow
save/cancel, unavailable keychain and packaged macOS restoration/loopback.
Do not infer these from the mock screen or successful Google login.


### Updated native checks — 2026-10-08

After the user approved macOS Keychain access, the newest readiness binary restored the saved production identity and refreshed online. In the isolated temporary project, a live terminal blocked account restart with a readable instruction and retained sign-in. Stop running work terminated it. Two real native windows then both received the unsaved-work prompt; confirming one did not clear the account while the second was pending. Cancelling from the second resumed both windows with the original identity/profile. Dirty-window flags were set by test IPC rather than actual edited files; editor-save behavior has separate focused regression coverage.

The temporary project also exposed a fleet error-display bug: the controlled readiness PATH has no git, and a structured backend error was coerced into `[object Object]`. The fleet hook now uses the existing errorMessage helper; its new regression failed before the fix and passed after it. Native DOM now shows the actual `git`-not-on-PATH message. This is not a Clerk credential error.


Local sign-out was exercised after stopping work and removing the temporary test project: the next native launch reported signedOut with no identity/profile and rejected list_projects. The terminal-owned restart printed the new bridge initialization but that replacement did not remain reachable when the parent tool session ended, so the app was relaunched manually. This verifies durable sign-out, not successful packaged automatic relaunch. Production browser sign-in is now pending a human email-code check; do not infer the method if Clerk reuses an existing browser session.

Focused fleet-error checks: 56 passed across useFleet/FleetBoard; frontend production build passed after the fix.


### Browser account-selection observation

The user confirmed the attempted email test reused the existing Google browser session. Native sign-out revokes/clears the desktop grant but does not sign out the separate hosted browser session. To reset that session for testing, opened the official hosted /user page, used Open user menu → Sign out, and observed the hosted sign-in form with Google/GitHub/email. Reopened the native OAuth flow; its sign-in URL contains the current OAuth consent redirect and ephemeral loopback callback. Email-code completion is pending. This proves the browser-session reset path; explicit desktop account-switch UX still needs to explain this behavior instead of promising that local sign-out always forces account selection.


### Email-code confirmation and browser-session recovery

The user confirmed successful production email one-time-code sign-in. Native account_status returned online, workspaceReady true, and the same immutable subject/profile as the earlier Google login. A Google avatar is profile metadata, not evidence of which sign-in method was used.

Sign-in now explains the separate remembered browser session and offers Open browser account, which opens only the configured hosted account page. Users sign out there themselves before starting another desktop sign-in. This does not revoke a desktop grant or change a running profile. Settings now explains both sides of sign-out. The command is available before workspace binding and accepts no caller-supplied URL.

Latest full frontend regression: 96 files / 1,511 tests passed; production frontend build passed. Focused native account tests passed after rerunning with local loopback access (sandboxed callback binding was denied). Readiness native build passed. Production GitHub, different-user profile switching, live offline relaunch and packaged automatic restart still require verification.

Latest full Rust regression after the browser-account opener: 896 passed, one ignored.

Production GitHub completed after resetting the hosted browser session. User reported Done; native status verified online/workspaceReady true with the same immutable subject/profile, and DOM verified the workspace visible with no sign-in gate. Google, GitHub and email-code production round trips are now all confirmed. Packaged restoration/restart, live offline relaunch and a different-account profile remain separate checks.

Local app bundle build passed (debug + readiness isolation, no install/notarization). Launched through macOS Launch Services with the isolated store; real webview origin is tauri://localhost. Credential restoration is awaiting macOS Keychain authorization. This is a packaged debug smoke check, not a signed distribution build.

After user approved Keychain access, the packaged debug readiness app restored the production account online and opened its existing immutable profile. Native status workspaceReady=true and bundled webview origin tauri://localhost verified. This confirms restoration in this local app bundle; signed distribution validation remains separate.

Packaged debug sign-out/restart passed: after account_request_restart disconnected the old bridge, the automatically relaunched bundle was reachable at9223 with tauri://localhost and signedOut/no identity/profile. No manual launch was used for this restart. Continue in browser opened production consent for the remembered browser session; renewing the same existing permissions returned through ephemeral loopback to the bundled desktop workspace, online with its same profile. Settings was opened and captured at /private/tmp/palisade-account-settings-packaged.png. Live offline relaunch and a genuinely different Clerk account remain unverified; asked user whether a second account is available.

User has no second account and accepted deferring that live check ("No but I think we're probably good"). Keep it documented as unverified rather than claiming isolation was exercised with two production users. No further human sign-in is pending.
