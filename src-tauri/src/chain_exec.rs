//! Production `NodeRunner`/`GateEvaluator` for `chain_runner.rs` (D26): real
//! `AcpSession`s per node, real `verify` commands per gate, real approval
//! gates resolved by the user.
//!
//! A node's session is a normal session on the invoking thread, so its
//! transcript IS a thread transcript — that's what makes "click a node, see
//! what it actually did" work with no new storage format (D7).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{Emitter, Manager};

use crate::acp_events::Cost;
use crate::chain_history::{self, NodeCost};
use crate::chain_runner::{Approval, Budget, GateEvaluator, NodeRunner, NodeState, Outcome, TurnResult};
use crate::chains::Chain;
use crate::executor::{Envelope, ExecutorEvent, Harness, TurnEnd, TurnWatch};
use crate::store::Res;
use crate::locks::MutexExt;

/// Live chain-run progress for the DAG view (D7). Carries the run id rather
/// than riding `Envelope`, because a chain run spans several sessions and no
/// single session id identifies it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChainEvent {
    pub run_id: String,
    pub thread_id: String,
    pub chain: String,
    /// The node this event is about, absent on run-level events.
    pub role: Option<String>,
    pub state: Option<NodeState>,
    /// Set once the run reaches a terminal state.
    pub outcome: Option<Outcome>,
    /// Set while a run is suspended at an approval gate.
    pub awaiting_approval: Option<AwaitingApproval>,
    /// The session backing `role`'s turn, so the view can open its transcript.
    pub session_id: Option<String>,
    /// `role`'s most recent reported cost (D-d) — absent when its agent
    /// doesn't report `usage.cost`, never a coerced `0.0`. `None` on
    /// run-level events, same as `role`.
    pub cost: Option<Cost>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AwaitingApproval {
    pub from: String,
    pub to: String,
    /// `from`'s actual output. Both deciding surfaces render it inline — a
    /// link is not evidence (PLAN §4.5, the critique's P1).
    pub output: String,
}

/// Every node's most recent reported cost (D-d). `usage.cost` is already
/// cumulative per ACP session (the schema's own doc comment: "Total
/// cumulative cost for session"), so recording a role's cost replaces its
/// prior value rather than summing deltas — a role that never reports stays
/// absent from the map, which callers must read as "unknown," never coerce
/// to `0.0` ("free"). Plain enough to unit-test with no `tauri::AppHandle`.
#[derive(Debug, Default)]
struct NodeCosts(Mutex<HashMap<String, Cost>>);

impl NodeCosts {
    fn record(&self, role: &str, cost: Cost) {
        self.0.lock_or_recover().insert(role.to_string(), cost);
    }

    fn get(&self, role: &str) -> Option<Cost> {
        self.0.lock_or_recover().get(role).cloned()
    }
}

/// A turn that produces nothing for this long is treated as a crashed turn
/// rather than hanging the run forever. Well inside the 30-minute run budget
/// (D19), so the run-level timeout still owns the overall ceiling.
const TURN_TIMEOUT: Duration = Duration::from_secs(20 * 60);

/// How often a blocked turn re-checks the run's cancellation flag. Fine
/// enough that Stop feels immediate; coarse enough not to spin.
const CANCEL_POLL: Duration = Duration::from_millis(200);

/// Runs each node turn on a real ACP session pinned to that node's agent.
pub struct AcpNodeRunner {
    app: tauri::AppHandle,
    project_hash: String,
    thread_id: String,
    run_id: String,
    chain: Chain,
    /// Role → its live session. A loop revisiting a role reuses its session,
    /// so the role keeps its own context across iterations; a crashed turn
    /// drops the entry so the retry starts fresh (D21). Behind a `Mutex`
    /// rather than plain, now that `NodeRunner::run_turn` takes `&self` and
    /// the frontier scheduler calls it from several node-turn threads at
    /// once (D10) — per-role sessions mean no real contention in practice.
    sessions: Mutex<HashMap<String, String>>,
    /// This run's cancellation flag (§4.2) — the same `Arc` `run_chain`
    /// stores in `Harness.chain_cancels` and hands to `ChainRun::walk`'s
    /// `cancel` parameter. A node turn polls it directly rather than
    /// waiting on `walk`'s own reaction to it, because `walk` only rechecks
    /// `cancel` between node completions and would otherwise sit blocked on
    /// this very turn for up to `TURN_TIMEOUT` after the user hit Stop.
    cancel: Arc<AtomicBool>,
    costs: NodeCosts,
    /// Completed loop iterations per role, persisted alongside every state
    /// transition. Retries are attempts within one iteration and do not bump
    /// this number.
    iterations: Mutex<HashMap<String, u32>>,
    /// The run's shared, pause-aware wall clock (D12) — a human turn pauses
    /// it for the same clock the scheduler's own timeout check consults.
    budget: Arc<Budget>,
}

