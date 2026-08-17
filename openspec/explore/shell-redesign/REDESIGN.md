# Palisade Code Shell Redesign

**Audience: an Opus-model coding agent working this in an isolated git
worktree.** This doc is the condensed decision record. `MEGA_PROMPT.md` in
this directory is the instruction set — read it first, it's the thing you
execute. This doc is _why_ those instructions say what they say, plus the
task list and the quality gate you run before calling any of it done.
`mockup.html` in this directory is the visual reference — open it in a
browser before writing any shell-layout code. Treat disagreement between
this doc and your own instincts about "better" layout ideas as a signal to
re-read the rejected-alternatives sections below, not as license to
freelance — every rejection here has a stated reason.

## How this doc was produced (so you can trust it)

Not a spec written from imagination. Produced across one conversation via:

- Direct reads of `openspec/changes/{run-debug-buttons,lsp-integration}/*.md`
  (proposal/design/tasks/decisions) — the two existing openspec changes this
  redesign amends.
- `grep`/`Read` against the live tree confirming both changes are
  **unimplemented** (no `lsp.rs`, no `run` field in `settings.rs`, no LSP
  code in `lib.rs`/`api.ts`) — this is greenfield work, not a partial build.
- Context7 query against `@codemirror/lsp-client`'s actual `Transport`
  API — confirmed it matches the existing design's WebSocket-bridge plan.
- A live UX audit driven through the real running app via the Tauri MCP
  bridge (screenshots, DOM reads, actual clicks — not just code reading),
  covering cold start, Vibe mode, Spec mode, Go mode, shell switching,
  Settings, and a live repro of a reported bug.
- Web research against Zed, Cursor, Windsurf, and Kiro's actual shipped UI
  layouts and 2026 competitive positioning (sources cited inline below).

## Ground truth facts (verified, not assumed)

- Neither `run-debug-buttons` nor `lsp-integration` has any code yet.
- `@codemirror/lsp-client`'s `Transport` interface (`send`/`subscribe`/
  `unsubscribe`) is a clean fit for the existing design's WebSocket bridge
  plan — no architecture change needed there.
- The executor/model-switching **mechanism** is not broken. Live-tested:
  picking a different agent updates `thread.executor` and the UI label
  immediately, correctly, every time. `App.tsx`'s `onPickExecutor` and
  `lib.rs`'s `selected_executor` priority chain (thread override → project
  `executorOverride` → PATH auto-detect) all work as designed.
- The perceived "stuck on Claude" bug is a **discoverability gap**:
  switching mid-live-session is intentionally deferred to the next session,
  and the only explanation is a hint line inside a menu that closes on
  selection. See `MEGA_PROMPT.md` Amendment 5.
- CLAUDE.md's "Agents are a const table (`KNOWN_AGENTS` in `executor.rs`)"
  is **stale** — agents are now discovered at runtime via an ACP Registry
  (`acp_registry.rs`). Fix this doc line as part of Amendment 5's cleanup.
- Live app today: Vibe mode's middle column is a **git/diff panel**, not a
  file editor. The right rail in both shells stacks workspace picker +
  full thread list + a "Specs" sub-list + file explorer into one column.
  Editor mode has **no left icon rail at all**. All three are drift from
  any coherent shared-shell design, not intentional differentiation.
- `SettingsPanel.tsx` opens on five rows of color-scheme swatches before
  any behavioral setting; the FIM completion toggle (line ~1047) is well
  below the fold.
- Every UI string that names Spec Mode ("Spec Mode — read-only planning",
  "Edits are disabled in spec mode") frames it purely as a restriction.
  Per PRODUCT.md this is wrong emphasis, not wrong fact: Spec Mode's actual
  job is a Socratic, one-question-at-a-time spec-writing interview (the
  grill-explore/propose/apply/archive chain) that produces a binding
  decision log — the read-only property is a side effect of that, not the
  point. See `MEGA_PROMPT.md` Amendment 6.
- A live Devin Desktop screenshot (user-supplied, not sourced from public
  docs) shows a fourth shell zone this redesign hadn't accounted for: a
  persistent session list distinct from the in-conversation thread-tab
  strip, sitting at the true left edge with chat/editor/explorer to its
  right. Folded in as Amendment 3's Vibe-only session list.

## Competitive research summary

