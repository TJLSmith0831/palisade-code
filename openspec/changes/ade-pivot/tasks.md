## 1. Positioning + spec (this change)

- [x] 1.1 Rewrite `PRODUCT.md` Product Purpose and Positioning sections around the ADE category; remove Graphify references; rename Chains to Playbooks in prose.
- [x] 1.2 Update `README.md` intro paragraph and "How it works" feature bullets for the ADE framing; drop the stale Graphify reference in Project layout.
- [x] 1.3 Update `DESIGN.md` frontmatter `description:` line for the ADE framing.
- [x] 1.4 Update `src/OnboardingScreen.tsx` user-visible copy for the ADE framing (no structural change).
- [x] 1.5 Write `openspec/changes/ade-pivot/{proposal,design,tasks}.md` and spec deltas; `openspec validate ade-pivot --json` passes.

## 2. Fleet backend

- [x] 2.1 Add `fleet_overview` IPC command in `src-tauri/src/fleet.rs` returning, per thread: status (idle/running/attention), agent, project, branch, worktree, diff stat (+/-/files), files touched, last verify (pass/fail/not-run, cmd, commit), merge readiness, and overlap (files touched by 2+ live threads in the same project).
- [x] 2.2 Register the command in `generate_handler!` (`lib.rs`) and add a typed wrapper in `src/api.ts`.
- [x] 2.3 `cd src-tauri && cargo test fleet::` green.

## 3. Fleet board UI

- [x] 3.1 Build `src/FleetBoard.tsx` as the home view, grouped Needs attention / Running / Idle, with row fields (agent glyph, title, project·branch, diff stat, verify badge, overlap warning) and actions (Open/Review/Stop/Merge/PR/Archive).
- [x] 3.2 Add a "New run" composer (prompt + agent + mode + isolated worktree in one step).
- [x] 3.3 Update `NavRail.tsx` to put Fleet first and group IDE panels under Workbench; update `App.tsx` routing/default panel and `App.css` as needed.
- [x] 3.4 `npx vitest run src/__tests__/FleetBoard.test.tsx` green; app boots to Fleet.

## 4. Review lane

- [x] 4.1 Build `src/ReviewPane.tsx` composing `DiffPane` (inline/side-by-side) with per-file Viewed state persisted per thread.
- [x] 4.2 Add a verify evidence strip and a `MergeGate` action; Merge enabled only on a green verify or an explicit override.
- [x] 4.3 Add j/k file navigation; wire `App.tsx` and `api.ts` if Viewed-state persistence needs IPC.
- [x] 4.4 `npx vitest run src/__tests__/ReviewPane.test.tsx` green.

## 5. Sidebar + thread header

- [x] 5.1 Update `SessionList.tsx` rows: 3-state dot, diff stat, agent glyph, overlap badge, grouped by status.
- [x] 5.2 Update the open thread's header in `App.tsx` to show branch + verify badge.
- [x] 5.3 `npx vitest run src/__tests__/SessionList.test.tsx` green.

## 6. Gate + after-screenshots + PR

- [x] 6.1 Run `pnpm test`, `cd src-tauri && cargo test`, `npx tsc --noEmit`.
- [x] 6.2 Run the app; capture an after-screenshot set matching `docs/pr/ade-pivot/before/*.png`.
- [x] 6.3 Commit before/after screenshot sets to `docs/pr/ade-pivot/`.
- [x] 6.4 Open the PR with a before/after table; record the PR URL.
