## Context

See proposal.md for motivation and the three delta specs for behavior. Today `store::palisade_home()` selects one OS-user directory; commands and asynchronous callbacks call it throughout the backend. Store functions already take a home path. Project windows and live agents share process state; frontend workspace/history preferences use unscoped localStorage keys. Database credentials are keyed by project/connection rather than account. Repo settings and coding-agent auth live outside Palisade's personal store.

## Goals / Non-Goals

**Goals:** establish account access before personal state loads; fix a profile identity and storage root for the process lifetime; support finite offline local work; migrate without data loss; keep authentication hosted by Clerk and desktop UI in Mantine.

**Non-Goals:** live profile switching, encryption of all local files, separation of source repos or third-party coding-agent credentials, cloud sync, billing, Railway integration, a marketplace, profile export/removal UI, or an auth-provider abstraction.

## Decisions

### Hosted Clerk OAuth with loopback return

Use a registered public Clerk OAuth client with Authorization Code + S256 PKCE, unpredictable state, and a one-shot listener bound only to `127.0.0.1` on an ephemeral port. Launch Clerk's hosted authorization flow using the existing opener; the browser offers Google, GitHub, or an email code. Follow [Clerk's first-party CLI reference](https://github.com/clerk/cli-auth-example) and [OAuth documentation](https://clerk.com/docs/guides/configure/auth-strategies/oauth/how-clerk-implements-oauth). This is a protocol pattern to implement in Rust, not a reason to ship a Node sidecar or a general OAuth framework.

Validate the callback path, state, attempt deadline, one-time code exchange, configured issuer, and returned identity. Use the provider-documented token/userinfo validation path for the actual token type: OAuth tokens are not interchangeable with Clerk web session JWTs. Request only identity and refresh scopes needed by the flow. Keep the PKCE verifier in memory, close the listener on success/cancel/timeout, and never return tokens in browser page content. Fixed production issuer/client ID are public config; no Clerk secret key belongs in the binary.

The first implementation task is a dev and production/free-tier feasibility check of this exact flow, including dynamic loopback ports, all three methods, identity retrieval, refresh/rotation, revocation, and browser account selection. Do not substitute embedded authentication, purchase a plan, or add a secret-bearing backend if a required capability is unavailable; report the concrete mismatch before widening scope.

Alternatives: the community Tauri plugin advertises unsupported default-component OAuth and globally patches fetch; reject it for this hosted-only use case. Custom URI callbacks add installation and interception concerns; use the documented loopback pattern. Device flow adds polling and user-code steps unnecessary for a desktop that can open a browser.

### Process-fixed account profile

Keep machine resources under `~/.palisade-code` and personal data under `~/.palisade-code/profiles/<identity-key>/`. Derive the directory key from configured Clerk issuer plus verified immutable user ID, using a safe hash rather than email or a caller-provided path. Bind an immutable profile context before creating workspace windows, starting watchers/agents, reconciling history, or loading project lists. Retain that context until process exit.

Reuse store functions' existing home parameter. Replace dynamic personal-store resolution with explicit captured profile paths in commands and asynchronous workers; distinguish machine resources (registry downloads, shared model assets) from account data. Scope frontend workspace, thread preferences, review state, appearance, editor, layout, and notification keys by the same identity. A minimal appearance default can render before auth without reading the previous profile's preferences.

Database records and credential keys include the profile identity; sharing a project hash must not share saved connections. Reuse the installed keyring dependency, not the DB module's private vault or its file fallback for auth secrets. Repo settings and externally managed agent logins remain OS-user resources. This is protection against accidental in-app disclosure, not a filesystem sandbox against someone using the same OS account.

### Credentials and offline permission

Rust owns refresh credentials, token state, and the account access decision. Persist refresh credentials and a bounded verified-access record in OS credential storage with an auth-specific service namespace. Access tokens stay in memory. Keychain failures require retry or an explicitly nonpersistent online session; they must not downgrade to plaintext token files. Frontend receives identity/status/deadline, not durable secrets.

Use provider-reported OAuth expiry and refresh semantics; do not copy the 60-second web-session token assumptions into OAuth. A successful online refresh plus verified identity check renews local permission to `min(last_verified + 7 days, earlier known authorization expiry)`. Ordinary activity or an unsuccessful request cannot renew it. Poll verification on active use at a modest interval (initially 15 minutes), plus launch, resume, and reconnect; serialize refresh requests to respect token rotation. Persist the new refresh token before treating refresh as durably successful.

Distinguish transient network/5xx/rate-limit failures from authoritative invalid authorization. Retry transient failures with bounded backoff while the existing offline window lasts. Local sign-out clears the local token and permission immediately; attempt Clerk token revocation online. Remote account/security revocation is enforced on detection, not claimed to work instantly offline. Verify and document what Clerk's OAuth refresh token actually revokes on; its lifetime may differ from hosted browser sessions.

Use monotonic elapsed time while running and a credential-protected last-observed wall time across restarts; a backward jump exceeding five minutes requires online verification. A seven-day local grace is a product policy, not tamper-proof licensing or a refresh-token expiry override. Account/subscription decisions for cloud services will be enforced online when those services exist.

### Safe sign-out, expiry, and restart

Expose a single account section using existing Mantine components: identity with missing-field fallbacks, verification/offline deadline, Sign out, and Switch account. Offer one browser sign-in entry point rather than duplicating provider forms in the desktop.

Switch account uses the existing whole-app dirty-window quit flow plus a running-work check. Save/discard/cancel applies to every window. Wait for running work or explicitly stop it through existing stop APIs; drain/persist pending history before clearing auth, marking next launch as requiring account selection, and restarting through the installed process plugin. Cancel before this commit leaves the current session intact. If automatic relaunch fails, exit safely and explain reopening is needed. The next hosted flow must explicitly select an account rather than automatically reusing the browser's previous account; verify the supported Clerk prompt/selection mechanism in the feasibility task.

Expiry and remote invalidation enter a restricted state in the same profile: block new mutations and agent turns, but permit save/recovery, viewing current work, and output persistence/safe stopping for already-running work. Do not destroy buffers or dynamically move background tasks. Fresh authentication for the same identity can unlock the existing process; a different identity must settle work and restart before its profile loads. Check access in the backend as well as the UI, with explicit narrowly scoped save/drain exceptions.

### Recoverable legacy import

After verified sign-in and before opening a profile workspace, detect an unclaimed legacy personal store. Display Import existing local workspace into this profile / Start fresh. Show what will be imported; require explicit confirmation. Starting fresh does not claim the legacy data and leaves import available later.

Quiesce legacy writers and reject concurrent access to the same store during migration. Copy personal files into a staging directory and preserve an immutable recovery copy; enumerate/verify copied records before atomic installation of the profile. Copy frontend persistent state into profile-scoped keys and copy DB credentials into account-scoped entries, retaining originals for recovery. Maintain a small migration record so file, localStorage, and keychain steps can resume idempotently after interruption. Commit legacy ownership only after all required steps succeed, never expose a partially imported profile, and never merge over an existing nonempty destination implicitly. Keep machine resources at their current paths. Do not move source repos or include auth secrets in the recovery copy.

Alternatives: silently claiming the first user's data risks incorrect ownership; deleting or renaming the legacy store before verification risks data loss. Copy-verify-commit is worth the extra disk space even for the current single-user install.

## Risks / Trade-offs

- [Clerk native/free-tier behavior differs from web defaults] → Prove the public-client flow first; use actual OAuth expiry/revocation behavior, never promise paid controls on Free.
- [Results arrive after a switch request] → Immutable process profile, no restart until work settles, captured store context in every worker.
- [A UI-only gate leaves IPC accessible] → Backend access checks for workspace entry points and tightly limited recovery/drain exceptions.
- [Same OS user can read other profiles or use agent logins] → Make the boundary explicit; do not present profiles as encrypted OS isolation.
- [Legacy import spans multiple storage systems] → Staging, resumable migration record, verification, and recovery copy; no destructive cleanup in this release.
- [Auth outage exceeds offline window] → Explain deadline and reconnect requirement while preserving data; never silently extend the window.

## Migration Plan

1. Configure separate development/production Clerk clients and hosted methods; prove the free-tier native flow and document production domain/DNS/provider setup.
2. Add auth gating and an immutable profile context before personal startup work runs.
3. Exercise new empty profiles and explicit legacy import against copies of real store shapes before using live data.
4. Ship import and restart switching with recovery paths; warn against concurrently running old builds against the legacy store.
5. Rollback preserves the original store/recovery copy and new profiles. An older app cannot see new-profile work automatically; recovering that work requires an explicit offline recovery procedure, not an automatic merge.

## Open Questions

- Production Clerk issuer/domain, public client IDs, and Google/GitHub application registrations are deployment inputs supplied at implementation time. Their absence does not change the chosen flow or local profile behavior.