impl AcpNodeRunner {
    pub fn new(
        app: tauri::AppHandle,
        project_hash: String,
        thread_id: String,
        run_id: String,
        chain: Chain,
        cancel: Arc<AtomicBool>,
        budget: Arc<Budget>,
    ) -> Self {
        Self {
            app,
            project_hash,
            thread_id,
            run_id,
            chain,
            sessions: Mutex::new(HashMap::new()),
            cancel,
            costs: NodeCosts::default(),
            iterations: Mutex::new(HashMap::new()),
            budget,
        }
    }

    fn harness(&self) -> tauri::State<'_, Harness> {
        self.app.state::<Harness>()
    }

    /// This role's live session, started if it doesn't have one. Chain-owned,
    /// so `find_live_session` won't hand it to a user's `/go` (D25).
    fn session_for(&self, role: &str) -> Res<String> {
        {
            let mut sessions = self.sessions.lock_or_recover();
            if let Some(id) = sessions.get(role) {
                if self.harness().acp_sessions.lock_or_recover().contains_key(id) {
                    return Ok(id.clone());
                }
                sessions.remove(role);
            }
        }
        let node = self
            .chain
            .nodes
            .get(role)
            .ok_or_else(|| format!("chain has no node `{role}`"))?;
        let (agent, model) = (&node.agent, node.model.clone());
        let id = crate::start_session_as(
            &self.app,
            &self.harness(),
            &self.project_hash,
            &self.thread_id,
            // Chain nodes are go-mode work (D5) — they need write permissions.
            "go",
            false,
            Some(agent),
            model,
        )?;
        self.harness().chain_sessions.lock_or_recover().insert(id.clone());
        self.sessions.lock_or_recover().insert(role.to_string(), id.clone());
        Ok(id)
    }

    /// Drops a role's session, closing its record with `outcome`, so the next
    /// attempt (if any) starts fresh rather than continuing a contaminated
    /// context (D21).
    fn discard_session_as(&self, role: &str, outcome: &str) {
        let id = self.sessions.lock_or_recover().remove(role);
        if let Some(id) = id {
            self.harness().chain_sessions.lock_or_recover().remove(&id);
            self.harness().turn_watchers.lock_or_recover().remove(&id);
            crate::end_session(&self.harness(), &self.thread_id, &id, outcome);
        }
    }

    /// A turn that crashed. The retry (if any) starts a fresh session.
    fn discard_session(&self, role: &str) {
        self.discard_session_as(role, "crashed");
    }

    /// Interrupts `role`'s live turn through the same per-session path a
    /// user's Stop uses (`stop_executor` in lib.rs), rather than a second
    /// cancellation mechanism: emit the same turn-failed envelope the
    /// frontend's listener already clears busy state on, then close the
    /// session `cancelled`, same outcome `stop_executor` records.
    fn cancel_turn(&self, role: &str, session_id: &str) {
        let envelope = Envelope {
            session_id: session_id.to_string(),
            thread_id: self.thread_id.clone(),
            event: ExecutorEvent::turn_failed("Chain run cancelled".into()),
        };
        let _ = self.app.emit("executor-event", &envelope);
        self.discard_session_as(role, "cancelled");
    }

    /// Releases every session this run started, closing each record idle.
    pub fn release(&mut self) {
        for (_, id) in std::mem::take(self.sessions.get_mut().unwrap()) {
            self.harness().chain_sessions.lock_or_recover().remove(&id);
            self.harness().turn_watchers.lock_or_recover().remove(&id);
            crate::end_session(&self.harness(), &self.thread_id, &id, "done");
        }
    }

    /// Records `role`'s latest reported cost (D-d), fed to the next
    /// `ChainEvent` this role emits.
    pub fn record_cost(&self, role: &str, cost: Cost) {
        self.costs.record(role, cost.clone());
        if let Err(err) = chain_history::record_cost(
            &crate::palisade_home(),
            &self.project_hash,
            &self.run_id,
            role,
            NodeCost { amount: cost.amount, currency: cost.currency },
        ) {
            eprintln!("chain run {}: could not persist {role}'s cost: {err}", self.run_id);
        }
    }

    fn persist_transition(&self, role: &str, state: NodeState, session_id: Option<String>) {
        let iterations = *self.iterations.lock_or_recover().get(role).unwrap_or(&0);
        if let Err(err) = chain_history::record_transition(
            &crate::palisade_home(),
            &self.project_hash,
            &self.run_id,
            role,
            state,
            session_id,
            iterations,
        ) {
            eprintln!("chain run {}: could not persist {role}'s transition: {err}", self.run_id);
        }
    }

    fn emit(&self, event: ChainEvent) {
        let _ = self.app.emit("chain-event", event);
    }

    fn base_event(&self) -> ChainEvent {
        ChainEvent {
            run_id: self.run_id.clone(),
            thread_id: self.thread_id.clone(),
            chain: self.chain.name.clone(),
            role: None,
            state: None,
            outcome: None,
            awaiting_approval: None,
            session_id: None,
            cost: None,
        }
    }
}

