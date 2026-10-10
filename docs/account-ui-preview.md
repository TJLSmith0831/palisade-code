# Account UI preview

Run `pnpm start`, then use the debug Tauri bridge to navigate the webview to `http://localhost:1420/?account-preview`. The query is development-only; normal startup opens the existing app.

Account identities, projects, offline deadlines, import, saves, agent completion, and restart are simulated in React memory. Reload resets the preview. No Clerk account, credentials, personal files, or migration are created. Native auth and profile isolation remain deferred in the OpenSpec tasks.

## Scope and coverage

Reviewed and refreshed the complete mock account flow: sign-in, browser wait, error/retry, import, empty/populated profiles, preferences, offline/expired access, and account switching. Stack: React/TypeScript, Mantine, Tauri WKWebView, existing OKLCH tokens and compact desktop density. Conventions inspected: AGENTS.md, CLAUDE.md, CONTRIBUTING.md, DESIGN.md, and account ADRs. The IDE and real Clerk integration are excluded.

| Domain | Evidence inspected | Result |
| --- | --- | --- |
| Accessibility | Native button/input semantics, labels, heading focus, modal close name, background inertness, Escape and focus restoration, motion guards | Fixed labels and focus; full keyboard/screen-reader walk not verified |
| Layout | Native rendering at 320 and 1280 pixels; overflow checks in sign-in, wait, import, profile, switch dialog, expiry; zoom/RTL and long translated copy samples | Fixed grouping; sampled reflow passes |
| Writing | Every action/error against its handler; account terminology and mock disclosure | Removed redundant entry copy |
| Typography | Heading hierarchy, DESIGN.md scale, wrapping in native narrow/zoom samples | Corrected title scale and button wrapping |
| Colors | Rendered canvas RGBA measurements composited over actual painted ancestor backgrounds, both themes | Inspected normal body/action text passes 4.5:1; dark modal minimum 5.01:1, dark muted card text 5.56:1, light profile minimum 5.86:1 |
| UI | Existing radii/shadows, icon role, button press and theme transitions | Removed lock decoration; retained existing tokens and disabled theme smearing |

## Findings addressed

| Severity | Domain | Location | Before | After | Why |
| --- | --- | --- | --- | --- | --- |
| HIGH, fixed | Accessibility | src/AccountPreview.tsx:618 | Modal close button had no accessible name. | `closeButtonProps` names it “Cancel account switch”. | Accessible names make the close action identifiable. |
| MEDIUM, fixed | Accessibility | src/AccountPreview.tsx:114, src/AccountPreview.tsx:142, src/AccountPreview.tsx:544 | Screen transitions kept old focus; background remained available to assistive technology; Appearance label targeted a div. | Focus the new heading, mark background inert, and label the preferences group. | Navigation and labels expose the current context. |
| MEDIUM, fixed | Layout | src/AccountPreview.tsx:200, src/AccountPreview.tsx:281, src/AccountPreview.css:118 | Uniform gaps and repeated divider lines blurred action/content groups. | Use 24px between groups, 12px within the sign-in action group, and remove project-row separators. | Group with space before lines. |
| MEDIUM, fixed | Typography | src/AccountPreview.css:51, src/AccountPreview.css:148 | Off-scale 25px heading; fixed-height, nonwrapping button labels. | Use DESIGN.md's 21px display size and expanding, wrapping buttons. | Preserve hierarchy and full action labels as space shrinks. |
| LOW, fixed | Writing | src/AccountPreview.tsx:200, src/AccountPreview.tsx:300 | Repeated welcome/provider instructions and an unrelated footer competed with sign-in. | Remove welcome/footer and state the next step once. | Delete words that do no work. |
| LOW, fixed | UI | src/AccountPreview.tsx:200, src/AccountPreview.css:187 | Decorative lock and animated label colors distracted from the action. | Remove lock; theme labels change instantly; modal respects reduced motion. | Contextual icons and restrained motion. |

## Verification

- `pnpm test`: 94 files, 1,503 tests passed, including the mock flow and new focus/name/inert checks.
- `pnpm build`: passed with existing bundle warnings.
- `cargo test --offline`: native suite passed when run with required socket/process/watcher permissions; the initial sandboxed run was blocked by those permissions.
- Native Tauri: inspected real rendering, no horizontal overflow in 320px samples, Escape closes the dialog and restores focus to its trigger, and background inertness toggles correctly.
- Inspected sign-in with CSS zoom 2 and RTL direction; inspected expanded German heading/action copy at 320px. These are samples, not full localization certification.
- Screenshots in `docs/screenshots/account-*-preview.png` come from the native app.

Not verified: full keyboard-only traversal, VoiceOver, automated accessibility-tree audit (bridge aria library unavailable), forced-colors appearance, actual browser zoom, all states at all zoom/RTL combinations, motion replay at 10% speed, real Clerk round trips, native offline enforcement, actual migration/restart, and packaged multiwindow behavior.

Approve for the inspected mock UI. Real authentication remains incomplete. A separate live native connection check is now available; see [Clerk connection check](clerk-connection-check.md) for its verified scope and pending steps.
