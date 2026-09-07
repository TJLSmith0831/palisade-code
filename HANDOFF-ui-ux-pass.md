# Handoff: beta-feedback pass + UI/UX hardening

**Branch:** `codex/astra-pass` · **For:** Astra, to review and finish the final polish pass
**State:** all green — 913 frontend tests (61 files), 686 Rust tests, `tsc --noEmit` clean.

Every fix below was written test-first: a failing test that reproduces the bug,
then the fix. Nothing here is "believed to work" — the counts above are from a
full run of both suites after the last edit.

---

## 1. What's done

### Beta-feedback issues (all 9 closed)

| # | Title | Fix |
|---|---|---|
| 26 | Add message queues | `src/hooks/useMessageQueue.ts` — FIFO per-thread outbox. Enter or the new queue button holds a mid-turn message; it sends when the turn ends. A failed send keeps the row with its error and stops that thread's queue until the user retries. |
| 27 | Preview SKILL pre-installed | Astra's (`src-tauri/skills/palisade-preview.md`, prepended in `send_acp_prompt`). Verified, not re-done. |
| 28 | Project delete | `store::remove_project` + `project_windows::remove_saved_project` (refuses while a turn is running) + a confirm dialog that says files and history stay on disk. |
| 30 | Spec mode → "Untitled Thread" | Root cause: `spec_mode` never called *any* titling path, so a spec thread stayed at its placeholder forever. It now runs the same chain every other thread uses — agent title → local model → truncated first request. |
| 31 | Right panel opens on send | Astra's (removed the rising-edge diff-open effect). Verified. |
| 32 | Mentions for chat | New `src/mentions.ts` + an `@` file menu sharing the `/` menu's shape. Opens mid-sentence, ignores email addresses and npm scopes. |
| 33 | Multiple workspaces | Backend + `?project=<hash>` boot + focus-an-open-window + ⌘-click. See §2. |
| 34 | Settings pane broken | Astra's (global vs project appearance scope, reset, save errors). Verified. |
| 35 | Spec mode clunky | Rebuilt. See §3. |

### Bugs found by driving the app, not in any issue

1. **Concurrent windows corrupted `projects.json`.** `fs::write` truncates before
   writing, so a second window reading mid-write got `EOF while parsing`.
   `write_json` is now write-then-rename, and the index's read-modify-write is
   behind a process lock. (`store.rs`)
2. **A second project window killed the first one's file watcher.**
   `harness.watch` / `harness.fswatch` were single slots. Now keyed by project
   hash, tracked per window, retired when the last window showing a project
   closes. Without this, multi-window shipped with silent stale file trees.
3. **`@rea` offered three 64-character graphify cache files.** Palisade's own
   generated output was hidden only via `git check-ignore`, so a project that
   isn't a git repo leaked it into every picker. `GRAPH_DIR` is now in
   `should_skip_entry`. Also added `scorePath` (filename hits outrank hits
   scattered through directories) — ⌘P shares it.
4. **The framing menu was two copies of the same ~90 lines.** #35 was reported
   against one of them and was present in both. Extracted to one `specTypeMenu`.
5. **The picker clipped its own content.** `justify-content: center` on an
   overflowing flex column clips at *both* ends and drops end padding — the
   heading lost its top and the Back button was sliced in half. Now auto-margin
   centering + `overflow-y: auto`.
6. **Framing cards clipped mid-word** ("Featur", "Diagnos") in a narrow chat
   column. `flex: 1 1 130px` + `flex-wrap: wrap` — they stack instead.
7. **"Move terminal to the sidebar" was a trap.** It set a right-panel tab
   nothing has rendered since Amendment 3, so it collapsed the terminal into
   nowhere — and the button that would undo it lived inside the panel it had
   just hidden. Removed, along with the whole `terminalPlacement` machinery.
8. **The session-list toggle was inert below 1180px.** A media query hid the
   column unconditionally, so on a small laptop the button flipped state a
   stylesheet then overrode and there was no way back to the thread list. The
   fold is now the default; an explicit toggle wins (`data-user-opened`).

---

## 2. Multi-window: conventions taken from other IDEs

Researched before implementing, at the user's request:

- **VS Code:** opening a project already open **focuses that window** instead of
  duplicating it. Implemented via the window→project map.
- **VS Code:** **⌘/Ctrl-click** a recent project opens it in a new window.
  Implemented, and ⌘-Enter does the same from the keyboard (`onActivateKey` now
  forwards the event).