/// Posts a condensed line into the invoking thread's history (D7). The DAG
/// view carries the detail; the thread only needs to say what happened, so a
/// user reading the conversation later isn't looking at a silent gap where a
/// chain ran.
pub fn post_thread_summary(app: &tauri::AppHandle, project_hash: &str, thread_id: &str, body: &str) {
    let _ = crate::store::append_message(
        &crate::store::palisade_home(),
        project_hash,
        thread_id,
        "chain",
        "go",
        body,
        None,
    );
    let _ = app.emit("thread-updated", thread_id);
}

impl NodeRunner for AcpNodeRunner {
    fn run_turn(&self, role: &str, instruction: &str, _attempt: u32) -> TurnResult {
        let session_id = self.session_for(role)?;

        // Registered before the prompt is sent: an agent that answers fast
        // would otherwise emit Done before anything was listening.
        let (tx, rx) = mpsc::channel();
        let watch = Arc::new(TurnWatch::new(tx));
        self.harness().turn_watchers.lock_or_recover().insert(session_id.clone(), watch.clone());

        let sent = crate::send_to(&self.harness(), &self.project_hash, &session_id, instruction);
        if let Err(err) = sent {
            self.harness().turn_watchers.lock_or_recover().remove(&session_id);
            self.discard_session(role);
            return Err(err);
        }

        // Polled in short slices rather than one `recv_timeout(TURN_TIMEOUT)`:
        // a run's Stop only flips `self.cancel`, it doesn't touch this
        // channel, so a single long wait would leave Stop sitting for up to
        // 20 minutes before this turn noticed (§4.2).
        let deadline = Instant::now() + TURN_TIMEOUT;
        let end = loop {
            if self.cancel.load(Ordering::SeqCst) {
                break None;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break Some(Err(mpsc::RecvTimeoutError::Timeout));
            }
            match rx.recv_timeout(remaining.min(CANCEL_POLL)) {
                Ok(end) => break Some(Ok(end)),
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(err) => break Some(Err(err)),
            }
        };
        self.harness().turn_watchers.lock_or_recover().remove(&session_id);

        match end {
            Some(Ok(TurnEnd::Done)) => {
                // ACP reports a cumulative session total, so take the latest
                // value observed during this turn and replace the role's
                // prior value. An absent value stays absent.
                if let Some(cost) = watch.take_cost() {
                    self.record_cost(role, cost);
                }
                let output = watch.take_text();
                *self.iterations.lock_or_recover().entry(role.to_string()).or_insert(0) += 1;
                if let Err(err) = chain_history::record_output(
                    &crate::palisade_home(),
                    &self.project_hash,
                    &self.run_id,
                    role,
                    output.clone(),
                ) {
                    eprintln!("chain run {}: could not persist {role}'s output: {err}", self.run_id);
                }
                Ok(output)
            }
            Some(Ok(TurnEnd::Crashed(message))) => {
                self.discard_session(role);
                Err(message)
            }
            Some(Err(_)) => {
                self.discard_session(role);
                Err(format!("`{role}` produced nothing for {} minutes", TURN_TIMEOUT.as_secs() / 60))
            }
            // Cancelled: interrupt through the existing per-session path
            // rather than waiting for the agent to notice on its own.
            None => {
                self.on_state(role, NodeState::Cancelled);
                self.cancel_turn(role, &session_id);
                Err(format!("`{role}` cancelled"))
            }
        }
    }

