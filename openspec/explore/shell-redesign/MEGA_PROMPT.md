# Palisade Code — IDE Shell Redesign: Run/Debug + LSP + Status Bar + Shared Shell Architecture

## Context

Two openspec changes exist as proposals only (verified against the actual
tree: no `lsp.rs`, no `run` field in `settings.rs`, no LSP/run code in
`lib.rs` or `api.ts` — this is greenfield, not partially built):

- `openspec/changes/run-debug-buttons/`
- `openspec/changes/lsp-integration/`

This prompt amends both, and adds a shell-architecture change neither
proposal covers. It is the product of a design-review conversation against
a ChatGPT-generated mockup, a live-app UX audit (Tauri MCP driven), and
competitive research against Zed, Cursor, Windsurf, and Kiro. Every claim
below is either grounded in this repo's code or cited to a live source —
see `REDESIGN.md` in this directory for the full evidence trail. Do not
silently reintroduce the mockup elements rejected below; they were rejected
for stated reasons, not by oversight.

Companion files in this directory: `REDESIGN.md` (design rationale, task
list, quality gate), `mockup.html` (static reference mockup of the main
shell — open it before writing a line of shell layout code), and
`mockup-onboarding.html` (reference for Amendment 8's first-run screen).

## Governing rule: Vibe and Editor are one shell, two arrangements

**This is the single most important architectural decision in this
prompt.** Vibe mode and Editor mode must render from the *same* panel set —
left icon rail, file editor, bottom panel, right chat rail — differing only
in which panel is open by default and how much width chat gets. There must
be no Vibe-exclusive or Editor-exclusive panel, ever. Today's app violates
this (Vibe has a git panel Editor doesn't show; Editor's structure isn't
shared with Vibe) — that drift is a bug to fix, not a pattern to extend.

Concretely: Vibe defaults to chat-wide, file editor narrow/collapsed.
Editor defaults to file-wide, chat narrow. The `Vibe`/`Editor` segmented
control in the title bar is a *layout preset switch*, not a feature switch.
Switching it must never lose state (open files, thread selection, panel
contents) — this already works correctly in the live app; preserve it.

**Column order flips between presets, panel inventory does not.** Editor
preset, left to right: icon rail → left panel (Explorer/Search/Source
Control/Specs/Run) → editor → chat. Vibe preset, left to right: **session
list** (new — see Amendment 3) → chat → editor → left panel → icon rail.
The rail and its panel move to the *right* edge in Vibe, not away — this
matches Devin's shell shape (session list, chat, and editor/explorer as
three visually distinct zones, agent-conversation-first) and is confirmed
against a live Devin Desktop screenshot, not invented. `mockup.html`
implements this via CSS `order` on the shared flex children — reuse that
approach rather than duplicating markup per preset.

## Process rules — how to build this, not just what

- **TDD, no exceptions.** For every non-trivial piece of logic in this
  redesign (project-file run-detection, LSP status-transition handling,
  the commit-message-generation prompt, the executor-switch banner's
  show/hide condition, panel-state persistence across shell switches) —
  write the failing test first, then the code that passes it. UI layout
  itself doesn't need a test per pixel, but anything with a branch, a
  parser, or a state transition does.