| Tool     | Left rail / activity bar                                                | Chat/agent surface           | Diagnostics                  | Debugger emphasis    |
| -------- | ----------------------------------------------------------------------- | ---------------------------- | ---------------------------- | -------------------- |
| Zed      | Left/right/bottom "docks", user-repositionable, icon-driven             | Editor+agent, agent optional | —                            | Not a differentiator |
| Cursor   | VS Code-style vertical rail (most users revert from default horizontal) | Right sidebar / Agent Tabs   | —                            | Not a differentiator |
| Windsurf | Left: Explorer/Search/Source Control/Extensions                         | Right: Cascade panel         | **Bottom dock Problems tab** | Not a differentiator |
| Kiro     | Same spine + **own custom icon** for Specs/Steering/Hooks/MCP           | Chat, Vibe/Spec modes        | —                            | Not a differentiator |

Takeaways this redesign is built on:

1. The left icon rail (Explorer/Search/Source Control/…) is the converged
   industry shape, not a stylistic choice this redesign invented.
2. Kiro's own custom rail icon for its product-specific concept (Specs) is
   precedent for Palisade's own "Specs" rail icon — not scope creep.
3. Windsurf's Problems-tab-in-bottom-dock independently validates this
   redesign's Amendment 2 placement.
4. **No competitor treats step-through debugging as a differentiator in 2026.** Skipping DAP (run-debug-buttons' original Non-Goal) is not a
   competitive gap — don't second-guess that decision.
5. Cursor's ghost-text completion is the bar for FIM quality; Palisade's model
   is already competitive — the gap this redesign closes is **visibility**
   (Amendment 4), not model quality. Do not touch the completion model.

Sources: [Zed panel system](https://zed.dev/blog/new-panel-system) ·
[Zed docs](https://deepwiki.com/zed-industries/zed/3.5-panels-and-sidebar) ·
[Cursor sidebar](https://forum.cursor.com/t/getting-used-to-the-orientation-of-the-primary-sidebar/20) ·
[Kiro first hour](https://medium.com/@sanchi.halikar3/my-first-hour-with-kiro-a0a7aa060151) ·
[Windsurf guide](https://www.deployhq.com/guides/windsurf) ·
[Cursor vs Windsurf vs Zed 2026](https://dev.to/alexcloudstar/cursor-vs-windsurf-vs-zed-the-ai-ide-showdown-2026-44eo) ·
[Kiro vs Zed vs Cursor vs Windsurf 2026](https://codemyspec.com/blog/ai-ides-compared-2026)

## Governing architecture decision

**Vibe and Editor are one shell, two layout presets — not two feature
sets.** Same panel inventory (left rail, file editor, bottom panel, chat
rail) in both; they differ only in default-open/width. See
`MEGA_PROMPT.md`'s "Governing rule" section — this is not optional and
supersedes any per-shell layout idea that would give one shell a panel the
other lacks.

## Rejected mockup elements (do not reintroduce)

| Element                                                | Why rejected                                                                                                                                        |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SPEC`/`PLAN`/`CHAT` thread badges                     | Doesn't exist in code; CLAUDE.md is explicit: two modes only                                                                                        |
| Generic extensions/puzzle-piece icon                   | `lsp-integration` D6 rules out an extension ecosystem; superseded by the Specs rail icon                                                            |
| Title-bar "Auto" dropdown                              | Undefined in both proposals, in the mockup, and in the live app (no tooltip) — do not invent functionality for it                                   |
| DAP/breakpoint UI                                      | No competitor treats it as a differentiator; explicit Non-Goal in `run-debug-buttons/design.md`                                                     |
| Run button in TabBar (design.md's original D4)         | Superseded — see Amendment 1, now title bar + rail                                                                                                  |
| Standalone "Spec Mode" banner pill above the chat body | Redundant with Amendment 6's socratic framing now living in the agent's own first message — two places saying the same thing is chrome, not clarity |
| Per-message avatar circles on agent chat turns         | Tried during this redesign, explicitly rejected by the user as unnecessary decoration — alignment/color already distinguishes agent from user turns |

## Task list

Work top to bottom; each phase should pass its own slice of the quality
gate before moving on, not just at the very end. Every phase below is
subject to `MEGA_PROMPT.md`'s Process Rules — TDD for anything with a
branch or state transition, Ponytail's ladder before writing code, and
`/ponytail-review` on each phase's diff before starting the next phase.

### Phase 0 — housekeeping

- [ ] Fix CLAUDE.md's stale `KNOWN_AGENTS` reference (Amendment 5).
- [ ] Confirm `.agents/skills/run-palisade-code/SKILL.md` Tauri MCP flow
      still works before relying on it for every later verification step.

### Phase 1 — shared shell skeleton (blocks everything else)

- [ ] Build the left icon rail component (Explorer, Search, Source
      Control, Specs, Codebase Map, Run, History, Account, Settings) —
      shared by both shells, mounted once, not duplicated per shell.
- [ ] Wire the Codebase Map rail icon to the existing Graphify view
      (DESIGN.md's already-documented component) — this is a new entry
      point, not a new graph feature. Reuse the existing force-directed
      canvas/palette rather than rebuilding it.
- [ ] Move the git/diff panel currently in Vibe's middle column behind the
      Source Control rail icon.
- [ ] Move the Specs list currently stacked in the right rail behind the
      new Specs rail icon.
- [ ] Move the file explorer currently in Editor's middle-left into the
      Explorer rail icon's panel, shared by both shells.
- [ ] Replace Vibe's middle column (currently the git panel) with the same
      file editor component Editor mode uses.
- [ ] Strip the right rail down to chat + thread list only, in both
      shells.
- [ ] Verify: switching Vibe ↔ Editor preserves open file, thread
      selection, and scroll position — this already works today, don't
      regress it while restructuring.
- [ ] Rebuild the Source Control panel per Amendment 7 (commit box with
      agent-drafted **Generate**, **Commit**, **Review Working Changes**,
      changes list with status chips, read-only commit graph) — build the
      richer panel now, not a stub; it's the primary git surface.
- [ ] Add the Vibe-only session list panel per Amendment 3 (new thread,
      search, threads grouped by workspace, relative timestamps, live-dot
      indicator). Hidden in Editor preset.
- [ ] Rewrite Spec Mode copy everywhere it appears per Amendment 6 — lead
      with the Socratic interview, not the read-only restriction. Drop the
      standalone banner pill; the framing lives in the agent's first turn.
- [ ] Add the title-bar session-list toggle (Vibe preset only).
- [ ] Add the New Thread empty state (Spec/Go picker cards) per Amendment 3.

### Phase 7 — onboarding (Amendment 8)

- [ ] Build the first-run/no-project screen per `mockup-onboarding.html`:
      pitch copy from PRODUCT.md, composer input + directory row,
      executor-detection status pill, Open Project / Clone Repository
      cards, Recent Projects list.
- [ ] No account/tier UI anywhere on this screen — verify against
      PRODUCT.md's bring-your-own-agent principle before shipping any copy.
- [ ] No Vibe/Editor shell switch on this screen (v1 scope note in
      Amendment 8) — confirm it doesn't leak in from a shared layout
      component.

### Phase 8 — title-bar utility cluster (Amendment 9)

- [ ] Terminal toggle icon, wired to the same collapsed state as the
      bottom panel's own inline chevron (one state, two controls).
- [ ] Chat toggle icon, Editor preset only, collapses the chat rail.
- [ ] Theme toggle — apply `data-theme`/`color-scheme` to `<html>`, not a
      nested container (see Amendment 9's implementation note — this bit
      a screenshot-only verification pass during the mockup build; check
      computed styles, not just a render).

### Phase 2 — bottom panel

- [ ] Add the toggleable bottom panel (Terminal + Problems tabs).
- [ ] Relocate `TerminalPane.tsx` into the Terminal tab.
- [ ] Problems tab can ship empty/stubbed until Phase 4 (LSP diagnostics)
      lands — build the shell now so Phase 4 has a home to write into.

### Phase 3 — run commands (Amendment 1)

- [ ] `run` field on `ProjectSettings` (`HashMap<String, String>`),
      `#[serde(default)]` for backward compat.
- [ ] Project-file detection for the onboarding default (package.json /
      Cargo.toml / pyproject.toml / Makefile) — propose, never auto-write.
- [ ] Title-bar split button: primary = last-used, dropdown = all
      configured commands.
- [ ] Run rail icon: full config CRUD.
- [ ] IPC command to write to terminal PTY; register in `lib.rs`; TS
      wrapper in `api.ts`. (Three-edit rule from CLAUDE.md — don't miss
      the `api.ts` wrapper.)
- [ ] Output lands in the Phase 2 Terminal tab.

### Phase 4 — LSP integration (Amendment 2)

- [ ] `src-tauri/src/lsp.rs`: process management, stdio transport, per the
      existing `lsp-integration/design.md` (unchanged architecture).
- [ ] WebSocket bridge via Tauri WebSocket plugin.
- [ ] `@codemirror/lsp-client` wired into `FileEditorPane.tsx`.
- [ ] Status bar language indicator: clickable, shows server state
      (running/starting/crashed/disabled-after-3-crashes/not-installed).
- [ ] Problems tab (Phase 2's stub) now populated from LSP diagnostics.
- [ ] Verify D14's failure handling end-to-end: force a crash, confirm
      restart-with-backoff, confirm disable-after-3 surfaces in the status
      bar, confirm editor keeps basic syntax highlighting throughout.

### Phase 5 — FIM visibility (Amendment 4)

- [ ] Status bar icon next to the LSP indicator, on/off state, click
      toggles via the existing `api.setCompletionEnabled` path.
- [ ] No changes to `GhostTextPlugin.ts`'s model/debounce/scoring logic.

### Phase 6 — executor-switch fix (Amendment 5)

- [ ] Persistent, dismissible banner in the chat area (not the menu) when
      switching agents during a live session.
- [ ] Verify it does _not_ appear when switching with no live session
      (that path already works and needs no extra UI).

## UI/UX Quality Gate — run this loop, not just `tsc`/`cargo test`

Passing type-check and unit tests proves the code compiles and individual
functions behave; it does not prove the shell looks or feels right. Run
this loop after each phase, and again fully before declaring the redesign
done. Do not skip steps because "it obviously works" — the whole reason
this document exists is that the previous shell drifted from its own
mockup without anyone noticing until an audit caught it.

1. **Build and launch**: `pnpm install` if needed, then `pnpm start` in the
   background, wait for `WebSocket server listening on: 127.0.0.1:9223` in
   the log.
2. **Connect**: Tauri MCP `driver_session` (start), confirm with a
   screenshot that the window actually rendered — don't skip looking at it.
3. **Screenshot both shell presets** (Vibe, Editor) and place them
   side-by-side against `mockup.html`'s two states (open it in a regular
   browser tab, or screenshot it via any browser tool). For each
   discrepancy, decide: intentional deviation (note why in a comment) or
   drift (fix it). Do not let "close enough" pass silently — this is
   exactly how the shell drifted the first time.
4. **Panel parity check**: click every left-rail icon from Vibe mode, then
   every left-rail icon from Editor mode. Same 9 panels, same content, in
   both. Any panel visible in one shell and not the other is a Governing
   Rule violation — stop and fix before continuing.
5. **State-preservation check**: open a file, select a thread, expand the
   bottom panel, then toggle Vibe ↔ Editor. Confirm nothing resets or
   flashes empty. Screenshot before/after.
6. **First-time-user walk**: pretend you have never seen this app. Cold
   start → add a project → first thread → Spec mode → Go mode → open
   Settings. At each step, could someone who has never heard of "ACP",
   "executor", or "flight" understand what's happening? Note any jargon
   surfaced in UI copy (not code) and flag it — don't silently rewrite
   product copy without noting the change.
7. **Bug-specific repro** (Amendment 5): start a Go-mode session, let it go
   busy, switch the executor mid-session, confirm the persistent banner
   appears and survives the menu closing. Switch executor with no live
   session running, confirm no banner (that path was already fine).
8. **Failure-mode check** (Phase 4 only): force an LSP server crash 3
   times, confirm the status bar reaches "disabled" state with a visible
   reason, confirm the editor still has basic syntax highlighting.
9. **Regression pass**: `pnpm test`, `npx tsc --noEmit`,
   `cd src-tauri && cargo test`. All must pass — this is necessary, just
   not sufficient on its own.
10. **Close the loop**: if any step in 3–8 found a real drift (not a noted
    intentional deviation), fix it and re-run steps 3–8 before moving on.
    Do not proceed to the next phase with a known, unfixed visual/UX
    discrepancy — record it as a rejected-alternative-style note in this
    file if you deliberately chose not to fix it, so the next reader
    (human or agent) knows it was a decision, not an oversight.

## User Personas — Quality Gate

The loop above catches drift from _this document_. It cannot catch "this is
technically correct and still confusing to a real person," because you
wrote the document — you can't audit your own blind spots with your own
checklist. That's what this gate is for: five fixed personas, each a
`general-purpose` sub-agent briefed with a distinct background and a
distinct thing they're primed to notice, reviewing the _built and running_
shell (drive it live via the Tauri MCP bridge, per the loop above — not the
static `mockup.html`, which only proves layout, not behavior). Run this
after Phase 6 is complete and the UI/UX Quality Gate above is clean.

### The personas

Spawn each as a separate sub-agent. Give each the _same_ briefing shape:
who they are, what they've used before, what they're trying to do right
now, and the one question to answer at the end: **"Would you switch to
this over what you use today — and if not, what's the first thing that
stopped you?"** Do not let a persona's context bleed into another's; each
should form an independent first impression, the way a real trial user
would.

1. **The Cursor Refugee** — a power user shipping production code daily in
   Cursor, deeply used to instant model switching, VS Code muscle memory,
   and best-in-class ghost-text completion. Task: open a project, switch
   models mid-thread, accept a few FIM completions, run a command. Judges
   on speed and whether anything feels like a downgrade from Cursor.
   Satisfied when: model/agent switching is at least as fast and legible
   as Cursor's, FIM visibility (Amendment 4) registers as a plus not a
   gimmick.
2. **The Kiro Convert** — came from Kiro specifically for spec-driven
   development, distrusts tools that generate code without a plan first.
   Task: start a new thread, pick Spec Mode, and try to get the agent to
   just write code without asking questions (a stress test, not a happy
   path). Satisfied when: Spec Mode visibly interviews before proposing
   anything (Amendment 6), and refuses to skip straight to code the way a
   restriction-framed "read-only mode" would silently allow by omission.
3. **The First-Timer** — has never used an agent-driven IDE, doesn't know
   what "executor," "ACP," or "flight" mean, and will not read a manual.
   Task: cold start through first successful thread with zero prior
   context, narrating confusion out loud. Satisfied when: no unexplained
   jargon blocks a first action, and the Vibe-mode session list / chat
   surface is self-explanatory without a tooltip.
4. **The Keyboard Purist** — a Zed user who treats the mouse as a last
   resort, cares about focus rings, tab order, and whether every action
   has a keyboard path. Task: open a file, switch shells, open the Source
   Control panel, and commit — without touching the mouse. Satisfied when:
   every interactive element in the new left rail, session list, and
   Source Control panel is reachable and operable by keyboard alone, with
   a visible focus ring at each step (DESIGN.md's global focus-ring rule).
5. **The Skeptical Reviewer** — a senior engineer who lives in diffs and
   commit graphs, joining specifically to evaluate whether Palisade's git
   workflow is trustworthy enough to replace their terminal habit. Task:
   make a change, review it in the Source Control panel, use Generate for
   a commit message, commit. Satisfied when: the commit graph, status
   chips, and Generate/Review actions (Amendment 7) feel accurate and
   trustworthy enough that they wouldn't double-check the terminal after.

### The loop

1. Build (or resume) the shell per the task list above through at least
   Phase 6.
2. Spawn all five personas in parallel against the live, running app.
   Each returns: satisfied (yes/no) and, if no, the single first blocking
   issue — not a wishlist. Cap each persona's report at the one thing that
   actually stopped them, per the ADHD-formatting instinct of this repo's
   own tooling: a ranked single blocker beats an unranked list of five.
3. Fix the blockers. Re-run the UI/UX Quality Gate for anything touched.
4. Re-spawn only the personas who were previously unsatisfied — don't
   re-run a persona that already passed, that's wasted budget.
5. Repeat until all five report satisfied **and** `impeccable detect`
   is clean on every changed UI file **and** `/ponytail-audit` has run
   with its findings resolved. All three gates, not any one of them, is
   what "done" means for this redesign.

## Open questions (flag, don't guess)

- Title-bar "Auto" dropdown's actual purpose — unresolved, out of scope
  for this redesign (see rejected-elements table).
- Whether mid-session executor handoff should ever become immediate rather
  than next-session-only — explicitly deferred, see `MEGA_PROMPT.md`
  Amendment 5's out-of-scope note.

## Implementation notes — deliberate deviations from `mockup.html`

Recorded per the UI/UX Quality Gate's step 10, so the next reader knows
these were decisions, not drift.

- **Status bar omits `Spaces: 4 · UTF-8 · LF`.** The mockup's right-hand
  cluster shows indent width, encoding and line endings. Palisade tracks none
  of these — there is no indent setting, no encoding selector, and no
  line-ending conversion. Rendering them would be three fabricated facts
  on a bar whose entire job is reporting real state. `Ln, Col` is shown
  because it _is_ real, and the LSP/FIM indicators are the two the
  amendments actually asked for.
- **`SPEC`/`GO` are the only thread-tab badges.** The mockup also showed
  `PLAN` and `CHAT`; MEGA_PROMPT's out-of-scope list already rules those
  out as a mockup fabrication, and CLAUDE.md fixes the mode set at two.
- **The Settings rail icon opens the existing Settings modal**, not a
  tenth side panel. It is the ninth rail icon as specified; only its
  surface differs, and duplicating Settings into a panel would have meant
  two settings UIs.
- **LSP transport is Tauri IPC, not a WebSocket bridge** — see
  `openspec/changes/lsp-integration/decisions.md` for the full rationale.

> > > > > > > shell-redesign-and-mvp-finalization
