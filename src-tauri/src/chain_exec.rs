//! Production `NodeRunner`/`GateEvaluator` for `chain_runner.rs` (D26): real
//! `AcpSession`s per node, real `verify` commands per gate, real approval
//! gates resolved by the user.
//!
//! A node's session is a normal session on the invoking thread, so its
//! transcript IS a thread transcript — that's what makes "click a node, see
//! what it actually did" work with no new storage format (D7).

use std::collections::HashMap;
use std::sync::mpsc;
use std::time::Duration;

use serde::Serialize;
use tauri::{Emitter, Manager};

use crate::chain_runner::{Approval, GateEvaluator, NodeRunner, NodeState, Outcome, TurnResult};
use crate::chains::Chain;
use crate::executor::{Harness, TurnEnd, TurnWatch};
use crate::store::Res;

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
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AwaitingApproval {
    pub from: String,
    pub to: String,
}

/// Runs each node turn on a real ACP session pinned to that node's agent.
pub struct AcpNodeRunner {
    app: tauri::AppHandle,
    project_hash: String,
    thread_id: String,
    run_id: String,
    chain: Chain,
    /// Role → its live session. A loop revisiting a role reuses its session,
    /// so the role keeps its own context across iterations; a crashed turn
    /// drops the entry so the retry starts fresh (D21).
    sessions: HashMap<String, String>,
}

impl AcpNodeRunner {
    pub fn new(
        app: tauri::AppHandle,
        project_hash: String,
        thread_id: String,
        run_id: String,
        chain: Chain,
    ) -> Self {
        Self { app, project_hash, thread_id, run_id, chain, sessions: HashMap::new() }
    }

    fn harness(&self) -> tauri::State<'_, Harness> {
        self.app.state::<Harness>()
    }

    /// This role's live session, started if it doesn't have one. Chain-owned,
    /// so `find_live_session` won't hand it to a user's `/go` (D25).
    fn session_for(&mut self, role: &str) -> Res<String> {
        if let Some(id) = self.sessions.get(role) {
            if self.harness().acp_sessions.lock().unwrap().contains_key(id) {
                return Ok(id.clone());
            }
            self.sessions.remove(role);
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
        self.harness().chain_sessions.lock().unwrap().insert(id.clone());
        self.sessions.insert(role.to_string(), id.clone());
        Ok(id)
    }

    /// Drops a role's session when its turn ended badly, so the next attempt
    /// starts a fresh one rather than continuing a contaminated context (D21).
    fn discard_session(&mut self, role: &str) {
        if let Some(id) = self.sessions.remove(role) {
            self.harness().chain_sessions.lock().unwrap().remove(&id);
            self.harness().turn_watchers.lock().unwrap().remove(&id);
            crate::end_session(&self.harness(), &self.thread_id, &id, "crashed");
        }
    }

    /// Releases every session this run started, closing each record idle.
    pub fn release(&mut self) {
        for (_, id) in std::mem::take(&mut self.sessions) {
            self.harness().chain_sessions.lock().unwrap().remove(&id);
            self.harness().turn_watchers.lock().unwrap().remove(&id);
            crate::end_session(&self.harness(), &self.thread_id, &id, "done");
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

/// A turn that produces nothing for this long is treated as a crashed turn
/// rather than hanging the run forever. Well inside the 30-minute run budget
/// (D19), so the run-level timeout still owns the overall ceiling.
const TURN_TIMEOUT: Duration = Duration::from_secs(20 * 60);

impl NodeRunner for AcpNodeRunner {
    fn run_turn(&mut self, role: &str, instruction: &str, _attempt: u32) -> TurnResult {
        let session_id = self.session_for(role)?;

        // Registered before the prompt is sent: an agent that answers fast
        // would otherwise emit Done before anything was listening.
        let (tx, rx) = mpsc::channel();
        let watch = std::sync::Arc::new(TurnWatch::new(tx));
        self.harness().turn_watchers.lock().unwrap().insert(session_id.clone(), watch.clone());

        let sent = crate::send_to(&self.harness(), &self.project_hash, &session_id, instruction);
        if let Err(err) = sent {
            self.harness().turn_watchers.lock().unwrap().remove(&session_id);
            self.discard_session(role);
            return Err(err);
        }

        let end = rx.recv_timeout(TURN_TIMEOUT);
        self.harness().turn_watchers.lock().unwrap().remove(&session_id);
        match end {
            Ok(TurnEnd::Done) => Ok(watch.take_text()),
            Ok(TurnEnd::Crashed(message)) => {
                self.discard_session(role);
                Err(message)
            }
            Err(_) => {
                self.discard_session(role);
                Err(format!("`{role}` produced nothing for {} minutes", TURN_TIMEOUT.as_secs() / 60))
            }
        }
    }

    fn on_state(&mut self, role: &str, state: NodeState) {
        let session_id = self.sessions.get(role).cloned();
        self.emit(ChainEvent {
            role: Some(role.to_string()),
            state: Some(state),
            session_id,
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
    /// The run's wall clock (D18). A gate blocks on a human, so it has to
    /// enforce the budget itself — the walk loop's own check can't run while
    /// the gate is waiting.
    budget: Duration,
}

impl AcpGateEvaluator {
    pub fn new(
        app: tauri::AppHandle,
        project_hash: String,
        thread_id: String,
        run_id: String,
        chain: String,
        budget: Duration,
    ) -> Self {
        Self { app, project_hash, thread_id, run_id, chain, budget }
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

    fn approval(&mut self, from_role: &str, to_role: &str) -> Result<Approval, String> {
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
                }),
                session_id: None,
            },
        );
        // Bounded by the run's own budget: a gate nobody ever answers would
        // otherwise hold the run's thread open forever, since the walk loop's
        // timeout check can't run while this call is blocked.
        let decision = rx.recv_timeout(self.budget).map_err(|err| match err {
            mpsc::RecvTimeoutError::Timeout => format!(
                "nobody answered the approval gate after {from_role} within {} minutes",
                self.budget.as_secs() / 60
            ),
            mpsc::RecvTimeoutError::Disconnected => "the approval gate was torn down".to_string(),
        });
        self.app.state::<Harness>().chain_gates.lock().unwrap().remove(&self.run_id);
        decision
    }
}
