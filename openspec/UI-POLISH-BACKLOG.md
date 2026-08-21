# UI Polish Backlog

A running list of per-screen polish opportunities, kept as `/impeccable`
commands so each entry is directly runnable rather than a vague note. Started
2026-08-21 during the post-critique cleanup pass.

**How to read this.** Each screen lists what is already settled (so a future
pass doesn't relitigate it), then what is open. An open item names the
`/impeccable` command that owns it. Severity uses the critique scale:
P0 blocking · P1 major · P2 minor · P3 polish.

**Standing constraints** (do not "fix" these — they are decisions):

- No pitch copy, headline, or tagline on the onboarding screen until account
  gating ships. Locked by `OnboardingScreen.test.tsx` and DESIGN.md's
  Typography section. This has been proposed and declined twice.
- Mantine components and Tabler icons only. No third UI library, no inline
  `<svg>`, no hand-rolled widget Mantine already ships.
- One accent (Dragon Fire Green), on live/active/agent-touched surfaces only.
- The three-column layout's resemblance to VS Code is deliberate and owned in
  DESIGN.md. Differentiation is behavioral, not compositional.

---

## Onboarding screen (`OnboardingScreen.tsx`)

**Settled:** card hover/focus states, entrance animation with a
`prefers-reduced-motion` opt-out, composer focus ring, no-agent-detected and
opening-in-progress states, deliberate absence of pitch copy.

| Open item | Sev | Command |
|---|---|---|
| The 21px display type step in DESIGN.md is declared but unused; the screen has no typographic peak at all, so every element sits at one weight. Worth deciding whether the step gets a non-pitch use (e.g. the project name on the recent list) or gets removed from the system. | P3 | `/impeccable typeset` |
| Recent-projects list has no empty-state treatment distinct from "not yet loaded" — a first-ever launch and a slow disk look the same for a beat. | P3 | `/impeccable onboard` |
| Two cards (Open / Clone) sit in an `auto-fit minmax(200px, 1fr)` grid, so at wide window widths they stretch to half the viewport each and the pair reads as a banner rather than a choice. A max-width would hold the decision compact. | P2 | `/impeccable layout` |

## Top chrome / title bar (`App.tsx` header)

**Settled:** Vibe/Editor toggle now carries layout glyphs, not just names;
command-palette entry point is visible; 32px icon-button family is consistent.

| Open item | Sev | Command |
|---|---|---|
| The utility cluster is now 6+ icon buttons in one undifferentiated run (commands, terminal, theme, sidebars, settings, preflight). Same >4-per-group problem the NavRail just had, unsolved one level up. | P2 | `/impeccable layout` |
| `margin-left: max(92px, 5%)` on `.ds-shell-toggle` is a magic number reserving space for macOS traffic lights; it is unlabelled and will silently misplace the toggle on any other platform. | P3 | `/impeccable adapt` |
| Preflight/executor status button encodes state as border+icon color with a `.ok`/`.warn`/`.bad` class. Color plus icon shape, but no text — the one status surface in the app that leans hardest on color. | P2 | `/impeccable audit` |

## Left rail + file explorer (`NavRail.tsx`, `FileTree.tsx`)

**Settled:** rail split into workspace-nav and agent-facing groups with a
divider; chevrons are Tabler icons, not Unicode glyphs; no panel opens by
default; rename/create now validate the name client-side before the round
trip.

| Open item | Sev | Command |
|---|---|---|
| Tree rows show no git status (modified/untracked) inline, so the explorer and the Source Control panel tell different stories about the same file. | P2 | `/impeccable colorize` |
| Deep nesting has no indent guides; past ~4 levels the indentation alone stops carrying structure. | P3 | `/impeccable layout` |
| The inline rename input inherits the row's typography, so during a rename the row is visually identical to its resting state apart from the caret. | P3 | `/impeccable polish` |

## Chat / agent console (`EventView.tsx`, composer in `App.tsx`)

**Settled:** semantic status colors route through real Mantine theme keys;
reasoning and tool blocks collapse by default; permission prompt renders
inline with Allow / Deny / Allow-for-session; bypass toggle uses asymmetric
confirmation.

| Open item | Sev | Command |
|---|---|---|
| The composer's bottom row stacks executor picker, model picker, permission icon and Spec/Go control around the textarea — four competing affordances in one 42px band, the densest decision point in the app. | P2 | `/impeccable layout` |
| A long agent turn gives no progress signal beyond the spinner; there is no elapsed time or token/step indication for a run that goes minutes. | P2 | `/impeccable animate` |
| Tool-call blocks all render at one visual weight regardless of consequence — a file read and a `rm` look identical until expanded. | P1 | `/impeccable bolder` |
| The pending-approval state has never been visually verified end to end; in this dev environment the CLI has permissions pre-granted, so the gate never renders. Needs a deliberate harness to see it. | P1 | `/impeccable audit` |

## Editor pane (`FileEditorPane.tsx`)

**Settled:** file-conflict banner color fixed (was referencing a token that
never existed, so it painted unstyled).

| Open item | Sev | Command |
|---|---|---|
| Editor font presets still lead with a webfont the app ships no file for, so the "Default" option silently falls back. Changing the stored string would orphan existing localStorage values, so this needs a migration, not an edit. | P3 | `/impeccable harden` |
| No visual distinction between a file the agent just modified and one the user edited, despite that being the core trust question of the product. | P1 | `/impeccable colorize` |

## Diff / source control (`DiffPane.tsx`)

| Open item | Sev | Command |
|---|---|---|
| Hunk-level stage/unstage controls appear on hover only, so the primary action of the screen is invisible at rest. | P2 | `/impeccable polish` |
| No confirm on discard — the highest-consequence action in the app relies on the backend's own guard rather than a UI step, unlike delete and bypass which both confirm. | P1 | `/impeccable harden` |

## Settings (`SettingsPanel.tsx`)

**Settled:** overlay scrim promoted to `--scrim` and documented; mono stack
now defers to `--mono`; wrap toggle is theme-aware in both states.

| Open item | Sev | Command |
|---|---|---|
| The panel is a single long scroll with no section nav; it is the longest surface in the app and has the least wayfinding. | P2 | `/impeccable layout` |
| Editor theme presets are named swatches with no live preview of what the editor will look like. | P3 | `/impeccable delight` |
| Several controls are hand-styled inline (`style={{}}` blocks running 15+ lines) rather than using Mantine's `Switch`/`Select` — the file with the most inline styling in the repo, and the one furthest from the stated component policy. | P2 | `/impeccable distill` |

## Codebase map (`GraphPane.tsx`, `GraphView.tsx`)

| Open item | Sev | Command |
|---|---|---|
| The 8-slot categorical palette is CVD-safe and documented, but it is also the one place a second, third, and eighth chromatic color appear — worth an explicit carve-out note in DESIGN.md so it does not read as a One Accent Rule violation. | P3 | `/impeccable document` |
| No legend; community colors are unlabelled, so the palette encodes information the viewer cannot decode. | P2 | `/impeccable clarify` |

---

## Cross-cutting

| Open item | Sev | Command |
|---|---|---|
| `.impeccable/design.json` is older than DESIGN.md and has been reported stale on every hook run this session. Not repaired here, because repairing drift as a side effect of a design task is against the skill's own rule. | — | `/impeccable document` |
| No in-app help beyond the command palette. The palette now documents its own shortcut and has a visible entry point, which closes the discovery gap, but there is still no task-focused help. | P3 | `/impeccable onboard` |
| Light mode has never been reviewed as carefully as dark. Two theme bugs surfaced this pass purely as side effects of other work (a hardcoded charcoal toggle track, a phantom token). There is likely more. | P1 | `/impeccable audit` |
