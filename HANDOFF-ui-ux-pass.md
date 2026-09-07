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

## 4. Remaining work

1. **Native New Project / Clone folder picker under Tauri MCP.** At 900×600,
   entering a clone URL opens the native folder picker, wedges the bridge, and
   the debug app panics with `unexpected NULL returned from +[NSOpenPanel
   openPanel]`. The picker is not available to this automation environment, so
   this needs a manual macOS reproduction before changing the dialog layer.
2. **Claude Agent completion and queued-message delivery.** The UI reaches the
   spec primer with Claude Agent + Sonnet, then the adapter reports expired
   OAuth which cannot refresh. Re-authenticate outside this pass and rerun an
   agent-backed turn before treating these flows as end-to-end verified.
3. **Data-dependent panels received a shallow pass.** The disposable audit
   project had no populated spec, review diff, database connection, graph, or
   chain. Their empty states and entry controls were exercised at 1440×900 and
   900×600; populated interactions still need project data.

**Separate, not UI:** `terminal::tests::terminate_kills_background_children_not_just_the_shell`
remains a known PTY timing flake. Rerun it once if it fails during the final gate.

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

---

## Terra handoff — Phase 1 backlog (uncommitted)

Resolved all eight scoped items:

1. Added `src/projectSettings.ts`, the single guarded read-merge-write path for
   appearance and verify-pin changes. Missing and blank files become `{}`;
   malformed non-empty JSON throws before writing; every write supplies the
   content read as `expectedPrevious`.
2. Mapped Mantine dark-7/6/5/4 to `--bg`, `--surface`, `--surface-warm`, and
   `--border` in `src/main.tsx`.
3. At the sub-820px scope, kept the contained fix to the recent-project rows:
   a fixed two-line rhythm plus ellipsized path preserves the full path in the
   row tooltip without uneven list heights. The spec primer's line height is
   tightened slightly for the same narrow column.
4. Removed unused `RightTab`, `rightTab`, and `setRightTab` from
   `src/hooks/useAppShell.ts`; `rg` now finds no readers.
5. Recent project paths no longer wrap the rows unevenly.
6. Primer copy remains unchanged; spacing was tightened only.
7. A successful text-editor save of a repaired `.ipynb` clears that path from
   `unopenableNotebooks`, allowing the next render to return to notebook mode.
8. Set the chat tool badge text floor to 10px, so `TERMINAL` is legible.

Files changed: `src/projectSettings.ts`, `src/SettingsPanel.tsx`,
`src/App.tsx`, `src/main.tsx`, `src/hooks/useAppShell.ts`,
`src/App.css`, `src/EventView.tsx`, and focused frontend tests.

Targeted validation passed: `npx vitest run src/__tests__/projectSettings.test.ts
src/__tests__/SettingsPanel.test.tsx src/__tests__/App.test.tsx
src/__tests__/EventView.test.tsx src/__tests__/OnboardingScreen.test.tsx`
(237 tests) and `npx tsc --noEmit`. No full test gate, Rust tests, packaging,
or commit was run.

Visual verification still for Astra: inspect the Mantine Menu/Popover dark
surfaces, onboarding rows with long paths, and the spec primer below 820px.
I attempted the local Tauri launch, but the existing localhost Vite port was
occupied and the already-running installed app displayed a blank workbench, so
there is no fresh live screenshot from this pass. No other uncertainty found.
