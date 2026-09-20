//! What the Fleet board renders: one row per live thread, across every open
//! project.
//!
//! The rules live here rather than in the command so they are testable
//! without a Tauri app, a git repo or a running agent: `lib.rs`'s
//! `fleet_overview` gathers the facts (store records, git measurements, live
//! session state) and this module turns them into rows.

use serde::Serialize;
use std::path::Path;

/// The dot the board shows for a thread. `Attention` always carries a
/// reason — a board that says "look at this" without saying why is noise.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FleetStatus {
    Attention,
    Running,
    Idle,
}

/// What a row is: a thread someone is working in, or one run of a playbook.
/// The board renders both, and a playbook run is not a thread — it has a run
/// id, no branch and no merge story of its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FleetKind {
    Thread,
    Playbook,
}

/// Why a thread wants the user. Ordered by how blocked the work is: a
/// permission prompt has an agent literally stopped mid-turn, a finished turn
/// is only waiting to be read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FleetAttention {
    Permission,
    /// A playbook run is suspended at a human approval gate.
    Gate,
    TurnDone,
    VerifyFailed,
    MergeConflict,
    Crashed,
}

/// Evidence, not opinion: a spec is green because a named command exited 0 at
/// a named commit. `NotRun` is the honest default, never a quiet pass.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VerifyState {
    Pass,
    Fail,
    NotRun,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetVerify {
    pub state: VerifyState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    /// The commit the command ran at, so a pass can be matched to the tree it
    /// actually proves.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
}

impl FleetVerify {
    /// No verification has ever run for this thread.
    pub fn not_run() -> Self {
        Self { state: VerifyState::NotRun, command: None, commit: None, at: None }
    }
}

/// The newest verification that proves this thread's current clean commit.
/// A successful run from another checkout, an older commit, or any dirty tree
/// is history, not permission to merge what is on screen now.
pub fn current_verify(
    runs: &[crate::store::VerificationRun],
    thread_id: &str,
    current_head: Option<&str>,
    clean: bool,
) -> FleetVerify {
    let Some(head) = current_head.filter(|_| clean) else {
        return FleetVerify::not_run();
    };
    runs.iter()
        .filter(|run| {
            run.thread_id.as_deref() == Some(thread_id)
                && run.git_head.as_deref() == Some(head)
        })
        .max_by(|a, b| a.at.cmp(&b.at))
        .map(|run| FleetVerify {
            state: if run.exit_code == 0 { VerifyState::Pass } else { VerifyState::Fail },
            command: (!run.command.is_empty()).then(|| run.command.clone()),
            commit: run.git_head.clone(),
            at: Some(run.at.clone()),
        })
        .unwrap_or_else(FleetVerify::not_run)
}

/// How close this thread's branch is to landing. `Behind` is a measured
/// rev-list count, `Conflicts` a real trial merge — the same probes the merge
/// gate runs, so the board can never promise a merge git would refuse.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FleetMerge {
    Clean,
    Conflicts,
    Behind,
    NoWorktree,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetDiff {
    pub added: u32,
    pub removed: u32,
    /// Tracked files that differ from HEAD — `git diff --numstat` and nothing
    /// else, so `+a −r` and `n files` always describe the same measurement.
    pub files: u32,
    /// Files the thread created that git does not track yet, counted apart
    /// because they contribute no numstat lines.
    pub untracked: u32,
}

/// Another thread in the same project writing some of the same files.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetOverlap {
    pub thread_id: String,
    pub files: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetRow {
    pub kind: FleetKind,
    /// The thread, or — for a playbook row — the run id, so the board keys
    /// every row the same way.
    pub thread_id: String,
    /// Set on playbook rows only: the run this row is.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    /// Set on playbook rows only: the saved playbook the run came from.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub playbook_name: Option<String>,
    /// Set on playbook rows only: the prompt the run was seeded with, so a
    /// row says what this run was asked to do rather than only which playbook
    /// it replayed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seed: Option<String>,
    pub title: String,
    pub project_id: String,
    pub project_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_name: Option<String>,
    /// "spec" | "go" — the thread's intent, which is what the board filters on.
    pub mode: String,
    pub status: FleetStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attention: Option<FleetAttention>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree_path: Option<String>,
    pub diff: FleetDiff,
    pub files_touched: Vec<String>,
    pub overlap: Vec<FleetOverlap>,
    pub verify: FleetVerify,
    pub merge: FleetMerge,
    pub updated_at: String,
}

/// Everything status derivation looks at, gathered by the caller so this stays
/// a pure function of observed facts.
#[derive(Debug, Clone, Default)]
pub struct StatusInput {
    /// A live session is blocked on an unanswered Allow/Deny prompt.
    pub awaiting_permission: bool,
    /// A live session is mid-turn.
    pub busy: bool,
    /// At least one turn has run and ended.
    pub turn_ended: bool,
    pub has_diff: bool,
    /// The user has looked at the thread since that turn ended. Always false
    /// today — Palisade records no per-thread view time (see `fleet_overview`).
    pub viewed_since_turn: bool,
    /// The thread's most recent verification run failed.
    pub verify_failed: bool,
    pub merge_conflict: bool,
    /// The thread's last session ended `crashed`.
    pub crashed: bool,
}