    fn on_state(&self, role: &str, state: NodeState) {
        // ChainRun announces Executing/Retrying before it invokes
        // `run_turn`. Create the role session here so each persisted/live
        // attempt transition has its transcript id rather than requiring a
        // second synthetic event.
        let session_id = match state {
            NodeState::Executing | NodeState::Retrying(_) => self.session_for(role).ok(),
            _ => self.sessions.lock_or_recover().get(role).cloned(),
        };
        let cost = self.costs.get(role);
        self.persist_transition(role, state, session_id.clone());
        self.emit(ChainEvent {
            role: Some(role.to_string()),
            state: Some(state),
            session_id,
            cost,
            ..self.base_event()
        });
    }
}

/// Verify gates run the project's named command through the same path the
/// rest of Palisade uses, exit code persisted (D8). Approval gates park on a
/// channel that `resolve_chain_gate` sends into (D9).
pub struct AcpGateEvaluator {
    app: tauri::AppHandle,
    project_hash: String,
    thread_id: String,
    run_id: String,
    chain: String,
    /// The run's shared, pause-aware wall clock (D12) — a gate pauses it for
    /// as long as it waits on a human, rather than enforcing its own
    /// deadline against it (that was the D12 bug: a paused approval gate
    /// could time out a run the user was about to approve).
    budget: Arc<Budget>,
    /// Shared with `cancel_chain_run`; approval waiting must observe Stop as
    /// promptly as a live ACP turn does, rather than waiting forever.
    cancel: Arc<AtomicBool>,
}

impl AcpGateEvaluator {
    pub fn new(
        app: tauri::AppHandle,
        project_hash: String,
        thread_id: String,
        run_id: String,
        chain: String,
        budget: Arc<Budget>,
        cancel: Arc<AtomicBool>,
    ) -> Self {
        Self { app, project_hash, thread_id, run_id, chain, budget, cancel }
    }
}

impl GateEvaluator for AcpGateEvaluator {
    fn verify(&mut self, command: &str) -> Result<bool, String> {
        // Palisade runs it and records the exit code — a gate is never
        // satisfied because an agent said the work was done (CLAUDE.md).
        let exit_code = crate::record_verification(
            &self.app,
            &self.project_hash,
            command,
            Some(self.thread_id.clone()),
            None,
        )?;
        Ok(exit_code == 0)
    }

    fn approval(
        &mut self,
        from_role: &str,
        to_role: &str,
        output: &str,
    ) -> Result<Approval, String> {
        post_thread_summary(
            &self.app,
            &self.project_hash,
            &self.thread_id,
            &format!("Chain `{}` is waiting for your approval after **{from_role}**.", self.chain),
        );
        let (tx, rx) = mpsc::channel();
        self.app
            .state::<Harness>()
            .chain_gates
            .lock()
            .unwrap()
            .insert(self.run_id.clone(), tx);
        let _ = self.app.emit(
            "chain-event",
            ChainEvent {
                run_id: self.run_id.clone(),
                thread_id: self.thread_id.clone(),
                chain: self.chain.clone(),
                role: Some(from_role.to_string()),
                state: None,
                outcome: None,
                awaiting_approval: Some(AwaitingApproval {
                    from: from_role.to_string(),
                    to: to_role.to_string(),
                    output: output.to_string(),
                }),
                session_id: None,
                cost: None,
            },
        );
        // Pauses the run's shared wall clock for as long as this blocks
        // (D12) — a gate nobody ever answers can leave the run open
        // indefinitely; Stop is still observed promptly below.
        let _pause = self.budget.pause();
        let decision = wait_for_approval(&rx, &self.cancel);
        drop(_pause);
        self.app.state::<Harness>().chain_gates.lock_or_recover().remove(&self.run_id);
        decision
    }
}

