//! Append-only chain-run history under Palisade user storage
//! (`~/.palisade-code`, next to session records) — never inside the target
//! repository (PRODUCT.md: chain records must not leak into a user's git
//! status).
//!
//! Mirrors `store.rs`'s conventions rather than inventing a second one:
//! `chain_runs.jsonl` sits under `store::project_dir`, the same home
//! `store::SessionRecord` uses for `<thread>.sessions.jsonl`. A run's record
//! is appended repeatedly as it progresses — id-keyed, last line for an id
//! wins on read — exactly like `SessionRecord`'s open-then-amended-close, so
//! the log stays append-only and a torn write can never lose an earlier
//! state. Startup reconciliation (`close_stale_runs`) mirrors
//! `store::close_stale_sessions`: Palisade sweeps every persisted project at
//! boot, while history reads defensively repeat the reconciliation in case a
//! caller reaches them before startup has completed.
//!
//! This module reverses the D15 decision recorded in `chain_runner.rs`
//! ("Deliberately not persisted") — see the OpenSpec change under
//! `openspec/changes/` for the rationale. D-c is unchanged by that reversal:
//! Palisade persists the *record*, it never resumes the *process*. A record
//! left open when the app restarts is closed `interrupted`, same as a
//! session.

use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

use crate::chain_runner::{NodeState, Outcome};
use crate::chains::Chain;
use crate::store::{project_dir, Res};

fn e(ctx: &str, err: impl std::fmt::Display) -> crate::PalisadeError {
    crate::PalisadeError::from(format!("{ctx}: {err}"))
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// A run amendment is read-modify-append. Frontier nodes can complete in
/// parallel, so the three operations must share one critical section or a
/// late append based on an older snapshot erases a sibling's fields. The log
/// remains append-only; this only serializes process-local amendments. A
/// poisoned mutex is recovered rather than making durable history unusable
/// after one unrelated writer panic.
static HISTORY_AMEND_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn with_history_amend_lock<T>(operation: impl FnOnce() -> Res<T>) -> Res<T> {
    let lock = HISTORY_AMEND_LOCK.get_or_init(|| Mutex::new(()));
    let _guard = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    operation()
}

#[cfg(test)]
struct AmendAfterReadGate {
    hash: String,
    entered_tx: std::sync::mpsc::Sender<()>,
    entered_rx: Mutex<std::sync::mpsc::Receiver<()>>,
    permits: Mutex<usize>,
    released: std::sync::Condvar,
}

#[cfg(test)]
impl AmendAfterReadGate {
    fn new(hash: impl Into<String>) -> Self {
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        Self {
            hash: hash.into(),
            entered_tx,
            entered_rx: Mutex::new(entered_rx),
            permits: Mutex::new(0),
            released: std::sync::Condvar::new(),
        }
    }

    fn pause_writer(&self) {
        let _ = self.entered_tx.send(());
        let mut permits = self.permits.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        while *permits == 0 {
            permits = self.released.wait(permits).unwrap_or_else(|poisoned| poisoned.into_inner());
        }
        *permits -= 1;
    }

    fn wait_for_entered(&self) {
        self.entered_rx.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).recv().unwrap();
    }

    fn next_writer_reached_read_within(&self, timeout: std::time::Duration) -> bool {
        self.entered_rx.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).recv_timeout(timeout).is_ok()
    }

    fn release_one(&self) {
        *self.permits.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) += 1;
        self.released.notify_one();
    }
}

#[cfg(test)]
static AMEND_AFTER_READ_GATE: OnceLock<Mutex<Option<std::sync::Arc<AmendAfterReadGate>>>> = OnceLock::new();

#[cfg(test)]
fn set_amend_after_read_gate(gate: Option<std::sync::Arc<AmendAfterReadGate>>) {
    *AMEND_AFTER_READ_GATE
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = gate;
}

#[cfg(test)]
fn pause_after_read_for_test(hash: &str) {
    let gate = AMEND_AFTER_READ_GATE
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    if let Some(gate) = gate.filter(|gate| gate.hash == hash) {
        gate.pause_writer();
    }
}

#[cfg(not(test))]
fn pause_after_read_for_test(_hash: &str) {}

