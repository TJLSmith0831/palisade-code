# Brooks-Lint Review

**Mode:** PR Review
**Scope:** PR #111 against main; sampled review focused on all seven changed production/test files: `src-tauri/src/git.rs`, `src-tauri/src/commands/git_cmds.rs`, `src-tauri/src/lib.rs`, `src/api.ts`, `src/SourceControlPanel.tsx`, `src/App.css`, and `src/__tests__/SourceControlPanel.test.tsx`. Also traced the existing DiffPane discard caller and tests.
**Health Score:** 100/100
**Trend:** First run — no trend data for this PR.

Approve within the reviewed scope: no remaining actionable Brooks findings after the fixes and regression checks.

## Findings

No remaining Critical, Warning, or Suggestion findings. All six production decay risks and the three Quick Test Check signals were evaluated. The IPC command adapters and serialized stash record are intentional boundary glue/DTOs; their shape does not warrant additional abstraction. The keyed panel owns target-specific state and prevents confirmations from crossing working trees or branches.

## Resolved findings

### Domain Model Distortion — positional stash names are not identity

Symptom: apply/pop/drop accepted only `stash@{N}`, which changes meaning when another stash is added or removed.
Source: *Domain-Driven Design* — Entity identity and lifecycle.
Consequence: a stale row could restore or delete different saved work.
Remedy: return the commit OID with each entry, reject a changed name/OID pair, apply the immutable OID, and recheck before deleting. Serialize stash mutations across app windows because worktrees share refs/stash. Regression tests preserve both entries when selectors shift and preserve the stash after a conflicting pop.

### Cognitive Overload — destructive discard trusted stale UI status

Symptom: untracked directories were removed recursively and the caller's old untracked flag authorized deletion.
Source: *Code Complete* — Defensive programming and validation at boundaries.
Consequence: ignored files or newly tracked work could be deleted; arbitrary paths were accepted.
Remedy: validate relative paths, use literal Git pathspecs, and delegate untracked deletion to `git clean -f -d`. Tests verify ignored-file preservation, tracked-file preservation, directory deletion, and unsafe-path rejection.

### Domain Model Distortion — destructive intent outlived its target

Symptom: Drop had no confirmation; discard dialogs persisted when their repository/working-tree target changed; repeated mutations had no pending guard.
Source: *Domain-Driven Design* — Invariant ownership; *The Mythical Man-Month* — Conceptual Integrity.
Consequence: a confirmation could affect a different target, and repeated operations could race index writes or remove more saved work than intended.
Remedy: confirm Drop, focus Cancel for destructive dialogs, key panel state by project/tree/branch, and guard pending mutations, including commit. Tests cover cancellation, target changes, deletion confirmation, and duplicate-action prevention.

### Cognitive Overload — errors obscured changed state

Symptom: refresh ran only after successful actions, and stash-list failures silently removed displayed entries.
Source: *Code Complete* — Error-handling discipline.
Consequence: conflicts or partial bulk discard left stale rows; failed reads made saved work appear missing.
Remedy: refresh after success or failure, report stash-list errors, retain last known entries, and disable tracked-only stash when only untracked files exist. Tests assert the resulting visible rows after conflicts and partial failures.

## Better UI

No actionable UI-polish findings remain in the changed controls. Drop uses the existing danger token, tooltips explain Apply/Pop/Delete, pending controls stay in place, stash row backgrounds do not imply a clickable row, modal corners account for child radius and padding, and press feedback uses `scale(0.96)` with an explicit 100ms transform transition. Reduced-motion and `data-static` opt-outs preserve static feedback. No dependencies were added.

Verification: the actual Tauri dev window displayed the stash list and clean working-tree state; opened Delete, observed Cancel focus and danger color, and cancelled without mutating the repository. Both stash creation entries were disabled on the clean tree. The confirmation had no active animations; modal transition duration is zero. Hover and focus were checked live. Pending and failure states were checked in component tests. A 10%-speed motion replay and a complete light-theme walkthrough were not performed.

**UI verdict:** Approve, with the stated visual-verification limits.

## Verification

- `pnpm test src/__tests__/SourceControlPanel.test.tsx src/__tests__/DiffPane.test.tsx`: 84 tests pass.
- `cargo test --lib git::tests -- --test-threads=1`: 57 tests pass.
- `pnpm build`: passes; existing bundle-size and mixed-import warnings remain.
- `git diff --check`: passes.

## Summary

The destructive paths now preserve ignored/tracked data, validate stash identity, confirm deletion, and refresh after failures. The PR exceeds 500 changed lines, a Change Propagation signal to consider when sizing future work; these files nevertheless form one coherent Git feature and its regression coverage, rather than unrelated responsibilities.

The score covers reviewed PR behavior, not the whole repository. The full unrelated test suites, release packaging, and notarization were skipped. The process-local stash lock does not coordinate other Git programs: avoid simultaneous external stash mutation during Pop/Drop, whose selector deletion still uses Git's ordinary reflog semantics.
