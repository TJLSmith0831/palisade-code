# Account Settings interface review

Scope: Account & local profile inside the existing Settings pane, plus its restart/expiry handoff. React, Mantine, existing CSS tokens and density; AGENTS.md and DESIGN.md were consulted. This is a screen/flow review, not an interface-review of every worktree change.

## Coverage

| Domain | Evidence inspected | Result |
| --- | --- | --- |
| Accessibility | Native dialog role, named native buttons, labelled section, focus CSS, close/recovery paths | Solid foreground focus ring added for account controls; screen-reader and OS keyboard traversal not verified |
| Layout | Native normal-width rendering; account section constrained to 320px dialog width | No overflow; buttons wrap into separate rows |
| Writing | Identity fallbacks, deadline, local-profile boundary, restart consequences and error recovery | Duplicate action removed; recovery action available after expiry |
| Typography | Actual 12px name and 11px secondary text in the documented dense desktop scale; wrapping at 320px | Clear within inspected section |
| Colors | Computed text/surface OKLCH pairs in light and dark | Dark body 16.74:1, secondary 6.05:1; light body 17.59:1, secondary 6.92:1; all exceed 4.5:1 |
| UI | Native screenshot, avatar, neutral actions, scroll cue, existing Mantine modal | Uses existing Settings surface; no additional account dialog |

## Findings

No actionable interface findings remain in the inspected account section. Replaced the separate account dialog with inline content; gave keyboard focus a solid foreground outline in both themes and the avatar the existing image-outline token.

## Verification

Native Tauri Settings opened with the real production identity. At 320px dialog width the account section reported scrollWidth ≤ clientWidth and both action rectangles stayed inside it. Contrast was computed from the measured rendered foreground/background pairs. Native dirty-window restart opened its Save/Discard/Cancel dialog; cancellation preserved account access. Existing Settings and AccountGate tests, full frontend tests and production build passed.

Not verified: screen-reader announcements, actual OS keyboard traversal (the bridge’s synthetic Tab did not change focus-visible state), forced colors, full application reflow at 320px, and motion slowed to 10%. The app’s supported native minimum width is 800px; the 320px check above covers only the account section. Unrelated Settings controls were not reviewed.

## Verdict

Approve for the reported screen scope. Manual accessibility checks remain explicit limitations, not claimed passes.


Browser-session follow-up: Settings explains that desktop sign-out and hosted browser sign-out are separate. The sign-in screen exposes an optional, labelled external-browser action outside the pending-login state, with instructions to return and continue. It reuses Mantine controls and existing error presentation. Production identity and updated Settings copy were inspected and captured in the real native webview. Email-code completion is verified. No new interface finding in this scope.
