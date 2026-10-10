# Brooks-Lint Review

**Mode:** PR Review
**Scope:** This worktree’s uncommitted account/profile implementation, including new untracked source and tests. Sampled review of the highest-risk paths because the change exceeds 300 lines: native OAuth, secure storage/rotation, offline permission, IPC admission, immutable profiles/import, browser persistence, unsaved editor/notebook buffers, restart coordination, and Settings integration. Existing unrelated application behavior is outside this review; generated Cargo.lock and image assets were excluded.
**Health Score:** 100/100
**Trend:** 75 → 95 → 100 after fixes and reinspection.

No actionable decay findings remain in the reviewed implementation. This score describes code-review findings; it is not proof that every release smoke test has passed.

## Findings

None remain. R1–R6 and the quick test check were considered. Coordinated storage edits belong to one account-profile boundary, rather than unrelated shotgun surgery. The native modules hide OAuth and credential details behind identity/status IPC; persistence DTOs are intentionally data-only. Linear migration steps retain explicit ordering and recovery rather than adding a migration framework.

## Resolved findings

| Symptom | Source | Consequence | Remedy applied |
| --- | --- | --- | --- |
| Switch and sign-out buttons called the identical restart command. | The Pragmatic Programmer — DRY; Domain-Driven Design — ubiquitous language | Two apparent operations could drift while promising different behavior. | One clearly labelled Sign out and restart action explains account selection. |
| Retired AccountConnect proof and its tests described discarded credentials after the native implementation began persisting them. | Refactoring — Speculative Generality | An unused authentication surface gave misleading security evidence. | Deleted the retired component/test; retained the explicitly requested development mock preview. |
| Native auth and session modules imported each other’s identity/configuration. | Clean Architecture — Acyclic Dependencies | Credential policy and OAuth transport could not be understood independently. | Session owns its identity/configuration record; OAuth consumes it. |
| Rotation-storage and interrupted-import failures had no focused checks. | Working Effectively with Legacy Code — sensing and separation | Successful-flow tests would miss permission renewal or ownership errors on failure. | Added ordered refresh verification checks, failed import/retry checks, and browser-copy rollback checks. |
| Static notebook helper imports defeated the existing lazy notebook boundary. | Software Engineering at Google — dependency management | Every launch loaded notebook editing dependencies even without a notebook. | Reused dynamic imports at the save/eviction call sites. |
| The callback test sent its HTTP request through several formatted stream writes with a short scheduling deadline. | xUnit Test Patterns — Erratic Test | Concurrent suite load could close the test listener before the request finished. | Send one complete request buffer; give only the test listener a larger scheduling allowance. Production deadlines are unchanged. |

Additional safety corrections: serialize restart commitment against cancellation, refuse normal Quit coordination during an account restart, close Settings on expiry/restart, surface cancellation errors, durably remove the signed-out marker, validate new stored records, and bound the serialized credential size.

## Verification

- Full frontend regression: 96 files, 1,509 tests passed.
- Full Rust regression: 896 passed, one existing ignored test.
- Frontend production build and native readiness build passed; release compilation checked separately.
- Real native production Google sign-in, secure restoration/refresh, Settings rendering, and dirty-window restart cancellation observed. Import recovery, callback binding, finite permission, profile isolation, and rotation ordering have focused checks.
- Manual release checks still required: email-code and production GitHub round trips, explicit second-account selection, actual multiple-window restart with running work, and packaged macOS credential persistence/return. No claim of those checks passing is made.

## Summary

The reviewed code retains one immutable process profile and one native credential owner. The remaining release work is live platform/provider verification, recorded in the OpenSpec checklist rather than inferred from mocks or this score.


## Follow-up inspection

Keychain approval restored the latest native binary. Live terminal rejection, stop-work, two actual window prompts, one-window confirmation waiting for the other, and cancellation preserving the account were observed. A newly exposed fleet error-display defect was corrected with the existing shared errorMessage helper and a red/green regression, removing duplicated error coercion without adding an abstraction. Reinspection of that two-line production fix found no additional actionable decay findings; reviewed score remains 100/100. Earlier manual-verification limitations still apply where not explicitly superseded here.


Browser-session follow-up: email-code returned to the same verified local profile. Added one fixed-URL native opener (no dynamic routing/configuration), reused existing error handling, and a UI regression proving browser-account management does not start or mutate desktop sign-in. Pre-auth admission is explicitly checked. Reinspection found no actionable decay finding; sampled review remains 100/100. Latest full frontend regression is 1,511 passing tests; focused native account tests and readiness build passed. Remaining live platform checks are unchanged except email-code is now verified.

Latest full Rust regression after the browser-account opener: 896 passed, one ignored.

Final local bundle checkpoint: all three production sign-in methods returned to the workspace with the same stable profile. Packaged debug restoration, automatic sign-out/restart and browser callback return passed against bundled tauri://localhost assets. These supersede the earlier email/GitHub/local packaged limitations. Live offline relaunch, different-user profile switching and signed distribution validation remain unverified. Full regression: frontend 1,511 passed; Rust 896 passed plus one ignored.
