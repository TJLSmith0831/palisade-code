## 1. Spikes and validation

- [x] 1.1 Inspect the exact output of `api.showSpecChange` for an existing change and confirm whether it exposes structured proposal/design/spec/tasks/verify artifacts or only raw markdown.
- [x] 1.2 If `showSpecChange` is not structured, spike a frontend markdown parser or the `openspec` CLI extension needed to render the artifacts; record the chosen path in `decisions.md`.
- [x] 1.3 Verify `verifyPins` can be added to `.project-settings.json` without breaking `settings.rs` parsing.

## 2. Data and tab model

- [x] 2.1 Extend `OpenTab` in `src/openTabs.ts` to support `type: "file" | "spec"`, with `specName` on spec tabs and `path` on file tabs.
- [x] 2.2 Update `useOpenTabs` to allow `openSpec(specName: string)` and to keep `activePath`/`activeTab` polymorphic across file and spec tabs.
- [x] 2.3 Add `saveSession`/`loadSession` support for mixed tab lists; spec tabs serialize as `spec:<name>` so `coerce` can recover them.
- [x] 2.4 Add unit tests in `src/__tests__/openTabs.test.ts` for opening, closing, and cycling with mixed file/spec tabs.

## 3. Spec tab rendering

- [x] 3.1 Create `src/SpecChangeTab.tsx` with inner tabs for Proposal/Design/Spec/Tasks/Verify, rendered from `api.showSpecChange`.
- [x] 3.2 Implement the Tasks tab: task list from `tasks.md`, read-only, with an agent-reported disclaimer.
- [x] 3.3 Implement the Verify tab: project-wide configured commands and latest runs, reusing `VerifyPane` data and `api.runVerify`.
- [x] 3.4 Implement the Tasks "Run verify" primary action when `verifyPins[specName]` exists.
- [x] 3.5 Add `src/__tests__/SpecChangeTab.test.tsx` covering inner tab switching and verify button presence.

## 4. Sidebar launcher

- [x] 4.1 Create `src/VibeSpecLauncher.tsx`: compact Specs list for the Vibe right sidebar, using `api.listSpecChanges` and `api.validateSpecChanges`.
- [x] 4.2 Wire `VibeSpecLauncher` into the Vibe right sidebar in `src/App.tsx`, below Threads and above File Explorer.
- [x] 4.3 Make the linked-change chip in `ChatSurface` clickable to open the linked spec as a tab.

## 5. Tab strip and shell wiring

- [x] 5.1 Update `src/TabBar.tsx` to render spec tabs with a spec icon and change-name label, and to handle closing mixed tabs.
- [x] 5.2 Update the Vibe files column in `src/App.tsx` to switch between `FileEditorPane`/`DiffPane` and `SpecChangeTab` based on the active tab type.
- [x] 5.3 Add `src/__tests__/App.test.tsx` coverage for opening a spec tab from the launcher and from the linked-change chip.

## 6. Settings and persistence

- [x] 6.1 Add `verifyPins?: Record<string, string[]>` to the `.project-settings.json` schema in `src-tauri/src/settings.rs`.
- [x] 6.2 Expose `loadProjectSettings`/`saveProjectSettings` updates so the frontend can read and mutate `verifyPins`.
- [x] 6.3 Add an "Add pin" affordance in the Verify tab of `SpecChangeTab` and a way to remove pins.

## 7. Verification and polish

- [x] 7.1 Run `pnpm test` and `npx tsc --noEmit` for the frontend, and `cargo test` in `src-tauri`, fixing any regressions.
- [x] 7.2 Run `openspec validate --change vibe-spec-tabs` and fix any spec/delta formatting issues.
- [x] 7.3 Update the mockup HTML to reflect the final implementation if the visual details changed.