- **Ponytail discipline throughout.** This repo runs the
  [Ponytail](https://github.com/dietrichgebert/ponytail) plugin
  (`/ponytail full` is the ambient mode) — climb its ladder before writing
  code for each amendment: does it need to exist at all → is there already
  a helper/pattern in this codebase (grep before writing, this repo
  already has process-management patterns in `executor.rs`/`terminal.rs`,
  a `Modal` component, a `ds-section-heading` pattern — reuse them) →
  stdlib/native → already-installed dependency → shortest correct code.
  No speculative abstractions, no unrequested config, no new dependency
  for what a few lines already covers. Run `/ponytail-review` on each
  amendment's diff before moving to the next one — don't wait until the
  end to find out a phase over-built.
- **Final step, after every amendment above is implemented and its own
  quality gate passes: run `/ponytail-audit`** (whole-repo over-engineering
  audit, not just the diff) and act on its findings — delete dead code,
  collapse unnecessary abstractions, remove anything that reads as
  AI-generated scaffolding rather than a deliberate, minimal change. This
  is a required last step, not an optional cleanup — do not report this
  redesign done until it has run and its findings have been resolved or
  explicitly noted as accepted trade-offs.

## Amendment 1: run-debug-buttons — two run affordances, not one

Supersedes design.md D4 ("split button in TabBar next to file names").

- **Title bar**: global split button (primary action = last-used command,
  dropdown chevron = all configured commands from `.project-settings.json`'s
  `run` field). Project-scoped, not file-scoped.
- **Left rail "Run" icon**: opens full run-configuration management (add,
  edit, delete named commands). The title-bar button is the quick-access
  shortcut; the rail icon is where configuration actually happens. These
  are two views of the same `run` config, not competing features.
- **Onboarding default replaces "run current file"** (design.md's original
  language doesn't apply to a project-scoped button): on first use with no
  `run` config, inspect the project root — `package.json` (`scripts`
  entries), `Cargo.toml` (`cargo run`), `pyproject.toml`, `Makefile` — and
  propose the most likely default. The user must confirm/edit before it
  writes to `.project-settings.json`; never auto-write silently (keeps
  design.md's existing D12 rejection of "auto-create without user input"
  intact — detection proposes, it doesn't decide).
- Command output goes to the **Terminal tab of the bottom panel** (Amendment
  3), same as the existing design's plan — just relocated.
- Explicitly NOT in scope: DAP/breakpoints/step-through. Web research
  confirms none of Kiro, Cursor, Windsurf, or Zed treat step-through
  debugging as a differentiator in 2026 — skipping it is not a competitive
  gap. Don't let "debug" in the folder name imply debugger UI.

## Amendment 2: lsp-integration — add the missing status surface

The existing design.md (D2, D3, D5, D12–D15) is architecturally sound —
confirmed via Context7 against the actual `@codemirror/lsp-client` API
(its `Transport` interface matches D12's WebSocket-bridge plan exactly). No
change to backend architecture, server lifecycle, or language support. This
amendment only adds UI that was missing:

- **Status bar language indicator**: the existing `{} Python` label becomes
  clickable, showing LSP server state — running / starting / crashed /
  disabled-after-3-crashes (per design.md D14) / server not installed. This
  is the only place D14's "show warning" requirement currently has a home.
- **Problems tab**: lives in the bottom panel next to Terminal (Amendment
  3). Diagnostics aggregate here; gutter squiggles and hover tooltips stay
  as already planned. Windsurf independently validates this exact pattern
  (their bottom dock has a Problems tab alongside Cascade/terminal).
- No scope change to detection, lifecycle, or failure handling.

## Amendment 3: shared shell architecture (new — not in either proposal)

Needed to host Amendments 1 and 2, and to fix the Vibe/Editor drift found
in the audit. Validated against Zed's dock system, Cursor's activity bar,
Windsurf's left sidebar, and Kiro's custom-icon-in-rail pattern (all four
converge on this shape independently — see REDESIGN.md §Competitive
Research).

**Left icon rail** (present in both shells, identical contents):

1. Explorer — file tree
2. Search
3. Source Control — the git panel currently living in Vibe's middle column
   moves here. Vibe mode putting git front-and-center in a dedicated column
   was a live-app-only quirk, not an intentional design; no competitor does
   this. See Amendment 7 for the panel's own redesign.
4. Specs — the openspec changes list currently stacked into the right rail
   moves here. Direct parallel to Kiro's own custom rail icon
   (Specs/Steering/Hooks/MCP) — validates that a product-specific rail item
   is normal, not scope creep.
5. Codebase Map — Graphify's existing force-directed graph (already
   documented in DESIGN.md's "Codebase-map (Graphify)" component; this
   redesign only gives it a rail entry point, it does not change the
   graph's own behavior, node-coloring, or Rust-side generation). Panel
   shows a compact preview with an expand affordance to the full view;
   node colors reuse DESIGN.md's existing 8-slot CVD-safe categorical
   palette verbatim — do not introduce new graph colors.
6. Run — full run-config management (Amendment 1).
7. History, Account, Settings at the bottom (as in the mockup and every
   competitor).

**Middle column**: file editor, in both shells (Vibe's middle column
currently shows a git panel instead — replace it with the same editor
Editor mode uses; this is the biggest single layout change in this prompt).

**Bottom panel**: toggleable, VS Code/Kiro/Windsurf pattern — pushes the
editor up when open, collapses to reclaim space when closed. Tabs:
**Terminal** (existing `TerminalPane.tsx`, relocated here) and **Problems**
(new, Amendment 2).

**Right rail**: chat only, in both shells. Drop the file explorer and specs
list from here — they move to the left rail per above. Thread list stays
(it's chat-scoped, not file-scoped).

**Vibe-only session list** (new panel, Devin-referenced): a dedicated
left-edge column in Vibe preset only — "+ New thread", a search field, and
threads grouped by workspace (not an invented "Spaces" concept; group
headers are the workspace name, since Palisade already has a workspace picker
per DESIGN.md's right-panel spec). Each row: thread title (2-line clamp),
relative timestamp, and a small accent dot for threads with a live/busy
session (`session.busy` already exists in the data model — this is a real
state, not invented). The Source Control rail icon keeps its own
notification dot too (uncommitted-changes indicator). This does not
replace the existing thread-tabs strip at the top of the chat rail — that
stays as the quick in-conversation switcher; the session list is the
browse/search surface, matching Devin's own split between a persistent
session list and an active-thread tab strip. Hidden entirely in Editor
preset (thread-tabs strip alone is sufficient there — don't duplicate the
browse surface in a mode where chat is already narrow).

**Toggleable.** A `layout-sidebar` icon button in the title bar (visible in
Vibe preset only, next to the `Vibe`/`Editor` switch) collapses/expands the
session list, matching Devin's own title-bar toggle affordance. Collapsing
gives chat the reclaimed width immediately — same "slide fully out, don't
overlay" rule DESIGN.md already states for the existing left/right docks.

**New Thread state.** Clicking "+" in the thread-tabs strip (or the session
list's "+ New thread") replaces the chat conversation view with an empty
state: centered icon, "New thread" heading, one line of framing copy, and
two cards — **Spec** and **Go** — each with a one-line description (reuse
Amendment 6's socratic framing for the Spec card's copy, don't write a
third variant). Picking a card starts the thread in that mode. Selecting
an existing thread from either the tab strip or the session list returns
to its conversation — this is a per-thread state, not a persistent screen.
Also drop the standalone "Spec Mode" banner pill that used to sit above
the chat body — Amendment 6's socratic framing now lives in the agent's
own first message, and a banner repeating the same point above it was
redundant chrome, not a second source of truth.

## Amendment 4: FIM completion — status bar indicator

FIM (`GhostTextPlugin.ts`) and its settings already exist and work, but are
buried in `SettingsPanel.tsx` (line ~1047) with zero in-editor visibility.
Web research confirms ghost-text quality is the exact bar Cursor set for
this category — Palisade's model is already competitive; the gap is visibility,
not quality.

- Small status bar icon, next to the LSP language indicator, showing FIM
  on/off. Click toggles it via the existing `api.setCompletionEnabled` /
  `handleCompletionEnabled` path already wired in `SettingsPanel.tsx` — do
  not duplicate the persistence logic.
- No changes to the completion model, debounce, or scoring logic.

## Amendment 5: fix — executor switch mid-session is a silent trap

Live-tested via Tauri MCP: the switching *mechanism* is correct — picking a
different agent from `executor-btn`'s dropdown updates `thread.executor`
immediately and correctly (`App.tsx` `onPickExecutor`, `lib.rs`
`selected_executor` priority chain all verified working). The bug is UX:
when a live session is running, the only explanation that switching applies
to the *next* session, not the current one, is a one-line hint inside the
dropdown menu (`App.tsx` ~line 922–928) — which closes the instant you make
a selection, hiding the explanation at the exact moment it's needed.

- **Fix**: when the user picks a different agent while `hasLiveSession` is
  true, show a **persistent, dismissible banner in the chat area itself**
  (not the menu) stating "Next session will use {agent}. This session
  continues as {current agent}." It must stay visible after the menu
  closes, not disappear with it.
- Also fix the stale doc: CLAUDE.md's "Agents are a const table (`KNOWN_AGENTS`
  in `executor.rs`)" is out of date — agents are now discovered at runtime
  via an ACP Registry (`acp_registry.rs`). Update CLAUDE.md's gotcha
  section to describe the registry instead of a const table. This is a
  one-line doc fix, bundle it with this amendment since it was found while
  diagnosing the same code path.

## Amendment 6: fix — Spec Mode's own copy misdescribes what it does

Every piece of UI copy audited for this redesign (the empty-state card, the
in-chat banner) describes Spec Mode as "read-only planning" with edits
"disabled" — a purely negative, restriction-first framing. That is not what
Spec Mode is. Per PRODUCT.md, Spec Mode is Palisade's core differentiator: a
**Socratic, one-question-at-a-time spec-writing interview** (the
grill-explore → grill-propose → grill-apply → grill-archive skill chain)
that produces a binding decision log before any code gets written — not a
passive "look but don't touch" state. Describing it as read-only is
accurate as a side effect but misses the entire point of the mode, and a
first-time user reading "edits are disabled" has no reason to expect an
active interview is about to happen.

- Rewrite every surface that names Spec Mode (empty-state card copy, the
  in-chat banner, any tooltip) to lead with what it *does* — asks
  structured questions to build the spec — not what it *disallows*.
  `mockup.html`'s banner ("Spec Mode — writing the spec together") and its
  first agent turn ("I'll ask one question at a time to shape requirements,
  design, and tasks — nothing gets built until you approve the plan.") are
  the reference copy; match that tone, don't just soften the old strings.
  "Edits are disabled" may still appear as a secondary clarifier, never as
  the lead sentence.
- This is a copy-only change — no change to the actual grill-* skill chain,
  permission flags, or the spec/go state machine.
- Drop per-message avatar circles on agent chat turns (a small filled
  circle was tried next to each agent message in `mockup.html` and
  rejected by the user as unnecessary decoration). Agent messages are
  distinguished from user messages by alignment/color alone, same as
  before — no avatar treatment.

## Amendment 7: Source Control panel — redesign to match reference

The panel behind the new Source Control rail icon (Amendment 3) needs more
than a bare file list; it's the primary git surface for a tool whose users
review diffs constantly. Reference: a Cursor-style Source Control panel
with header actions, an AI-assisted commit flow, and an inline graph —
confirmed against a live screenshot, not invented from scratch, and
implemented in full in `mockup.html`'s `#panel-git` — build from that
markup/CSS, don't redesign again from prose.

- **Header row**: "Source Control" label + an overflow (`···`) menu.
- **Changes row**: section label + three icon actions (stage all, refresh,
  overflow menu).
- **Commit box**: a multi-line message input (placeholder: `Message
  (⌘Enter to commit on {branch})`) with an inline **Generate** button
  (sparkles icon) that drafts a commit message from the staged diff via the
  active agent — this is a new capability, not just UI: wire it to a
  prompt that summarizes `git diff --staged` through the session's
  executor, not a canned template.
- **Commit button**: primary, full-width, commits with the message in the
  box.
- **Review Working Changes button**: secondary, full-width, sparkles icon —
  sends the working diff to the active agent for a review pass (a second
  new agent-assisted capability; distinct from Commit, doesn't require a
  message).
- **Changes list**: below the actions, each row two-line (filename bold,
  dim relative path beneath) with a right-aligned single-letter status chip
  (`M`/`A`/`U`/`D`), colored from the existing semantic tokens (`--warn` for
  modified, `--success` for added/untracked) — never a new chromatic color,
  per DESIGN.md's One Accent Rule.
- **Graph section**: a compact commit-log timeline below the changes list —
  dot-and-line graph, most recent commit marked with a `main` branch badge,
  each row showing the commit subject (truncated) and author. Read-only in
  this panel; clicking a commit is out of scope for this redesign (no diff
  viewer wired here — that's the existing Diff tab per DESIGN.md's Center
  Workspace layout).
- The existing `git-btn` "Fetch · Pull · Push" affordance from the original
  panel draft is superseded by this layout — drop it; fetch/pull/push can
  live in the header's overflow menu if needed, don't invent new primary
  buttons for it.

## Amendment 8: onboarding — a real first-run screen for a new project

Today there is no dedicated first-run/no-project-open screen — the audit
found cold start lands directly on a bare workspace picker with zero
framing (REDESIGN.md's audit findings). Competitors treat this as a real
surface: Cursor, Windsurf, and Devin all show a centered welcome state with
clear "open/clone a project" actions and recent-project recall before any
editor chrome appears. Reference: `mockup-onboarding.html` in this
directory — adapted from a live Windsurf/Devin screenshot, not copied
literally (their "Connect via SSH" and account/tier UI don't map to
Palisade's model and are deliberately absent).

- Shown whenever no project is open (cold start, or after closing the last
  open project) — replaces whatever bare picker currently renders.
- Centered layout: product mark, one-sentence pitch grounded in
  PRODUCT.md's actual positioning (Socratic spec cycle, bring-your-own-agent
  — don't write new marketing copy, pull from PRODUCT.md's Positioning
  section), two primary action cards (**Open Project**, **Clone
  Repository**), and a **Recent Projects** list below.
- **Executor detection status is part of onboarding, not hidden in
  Settings**: a small status pill states which agent (Claude Code / Codex)
  was auto-detected on this machine, or that none was found with a link to
  install one. This is the same detection the app already runs
  (`executor.rs` / ACP Registry per CLAUDE.md) — surface its result here
  immediately, don't make a first-time user discover it by opening a
  project and hitting a dead end.
- No account/sign-in UI, no tier/plan badge, no "Pro" label anywhere —
  PRODUCT.md is explicit that Palisade has no bundled billing; inventing one on
  the welcome screen would misrepresent the product on the first screen a
  new user sees.
- "Recent Projects" (not "Recent sessions" — Devin's sessions are
  cloud-hosted and cross-project; Palisade's are local and project-scoped, so
  the natural recall list here is projects, with sessions/threads reachable
  once one is opened).
- **Composer input, present even before a project is open** (per the
  user-supplied Windsurf/Devin reference): a text input ("Type a request,
  or select a project below to get started…"), a control row (add-context,
  Bypass Permissions toggle, detected-agent pill, mic, send), and a
  directory row below it ("Local" tag + "Select a directory…"). Submitting
  a message with no project open should prompt for a directory first
  (Palisade's project-scoped model, per PRODUCT.md, has no cloud/directory-less
  execution path the way Devin does) — don't silently accept a message
  with nowhere to run it.
- **No Vibe/Editor shell switch on this screen.** There's no project open
  yet, so there's nothing for either shell preset to render — v1 shows
  this screen standalone, outside the Vibe/Editor governing rule entirely,
  until a project is opened.

## Amendment 9: title-bar utility cluster — terminal, chat, and theme toggles

DESIGN.md's Layout section already documents a "right-aligned utility
cluster of 32px icon buttons (left-sidebar toggle, theme cycle,
right-sidebar toggle, terminal toggle, settings, preflight/executor
status)" — this redesign had not yet built it. Add, in the title bar next
to Settings:

- **Terminal toggle** (`layout-bottombar` icon): collapses/expands the
  bottom panel (Amendment 3). Same state as the bottom panel's own inline
  chevron — one control, two entry points, not two independent states.
- **Chat toggle** (`layout-sidebar-right` icon), **Editor preset only**:
  collapses/expands the chat rail so the editor can take the full width.
  Hidden in Vibe preset — chat is the primary surface there and already
  has its own session-list toggle (Amendment 3); a second toggle for the
  same rail would be redundant.
- **Theme toggle** (`sun-moon` icon): cycles light/dark. **Implementation
  note from building this in `mockup.html`**: apply the theme attribute
  and `color-scheme` CSS property to `<html>`, not a nested app container
  — `html`/`body` read `--bg` etc. from `:root` scope regardless of what a
  descendant div overrides, so a theme override scoped below `<html>`
  leaves `body`'s own background stale. Verify a theme toggle by checking
  computed styles (`getComputedStyle(document.body).backgroundColor` and
  `getComputedStyle(document.documentElement).colorScheme`), not only a
  screenshot — this exact bug looked correct in computed CSS the first
  time and still needed the `<html>`-level fix to actually paint right.
- DESIGN.md's exact light-mode token values weren't available while
  building this reference — `mockup.html`'s light palette is a good-faith
  OKLCH mirror (lightness inverted, hue/chroma intent preserved), flagged
  inline in the CSS. Pull the app's real light tokens if they already
  exist somewhere in the codebase rather than trusting this mirror as final.

## Explicitly out of scope — do not build these

- **No third thread mode.** The mockup showed `SPEC`/`PLAN`/`CHAT`
  thread-tab badges. This does not exist anywhere in `App.tsx` and
  contradicts CLAUDE.md ("Two modes only (spec/go)... No third mode"). It
  was a mockup fabrication. If thread tabs need a label, it must map onto
  the existing spec/go state machine.
- **No generic extensions/plugin icon.** Superseded by the Specs icon
  (Amendment 3) — that's what the mockup's puzzle-piece slot should have
  meant, once corrected. `lsp-integration/design.md` D6 explicitly rules
  out "full extension ecosystem."
- **No "Auto" title-bar dropdown.** Undefined in both proposals and the
  mockup; the live app has no tooltip explaining it either. Do not
  implement speculative functionality — if it turns out to mean something,
  that's a separate proposal with its own Why.
- **No DAP/breakpoint UI** (Amendment 1).
- **No mid-session live agent handoff.** Amendment 5 fixes the
  *discoverability* of the next-session-only behavior; it does not change
  the behavior itself to apply immediately. That's a larger, separate
  design question (what happens to in-flight tool calls, conversation
  state translation across providers) — out of scope here.

## Verification

- Frontend: `pnpm test`, `npx tsc --noEmit`
- Rust: `cd src-tauri && cargo test`
- Manual, via Tauri MCP bridge (127.0.0.1:9223) per
  `.agents/skills/run-palisade-code/SKILL.md` — Playwright cannot drive this
  app (WKWebView):
  - Run button proposes correct default per project type (test against a
    Node, Rust, and Python fixture project).
  - LSP status indicator reflects actual server state, including a
    forced-crash case reaching the disabled-after-3-crashes state.
  - Bottom panel toggle doesn't clip/overlap the chat rail in either shell.
  - **Parity check**: every left-rail panel opens correctly from both Vibe
    and Editor shells, with identical content. Switching shells mid-task
    (file open, thread selected, terminal running) loses nothing.
  - Executor-switch banner appears and persists through menu close when
    switched during a live session; does not appear when switched with no
    live session.
- Run the full UI/UX quality gate loop in `REDESIGN.md` §Quality Gate
  before considering this done — passing `tsc`/`cargo test` is necessary
  but not sufficient.
- Run the **persona review loop** in `REDESIGN.md` §User Personas — Quality
  Gate: spawn each persona sub-agent against the built shell, fix what they
  flag, re-run. Not done until every persona reports satisfied.
- Run `impeccable detect` (or `/impeccable audit`) against every changed
  UI file — clean, or findings explicitly classified as intentional with a
  reason, per the pattern already established in `mockup.html`.
- Run `/ponytail-audit` last, per Process Rules above, and resolve its
  findings before calling this done.