/// Has the user looked at this thread since its last turn ended?
///
/// A thread that predates view tracking has no `last_viewed_at` at all.
/// Reading that absence as "never viewed" made every legacy thread shout
/// "Turn finished" forever, which is the opposite of a signal — so missing
/// tracking counts as viewed. Only a recorded view older than a recorded turn
/// end is evidence of something unread.
pub fn viewed_since_turn(last_viewed_at: Option<&str>, turn_ended_at: Option<&str>) -> bool {
    match (last_viewed_at, turn_ended_at) {
        // ISO timestamps compare lexically, same as everywhere else here.
        (Some(viewed), Some(ended)) => viewed >= ended,
        _ => true,
    }
}

/// Map observed session/worktree state onto the dot and its reason.
///
/// The order is the precedence: a paused agent outranks a running one, a
/// running one outranks anything waiting to be read, and a crash only shows
/// when nothing more actionable is true.
pub fn derive_status(input: &StatusInput) -> (FleetStatus, Option<FleetAttention>) {
    if input.awaiting_permission {
        return (FleetStatus::Attention, Some(FleetAttention::Permission));
    }
    if input.busy {
        return (FleetStatus::Running, None);
    }
    let attention = if input.turn_ended && input.has_diff && !input.viewed_since_turn {
        Some(FleetAttention::TurnDone)
    } else if input.verify_failed {
        Some(FleetAttention::VerifyFailed)
    } else if input.merge_conflict {
        Some(FleetAttention::MergeConflict)
    } else if input.crashed {
        Some(FleetAttention::Crashed)
    } else {
        None
    };
    match attention {
        Some(reason) => (FleetStatus::Attention, Some(reason)),
        None => (FleetStatus::Idle, None),
    }
}

/// What one playbook run's record says it is doing. Gathered by the caller
/// for the same reason `StatusInput` is: a pure function of observed facts.
#[derive(Debug, Clone, Copy, Default)]
pub struct PlaybookInput {
    /// The run is suspended at a human approval gate right now.
    pub awaiting_gate: bool,
    /// The run is over — it recorded an outcome, or no live run owns it any
    /// more, which is the same thing said the honest way.
    pub ended: bool,
    /// It ended as anything other than `Completed`: rejected, cancelled,
    /// timed out, interrupted by a restart.
    pub failed: bool,
}

/// Map a playbook run onto the same dot and reason a thread gets.
///
/// Same precedence shape as `derive_status`: a run waiting on a human
/// outranks one still moving, and only a finished run can be judged.
pub fn derive_playbook_status(input: &PlaybookInput) -> (FleetStatus, Option<FleetAttention>) {
    if input.awaiting_gate {
        return (FleetStatus::Attention, Some(FleetAttention::Gate));
    }
    if !input.ended {
        return (FleetStatus::Running, None);
    }
    if input.failed {
        return (FleetStatus::Attention, Some(FleetAttention::Crashed));
    }
    (FleetStatus::Idle, None)
}

/// One changed file in a thread's tree. The Review lane's row, and the unit
/// the board's counts are made of.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewFile {
    pub path: String,
    pub added: u32,
    pub removed: u32,
    /// "added" | "modified" | "deleted".
    pub status: String,
}

/// One untracked path git reported, with the two facts that decide whether it
/// is this thread's work at all.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UntrackedFile {
    pub path: String,
    pub lines: u32,
    /// Byte-identical to the same path in the project checkout: the thread
    /// inherited this file, it did not write it.
    pub inherited: bool,
}

/// What one thread's tree holds once the noise is gone.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ThreadChanges {
    pub files: Vec<ReviewFile>,
    pub added: u32,
    pub removed: u32,
    /// Numstat files only — what `n files` counts.
    pub tracked: u32,
    pub untracked: u32,
}

impl ThreadChanges {
    pub fn paths(&self) -> Vec<String> {
        self.files.iter().map(|f| f.path.clone()).collect()
    }
}

/// A path the file tree already hides is a path no thread authored: machine-
/// local state (`.palisade/`, `.mcp.json`, `.project-settings.json`, every
/// other dotfile) and build output (`node_modules/`, `target/`,
/// `__pycache__/`). Reuses the tree's own rule rather than restating it, so
/// the two can never drift.
pub fn is_skipped_path(path: &str) -> bool {
    path.split('/').any(|part| crate::commands::fs_ops::should_skip_entry(part, false))
}

