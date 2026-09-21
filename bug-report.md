# PR #55 Dogfood Bug Report

| Field | Value |
| --- | --- |
| Date | 2026-09-21 |
| App | Palisade Code Tauri dev window |
| Scope | Every user-actionable seam added or materially changed by PR #55 |

## Checklist

- [x] No confirmed, user-reachable defects found in the exercised PR #55 seams.

## User-actionable seams

- [x] Fleet: project header, status groups, start-run composer (Codex 5.6 Luna, Spec/Go, isolation), rows and action menus.
- [x] Review: review-run list, run selection, split/inline diff, and back navigation.
- [x] Thread shell: Fleet return, Agent Access panel, rail collapse/restore, editor mutual-exclusion guard, Cmd+Shift+J, and Cmd+K.
- [x] Specs: full-row open, validation state, and refresh.
- [x] Playbooks: run history, archive/unarchive, show/hide archived, and overflow actions.
- [x] Connections: refresh and reported usage states.
- [x] Setup/nav: regrouped navigation rail, Workspace project selection, Run panel, and Go to file affordance.
- [x] Worktree/diff/time: isolated/project-root selection, merge-target/readiness treatment, and compact created/active time rendering.

## Confirmed issues

None. The initially suspicious `invalid` Specs badge was reproduced and traced: it is the intentional, tooltip-explained result of `openspec validate` failing for the existing Signalboard fixture, not an application defect.

Screenshots from the real Tauri pass are retained locally and intentionally excluded from the repository.

## Not exercised without user authorization

- Agent sign-in, because it opens or changes an external account session.
- Starting/re-running a fleet or playbook agent, merging, opening a PR, and running configured commands, because each can alter Signalboard or external GitHub state.