- **JetBrains:** the recents context menu is *Open in New Window* +
  *Remove from Recent Projects*. Adopted, including the wording — it is exactly
  what the action does.

**Deliberately not adopted:** VS Code's multi-root workspace (several folders in
*one* window). Different feature from #33, and Palisade's session/thread model is
per-project.

---

## 3. Spec mode (#35), rebuilt around Kiro's model

The user's clarification: the framing cards exist for **pre-wired prompt
guidance that accompanies the user's own request** — Kiro's shape, where you
select Spec and then *describe the work*.

**Before:** pressing Feature immediately fired an agent turn whose entire body
was `Start exploring the following concept: Feature`. A real run in this session
came back with *"The topic is literally 'Feature.' Nothing to explore."* — the
agent's own words. That is the bug, verbatim.

**Now:**
- A card **selects a framing**; it starts nothing.
- One required request field per framing, each with its own label and example
  ("What do you want to build?" / "What's going wrong?" / "What should this spec
  cover?").
- `Start spec` is disabled until there is text. Enter starts, Shift+Enter newlines,
  and the field says so.
- `framing_guidance()` supplies the per-framing questions (Feature: outcome, who
  for, out of scope. Bugfix: observed vs expected, reproduction, root cause not
  symptom). **A framing the user typed themselves gets no invented guidance** —
  Palisade cannot know what questions it implies.
- `spec_mode` takes `description`; it becomes the visible user message and the
  thread's name, through the normal titling chain.
- While the first turn is in flight, a **primer** replaces the bare "working"
  line: what is starting, that the agent asks one question at a time, that
  nothing changes until the user approves. It clears the moment the agent
  produces anything.

The "Other" path specifically (what #35 was reported against) had: a one-line
input sized to its own placeholder, **no submit control at all** (Enter was the
only way forward and nothing said so), the three cards blanked so the screen lost
its context, and two back buttons with no forward button. Zero test coverage.
All fixed; three tests now cover it.

---

## 4. What I did NOT fix — the polish backlog

Ranked. Items 1–2 are the ones I'd do first.

1. **Mantine's dark ramp was never repainted, so every popover surface is off
   palette.** A `Menu` dropdown computes to `rgb(46,46,46)` with a
   `rgb(66,66,66)` border, because in dark scheme Mantine draws popovers from
   `--mantine-color-dark-6` (`#2e2e2e`) and `--mantine-color-dark-4`
   (`#424242`) rather than from the `--mantine-color-default` family the
   resolver overrides. Map the ramp's surface stops onto the shell's tokens in
   `shellTokens` in `src/main.tsx` — dark-7 to `--bg`, dark-6 to `--surface`,
   dark-5 to `--surface-warm`, dark-4 to `--border`. Left undone deliberately:
   the ramp backs every Mantine surface in the app, so it needs the visual
   sweep that is Phase 2 of this brief, not a blind remap at the end of a
   session.
2. **Sizes below 820px are unswept.** I covered 1600×1000, 1440×900, 1100×620,
   1000×700 and 900×560. The `max-width: 820px` breakpoint (`.ds-side-panel`
   hides) was never exercised.
3. **Dead state in `useAppShell`:** `rightTab` / `setRightTab` are now written
   nowhere and read nowhere — I removed their last real writer. Safe deletion,
   plus the `RightTab` type's `"terminal"` member.
4. **Onboarding recent-project rows have uneven heights** when a long path wraps
   to two lines, so the list reads ragged. Cosmetic.
5. **The spec primer's copy and spacing were only reviewed at 1440×900.**

**Separate, not UI:**
- `terminal::tests::terminate_kills_background_children_not_just_the_shell` is
  **flaky** — failed once, passed on rerun and on every run since. PTY timing,
  unrelated to this branch.
- Issue #8 is live: I counted five orphaned `llama-server` sidecars from earlier
  runs still resident during this session.

---

## 5. How to verify

```bash
pnpm test && npx tsc --noEmit && (cd src-tauri && cargo test)
```

To drive it: `pnpm start`, then the Tauri MCP on `127.0.0.1:9223`
(`.agents/skills/run-palisade-code/SKILL.md`). The flows worth re-driving are
the spec framing menu at several window sizes, the `@` menu in a non-git
project, and two project windows open at once.

**One caveat on my own live testing:** the Claude agent in this environment could
not refresh its OAuth token (another Claude Code process — this session — held
it), so I never saw a spec interview run to completion in the real app. Every
spec-mode change is covered by tests and by driving the UI up to the agent
boundary; the agent's side of that conversation is unverified end-to-end.