/// Turn one tree's raw git output into what the board and the Review lane
/// both read. Pure on purpose: the two surfaces disagreeing about what a
/// thread changed is the bug this exists to prevent.
///
/// `status` is porcelain `(code, path)` pairs, used only to tell a deletion
/// from a modification — numstat cannot.
pub fn changed_files(
    numstat: &str,
    status: &[(String, String)],
    untracked: &[UntrackedFile],
) -> ThreadChanges {
    let mut out = ThreadChanges::default();
    for line in numstat.lines() {
        let mut cols = line.split('\t');
        let (Some(a), Some(r), Some(path)) = (cols.next(), cols.next(), cols.next()) else {
            continue;
        };
        if is_skipped_path(path) {
            continue;
        }
        // A binary file reports "-\t-": a real change with no line counts.
        let added = a.parse::<u32>().unwrap_or(0);
        let removed = r.parse::<u32>().unwrap_or(0);
        let code = status.iter().find(|(_, p)| p == path).map(|(c, _)| c.as_str());
        let state = match code {
            Some(c) if c.contains('D') => "deleted",
            Some(c) if c.contains('A') => "added",
            _ => "modified",
        };
        out.added += added;
        out.removed += removed;
        out.tracked += 1;
        out.files.push(ReviewFile {
            path: path.to_string(),
            added,
            removed,
            status: state.to_string(),
        });
    }
    for file in untracked {
        if file.inherited || is_skipped_path(&file.path) {
            continue;
        }
        out.untracked += 1;
        out.files.push(ReviewFile {
            path: file.path.clone(),
            added: file.lines,
            removed: 0,
            status: "added".to_string(),
        });
    }
    out.files.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

/// The same path, byte for byte, already sits in the project checkout — so
/// the thread inherited this file rather than writing it.
///
/// A thread with no worktree of its own measures the checkout itself, where
/// every untracked file is inherited by definition. That is exactly the bug
/// this rule closes: five such threads used to report the same fourteen
/// ambient files and "overlap" each other on all of them.
///
/// ponytail: over 1 MiB, equal length is taken as equal content. Hash the
/// bytes if two big generated files ever need telling apart.
fn is_inherited(tree: &Path, root: &Path, rel: &str) -> bool {
    if tree == root {
        return true;
    }
    let (a, b) = (tree.join(rel), root.join(rel));
    let (Ok(ma), Ok(mb)) = (std::fs::metadata(&a), std::fs::metadata(&b)) else {
        return false;
    };
    if ma.len() != mb.len() {
        return false;
    }
    if ma.len() > (1 << 20) {
        return true;
    }
    matches!((std::fs::read(&a), std::fs::read(&b)), (Ok(x), Ok(y)) if x == y)
}

/// Everything the board and the Review lane need from one thread's tree, in
/// at most three git calls: `merge-base`, `diff --numstat <mb>` and
/// `status --porcelain`.
///
/// `base` is the thread's base branch. The diff runs from where that branch
/// and this tree's HEAD diverged, so a thread that commits as it goes still
/// reports the work it did — measuring against HEAD dropped it to "+0 −0"
/// the moment it committed, which is also why the board and the thread
/// footer could disagree. No base (a thread with no worktree of its own, or
/// no shared history) keeps the HEAD measurement.
pub fn thread_changes(bin: &Path, tree: &Path, root: &Path, base: Option<&str>) -> ThreadChanges {
    let from = base
        .and_then(|b| crate::git::merge_base(bin, tree, b))
        .unwrap_or_else(|| "HEAD".to_string());
    let numstat = crate::git::diff_numstat(bin, tree, &from).unwrap_or_default();
    let status = crate::git::status(bin, tree).unwrap_or_default();
    let untracked: Vec<UntrackedFile> = status
        .iter()
        .filter(|f| f.code == "??")
        .map(|f| UntrackedFile {
            path: f.path.clone(),
            // A binary file decodes to nothing; it still counts as a file.
            lines: std::fs::read_to_string(tree.join(&f.path))
                .map(|body| body.lines().count() as u32)
                .unwrap_or(0),
            inherited: is_inherited(tree, root, &f.path),
        })
        .collect();
    let pairs: Vec<(String, String)> =
        status.iter().map(|f| (f.code.clone(), f.path.clone())).collect();
    changed_files(&numstat, &pairs, &untracked)
}

/// The Review lane's file list. Deliberately the same measurement the board
/// shows — one helper, so the two surfaces cannot disagree.
pub fn review_files(bin: &Path, tree: &Path, root: &Path, base: Option<&str>) -> Vec<ReviewFile> {
    thread_changes(bin, tree, root, base).files
}

/// The Review lane's patch, measured from the same merge base as its file
/// list so committed work cannot disappear from a clean worktree.
pub fn review_diff(bin: &Path, tree: &Path, base: Option<&str>) -> String {
    let from = base
        .and_then(|b| crate::git::merge_base(bin, tree, b))
        .unwrap_or_else(|| "HEAD".to_string());
    crate::git::diff_from(bin, tree, &from).unwrap_or_default()
}

/// The files a thread has touched: whatever is dirty in its tree right now,
/// plus whatever it already committed on its worktree branch but hasn't
/// merged back yet. A thread that commits as it goes would otherwise drop
/// out of overlap detection the moment its tree goes clean.
pub fn union_files_touched(status: Vec<String>, committed: Vec<String>) -> Vec<String> {
    let mut set: std::collections::BTreeSet<String> = status.into_iter().collect();
    set.extend(committed);
    set.into_iter().collect()
}

/// Fill every row's `overlap`: the other threads in the same project that
/// have touched any of the same files.
///
/// Symmetric by construction — if A overlaps B, B overlaps A — so the board
/// can warn on either card without the user having to find the other one.
///
/// ponytail: O(n²) over threads in the open projects, which is tens at most.
/// Index by path if a fleet ever runs to thousands.
pub fn compute_overlap(rows: &mut [FleetRow]) {
    let others: Vec<(String, String, std::collections::HashSet<String>)> = rows
        .iter()
        .map(|row| {
            (
                row.thread_id.clone(),
                row.project_id.clone(),
                row.files_touched.iter().cloned().collect(),
            )
        })
        .collect();
    for row in rows.iter_mut() {
        row.overlap = others
            .iter()
            .filter(|(id, project, _)| *id != row.thread_id && *project == row.project_id)
            .filter_map(|(id, _, files)| {
                let shared: Vec<String> = row
                    .files_touched
                    .iter()
                    .filter(|path| files.contains(*path))
                    .cloned()
                    .collect();
                (!shared.is_empty())
                    .then(|| FleetOverlap { thread_id: id.clone(), files: shared })
            })
            .collect();
    }
}

/// How many finished playbook runs the board keeps. Enough that a run which
/// just ended is still where you left it; few enough that a week of runs does
/// not bury the threads.
pub const FINISHED_PLAYBOOK_LIMIT: usize = 5;

/// Drop all but the `keep` most recent finished playbook rows.
///
/// A finished run is history, and the Playbooks panel is where history lives.
/// Running and attention rows are never dropped, however old: a run at an
/// approval gate is the whole reason to look at the board.
pub fn cap_finished_playbooks(rows: &mut Vec<FleetRow>, keep: usize) {
    let mut finished: Vec<(&str, &str)> = rows
        .iter()
        .filter(|r| r.kind == FleetKind::Playbook && r.status == FleetStatus::Idle)
        .map(|r| (r.updated_at.as_str(), r.thread_id.as_str()))
        .collect();
    if finished.len() <= keep {
        return;
    }
    // ISO timestamps compare lexically, same as everywhere else here.
    finished.sort_by(|a, b| b.0.cmp(a.0));
    let dropped: std::collections::HashSet<String> =
        finished.into_iter().skip(keep).map(|(_, id)| id.to_string()).collect();
    rows.retain(|r| !dropped.contains(&r.thread_id));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(thread_id: &str, project_id: &str, files: &[&str]) -> FleetRow {
        FleetRow {
            kind: FleetKind::Thread,
            thread_id: thread_id.into(),
            run_id: None,
            playbook_name: None,
            seed: None,
            title: thread_id.into(),
            project_id: project_id.into(),
            project_name: project_id.into(),
            agent_id: None,
            agent_name: None,
            mode: "go".into(),
            status: FleetStatus::Idle,
            attention: None,
            branch: None,
            worktree_path: None,
            diff: FleetDiff::default(),
            files_touched: files.iter().map(|f| (*f).to_string()).collect(),
            overlap: vec![],
            verify: FleetVerify::not_run(),
            merge: FleetMerge::NoWorktree,
            updated_at: "2026-01-01T00:00:00Z".into(),
        }
    }

    fn verification(thread_id: &str, head: &str, exit_code: i32, at: &str) -> crate::store::VerificationRun {
        crate::store::VerificationRun {
            id: at.into(),
            project_hash: "p1".into(),
            thread_id: Some(thread_id.into()),
            session_id: None,
            name: "test".into(),
            command: "pnpm test".into(),
            exit_code,
            output_tail: String::new(),
            git_head: Some(head.into()),
            at: at.into(),
            tests: None,
        }
    }

    fn overlapping_ids(row: &FleetRow) -> Vec<&str> {
        row.overlap.iter().map(|o| o.thread_id.as_str()).collect()
    }

    #[test]
    fn disjoint_threads_do_not_overlap() {
        let mut rows = vec![row("a", "p1", &["src/a.rs"]), row("b", "p1", &["src/b.rs"])];
        compute_overlap(&mut rows);
        assert!(rows.iter().all(|r| r.overlap.is_empty()), "no shared path, no overlap");
    }

    #[test]
    fn a_shared_file_overlaps_both_ways() {
        let mut rows = vec![
            row("a", "p1", &["src/lib.rs", "src/a.rs"]),
            row("b", "p1", &["src/lib.rs"]),
        ];
        compute_overlap(&mut rows);
        assert_eq!(overlapping_ids(&rows[0]), ["b"]);
        assert_eq!(overlapping_ids(&rows[1]), ["a"]);
        assert_eq!(rows[0].overlap[0].files, ["src/lib.rs"], "only the shared path is listed");
    }

    #[test]
    fn three_threads_on_one_file_each_see_the_other_two() {
        let mut rows = vec![
            row("a", "p1", &["src/lib.rs"]),
            row("b", "p1", &["src/lib.rs"]),
            row("c", "p1", &["src/lib.rs"]),
        ];
        compute_overlap(&mut rows);
        assert_eq!(overlapping_ids(&rows[0]), ["b", "c"]);
        assert_eq!(overlapping_ids(&rows[1]), ["a", "c"]);
        assert_eq!(overlapping_ids(&rows[2]), ["a", "b"]);
    }

    /// Two projects can hold the same relative path; they are different files.
    #[test]
    fn the_same_path_in_another_project_is_not_an_overlap() {
        let mut rows = vec![row("a", "p1", &["src/lib.rs"]), row("b", "p2", &["src/lib.rs"])];
        compute_overlap(&mut rows);
        assert!(rows.iter().all(|r| r.overlap.is_empty()), "overlap is per project");
    }

    #[test]
    fn a_pending_permission_prompt_outranks_everything_else() {
        let input = StatusInput {
            awaiting_permission: true,
            busy: true,
            crashed: true,
            verify_failed: true,
            ..StatusInput::default()
        };
        assert_eq!(
            derive_status(&input),
            (FleetStatus::Attention, Some(FleetAttention::Permission))
        );
    }

    #[test]
    fn a_busy_session_is_running_not_attention() {
        let input =
            StatusInput { busy: true, verify_failed: true, crashed: true, ..StatusInput::default() };
        assert_eq!(derive_status(&input), (FleetStatus::Running, None));
    }

    #[test]
    fn a_finished_turn_with_unreviewed_changes_asks_to_be_read() {
        let input =
            StatusInput { turn_ended: true, has_diff: true, ..StatusInput::default() };
        assert_eq!(
            derive_status(&input),
            (FleetStatus::Attention, Some(FleetAttention::TurnDone))
        );
    }

    #[test]
    fn a_finished_turn_that_changed_nothing_is_idle() {
        let input = StatusInput { turn_ended: true, ..StatusInput::default() };
        assert_eq!(derive_status(&input), (FleetStatus::Idle, None));
    }

    #[test]
    fn an_already_viewed_turn_stops_asking() {
        let input = StatusInput {
            turn_ended: true,
            has_diff: true,
            viewed_since_turn: true,
            ..StatusInput::default()
        };
        assert_eq!(derive_status(&input), (FleetStatus::Idle, None));
    }

    #[test]
    fn a_failed_verification_is_attention() {
        let input = StatusInput { verify_failed: true, ..StatusInput::default() };
        assert_eq!(
            derive_status(&input),
            (FleetStatus::Attention, Some(FleetAttention::VerifyFailed))
        );
    }

    #[test]
    fn a_conflicting_merge_is_attention() {
        let input = StatusInput { merge_conflict: true, ..StatusInput::default() };
        assert_eq!(
            derive_status(&input),
            (FleetStatus::Attention, Some(FleetAttention::MergeConflict))
        );
    }

    #[test]
    fn a_crashed_session_is_attention() {
        let input = StatusInput { crashed: true, ..StatusInput::default() };
        assert_eq!(
            derive_status(&input),
            (FleetStatus::Attention, Some(FleetAttention::Crashed))
        );
    }

    #[test]
    fn files_touched_unions_dirty_and_committed_paths_deduped() {
        let files = union_files_touched(
            vec!["src/a.rs".into(), "src/b.rs".into()],
            vec!["src/b.rs".into(), "src/c.rs".into()],
        );
        assert_eq!(files, vec!["src/a.rs", "src/b.rs", "src/c.rs"]);
    }

    #[test]
    fn files_touched_includes_committed_only_paths_even_with_a_clean_tree() {
        // A thread that commits as it goes has nothing dirty, but its
        // committed-and-unmerged files must still count for overlap.
        let files = union_files_touched(vec![], vec!["src/c.rs".into()]);
        assert_eq!(files, vec!["src/c.rs"]);
    }

    #[test]
    fn a_quiet_thread_is_idle() {
        assert_eq!(derive_status(&StatusInput::default()), (FleetStatus::Idle, None));
    }

    #[test]
    fn verify_only_applies_to_the_current_clean_head() {
        let runs = vec![
            verification("t1", "old", 0, "2026-01-01T00:00:00Z"),
            verification("t1", "current", 0, "2026-01-02T00:00:00Z"),
        ];
        assert_eq!(current_verify(&runs, "t1", Some("current"), true).state, VerifyState::Pass);
        assert_eq!(current_verify(&runs, "t1", Some("newer"), true).state, VerifyState::NotRun);
        assert_eq!(current_verify(&runs, "t1", Some("current"), false).state, VerifyState::NotRun);
    }

    #[test]
    fn current_failed_verify_stays_failed() {
        let runs = vec![verification("t1", "current", 1, "2026-01-01T00:00:00Z")];
        assert_eq!(current_verify(&runs, "t1", Some("current"), true).state, VerifyState::Fail);
    }

    #[test]
    fn a_playbook_run_still_walking_is_running() {
        let input = PlaybookInput::default();
        assert_eq!(derive_playbook_status(&input), (FleetStatus::Running, None));
    }

    #[test]
    fn a_playbook_run_at_an_approval_gate_asks_for_approval() {
        let input = PlaybookInput { awaiting_gate: true, ..PlaybookInput::default() };
        assert_eq!(
            derive_playbook_status(&input),
            (FleetStatus::Attention, Some(FleetAttention::Gate))
        );
    }

    #[test]
    fn a_finished_playbook_run_is_idle() {
        let input = PlaybookInput { ended: true, ..PlaybookInput::default() };
        assert_eq!(derive_playbook_status(&input), (FleetStatus::Idle, None));
    }

    /// Rejected, cancelled, timed out and interrupted all land here: the run
    /// stopped without finishing, which is the one thing the board must say.
    #[test]
    fn a_playbook_run_that_ended_unfinished_is_attention() {
        let input = PlaybookInput { ended: true, failed: true, ..PlaybookInput::default() };
        assert_eq!(
            derive_playbook_status(&input),
            (FleetStatus::Attention, Some(FleetAttention::Crashed))
        );
    }

    #[test]
    fn a_playbook_row_serializes_its_kind_and_run_id() {
        let mut row = row("run-1", "p1", &[]);
        row.kind = FleetKind::Playbook;
        row.run_id = Some("run-1".into());
        row.playbook_name = Some("release notes".into());
        let json = serde_json::to_value(&row).unwrap();
        assert_eq!(json["kind"], "playbook");
        assert_eq!(json["runId"], "run-1");
        assert_eq!(json["playbookName"], "release notes");
    }

    /// The board's TypeScript types are camelCase; serde must agree or every
    /// field reads as undefined in the frontend.
    #[test]
    fn rows_serialize_as_camel_case() {
        let mut row = row("a", "p1", &["src/lib.rs"]);
        row.status = FleetStatus::Attention;
        row.attention = Some(FleetAttention::TurnDone);
        row.merge = FleetMerge::NoWorktree;
        let json = serde_json::to_value(&row).unwrap();
        assert_eq!(json["kind"], "thread");
        assert!(json.get("runId").is_none(), "a thread row carries no run id");
        assert_eq!(json["threadId"], "a");
        assert_eq!(json["projectName"], "p1");
        assert_eq!(json["filesTouched"][0], "src/lib.rs");
        assert_eq!(json["updatedAt"], "2026-01-01T00:00:00Z");
        assert_eq!(json["attention"], "turn_done");
        assert_eq!(json["merge"], "no_worktree");
        assert_eq!(json["verify"]["state"], "not_run");
        assert!(json["verify"].get("command").is_none(), "an absent field stays absent");
    }

    fn untracked(path: &str, lines: u32, inherited: bool) -> UntrackedFile {
        UntrackedFile { path: path.into(), lines, inherited }
    }

    fn status_pairs(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs.iter().map(|(c, p)| ((*c).to_string(), (*p).to_string())).collect()
    }

    #[test]
    fn numstat_lines_become_files_with_their_counts() {
        let changes = changed_files(
            "12\t3\tsrc/App.tsx\n0\t4\tsrc/old.rs\n",
            &status_pairs(&[(" M", "src/App.tsx"), (" D", "src/old.rs")]),
            &[],
        );
        assert_eq!(changes.added, 12);
        assert_eq!(changes.removed, 7);
        assert_eq!(changes.tracked, 2);
        assert_eq!(changes.untracked, 0);
        assert_eq!(changes.files[0].status, "modified");
        assert_eq!(changes.files[1].status, "deleted");
    }

    /// A binary file reports "-\t-": a real change with no line counts.
    #[test]
    fn a_binary_file_counts_as_a_file_with_no_lines() {
        let changes = changed_files("-\t-\tassets/logo.png\n", &[], &[]);
        assert_eq!(changes.tracked, 1);
        assert_eq!((changes.added, changes.removed), (0, 0));
    }

    /// Machine-local state and build output are not anyone's work. The rule
    /// is the file tree's own, imported rather than restated.
    #[test]
    fn the_file_trees_skip_list_hides_machine_local_paths() {
        assert!(is_skipped_path(".mcp.json"));
        assert!(is_skipped_path(".project-settings.json"));
        assert!(is_skipped_path(".palisade/threads.jsonl"));
        assert!(is_skipped_path("node_modules/react/index.js"));
        assert!(is_skipped_path("src-tauri/target/debug/build.rs"));
        assert!(!is_skipped_path("src/App.tsx"));
        assert!(!is_skipped_path("artifacts/report.md"));
    }

    #[test]
    fn skip_listed_paths_never_reach_the_board() {
        let changes = changed_files(
            "5\t0\t.mcp.json\n2\t1\tsrc/App.tsx\n",
            &[],
            &[untracked(".palisade/threads.jsonl", 40, false), untracked("src/new.rs", 9, false)],
        );
        assert_eq!(changes.paths(), vec!["src/App.tsx", "src/new.rs"]);
        assert_eq!(changes.added, 2, "the skipped file's lines are not this thread's work");
    }

    /// The bug this rule closes: threads with no worktree of their own all
    /// measure the project checkout, so its ambient untracked files showed up
    /// as every thread's work — identical diffs that then "overlapped".
    #[test]
    fn untracked_files_inherited_from_the_checkout_are_not_this_threads_work() {
        let changes = changed_files(
            "",
            &[],
            &[
                untracked("artifacts/report.md", 36, true),
                untracked("artifacts/ledger.json", 136, true),
                untracked("src/new.rs", 9, false),
            ],
        );
        assert_eq!(changes.untracked, 1);
        assert_eq!(changes.paths(), vec!["src/new.rs"]);
    }

    /// A new file is still a change, and it is the most visible one there is
    /// — it just contributes no numstat lines, so it is counted apart.
    #[test]
    fn untracked_files_are_added_rows_counted_apart_from_the_numstat() {
        let changes = changed_files("2\t1\tsrc/App.tsx\n", &[], &[untracked("src/new.rs", 9, false)]);
        assert_eq!(changes.tracked, 1, "n files counts only what numstat measured");
        assert_eq!(changes.untracked, 1);
        assert_eq!((changes.added, changes.removed), (2, 1));
        let new = changes.files.iter().find(|f| f.path == "src/new.rs").unwrap();
        assert_eq!((new.status.as_str(), new.added, new.removed), ("added", 9, 0));
    }

    /// A throwaway repo with one committed file, plus a worktree branched
    /// off it — the shape every thread with isolation on actually has.
    fn repo_with_worktree() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        for args in [
            &["init", "-q", "-b", "main"][..],
            &["config", "user.email", "test@example.com"][..],
            &["config", "user.name", "Test"][..],
        ] {
            std::process::Command::new("git").args(args).current_dir(root).output().unwrap();
        }
        std::fs::write(root.join("tracked.txt"), "one\ntwo\nthree\n").unwrap();
        crate::git::stage_file(Path::new("git"), root, "tracked.txt").unwrap();
        crate::git::commit(Path::new("git"), root, "initial").unwrap();
        let (path, _) = crate::git::add_worktree(Path::new("git"), root, "01THREADAAAA").unwrap();
        (dir, path)
    }

    /// The bug: a thread that commits as it goes went clean, so the board
    /// showed it "+0 −0" while the thread footer still counted its work.
    /// Measured from the merge base, the commit still counts.
    #[test]
    fn committed_work_on_the_thread_branch_still_counts_as_changed() {
        let (dir, wt) = repo_with_worktree();
        std::fs::write(wt.join("added_then_committed.rs"), "a\nb\nc\n").unwrap();
        crate::git::stage_file(Path::new("git"), &wt, "added_then_committed.rs").unwrap();
        crate::git::commit(Path::new("git"), &wt, "thread work").unwrap();

        let vs_head = thread_changes(Path::new("git"), &wt, dir.path(), None);
        assert_eq!(vs_head.added, 0, "against HEAD a committed change is invisible");

        let vs_base = thread_changes(Path::new("git"), &wt, dir.path(), Some("main"));
        assert_eq!(vs_base.added, 3);
        assert_eq!(vs_base.tracked, 1);
        assert_eq!(vs_base.paths(), vec!["added_then_committed.rs"]);
    }

    #[test]
    fn review_diff_includes_committed_work_on_a_clean_branch() {
        let (dir, wt) = repo_with_worktree();
        std::fs::write(wt.join("committed.rs"), "review me\n").unwrap();
        crate::git::stage_file(Path::new("git"), &wt, "committed.rs").unwrap();
        crate::git::commit(Path::new("git"), &wt, "thread work").unwrap();

        let patch = review_diff(Path::new("git"), &wt, Some("main"));
        assert!(patch.contains("diff --git a/committed.rs b/committed.rs"), "{patch}");
        assert!(patch.contains("+review me"), "{patch}");
        assert!(crate::git::status(Path::new("git"), &wt).unwrap().is_empty());
        drop(dir);
    }

    /// A thread with no worktree of its own has no base branch to diverge
    /// from, and measures its checkout exactly as it always did.
    #[test]
    fn a_thread_without_a_worktree_keeps_the_head_measurement() {
        let (dir, _) = repo_with_worktree();
        let root = dir.path();
        std::fs::write(root.join("tracked.txt"), "one\nedited\nthree\nfour\n").unwrap();

        let changes = thread_changes(Path::new("git"), root, root, None);
        assert_eq!((changes.added, changes.removed), (2, 1));
        assert_eq!(changes.paths(), vec!["tracked.txt"]);
    }

    /// The board's TypeScript type is camelCase, same as every other row field.
    #[test]
    fn a_review_file_serializes_as_camel_case() {
        let file =
            ReviewFile { path: "src/a.rs".into(), added: 1, removed: 2, status: "modified".into() };
        let json = serde_json::to_value(&file).unwrap();
        assert_eq!(json["path"], "src/a.rs");
        assert_eq!(json["status"], "modified");
    }

    /// Threads created before view tracking existed have no `last_viewed_at`.
    /// Reading that absence as "never viewed" made every legacy thread shout
    /// "Turn finished" forever.
    #[test]
    fn a_thread_that_predates_view_tracking_counts_as_viewed() {
        assert!(viewed_since_turn(None, Some("2026-01-01T00:00:00Z")));
        let input = StatusInput {
            turn_ended: true,
            has_diff: true,
            viewed_since_turn: viewed_since_turn(None, Some("2026-01-01T00:00:00Z")),
            ..StatusInput::default()
        };
        assert_eq!(derive_status(&input), (FleetStatus::Idle, None));
    }

    #[test]
    fn a_view_older_than_the_turn_that_ended_is_still_unread() {
        assert!(!viewed_since_turn(Some("2026-01-01T00:00:00Z"), Some("2026-01-02T00:00:00Z")));
        assert!(viewed_since_turn(Some("2026-01-03T00:00:00Z"), Some("2026-01-02T00:00:00Z")));
        assert!(viewed_since_turn(Some("2026-01-01T00:00:00Z"), None), "no turn has ended");
    }

    #[test]
    fn a_playbook_row_serializes_its_seed() {
        let mut r = row("run-1", "p1", &[]);
        r.kind = FleetKind::Playbook;
        r.seed = Some("draft the release notes".into());
        let json = serde_json::to_value(&r).unwrap();
        assert_eq!(json["seed"], "draft the release notes");
        assert!(
            serde_json::to_value(row("a", "p1", &[])).unwrap().get("seed").is_none(),
            "a thread row carries no seed"
        );
    }

    fn playbook(run_id: &str, status: FleetStatus, updated_at: &str) -> FleetRow {
        let mut r = row(run_id, "p1", &[]);
        r.kind = FleetKind::Playbook;
        r.run_id = Some(run_id.into());
        r.status = status;
        r.updated_at = updated_at.into();
        r
    }

    /// A week of finished runs must not bury the threads: the board keeps the
    /// newest few, and the Playbooks panel keeps the rest.
    #[test]
    fn only_the_newest_finished_playbook_runs_survive_the_cap() {
        let mut rows: Vec<FleetRow> = (1..=8)
            .map(|i| playbook(&format!("r{i}"), FleetStatus::Idle, &format!("2026-01-0{i}T00:00:00Z")))
            .collect();
        cap_finished_playbooks(&mut rows, 3);
        let kept: Vec<&str> = rows.iter().map(|r| r.thread_id.as_str()).collect();
        assert_eq!(kept, vec!["r6", "r7", "r8"]);
    }

    /// A run that is still walking, or stopped at an approval gate, is the
    /// whole reason to look at the board — age never drops it.
    #[test]
    fn running_and_attention_playbook_rows_are_never_capped() {
        let mut rows = vec![
            playbook("old-running", FleetStatus::Running, "2020-01-01T00:00:00Z"),
            playbook("old-gate", FleetStatus::Attention, "2020-01-01T00:00:00Z"),
            playbook("done-1", FleetStatus::Idle, "2026-01-01T00:00:00Z"),
            playbook("done-2", FleetStatus::Idle, "2026-01-02T00:00:00Z"),
        ];
        cap_finished_playbooks(&mut rows, 1);
        let kept: Vec<&str> = rows.iter().map(|r| r.thread_id.as_str()).collect();
        assert_eq!(kept, vec!["old-running", "old-gate", "done-2"]);
    }

    /// Threads are not runs. The cap must not touch them however many there are.
    #[test]
    fn thread_rows_are_untouched_by_the_playbook_cap() {
        let mut rows = vec![row("a", "p1", &[]), row("b", "p1", &[]), row("c", "p1", &[])];
        cap_finished_playbooks(&mut rows, 1);
        assert_eq!(rows.len(), 3);
    }
}
