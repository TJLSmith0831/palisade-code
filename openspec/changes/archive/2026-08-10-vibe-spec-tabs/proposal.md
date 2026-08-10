## Why

The Vibe shell is chat-first, but a thread in `spec` mode has no way to view its linked OpenSpec change without switching to the Editor shell. That breaks the spec→build loop: the user leaves the conversational context just to read `proposal.md`, check task progress, or see verification results. This change brings OpenSpec changes into the Vibe shell as first-class editor tabs, the same way files and diffs already live in the files column.

## What Changes

- Add a compact **Specs** launcher to the Vibe shell's right sidebar, listing the project's OpenSpec changes with status and a mini progress bar.
- Clicking a spec in the launcher, or the linked-change chip in the chat header, opens that change as a **rounded-pill editor tab** in the Vibe files column.
- A spec tab renders as a read-only structured view with **inner tabs** for Proposal, Design, Spec, Tasks, and Verify — one tab per change, not one tab per artifact.
- The **Tasks** inner tab shows the OpenSpec task checklist (agent-reported) and, if the user has pinned a verify command, a primary **Run verify** button.
- The **Verify** inner tab shows the project-wide verify commands and their latest runs, reusing the same data as `VerifyPane`.
- Verify-pins are stored in `.project-settings.json` keyed by spec change name, so they persist without writing spec files.
- The existing Editor shell `SpecPane` is left unchanged.

## Capabilities

### New Capabilities
- `vibe-spec-tabs`: surfacing OpenSpec changes as editor tabs in the Vibe shell, with a sidebar launcher and inner artifact tabs.

### Modified Capabilities
<!-- none — no existing spec requirement changes; the Editor shell SpecPane stays as-is -->

## Impact

- `src/App.tsx`: new "Specs" section in the Vibe right sidebar; updated tab-handling to support spec tabs alongside file tabs; linked-change chip becomes clickable.
- `src/openTabs.ts` and `src/TabBar.tsx`: extend `OpenTab` to support a `specName` alternative to `path`, or create a separate `SpecTab` concept.
- New/updated component: a read-only `SpecChangeTab` for rendering `openspec show` output with inner artifact tabs.
- `src/settings.ts` and `src-tauri/src/settings.rs`: add `verifyPins` field to `.project-settings.json` schema and persistence.
- Reuses `api.listSpecChanges`, `api.showSpecChange`, `api.validateSpecChanges`, `api.listVerifications`, and `api.runVerify`; no new backend IPC commands.