/// Real billed cost for one node turn, reported by the agent via ACP's
/// `usage.cost` (D-d, Wave B). A separate optional field rather than a bare
/// `f64`: absent means "this agent didn't report a cost," which must never
/// collapse to `0.0` — zero reads as free, absent reads as unknown. Wave B's
/// exact wire field name may differ; the shape (amount + currency, optional)
/// is what has to survive.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NodeCost {
    pub amount: f64,
    pub currency: String,
}

/// Mirrors `chain_runner::NodeState` for persistence. Kept as a distinct type
/// rather than reusing that enum directly: `NodeState` only derives
/// `Serialize` (an in-memory run never needs to deserialize its own state),
/// but a history record must round-trip. The `From` impl below is matched
/// exhaustively, so a new `NodeState` variant fails to compile here instead
/// of silently vanishing from history.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum NodeStateSnapshot {
    Queued,
    Executing,
    Retrying { attempt: u32 },
    Blocked { met: u32, required: u32 },
    Done,
    Failed,
    Cancelled,
}

impl From<NodeState> for NodeStateSnapshot {
    fn from(state: NodeState) -> Self {
        match state {
            NodeState::Queued => Self::Queued,
            NodeState::Executing => Self::Executing,
            NodeState::Retrying(attempt) => Self::Retrying { attempt },
            NodeState::Blocked { met, required } => Self::Blocked { met, required },
            NodeState::Done => Self::Done,
            NodeState::Failed => Self::Failed,
            NodeState::Cancelled => Self::Cancelled,
        }
    }
}

/// Mirrors `chain_runner::Outcome`, plus `Interrupted` for a record startup
/// reconciliation closes on Palisade's behalf rather than the run itself
/// (D-c). Same reasoning as `NodeStateSnapshot`: a distinct type so this
/// module doesn't need `chain_runner::Outcome` to derive `Deserialize`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum OutcomeSnapshot {
    Completed { output: String },
    Rejected { at: String },
    GateFailed { at: String, command: String },
    CapReached { at: String, max_iterations: u32 },
    TimedOut { at: String, after_seconds: u64 },
    RetriesExhausted { at: String, attempts: u32, message: String },
    Cancelled { at: Vec<String> },
    Blocked { reason: String },
    /// No agent process survives an app restart, so a record still open at
    /// startup was interrupted — never resumed (D-c). Palisade persists the
    /// record; it does not resume the process.
    Interrupted,
}

impl From<Outcome> for OutcomeSnapshot {
    fn from(outcome: Outcome) -> Self {
        match outcome {
            Outcome::Completed { output } => Self::Completed { output },
            Outcome::Rejected { at } => Self::Rejected { at },
            Outcome::GateFailed { at, command } => Self::GateFailed { at, command },
            Outcome::CapReached { at, max_iterations } => Self::CapReached { at, max_iterations },
            Outcome::TimedOut { at, after_seconds } => Self::TimedOut { at, after_seconds },
            Outcome::RetriesExhausted { at, attempts, message } => {
                Self::RetriesExhausted { at, attempts, message }
            }
            Outcome::Cancelled { at } => Self::Cancelled { at },
            Outcome::Blocked { reason } => Self::Blocked { reason },
        }
    }
}

/// One state a node passed through, timestamped.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NodeTransition {
    pub state: NodeStateSnapshot,
    pub at: String,
}

/// Everything recorded about one node across a run: every state it passed
/// through, the session backing its turn (so a past run's transcript stays
/// reachable), how many times it has run (loop iterations), and its reported
/// cost where the agent supplied one.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct NodeHistory {
    #[serde(default)]
    pub transitions: Vec<NodeTransition>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub iterations: u32,
    /// Most recent completed output for this role. It is retained with the
    /// definition snapshot so re-run-from-node can seed downstream prompts
    /// without re-spending its upstream turns.
    #[serde(default)]
    pub output: Option<String>,
    /// Absent until the agent reports one; never coerced to `0.0` (D-d).
    #[serde(default)]
    pub cost: Option<NodeCost>,
}

