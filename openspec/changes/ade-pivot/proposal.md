## Why

Every ACP-agent shell on the market today (Orca, Emdash, Superset, Conductor, Nimbalyst, AO) converges on the same shape: spawn a CLI agent, give it a worktree, show a diff. Palisade already has the pieces to do more — per-thread worktrees, a verify command that gates merge on recorded evidence rather than agent narration, ACP-any-agent support, and multi-agent chains — but the shell still presents itself as a chat-first IDE with those pieces scattered across panels. A user running several agents at once has no single place to see which threads need attention, and no dedicated place to review a thread's output against its verify evidence before merging it.

This change repositions Palisade as an Agentic Development Environment (ADE): a shell built around running several agents in parallel, reviewing their output, and gating merge on verification, with the existing editor/terminal/run/debug/database/notebook/preview tools demoted to a supporting "Workbench" rather than removed. Nothing that exists today is deleted by this change; it is re-centered around a fleet board and a review lane.

## What Changes

- Home becomes a fleet board: every thread/worktree in the project, grouped by status (attention / running / idle), with agent, diff stat, verify evidence, merge readiness, and cross-thread file overlap visible at a glance.
- A dedicated review lane pairs a thread's diff with per-file viewed state and its verify evidence; merge is enabled only on a green verify at that commit, or an explicit human override.
- The Vibe/Editor shell-mode toggle is removed. Editor, terminal, run/debug, database, notebooks, and preview remain reachable from the rail and from any diff/explorer file click, grouped under "Workbench" and demoted in priority rather than removed.
- Chains are renamed Playbooks and launch from the fleet board; a playbook run appears as a fleet row like any other thread. The canvas editor is unchanged. Scheduling and event triggers remain out of scope.
- The MCP panel becomes Connections, with tabs for Agents (registry/installed/sign-in/usage), MCP servers, and Skills (read-only).
- Graphify / Codebase Map is removed entirely (handled by a separate, parallel change; this proposal only stops referencing it in positioning copy).
- **BREAKING**: the Vibe/Editor mode toggle's associated UI and default-view behavior go away; opening a project lands on the fleet board instead of a thread or the Editor shell.

## Capabilities

### New Capabilities
- `fleet-board`: the project home view listing every thread's status, agent, diff stat, verify evidence, merge readiness, and cross-thread file overlap, with actions to open/review/stop/merge/archive a thread and a composer to start a new one.
- `review-lane`: per-thread diff review combining inline/side-by-side diff, persisted per-file viewed state, a verify evidence strip, and a merge gate.

### Modified Capabilities
- `workspace-shell-toggle`: removes the Vibe/Editor mode toggle; Workbench tools (editor, terminal, run/debug, database, notebooks, preview) are reached from the rail and from diff/explorer file clicks instead of a shell-wide mode switch.
- `agent-chain-builder`: renames chains to Playbooks, launched from the fleet board; a playbook run is represented as a fleet row with the same status/diff/verify signals as any other thread.

## Impact

- **Frontend**: `src/FleetBoard.tsx` (new), `src/ReviewPane.tsx` (new), `src/NavRail.tsx` (rail groups: Fleet, Review, Playbooks, Connections, Specs, Workbench), `src/App.tsx` (routing/default view), `src/SessionList.tsx` (row signals), `PRODUCT.md`, `README.md`, `DESIGN.md`, `src/OnboardingScreen.tsx`.
- **Backend**: `src-tauri/src/fleet.rs` (new IPC for fleet overview), `src-tauri/src/lib.rs` (command registration), `src/api.ts` (typed wrapper).
- **No new external dependencies.**
- This proposal (`ade-pivot`) covers positioning and the full pivot's plan; positioning artifacts (`PRODUCT.md`, `README.md`, `DESIGN.md`, `OnboardingScreen.tsx`) are updated by this same change. Fleet backend, fleet board UI, review lane, and sidebar/header signal work are separate implementation passes against this proposal's spec deltas and tasks.