/// Waits for a gate decision in short slices so the shared run cancellation
/// flag can interrupt it. Kept independent of Tauri for a fast deterministic
/// regression test of the P0 Stop path. Bounded only by cancellation, not by
/// the run's timeout (D12) — the caller has already paused the run's budget
/// for the duration of this wait.
fn wait_for_approval(rx: &mpsc::Receiver<Approval>, cancel: &AtomicBool) -> Result<Approval, String> {
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err("chain run cancelled while awaiting approval".to_string());
        }
        match rx.recv_timeout(CANCEL_POLL) {
            Ok(decision) => return Ok(decision),
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => return Err("the approval gate was torn down".to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::locks::MutexExt;
    use super::*;
    use crate::chain_runner::ChainRun;
    use crate::chains::{ChainEdge, ChainNode, RetryPolicy};

    // -------------------------------------------------------------- D-d: cost

    #[test]
    fn a_recorded_cost_is_returned_for_its_role_and_absent_for_others() {
        let costs = NodeCosts::default();
        costs.record("reviewer", Cost { amount: 0.0043, currency: "USD".into() });
        assert_eq!(costs.get("reviewer"), Some(Cost { amount: 0.0043, currency: "USD".into() }));
        assert_eq!(
            costs.get("auditor"),
            None,
            "a node whose agent never reports cost must read as unknown, never 0.0"
        );
    }

    /// `usage.cost` is already cumulative per ACP session (the schema's own
    /// doc comment: "Total cumulative cost for session"), so a fresh report
    /// replaces the stored value instead of summing onto it.
    #[test]
    fn a_later_report_replaces_rather_than_sums_the_earlier_one() {
        let costs = NodeCosts::default();
        costs.record("reviewer", Cost { amount: 0.001, currency: "USD".into() });
        costs.record("reviewer", Cost { amount: 0.0043, currency: "USD".into() });
        assert_eq!(costs.get("reviewer").unwrap().amount, 0.0043);
    }

    #[test]
    fn approval_wait_returns_cancelled_without_waiting_for_the_full_budget() {
        let (_tx, rx) = mpsc::channel();
        let cancel = Arc::new(AtomicBool::new(false));
        let flips = cancel.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(10));
            flips.store(true, Ordering::SeqCst);
        });

        let started = Instant::now();
        let result = wait_for_approval(&rx, &cancel);
        assert_eq!(result.unwrap_err(), "chain run cancelled while awaiting approval");
        assert!(started.elapsed() < Duration::from_secs(1), "Stop must not wait out the gate budget");
    }

    // ---------------------------------------------------- §4.2: cancellation

    fn node(role: &str) -> ChainNode {
        ChainNode { role: role.into(), guideline: String::new(), agent: "claude-code".into(), model: None, retry: None }
    }

    /// entry -> leaf0, entry -> leaf1; both leaves are sinks, dispatched in
    /// the same round once entry delivers (D10 fan-out).
    fn fan_out_chain() -> Chain {
        Chain {
            name: "cancel-test".into(),
            nodes: HashMap::from([
                ("entry".into(), node("entry")),
                ("leaf0".into(), node("leaf0")),
                ("leaf1".into(), node("leaf1")),
            ]),
            edges: vec![
                ChainEdge { from: "entry".into(), to: "leaf0".into(), gate: None, max_iterations: None },
                ChainEdge { from: "entry".into(), to: "leaf1".into(), gate: None, max_iterations: None },
            ],
            entry: "entry".into(),
            timeout_seconds: 60,
            retry: RetryPolicy { max_attempts: 1 },
            max_parallel: 0,
            layout: HashMap::new(),
        }
    }

    struct NoGates;
    impl GateEvaluator for NoGates {
        fn verify(&mut self, _command: &str) -> Result<bool, String> {
            Ok(true)
        }
        fn approval(&mut self, _from: &str, _to: &str, _output: &str) -> Result<Approval, String> {
            Ok(Approval::Approve)
        }
    }

    /// A minimal stand-in for what `AcpNodeRunner::run_turn` actually does on
    /// cancellation: return promptly instead of blocking out the whole turn.
    /// `AcpNodeRunner` itself needs a live `tauri::AppHandle` to construct
    /// and this codebase has no Tauri mock, so this proves the *contract*
    /// the real implementation follows: a node whose own turn eventually
    /// fails after the run has already decided `Cancelled` elsewhere must
    /// not change that outcome.
    ///
    /// Both leaves block on their own release channel rather than polling —
    /// unlike the real `AcpNodeRunner`, which does poll — because this test
    /// needs `leaf1`'s completion to be *guaranteed* processed before
    /// `leaf0`'s, to prove the scheduler's own top-of-loop cancel check
    /// rather than getting lucky on thread scheduling.
    struct CancelAwareRunner {
        leaf0_started: Mutex<Option<mpsc::Sender<()>>>,
        leaf1_started: Mutex<Option<mpsc::Sender<()>>>,
        leaf0_release: Mutex<Option<mpsc::Receiver<()>>>,
        leaf1_release: Mutex<Option<mpsc::Receiver<()>>>,
        leaf1_done: Mutex<Option<mpsc::Sender<()>>>,
        states: Mutex<Vec<(String, NodeState)>>,
    }

    impl NodeRunner for CancelAwareRunner {
        fn run_turn(&self, role: &str, _instruction: &str, _attempt: u32) -> TurnResult {
            match role {
                "leaf0" => {
                    if let Some(tx) = self.leaf0_started.lock_or_recover().take() {
                        let _ = tx.send(());
                    }
                    if let Some(rx) = self.leaf0_release.lock_or_recover().take() {
                        rx.recv().ok();
                    }
                    Err("cancelled".into())
                }
                "leaf1" => {
                    if let Some(tx) = self.leaf1_started.lock_or_recover().take() {
                        let _ = tx.send(());
                    }
                    // "Finishes right as cancel fires" — a fast agent whose
                    // answer was already on the wire when Stop was pressed.
                    if let Some(rx) = self.leaf1_release.lock_or_recover().take() {
                        rx.recv().ok();
                    }
                    Ok("leaf1 output".into())
                }
                _ => Ok(format!("{role} output")),
            }
        }

        fn on_state(&self, role: &str, state: NodeState) {
            self.states.lock_or_recover().push((role.to_string(), state));
            if role == "leaf1" && state == NodeState::Done {
                if let Some(tx) = self.leaf1_done.lock_or_recover().take() {
                    let _ = tx.send(());
                }
            }
        }
    }

    /// A run whose cancel flag is set mid-flight — with one node still
    /// genuinely executing — ends `Outcome::Cancelled`, naming that node.
    #[test]
    fn a_node_still_executing_when_cancel_fires_ends_the_run_cancelled() {
        let cancel = Arc::new(AtomicBool::new(false));
        let (leaf0_started_tx, leaf0_started_rx) = mpsc::channel();
        let (leaf1_started_tx, leaf1_started_rx) = mpsc::channel();
        let (leaf0_release_tx, leaf0_release_rx) = mpsc::channel();
        let (leaf1_release_tx, leaf1_release_rx) = mpsc::channel();
        let (leaf1_done_tx, leaf1_done_rx) = mpsc::channel();
        let runner = CancelAwareRunner {
            leaf0_started: Mutex::new(Some(leaf0_started_tx)),
            leaf1_started: Mutex::new(Some(leaf1_started_tx)),
            leaf0_release: Mutex::new(Some(leaf0_release_rx)),
            leaf1_release: Mutex::new(Some(leaf1_release_rx)),
            leaf1_done: Mutex::new(Some(leaf1_done_tx)),
            states: Mutex::new(vec![]),
        };
        let mut run = ChainRun::new("run-1", fan_out_chain(), "seed");
        let mut gates = NoGates;

        let outcome = std::thread::scope(|scope| {
            let handle = scope.spawn(|| run.walk(&runner, &mut gates, &cancel));
            // Wait until both leaves are genuinely in flight before
            // cancelling — otherwise cancel could land before either is
            // even dispatched, which isn't the scenario under test.
            leaf0_started_rx.recv().unwrap();
            leaf1_started_rx.recv().unwrap();
            cancel.store(true, Ordering::SeqCst);
            // Let leaf1 finish normally, and wait for confirmation the
            // scheduler actually processed it (its own top-of-loop cancel
            // check runs right after) before letting leaf0's interrupted
            // turn return — pins the ordering instead of hoping for it.
            let _ = leaf1_release_tx.send(());
            leaf1_done_rx.recv().unwrap();
            let _ = leaf0_release_tx.send(());
            handle.join().unwrap()
        });

        assert_eq!(outcome, Outcome::Cancelled { at: vec!["leaf0".to_string()] });
        assert!(
            runner.states.lock_or_recover().contains(&("leaf0".into(), NodeState::Cancelled)),
            "a mid-turn cancellation must remain Cancelled rather than becoming Failed: {:?}",
            runner.states.lock_or_recover()
        );
    }
}
