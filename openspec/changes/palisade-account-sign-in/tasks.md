## 0. Mock UI first (user-directed implementation phase)

Clerk configuration and the native security/profile implementation below are deferred until the user configures Clerk. This phase is a development-only UI preview, not release authentication.

- [x] 0.1 Build Mantine sign-in, browser-wait, retry, legacy-import, profile/preferences, offline, and expired-access screens with mock data.
- [x] 0.2 Simulate account switching with unsaved-file and running-agent gates, cancellation, restart, and separate mock profile state.
- [x] 0.3 Fix preview stacking above the native window backdrop; apply better-ui polish and verify visible content in the real Tauri webview.
- [x] 0.4 Run the focused mock-flow test and frontend build; capture native screenshots and document preview limitations.

## 1. Prove and configure Clerk browser authentication

- [ ] 1.1 Register a public dev OAuth client with PKCE and loopback callback; verify Google, GitHub, and one-time email-code hosted sign-in plus explicit account selection.
- [ ] 1.2 Verify identity retrieval, actual OAuth token lifetimes, refresh/rotation, logout/revocation behavior, and production Free-plan support; document any mismatch before changing scope.
- [x] 1.3 Document production issuer/domain/DNS, Google/GitHub registrations, email-code settings, public client IDs, and signup reporting; keep provider secrets outside the repository and app binary.

## 2. Add native auth and finite offline access

- [x] 2.1 Implement Rust-owned pending login, S256 PKCE/state, one-shot loopback callback, timeout/cancel, validated token exchange, and account identity retrieval using existing networking/crypto facilities where available.
- [x] 2.2 Add auth-specific OS credential storage and serialized token refresh, safe rotation persistence, and local sign-out with best-effort provider revocation; expose only identity/status to the frontend.
- [x] 2.3 Implement seven-day offline permission bounded by known authorization expiry, launch/resume/reconnect/periodic verification, transient-vs-invalid error handling, and rollback detection without treating expired tokens as cloud credentials.
- [ ] 2.4 Add focused Rust checks for wrong/replayed callbacks, timeout cleanup, token rotation failure, offline expiry boundaries, non-renewal on errors/restarts, sign-out, revoked sessions, and clock rollback.

## 3. Bind account profiles before workspace startup

- [x] 3.1 Separate machine home from an issuer/user-ID-derived immutable profile root; audit all personal-store callers and capture the root in workers, startup reconciliation, watchers, and session writers.
- [x] 3.2 Gate workspace IPC and personal startup state on account access; define narrow save/drain exceptions for expired sessions and prevent caller-supplied profile selection.
- [x] 3.3 Scope projects/history/worktrees and saved database records/credentials by profile; preserve shared installed resources, source repositories, repo settings, and external coding-agent auth.
- [x] 3.4 Scope frontend workspace restoration, last thread, review/thread preferences, appearance/editor/layout/notification persistence by profile; avoid reading old-profile preferences before authentication.
- [ ] 3.5 Add isolation checks for A/B accounts opening the same repo, changed email with stable user ID, database credentials, background output, and pre-auth/expired IPC restrictions.

## 4. Import the existing local workspace safely

- [x] 4.1 Inventory legacy personal files, browser storage keys, and database credential entries; add explicit Import / Start fresh with ownership recorded only after successful import.
- [x] 4.2 Implement exclusive migration access, recovery copy, staged copy/verification, idempotent browser/keychain migration, and atomic completion; never overwrite a nonempty profile silently.
- [ ] 4.3 Add checks for fresh-start preservation, repeat import, partial file/keychain/browser-state failure, interruption/retry, and refusal to import already-claimed data into another profile.

## 5. Add profile UI and safe restart transitions

- [x] 5.1 Build accessible Mantine sign-in/wait/retry states and account settings with name/avatar/email fallbacks, online/offline deadline, Sign out, and Switch account.
- [ ] 5.2 Extend whole-app dirty-window quit handling to settle running agents/terminals and persist output before account-switch commit; clear auth and restart into explicit account selection, preserving cancellation and relaunch failure recovery.
- [x] 5.3 Implement safe expiry/invalidation restrictions that preserve unsaved work and current output; same-account reauth unlocks, different-account reauth requires restart before loading its profile.
- [ ] 5.4 Add focused UI/transition checks for cancelling a switch, multiwindow unsaved work, running sessions, expiry recovery, profile preferences, and identity/status accessibility.