/// One run, start to (maybe) finish. Appended repeatedly as the run
/// progresses — id-keyed, last line for an id wins on read, same convention
/// `store::SessionRecord` uses.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChainRunRecord {
    pub id: String,
    pub project_hash: String,
    pub thread_id: String,
    pub chain_name: String,
    /// The chain definition exactly as it was when this run started. This is
    /// what makes re-run-from-node safe after the chain has since been
    /// edited: a replay uses this snapshot, never the current definition.
    pub chain_snapshot: Chain,
    pub seed: String,
    pub started_at: String,
    #[serde(default)]
    pub ended_at: Option<String>,
    #[serde(default)]
    pub outcome: Option<OutcomeSnapshot>,
    #[serde(default)]
    pub nodes: HashMap<String, NodeHistory>,
}

impl ChainRunRecord {
    pub fn new(
        id: impl Into<String>,
        project_hash: impl Into<String>,
        thread_id: impl Into<String>,
        chain: Chain,
        seed: impl Into<String>,
    ) -> Self {
        Self {
            id: id.into(),
            project_hash: project_hash.into(),
            thread_id: thread_id.into(),
            chain_name: chain.name.clone(),
            chain_snapshot: chain,
            seed: seed.into(),
            started_at: now(),
            ended_at: None,
            outcome: None,
            nodes: HashMap::new(),
        }
    }
}

fn history_path(home: &Path, hash: &str) -> PathBuf {
    project_dir(home, hash).join("chain_runs.jsonl")
}

fn append_unlocked(home: &Path, record: &ChainRunRecord) -> Res<()> {
    let path = history_path(home, &record.project_hash);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| e("create project dir", err))?;
    }
    let line = serde_json::to_string(record).map_err(|err| e("serialize chain run", err))?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|err| e(&format!("open {}", path.display()), err))?;
    file.write_all(line.as_bytes()).map_err(|err| e("append chain run", err))?;
    file.write_all(b"\n").map_err(|err| e("append newline", err))?;
    file.sync_all().map_err(|err| e("fsync chain run log", err))?;
    Ok(())
}

/// Appends a run's opening record.
pub fn start_run(home: &Path, record: &ChainRunRecord) -> Res<()> {
    with_history_amend_lock(|| append_unlocked(home, record))
}

/// Applies one mutation to the latest snapshot while holding the same lock as
/// every other append-and-amend operation for this process.
fn amend_run<T>(
    home: &Path,
    hash: &str,
    run_id: &str,
    amend: impl FnOnce(&mut ChainRunRecord) -> T,
) -> Res<T> {
    with_history_amend_lock(|| {
        let mut record = get_run_unlocked(home, hash, run_id)?.ok_or_else(|| format!("no chain run `{run_id}`"))?;
        pause_after_read_for_test(hash);
        let result = amend(&mut record);
        append_unlocked(home, &record)?;
        Ok(result)
    })
}

/// Records one node's state transition by re-appending the whole run record
/// with that node's history updated — id-keyed, last row wins on read, same
/// amend-by-append convention as `store::close_session`.
pub fn record_transition(
    home: &Path,
    hash: &str,
    run_id: &str,
    role: &str,
    state: NodeState,
    session_id: Option<String>,
    iterations: u32,
) -> Res<()> {
    amend_run(home, hash, run_id, |record| {
        let entry = record.nodes.entry(role.to_string()).or_default();
        entry.transitions.push(NodeTransition { state: state.into(), at: now() });
        if session_id.is_some() {
            entry.session_id = session_id;
        }
        entry.iterations = iterations;
    })
}

/// Records a node's reported cost. Never call this with `0.0` standing in for
/// "not reported" — leave it uncalled instead, so the field stays `None`
/// (D-d).
pub fn record_cost(home: &Path, hash: &str, run_id: &str, role: &str, cost: NodeCost) -> Res<()> {
    amend_run(home, hash, run_id, |record| {
        record.nodes.entry(role.to_string()).or_default().cost = Some(cost);
    })
}

/// Records a completed node's output. This is append-only like every other
/// history update; on a loop the latest successful iteration is the output a
/// future re-run-from-node should inherit.
pub fn record_output(home: &Path, hash: &str, run_id: &str, role: &str, output: String) -> Res<()> {
    amend_run(home, hash, run_id, |record| {
        record.nodes.entry(role.to_string()).or_default().output = Some(output);
    })
}

/// Closes a run's record with its terminal outcome.
pub fn end_run(home: &Path, hash: &str, run_id: &str, outcome: Outcome) -> Res<()> {
    amend_run(home, hash, run_id, |record| {
        record.ended_at = Some(now());
        record.outcome = Some(outcome.into());
    })
}

