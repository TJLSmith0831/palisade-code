//! What the Fleet board renders: one row per live thread, across every open
//! project.
//!
//! The rules live here rather than in the command so they are testable
//! without a Tauri app, a git repo or a running agent: `lib.rs`'s
//! `fleet_overview` gathers the facts (store records, git measurements, live
//! session state) and this module turns them into rows.

use serde::Serialize;

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
    pub files: u32,
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