## 6. Verify the real app and document release prerequisites

- [x] 6.1 Run `pnpm build`, focused frontend checks, and `cargo test` from `src-tauri`; fix regressions from the profile/auth changes.
- [ ] 6.2 Use the real Tauri debug bridge to verify browser sign-in/return for all three methods, offline relaunch/expiry, legacy import, two-account restart switching, and running-work/multiwindow safety. Verify packaged macOS credential persistence and loopback return as well.
- [x] 6.3 Document credential-store failure behavior, offline/revocation limits, shared agent/filesystem boundary, migration recovery/rollback, and production Clerk configuration. Confirm no Supabase, Railway deployment, billing, or mandatory paid auth upgrade was introduced.

## Live integration checkpoint — 2026-10-07

The supplied development client and issuer are connected to a development-only native check at `?account-connect`, sharing the approved sign-in UI. Discovery and a live authorization redirect with an ephemeral loopback port succeeded. Native browser handoff/cancel and focused callback/UI security checks are verified. See `docs/clerk-connection-check.md` for the exact scope and morning steps.

Tasks 1.1/1.2 remain open until a human completes the hosted sign-in methods and actual identity/lifetime/refresh/revocation behavior is verified. Task 2.1 has a working development proof; production integration and the remainder of native auth/profile work are still pending. No credentials or workspace access are persisted by the proof. Pausing at the real account sign-in per the user's overnight instruction; do not mark these tasks complete based on the mock preview or authorization redirect alone.


## Successful live sign-in — 2026-10-08

User confirmed successful **GitHub** sign-in; native screen confirms authenticated userinfo success and reports a 86,399-second access-token lifetime with a refresh token issued. The overnight human prerequisite of one complete round trip is satisfied. This does not complete tasks 1.1/1.2: all three methods/account selection and refresh/rotation/revocation still require verification. The development check did not retain credentials. Continue with the approved native session/profile implementation using the newly requested official Clerk skills where relevant.

## Production implementation checkpoint — 2026-10-08

Production Google browser sign-in returned to the native desktop workspace. Rust now owns secure refresh storage, finite offline permission, immutable profile binding, pre-auth IPC denial and restricted save/drain operations. The frontend gate mounts the workspace only after native profile preparation. Profiles scope personal files, database credentials and browser preferences. Whole-window restart coordination and stop-work actions are implemented; live multiwindow/relaunch checks remain open. Initial restart verification exposed a synchronous keychain read on the UI thread; it now runs on a blocking worker. The latest complete regression run passed 1,507 frontend tests and 894 Rust tests (one ignored). Keep the remaining security/transition/release tasks open until the relevant failure and live-flow checks finish.


## Inline Settings and review checkpoint — 2026-10-08

Account/profile content is now part of the existing Settings pane. Sign out and restart is the shared entry to choosing another account, with explicit explanation; expiry exposes the same restart recovery path. Interface review and the sampled worktree Brooks review are recorded in docs/reviews/. Brooks iterations reached 100/100 with no outstanding actionable review findings; manual provider/platform release validation remains open and is not implied by that score. Full frontend tests: 1,509; full Rust tests: 896 plus one ignored. Native secure restoration with the newest rebuilt binary is waiting for the user's Keychain permission if macOS prompts.


## Final local bundle checkpoint — 2026-10-08

Google, GitHub and email one-time-code production round trips are all human-confirmed and native status/workspace verified. The local packaged debug readiness bundle restored the saved account, automatically restarted to durable signed-out state, and accepted a browser/loopback return into the same profile. Latest full frontend regression: 1,511 passed; Rust: 896 passed, one ignored. Live offline relaunch, a genuinely different account/profile, credential-store failure scenarios and signed distribution verification remain open; task6.2 is intentionally not marked complete.

User has no second account and accepted deferring that live check ("No but I think we're probably good"). Keep it documented as unverified rather than claiming isolation was exercised with two production users. No further human sign-in is pending.