/// Every run recorded for a project, oldest first. The log is append-only;
/// this collapses it to the last line written for each run id, matching
/// `store::read_sessions`.
fn list_runs_unlocked(home: &Path, hash: &str) -> Res<Vec<ChainRunRecord>> {
    let path = history_path(home, hash);
    let body = match fs::read_to_string(&path) {
        Ok(body) => body,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(err) => return Err(e("read chain run log", err)),
    };
    let mut records: Vec<ChainRunRecord> = vec![];
    for line in body.lines() {
        if line.trim().is_empty() {
            continue;
        }
        // A corrupt line (torn write, foreign content) is skipped rather than
        // failing the whole read, matching store.rs's tolerant JSONL reads.
        if let Ok(record) = serde_json::from_str::<ChainRunRecord>(line) {
            match records.iter_mut().find(|r| r.id == record.id) {
                Some(existing) => *existing = record,
                None => records.push(record),
            }
        }
    }
    Ok(records)
}

pub fn list_runs(home: &Path, hash: &str) -> Res<Vec<ChainRunRecord>> {
    with_history_amend_lock(|| list_runs_unlocked(home, hash))
}

/// One run by id, if it has ever been recorded for this project.
pub fn get_run(home: &Path, hash: &str, run_id: &str) -> Res<Option<ChainRunRecord>> {
    with_history_amend_lock(|| get_run_unlocked(home, hash, run_id))
}

fn get_run_unlocked(home: &Path, hash: &str, run_id: &str) -> Res<Option<ChainRunRecord>> {
    Ok(list_runs_unlocked(home, hash)?.into_iter().find(|r| r.id == run_id))
}

/// No agent process survives an app restart (D-c): any record still open
/// (`ended_at: None`) whose id isn't in `live` was interrupted, not resumed.
/// Mirrors `store::close_stale_sessions`. Called by the boot sweep and also
/// from read endpoints as a defensive second line of reconciliation.
pub fn close_stale_runs(home: &Path, hash: &str, live: &[String]) -> Res<Vec<ChainRunRecord>> {
    with_history_amend_lock(|| {
        for record in list_runs_unlocked(home, hash)? {
            if record.ended_at.is_none() && !live.contains(&record.id) {
                let mut record = record;
                record.ended_at = Some(now());
                record.outcome = Some(OutcomeSnapshot::Interrupted);
                append_unlocked(home, &record)?;
            }
        }
        list_runs_unlocked(home, hash)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chains::{ChainEdge, ChainNode, RetryPolicy};

    fn home() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    fn chain(name: &str) -> Chain {
        let mut nodes = HashMap::new();
        nodes.insert(
            "designer".to_string(),
            ChainNode { role: "designer".into(), guideline: String::new(), agent: "claude".into(), model: None, retry: None },
        );
        nodes.insert(
            "programmer".to_string(),
            ChainNode { role: "programmer".into(), guideline: String::new(), agent: "codex".into(), model: None, retry: None },
        );
        Chain {
            name: name.to_string(),
            nodes,
            edges: vec![ChainEdge { from: "designer".into(), to: "programmer".into(), gate: None, max_iterations: None }],
            entry: "designer".into(),
            timeout_seconds: 1800,
            retry: RetryPolicy::default(),
            max_parallel: 0,
            layout: HashMap::new(),
        }
    }

    fn record(id: &str, hash: &str) -> ChainRunRecord {
        ChainRunRecord::new(id, hash, "thread-1", chain("acceptance-fanout"), "seed text")
    }

    // ---- 1. append and read back, including every new NodeState/Outcome variant ----

    #[test]
    fn a_record_round_trips_through_append_and_read() {
        let home = home();
        let hash = "proj-a";
        let rec = record("run-1", hash);
        start_run(home.path(), &rec).unwrap();

        record_transition(home.path(), hash, "run-1", "designer", NodeState::Executing, Some("sess-1".into()), 1).unwrap();
        record_transition(home.path(), hash, "run-1", "designer", NodeState::Done, Some("sess-1".into()), 1).unwrap();
        record_transition(
            home.path(),
            hash,
            "run-1",
            "programmer",
            NodeState::Blocked { met: 1, required: 2 },
            None,
            0,
        )
        .unwrap();
        record_transition(home.path(), hash, "run-1", "programmer", NodeState::Retrying(2), Some("sess-2".into()), 2).unwrap();
        record_transition(home.path(), hash, "run-1", "programmer", NodeState::Cancelled, Some("sess-2".into()), 2).unwrap();
        record_output(home.path(), hash, "run-1", "designer", "designer output".into()).unwrap();

        end_run(home.path(), hash, "run-1", Outcome::Cancelled { at: vec!["programmer".into()] }).unwrap();

        let got = get_run(home.path(), hash, "run-1").unwrap().expect("record should exist");
        assert_eq!(got.chain_snapshot, chain("acceptance-fanout"));
        assert_eq!(got.seed, "seed text");
        assert!(got.ended_at.is_some());
        assert_eq!(got.outcome, Some(OutcomeSnapshot::Cancelled { at: vec!["programmer".into()] }));

        let designer = &got.nodes["designer"];
        assert_eq!(designer.session_id.as_deref(), Some("sess-1"));
        assert_eq!(designer.output.as_deref(), Some("designer output"));
        assert_eq!(
            designer.transitions.iter().map(|t| t.state).collect::<Vec<_>>(),
            vec![NodeStateSnapshot::Executing, NodeStateSnapshot::Done]
        );

        let programmer = &got.nodes["programmer"];
        assert_eq!(
            programmer.transitions.iter().map(|t| t.state).collect::<Vec<_>>(),
            vec![
                NodeStateSnapshot::Blocked { met: 1, required: 2 },
                NodeStateSnapshot::Retrying { attempt: 2 },
                NodeStateSnapshot::Cancelled,
            ]
        );
    }

    #[test]
    fn every_outcome_variant_round_trips() {
        let home = home();
        let hash = "proj-b";
        let outcomes = vec![
            Outcome::Completed { output: "done".into() },
            Outcome::Rejected { at: "designer".into() },
            Outcome::GateFailed { at: "designer".into(), command: "cargo test".into() },
            Outcome::CapReached { at: "designer".into(), max_iterations: 2 },
            Outcome::TimedOut { at: "designer".into(), after_seconds: 1800 },
            Outcome::RetriesExhausted { at: "designer".into(), attempts: 2, message: "boom".into() },
            Outcome::Cancelled { at: vec!["designer".into(), "programmer".into()] },
            Outcome::Blocked { reason: "agent not installed".into() },
        ];
        for (i, outcome) in outcomes.into_iter().enumerate() {
            let id = format!("run-{i}");
            start_run(home.path(), &record(&id, hash)).unwrap();
            end_run(home.path(), hash, &id, outcome.clone()).unwrap();
            let got = get_run(home.path(), hash, &id).unwrap().unwrap();
            assert_eq!(got.outcome, Some(OutcomeSnapshot::from(outcome)));
        }
    }

    // ---- 2. startup reconciliation closes an open record `interrupted` ----

    #[test]
    fn a_record_left_open_is_closed_interrupted_by_reconciliation() {
        let home = home();
        let hash = "proj-c";
        start_run(home.path(), &record("dead", hash)).unwrap();
        start_run(home.path(), &record("alive", hash)).unwrap();

        let reconciled = close_stale_runs(home.path(), hash, &["alive".to_string()]).unwrap();

        let dead = reconciled.iter().find(|r| r.id == "dead").unwrap();
        assert_eq!(dead.outcome, Some(OutcomeSnapshot::Interrupted));
        assert!(dead.ended_at.is_some());

        let alive = reconciled.iter().find(|r| r.id == "alive").unwrap();
        assert_eq!(alive.outcome, None, "a run still in the live set must not be touched");
        assert!(alive.ended_at.is_none());
    }

    #[test]
    fn reconciliation_never_reopens_an_already_closed_run() {
        let home = home();
        let hash = "proj-d";
        start_run(home.path(), &record("finished", hash)).unwrap();
        end_run(home.path(), hash, "finished", Outcome::Completed { output: "ok".into() }).unwrap();

        let reconciled = close_stale_runs(home.path(), hash, &[]).unwrap();
        let finished = reconciled.iter().find(|r| r.id == "finished").unwrap();
        assert_eq!(finished.outcome, Some(OutcomeSnapshot::Completed { output: "ok".into() }));
    }

    // ---- 3. records land outside the project root ----

    #[test]
    fn records_land_under_palisade_home_not_the_project_root() {
        let project_root = tempfile::tempdir().unwrap();
        let home = home();
        let hash = "proj-e";

        start_run(home.path(), &record("run-1", hash)).unwrap();

        let resolved = history_path(home.path(), hash);
        assert!(resolved.starts_with(home.path()), "record must live under palisade home");
        assert!(
            !resolved.starts_with(project_root.path()),
            "a chain record must never land inside the target repo (PRODUCT.md)"
        );
        assert!(resolved.exists());
    }

    // ---- 4. absent cost stays absent, never zero ----

    #[test]
    fn a_node_with_no_reported_cost_round_trips_as_absent() {
        let home = home();
        let hash = "proj-f";
        start_run(home.path(), &record("run-1", hash)).unwrap();
        record_transition(home.path(), hash, "run-1", "designer", NodeState::Done, None, 1).unwrap();

        let got = get_run(home.path(), hash, "run-1").unwrap().unwrap();
        assert_eq!(got.nodes["designer"].cost, None, "no cost reported must read back as None, not 0.0");
    }

    #[test]
    fn a_node_with_a_reported_cost_round_trips_exactly() {
        let home = home();
        let hash = "proj-g";
        start_run(home.path(), &record("run-1", hash)).unwrap();
        record_transition(home.path(), hash, "run-1", "designer", NodeState::Done, None, 1).unwrap();
        record_cost(home.path(), hash, "run-1", "designer", NodeCost { amount: 0.0043, currency: "USD".into() }).unwrap();

        let got = get_run(home.path(), hash, "run-1").unwrap().unwrap();
        assert_eq!(got.nodes["designer"].cost, Some(NodeCost { amount: 0.0043, currency: "USD".into() }));

        // A node that never reports cost stays absent even when a sibling did.
        record_transition(home.path(), hash, "run-1", "programmer", NodeState::Done, None, 1).unwrap();
        let got = get_run(home.path(), hash, "run-1").unwrap().unwrap();
        assert_eq!(got.nodes["programmer"].cost, None);
    }

    /// The frontier scheduler can complete several roles at once. Each
    /// amendment must begin from a serialized latest record, or the final
    /// JSONL row will silently contain only whichever branch appended last.
    #[test]
    fn concurrent_amendments_to_distinct_roles_preserve_every_update() {
        use std::sync::Arc;

        let home = home();
        let hash = "proj-parallel";
        start_run(home.path(), &record("run-1", hash)).unwrap();

        let gate = Arc::new(AmendAfterReadGate::new(hash));
        set_amend_after_read_gate(Some(gate.clone()));
        std::thread::scope(|scope| {
            let designer = scope.spawn(|| {
                record_transition(home.path(), hash, "run-1", "designer", NodeState::Done, Some("sess-designer".into()), 1)
            });
            let reviewer = scope.spawn(|| record_output(home.path(), hash, "run-1", "reviewer", "review output".into()));
            let auditor = scope.spawn(|| {
                record_cost(
                    home.path(),
                    hash,
                    "run-1",
                    "auditor",
                    NodeCost { amount: 0.0043, currency: "USD".into() },
                )
            });

            // The first writer is deliberately held after its read. Before
            // the per-history lock, another writer would reach this same
            // point and take a stale snapshot; with it, the second remains
            // blocked until we release the first append.
            gate.wait_for_entered();
            assert!(
                !gate.next_writer_reached_read_within(std::time::Duration::from_millis(100)),
                "a second writer read before the first amended the record"
            );
            gate.release_one();
            gate.wait_for_entered();
            gate.release_one();
            gate.wait_for_entered();
            gate.release_one();
            designer.join().unwrap().unwrap();
            reviewer.join().unwrap().unwrap();
            auditor.join().unwrap().unwrap();
        });
        set_amend_after_read_gate(None);

        let got = get_run(home.path(), hash, "run-1").unwrap().unwrap();
        assert_eq!(got.nodes["designer"].transitions.len(), 1);
        assert_eq!(got.nodes["reviewer"].output.as_deref(), Some("review output"));
        assert_eq!(got.nodes["auditor"].cost.as_ref().map(|cost| cost.amount), Some(0.0043));
    }
}
