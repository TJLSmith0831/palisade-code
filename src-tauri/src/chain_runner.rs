//! Walks a saved chain (`chains.rs`) as a concurrent frontier: every node
//! whose forward in-edges have all delivered is dispatched at once, one
//! thread per node turn (D10). Run state itself — `node_states`,
//! `iterations` — stays single-threaded; only the node turns run
//! concurrently. Holds run state in memory only — a run interrupted by an
//! app restart is gone, same as any other session (D15).
//!
//! The walk is generic over `NodeRunner`/`GateEvaluator` (D26) so the state
//! machine — gates, loops, caps, timeouts, retries, the barrier — is
//! testable without a live ACP agent. `chain_exec.rs` supplies the
//! production implementations.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::chains::{Chain, ChainEdge, Gate};

/// What one node turn produced, or why it couldn't.
pub type TurnResult = Result<String, String>;

/// Runs a single node turn against a real (or fake) agent session. `&self` +
/// `Send + Sync` because the frontier scheduler dispatches ready nodes
/// concurrently, one OS thread per node turn (D10).
pub trait NodeRunner: Send + Sync {
    /// Runs `role`'s bound agent with `instruction` and returns the text the
    /// node produced. `attempt` is 1-based; a retry gets a fresh session
    /// rather than continuing the crashed one's context (D21).
    fn run_turn(&self, role: &str, instruction: &str, attempt: u32) -> TurnResult;

    /// Called as each node changes state, so the live DAG view can highlight
    /// the executing node (D7). Default no-op keeps tests terse. May be
    /// called from any of the scheduler's node-turn threads.
    fn on_state(&self, _role: &str, _state: NodeState) {}
}

/// Evaluates an edge's gate. Verify gates run a named project `verify`
/// command through the existing mechanism (D8); approval gates come back from
/// the user. Only ever called from the scheduler's single main thread, so
/// this stays `&mut self` — no concurrency to guard against.
pub trait GateEvaluator {
    /// `Ok(true)` when the named command exited 0.
    fn verify(&mut self, command: &str) -> Result<bool, String>;

    /// Blocks until the human decides, or the run is torn down. `output` is
    /// `from_role`'s actual text, carried so the deciding surface can show the
    /// evidence inline rather than only a link to it (PLAN §4.5).
    fn approval(
        &mut self,
        from_role: &str,
        to_role: &str,
        output: &str,
    ) -> Result<Approval, String>;
}

#[derive(Debug, Clone, PartialEq)]
pub enum Approval {
    Approve,
    Reject,
    /// Re-run the upstream node with this note appended to its instruction.
    SendBack(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum NodeState {
    Queued,
    Executing,
    /// A crashed turn being retried; carries the attempt about to start.
    Retrying(u32),
    /// Waiting on a barrier: `met` of `required` forward in-edges have
    /// delivered so far. Without this a fan-in node renders as `Queued` and
    /// looks like the run hung (N2) — it's the reason this variant exists.
    Blocked { met: u32, required: u32 },
    Done,
    Failed,
    /// Torn down mid-turn because the run was cancelled or a sibling failed
    /// first, rather than because this node itself errored.
    Cancelled,
}

/// Why a run stopped. Every terminal state names a reason — a chain never
/// stops silently (D18).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Outcome {
    /// Reached the end of every branch with no outgoing edge left to follow.
    Completed { output: String },
    /// A human rejected at an approval gate (D9).
    Rejected { at: String },
    /// A verify gate on a forward edge failed (D24) — a checkpoint, not a
    /// retry loop, so the run stops here.
    GateFailed { at: String, command: String },
    /// A loop hit its mandatory iteration cap (D3).
    CapReached { at: String, max_iterations: u32 },
    /// The per-run wall clock ran out (D18/D19).
    TimedOut { at: String, after_seconds: u64 },
    /// A node crashed on every allowed attempt (D21).
    RetriesExhausted { at: String, attempts: u32, message: String },
    /// The run was cancelled (a user's Stop, or a sibling's failure) while
    /// one or more nodes were mid-turn. Plural — several nodes can be in
    /// flight at once now that the frontier runs concurrently.
    Cancelled { at: Vec<String> },
    /// Something stopped the run before it could walk — a bound agent that
    /// isn't installed (D17), an invalid definition.
    Blocked { reason: String },
}

/// One in-flight run. Deliberately not persisted (D15).
#[derive(Debug)]
pub struct ChainRun {
    pub id: String,
    pub chain: Chain,
    pub seed: String,
    /// Role → how many times it has produced output. Drives the loop cap.
    pub iterations: HashMap<String, u32>,
    pub node_states: HashMap<String, NodeState>,
    started: Instant,
    timeout: Duration,
}

impl ChainRun {
    pub fn new(id: impl Into<String>, chain: Chain, seed: impl Into<String>) -> Self {
        let timeout = Duration::from_secs(chain.timeout_seconds);
        let node_states = chain.nodes.keys().map(|role| (role.clone(), NodeState::Queued)).collect();
        Self {
            id: id.into(),
            chain,
            seed: seed.into(),
            iterations: HashMap::new(),
            node_states,
            started: Instant::now(),
            timeout,
        }
    }

    /// Overrides the wall clock — tests need a run that can time out inside a
    /// test's lifetime.
    #[cfg(test)]
    fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    fn elapsed(&self) -> Duration {
        self.started.elapsed()
    }

    /// Walks the graph until every branch drains or a terminal outcome
    /// fires. `cancel` is checked before each dispatch round and between
    /// completions — Wave B wires it to a real `Arc<AtomicBool>` shared with
    /// the `cancel_chain_run` IPC command; tests pass a local one that never
    /// flips.
    pub fn walk<R: NodeRunner, G: GateEvaluator>(
        &mut self,
        runner: &R,
        gates: &mut G,
        cancel: &AtomicBool,
    ) -> Outcome {
        let entry = self.chain.entry.clone();
        self.walk_from(runner, gates, cancel, &entry, vec![])
    }

    /// Runs a stored definition from `start_role`, treating `initial_inputs`
    /// as already-delivered forward-edge outputs. This is the runner half of
    /// history replay: callers validate that the inputs cover every required
    /// predecessor before launching, then the normal frontier scheduler takes
    /// over unchanged for the chosen node and all of its downstream work.
    pub fn walk_from<R: NodeRunner, G: GateEvaluator>(
        &mut self,
        runner: &R,
        gates: &mut G,
        cancel: &AtomicBool,
        start_role: &str,
        initial_inputs: Vec<(String, String)>,
    ) -> Outcome {
        if !self.chain.nodes.contains_key(start_role) {
            return Outcome::Blocked { reason: format!("chain has no node `{start_role}`") };
        }
        let loop_edges = self.chain.loop_edges();

        // Barrier requirement per role: how many *forward* (non-loop) in-edges
        // it has. Loop-closing edges never count here — counting them would
        // deadlock the head of every loop against its own back edge, since
        // the back edge's delivery only exists after the loop body (which
        // needs the head to have already run) completes. This is the single
        // most important invariant in the scheduler; see
        // `a_loop_heads_barrier_ignores_its_own_back_edge` below.
        let mut required: HashMap<String, u32> = self.chain.nodes.keys().map(|r| (r.clone(), 0)).collect();
        for (index, edge) in self.chain.edges.iter().enumerate() {
            if !loop_edges.contains(&index) {
                *required.entry(edge.to.clone()).or_insert(0) += 1;
            }
        }

        let mut met: HashMap<String, u32> = self.chain.nodes.keys().map(|r| (r.clone(), 0)).collect();
        let mut inputs: HashMap<String, Vec<(String, String)>> = HashMap::new();
        let mut notes: HashMap<String, String> = HashMap::new();
        let mut sinks: HashMap<String, String> = HashMap::new();
        // The normal entry begins with no predecessors and therefore no
        // recorded inputs. A history replay begins at an interior node with
        // its persisted predecessor outputs pre-delivered; its ancestors are
        // intentionally absent from `ready`, so they can never spend turns.
        met.insert(start_role.to_string(), initial_inputs.len() as u32);
        if !initial_inputs.is_empty() {
            inputs.insert(start_role.to_string(), initial_inputs);
        }
        let mut ready: Vec<String> = vec![start_role.to_string()];
        let mut in_flight: HashSet<String> = HashSet::new();
        let mut first_failure: Option<Outcome> = None;
        // Internal abort, distinct from the caller's `cancel`: flips the
        // moment a terminal outcome is decided (a sibling's failure, or the
        // caller's cancel request) so in-flight node threads stop retrying
        // and new dispatch halts, while `thread::scope` still waits for every
        // spawned thread to unwind before `walk` returns — no ACP session
        // outlives the run.
        let abort = Arc::new(AtomicBool::new(false));

        std::thread::scope(|scope| {
            let (tx, rx) = mpsc::channel::<(String, Result<String, Outcome>)>();

            loop {
                if cancel.load(Ordering::SeqCst) && first_failure.is_none() {
                    abort.store(true, Ordering::SeqCst);
                    let mut at: Vec<String> = in_flight.iter().cloned().collect();
                    at.sort();
                    first_failure = Some(Outcome::Cancelled { at });
                    ready.clear();
                }

                while first_failure.is_none()
                    && !ready.is_empty()
                    && (self.chain.max_parallel == 0 || (in_flight.len() as u32) < self.chain.max_parallel)
                {
                    if self.elapsed() > self.timeout {
                        let role = ready[0].clone();
                        self.mark(runner, &role, NodeState::Failed);
                        first_failure = Some(Outcome::TimedOut { at: role, after_seconds: self.timeout.as_secs() });
                        break;
                    }
                    let role = ready.remove(0);
                    let Some(node) = self.chain.nodes.get(&role).cloned() else {
                        first_failure = Some(Outcome::Blocked { reason: format!("chain has no node `{role}`") });
                        break;
                    };
                    let upstream = inputs.remove(&role).unwrap_or_default();
                    let note = notes.remove(&role);
                    let instruction = compose_instruction(&node.guideline, &self.seed, &upstream, note.as_deref());
                    self.set_state(&role, NodeState::Executing);

                    let max_attempts = self.chain.retry_for(&role).max_attempts.max(1);
                    let deadline = self.started + self.timeout;
                    let timeout_secs = self.timeout.as_secs();
                    in_flight.insert(role.clone());

                    let tx = tx.clone();
                    let abort = Arc::clone(&abort);
                    let role_for_thread = role.clone();
                    scope.spawn(move || {
                        let result =
                            run_node_turn(runner, &role_for_thread, &instruction, max_attempts, deadline, timeout_secs, &abort);
                        let _ = tx.send((role_for_thread, result));
                    });
                }

                if first_failure.is_some() {
                    abort.store(true, Ordering::SeqCst);
                    ready.clear();
                }

                if in_flight.is_empty() {
                    return match first_failure.take() {
                        Some(outcome) => outcome,
                        None => self.finish(sinks),
                    };
                }

                let (role, result) = rx.recv().expect("a node-turn thread dropped its sender before completing");
                in_flight.remove(&role);

                match result {
                    Ok(output) => {
                        *self.iterations.entry(role.clone()).or_insert(0) += 1;
                        self.mark(runner, &role, NodeState::Done);

                        if first_failure.is_some() {
                            // A sibling that was already mid-turn when the
                            // first failure landed can still finish for real
                            // (its ACP call was in flight and ran to
                            // completion) — but the run is already deciding
                            // to stop, so this output must not resurrect
                            // dispatch or change the outcome. Record the
                            // completion and move on; `thread::scope` still
                            // waits for it before `walk` returns.
                            continue;
                        }

                        let edges: Vec<ChainEdge> = self.chain.outgoing(&role).cloned().collect();
                        let mut advanced = false;
                        for edge in &edges {
                            let is_loop = self.is_loop(edge);
                            match self.cross(gates, edge, is_loop, &output) {
                                Crossing::Advance => {
                                    advanced = true;
                                    inputs.entry(edge.to.clone()).or_default().push((role.clone(), output.clone()));
                                    let m = {
                                        let slot = met.entry(edge.to.clone()).or_insert(0);
                                        *slot += 1;
                                        *slot
                                    };
                                    let req = *required.get(&edge.to).unwrap_or(&0);
                                    if m >= req {
                                        if !ready.contains(&edge.to) && !in_flight.contains(&edge.to) {
                                            ready.push(edge.to.clone());
                                        }
                                    } else {
                                        self.mark(runner, &edge.to, NodeState::Blocked { met: m, required: req });
                                    }
                                }
                                // A passed gate on a loop edge means the loop
                                // is done for this branch, not that the walk
                                // goes backwards (D3, tasks 4.1). It does not
                                // deliver anywhere; if nothing else does
                                // either, this node is a sink.
                                Crossing::ExitLoop => {}
                                Crossing::Repeat(back_to) => {
                                    let cap = edge.max_iterations.unwrap_or(u32::MAX);
                                    if self.iterations.get(&back_to).copied().unwrap_or(0) >= cap {
                                        self.mark(runner, &role, NodeState::Failed);
                                        first_failure = Some(Outcome::CapReached { at: back_to, max_iterations: cap });
                                        break;
                                    }
                                    advanced = true;
                                    self.reset_subtree(&back_to, &loop_edges, &mut met, &mut inputs, &mut sinks, &mut ready, &in_flight);
                                    inputs.entry(back_to.clone()).or_default().push((role.clone(), output.clone()));
                                    if !ready.contains(&back_to) {
                                        ready.push(back_to.clone());
                                    }
                                }
                                Crossing::SendBack(back_to, human_note) => {
                                    let cap = edge.max_iterations.unwrap_or(u32::MAX);
                                    if self.iterations.get(&back_to).copied().unwrap_or(0) >= cap {
                                        self.mark(runner, &role, NodeState::Failed);
                                        first_failure = Some(Outcome::CapReached { at: back_to, max_iterations: cap });
                                        break;
                                    }
                                    advanced = true;
                                    self.reset_subtree(&back_to, &loop_edges, &mut met, &mut inputs, &mut sinks, &mut ready, &in_flight);
                                    inputs.entry(back_to.clone()).or_default().push((role.clone(), output.clone()));
                                    notes.insert(back_to.clone(), human_note);
                                    if !ready.contains(&back_to) {
                                        ready.push(back_to.clone());
                                    }
                                }
                                Crossing::Stop(outcome) => {
                                    // An approval evaluator observes the
                                    // same shared cancellation flag. Its
                                    // cancellation error must terminate as
                                    // Cancelled, not masquerade as a generic
                                    // blocked/failed gate outcome.
                                    if cancel.load(Ordering::SeqCst) {
                                        self.mark(runner, &role, NodeState::Cancelled);
                                        first_failure = Some(Outcome::Cancelled { at: vec![role.clone()] });
                                    } else {
                                        self.mark(runner, &role, NodeState::Failed);
                                        first_failure = Some(outcome);
                                    }
                                    break;
                                }
                            }
                        }
                        if first_failure.is_none() && !advanced {
                            sinks.insert(role.clone(), output);
                        }
                    }
                    Err(outcome) => {
                        // `run_node_turn` already reported the terminal
                        // per-node state (Failed or Cancelled) through
                        // `on_state`; mirror it into `node_states` here since
                        // that write has to happen on this single thread.
                        let state =
                            if matches!(outcome, Outcome::Cancelled { .. }) { NodeState::Cancelled } else { NodeState::Failed };
                        self.set_state(&role, state);
                        if first_failure.is_none() {
                            first_failure = Some(outcome);
                        }
                    }
                }

                if first_failure.is_some() {
                    abort.store(true, Ordering::SeqCst);
                    ready.clear();
                }
            }
        })
    }

    /// Concatenates the outputs of every node that had nowhere left to go —
    /// no outgoing edge, or every outgoing edge either failed to deliver
    /// (`ExitLoop`) or was never reached. A single sink keeps the exact
    /// unlabeled wording every pre-existing test expects; several sinks are
    /// labeled by role and ordered by role name, same rule as
    /// `compose_instruction`'s multi-upstream list, so the result is
    /// deterministic (D10).
    fn finish(&self, sinks: HashMap<String, String>) -> Outcome {
        if sinks.len() <= 1 {
            let output = sinks.into_values().next().unwrap_or_default();
            return Outcome::Completed { output };
        }
        let mut roles: Vec<&String> = sinks.keys().collect();
        roles.sort();
        let output = roles.iter().map(|role| format!("{role}: {}", sinks[*role])).collect::<Vec<_>>().join("\n\n");
        Outcome::Completed { output }
    }

    /// A loop re-entry resets every barrier tally reachable (by forward
    /// edges) from `back_to`, so the second iteration waits for its own
    /// fresh deliveries instead of seeing the first iteration's satisfied
    /// edges and running early or not at all.
    fn reset_subtree(
        &self,
        back_to: &str,
        loop_edges: &HashSet<usize>,
        met: &mut HashMap<String, u32>,
        inputs: &mut HashMap<String, Vec<(String, String)>>,
        sinks: &mut HashMap<String, String>,
        ready: &mut Vec<String>,
        in_flight: &HashSet<String>,
    ) {
        let mut stack = vec![back_to.to_string()];
        let mut seen: HashSet<String> = HashSet::new();
        while let Some(role) = stack.pop() {
            if !seen.insert(role.clone()) {
                continue;
            }
            met.insert(role.clone(), 0);
            inputs.remove(&role);
            sinks.remove(&role);
            if role != back_to {
                ready.retain(|r| r != &role);
            }
            for (index, edge) in self.chain.edges.iter().enumerate() {
                if edge.from == role && !loop_edges.contains(&index) && !in_flight.contains(&edge.to) {
                    stack.push(edge.to.clone());
                }
            }
        }
    }

    fn is_loop(&self, edge: &ChainEdge) -> bool {
        self.chain
            .loop_edges()
            .iter()
            .any(|i| self.chain.edges.get(*i).is_some_and(|e| e.from == edge.from && e.to == edge.to))
    }

    /// What crossing this edge does, once its gate (if any) has spoken.
    fn cross<G: GateEvaluator>(
        &mut self,
        gates: &mut G,
        edge: &ChainEdge,
        is_loop: bool,
        output: &str,
    ) -> Crossing {
        let Some(gate) = &edge.gate else {
            // An ungated loop edge can't reach here — validation rejects it
            // (D3) — so an absent gate always means a plain forward pipe.
            return Crossing::Advance;
        };
        match gate {
            Gate::Verify { command } => match gates.verify(command) {
                Ok(true) if is_loop => Crossing::ExitLoop,
                Ok(true) => Crossing::Advance,
                Ok(false) if is_loop => Crossing::Repeat(edge.to.clone()),
                // D24: a failed verify on a forward edge is a checkpoint
                // failure, not an uncapped repeat.
                Ok(false) => Crossing::Stop(Outcome::GateFailed {
                    at: edge.from.clone(),
                    command: command.clone(),
                }),
                Err(err) => Crossing::Stop(Outcome::Blocked { reason: err }),
            },
            Gate::Approval => match gates.approval(&edge.from, &edge.to, output) {
                Ok(Approval::Approve) if is_loop => Crossing::ExitLoop,
                Ok(Approval::Approve) => Crossing::Advance,
                Ok(Approval::Reject) => Crossing::Stop(Outcome::Rejected { at: edge.from.clone() }),
                // Send back re-runs the node the human just judged, which is
                // `edge.from` on a forward edge. On a loop edge the judged
                // node is the loop's tail and `edge.to` is the body it goes
                // back to, same target `Repeat` uses. Using `edge.to`
                // unconditionally made "send back" on a forward edge advance
                // to the *next* node with the note attached — the opposite of
                // sending the work back.
                Ok(Approval::SendBack(note)) => Crossing::SendBack(
                    if is_loop { edge.to.clone() } else { edge.from.clone() },
                    note,
                ),
                Err(err) => Crossing::Stop(Outcome::Blocked { reason: err }),
            },
        }
    }

    fn set_state(&mut self, role: &str, state: NodeState) {
        self.node_states.insert(role.to_string(), state);
    }

    fn mark<R: NodeRunner>(&mut self, runner: &R, role: &str, state: NodeState) {
        self.set_state(role, state);
        runner.on_state(role, state);
    }
}

enum Crossing {
    /// Follow the edge to its target.
    Advance,
    /// A satisfied loop gate: the loop is finished for this branch.
    ExitLoop,
    /// Go back around the loop to this role.
    Repeat(String),
    /// Go back to this role, carrying the human's note.
    SendBack(String, String),
    Stop(Outcome),
}

/// One node turn, retried on crash up to `max_attempts` (D21). Each attempt
/// is a fresh turn rather than a continuation, so a failed attempt's output
/// never contaminates the retry's context. Runs on its own thread inside the
/// scheduler's `thread::scope`, so it takes everything it needs by value or
/// shared reference rather than touching `ChainRun`.
fn run_node_turn<R: NodeRunner>(
    runner: &R,
    role: &str,
    instruction: &str,
    max_attempts: u32,
    deadline: Instant,
    timeout_secs: u64,
    abort: &AtomicBool,
) -> Result<String, Outcome> {
    let mut last = String::new();
    for attempt in 1..=max_attempts {
        if abort.load(Ordering::SeqCst) {
            runner.on_state(role, NodeState::Cancelled);
            return Err(Outcome::Cancelled { at: vec![role.to_string()] });
        }
        let state = if attempt == 1 { NodeState::Executing } else { NodeState::Retrying(attempt) };
        runner.on_state(role, state);
        match runner.run_turn(role, instruction, attempt) {
            Ok(output) => return Ok(output),
            Err(message) => {
                // A real ACP turn may notice Stop by returning an error after
                // the scheduler has already set `abort`. Preserve the honest
                // cancellation state rather than falling through to the
                // retry-exhausted `Failed` state below.
                if abort.load(Ordering::SeqCst) {
                    runner.on_state(role, NodeState::Cancelled);
                    return Err(Outcome::Cancelled { at: vec![role.to_string()] });
                }
                last = message;
            }
        }
        // A retry that would outlive the run's budget is not worth
        // starting — report the timeout, which is the truer reason.
        if Instant::now() > deadline {
            runner.on_state(role, NodeState::Failed);
            return Err(Outcome::TimedOut { at: role.into(), after_seconds: timeout_secs });
        }
    }
    if abort.load(Ordering::SeqCst) {
        runner.on_state(role, NodeState::Cancelled);
        Err(Outcome::Cancelled { at: vec![role.to_string()] })
    } else {
        runner.on_state(role, NodeState::Failed);
        Err(Outcome::RetriesExhausted { at: role.into(), attempts: max_attempts, message: last })
    }
}

/// D23: the guideline shapes *how* the node acts on the seed and its
/// upstream's output — it doesn't replace either. The first node has no
/// upstream segment; a send-back appends the human's note rather than
/// inventing a fourth input channel (D9). With a fan-in (D10), every upstream
/// output renders as a labeled list, ordered by role name so the prompt is
/// deterministic regardless of completion order; a single upstream keeps the
/// exact wording every pre-existing test and prompt already relies on.
pub fn compose_instruction(
    guideline: &str,
    seed: &str,
    upstream: &[(String, String)],
    note: Option<&str>,
) -> String {
    let mut out = String::new();
    if !guideline.trim().is_empty() {
        out.push_str(guideline.trim());
        out.push_str("\n\n---\n\n");
    }
    out.push_str(&format!("Original request: {}", seed.trim()));
    match upstream {
        [] => {}
        [(from_role, output)] => {
            out.push_str(&format!("\n\nPrevious step output ({from_role}): {output}"));
        }
        many => {
            let mut sorted: Vec<&(String, String)> = many.iter().collect();
            sorted.sort_by(|a, b| a.0.cmp(&b.0));
            out.push_str("\n\nPrevious step output:");
            for (from_role, output) in sorted {
                out.push_str(&format!("\n- {from_role}: {output}"));
            }
        }
    }
    if let Some(note) = note {
        out.push_str(&format!("\n\nHuman note: {note}"));
    }
    out
}

/// "30-minute" for a normal budget, "45-second" for a short one — dividing
/// straight to minutes reported a 1-second timeout as a "0-minute limit".
fn humanize_seconds(seconds: u64) -> String {
    if seconds < 60 {
        format!("{seconds}-second")
    } else {
        format!("{}-minute", seconds / 60)
    }
}

/// One line naming what happened, for the invoking thread's history (D7).
/// The DAG view has the detail; this is what a reader of the conversation
/// sees. Every branch states a reason — a chain never reports a silent stop.
pub fn describe(outcome: &Outcome) -> String {
    match outcome {
        Outcome::Completed { .. } => "finished.".into(),
        Outcome::Rejected { at } => format!("rejected at **{at}**."),
        Outcome::GateFailed { at, command } => {
            format!("stopped after **{at}**: `{command}` did not pass.")
        }
        Outcome::CapReached { at, max_iterations } => {
            format!("stopped: the loop through **{at}** hit its cap of {max_iterations}.")
        }
        Outcome::TimedOut { at, after_seconds } => {
            format!("stopped at **{at}**: past its {} limit.", humanize_seconds(*after_seconds))
        }
        Outcome::RetriesExhausted { at, attempts, message } => {
            format!("stopped at **{at}** after {attempts} attempts: {message}")
        }
        Outcome::Cancelled { at } => format!("stopped: cancelled while running **{}**.", at.join(", ")),
        Outcome::Blocked { reason } => format!("could not run: {reason}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chains::{ChainNode, RetryPolicy};
    use std::collections::HashMap;
    use std::sync::Mutex;

    /// Replays scripted turn results in order, recording what it was asked.
    /// `&self` + interior mutability because `NodeRunner` now runs
    /// concurrently across threads (D10).
    struct FakeRunner {
        script: Mutex<HashMap<String, Vec<TurnResult>>>,
        calls: Mutex<Vec<(String, String, u32)>>,
        states: Mutex<Vec<(String, NodeState)>>,
    }

    impl FakeRunner {
        fn new(script: &[(&str, Vec<TurnResult>)]) -> Self {
            Self {
                script: Mutex::new(script.iter().map(|(r, v)| (r.to_string(), v.clone())).collect()),
                calls: Mutex::new(Vec::new()),
                states: Mutex::new(Vec::new()),
            }
        }
        /// Always succeeds, echoing "<role> output".
        fn echoing() -> Self {
            Self { script: Mutex::new(HashMap::new()), calls: Mutex::new(Vec::new()), states: Mutex::new(Vec::new()) }
        }
        fn calls(&self) -> Vec<(String, String, u32)> {
            self.calls.lock().unwrap().clone()
        }
        fn states(&self) -> Vec<(String, NodeState)> {
            self.states.lock().unwrap().clone()
        }
    }

    impl NodeRunner for FakeRunner {
        fn run_turn(&self, role: &str, instruction: &str, attempt: u32) -> TurnResult {
            let mut calls = self.calls.lock().unwrap();
            calls.push((role.into(), instruction.into(), attempt));
            let taken = calls.iter().filter(|(r, _, _)| r == role).count();
            drop(calls);
            let script = self.script.lock().unwrap();
            match script.get(role) {
                Some(results) if !results.is_empty() => results[(taken - 1).min(results.len() - 1)].clone(),
                _ => Ok(format!("{role} output")),
            }
        }
        fn on_state(&self, role: &str, state: NodeState) {
            self.states.lock().unwrap().push((role.into(), state));
        }
    }

    /// Blocks on `hold`'s first turn until released, so a test can prove a
    /// downstream barrier hasn't run while `hold` is still in flight.
    struct BarrierRunner {
        hold: String,
        release: Mutex<Option<mpsc::Receiver<()>>>,
        inner: FakeRunner,
    }

    impl BarrierRunner {
        fn new(hold: &str, release: mpsc::Receiver<()>) -> Self {
            Self { hold: hold.into(), release: Mutex::new(Some(release)), inner: FakeRunner::echoing() }
        }
        fn calls(&self) -> Vec<(String, String, u32)> {
            self.inner.calls()
        }
        fn states(&self) -> Vec<(String, NodeState)> {
            self.inner.states()
        }
    }

    impl NodeRunner for BarrierRunner {
        fn run_turn(&self, role: &str, instruction: &str, attempt: u32) -> TurnResult {
            if role == self.hold {
                // Only the first caller actually waits; a retry (not
                // exercised by the tests that use this fake) would otherwise
                // block on an already-drained receiver.
                if let Some(rx) = self.release.lock().unwrap().take() {
                    rx.recv().ok();
                }
            }
            self.inner.run_turn(role, instruction, attempt)
        }
        fn on_state(&self, role: &str, state: NodeState) {
            self.inner.on_state(role, state);
        }
    }

    /// Counts how many turns are running at once, so `maxParallel` can be
    /// verified rather than assumed.
    struct ConcurrencyProbe {
        current: std::sync::atomic::AtomicU32,
        max_seen: std::sync::atomic::AtomicU32,
        hold: Duration,
    }

    impl ConcurrencyProbe {
        fn new(hold: Duration) -> Self {
            Self { current: std::sync::atomic::AtomicU32::new(0), max_seen: std::sync::atomic::AtomicU32::new(0), hold }
        }
        fn max_concurrent(&self) -> u32 {
            self.max_seen.load(Ordering::SeqCst)
        }
    }

    impl NodeRunner for ConcurrencyProbe {
        fn run_turn(&self, role: &str, _instruction: &str, _attempt: u32) -> TurnResult {
            let now = self.current.fetch_add(1, Ordering::SeqCst) + 1;
            self.max_seen.fetch_max(now, Ordering::SeqCst);
            std::thread::sleep(self.hold);
            self.current.fetch_sub(1, Ordering::SeqCst);
            Ok(format!("{role} output"))
        }
    }

    /// Lets a test hold `auditor`'s very first attempt open (past its abort
    /// check, so it's guaranteed to actually call `run_turn` once) and hold
    /// `reviewer`'s single attempt open too, so the test can sequence:
    /// auditor enters its blocked first attempt -> reviewer is released and
    /// fails -> only once that failure has landed is auditor released to
    /// return, at which point it must notice the abort before a second
    /// attempt rather than racing it.
    struct SiblingAbortRunner {
        auditor_started: Mutex<Option<mpsc::Sender<()>>>,
        auditor_proceed: Mutex<Option<mpsc::Receiver<()>>>,
        reviewer_proceed: Mutex<Option<mpsc::Receiver<()>>>,
        inner: FakeRunner,
    }

    impl NodeRunner for SiblingAbortRunner {
        fn run_turn(&self, role: &str, instruction: &str, attempt: u32) -> TurnResult {
            if role == "auditor" && attempt == 1 {
                if let Some(tx) = self.auditor_started.lock().unwrap().take() {
                    let _ = tx.send(());
                }
                if let Some(rx) = self.auditor_proceed.lock().unwrap().take() {
                    rx.recv().ok();
                }
            }
            if role == "reviewer" {
                if let Some(rx) = self.reviewer_proceed.lock().unwrap().take() {
                    rx.recv().ok();
                }
            }
            self.inner.run_turn(role, instruction, attempt)
        }
        fn on_state(&self, role: &str, state: NodeState) {
            self.inner.on_state(role, state);
        }
    }

    /// Replays scripted gate decisions in order.
    struct FakeGates {
        verify: Vec<Result<bool, String>>,
        approval: Vec<Result<Approval, String>>,
        pub verify_calls: Vec<String>,
        /// Every `(from, output)` an approval gate was handed, so a test can
        /// prove the deciding surface receives the evidence, not just a link.
        pub approval_outputs: Vec<(String, String)>,
    }

    impl FakeGates {
        fn none() -> Self {
            Self { verify: Vec::new(), approval: Vec::new(), verify_calls: Vec::new(), approval_outputs: Vec::new() }
        }
        fn verifying(results: Vec<Result<bool, String>>) -> Self {
            Self { verify: results, approval: Vec::new(), verify_calls: Vec::new(), approval_outputs: Vec::new() }
        }
        fn approving(results: Vec<Result<Approval, String>>) -> Self {
            Self { verify: Vec::new(), approval: results, verify_calls: Vec::new(), approval_outputs: Vec::new() }
        }
    }

    impl GateEvaluator for FakeGates {
        fn verify(&mut self, command: &str) -> Result<bool, String> {
            self.verify_calls.push(command.into());
            if self.verify.is_empty() {
                return Ok(true);
            }
            Ok(self.verify.remove(0)?)
        }
        fn approval(&mut self, from: &str, _to: &str, output: &str) -> Result<Approval, String> {
            self.approval_outputs.push((from.into(), output.into()));
            if self.approval.is_empty() {
                return Ok(Approval::Approve);
            }
            self.approval.remove(0)
        }
    }

    fn no_cancel() -> AtomicBool {
        AtomicBool::new(false)
    }

    fn node(role: &str) -> ChainNode {
        ChainNode {
            role: role.into(),
            guideline: format!("You are the {role}."),
            agent: "claude-code".into(),
            model: None,
            retry: None,
        }
    }

    fn two_node_chain(edges: Vec<ChainEdge>) -> Chain {
        Chain {
            name: "design-loop".into(),
            nodes: HashMap::from([
                ("designer".into(), node("designer")),
                ("programmer".into(), node("programmer")),
            ]),
            edges,
            entry: "designer".into(),
            timeout_seconds: 1800,
            retry: RetryPolicy { max_attempts: 1 },
            max_parallel: 0,
            layout: HashMap::new(),
        }
    }

    fn forward() -> ChainEdge {
        ChainEdge { from: "designer".into(), to: "programmer".into(), gate: None, max_iterations: None }
    }

    fn back(gate: Gate, cap: u32) -> ChainEdge {
        ChainEdge {
            from: "programmer".into(),
            to: "designer".into(),
            gate: Some(gate),
            max_iterations: Some(cap),
        }
    }

    fn edge(from: &str, to: &str) -> ChainEdge {
        ChainEdge { from: from.into(), to: to.into(), gate: None, max_iterations: None }
    }

    fn run(chain: Chain) -> ChainRun {
        ChainRun::new("run-1", chain, "build me a settings page")
    }

    #[test]
    fn rerun_from_a_node_runs_only_that_node_and_downstream_with_recorded_fan_in() {
        let mut chain = two_node_chain(vec![]);
        chain.nodes = ["scout", "reviewer", "auditor", "judge"]
            .into_iter()
            .map(|role| (role.to_string(), node(role)))
            .collect();
        chain.entry = "scout".into();
        chain.edges = vec![
            edge("scout", "reviewer"),
            edge("scout", "auditor"),
            edge("reviewer", "judge"),
            edge("auditor", "judge"),
        ];
        let runner = FakeRunner::echoing();
        let mut gates = FakeGates::none();
        let cancel = AtomicBool::new(false);

        let outcome = ChainRun::new("rerun-1", chain, "seed").walk_from(
            &runner,
            &mut gates,
            &cancel,
            "judge",
            vec![("reviewer".into(), "review output".into()), ("auditor".into(), "audit output".into())],
        );

        assert_eq!(outcome, Outcome::Completed { output: "judge output".into() });
        let calls = runner.calls();
        assert_eq!(calls.iter().map(|(role, _, _)| role.as_str()).collect::<Vec<_>>(), ["judge"]);
        let instruction = &calls[0].1;
        assert!(instruction.contains("- auditor: audit output"), "{instruction}");
        assert!(instruction.contains("- reviewer: review output"), "{instruction}");
    }

    /// `entry` fans out to `n` leaf nodes with no edges of their own, so all
    /// `n` are ready in the same dispatch round.
    fn fan_out_chain(n: usize, max_parallel: u32) -> Chain {
        let mut nodes = HashMap::from([("entry".to_string(), node("entry"))]);
        let mut edges = Vec::new();
        for i in 0..n {
            let role = format!("leaf{i}");
            nodes.insert(role.clone(), node(&role));
            edges.push(edge("entry", &role));
        }
        Chain {
            name: "fan-out".into(),
            nodes,
            edges,
            entry: "entry".into(),
            timeout_seconds: 1800,
            retry: RetryPolicy { max_attempts: 1 },
            max_parallel,
            layout: HashMap::new(),
        }
    }

    /// scout -> reviewer, scout -> auditor, reviewer -> judge, auditor ->
    /// judge. No loop. Used by the fan-out/barrier tests.
    fn fan_in_chain(extra_edges: Vec<ChainEdge>) -> Chain {
        let mut edges = vec![edge("scout", "reviewer"), edge("scout", "auditor"), edge("reviewer", "judge"), edge("auditor", "judge")];
        edges.extend(extra_edges);
        Chain {
            name: "fan-in".into(),
            nodes: HashMap::from([
                ("scout".into(), node("scout")),
                ("reviewer".into(), node("reviewer")),
                ("auditor".into(), node("auditor")),
                ("judge".into(), node("judge")),
            ]),
            edges,
            entry: "scout".into(),
            timeout_seconds: 1800,
            retry: RetryPolicy { max_attempts: 1 },
            max_parallel: 0,
            layout: HashMap::new(),
        }
    }

    // ------------------------------------------------- instruction composition

    #[test]
    fn the_first_node_gets_no_upstream_segment() {
        let text = compose_instruction("You are the designer.", "build a page", &[], None);
        assert!(text.starts_with("You are the designer.\n\n---\n\n"));
        assert!(text.contains("Original request: build a page"));
        assert!(!text.contains("Previous step output"));
    }

    #[test]
    fn a_downstream_node_gets_guideline_seed_and_upstream_output() {
        let text = compose_instruction(
            "You are the programmer.",
            "build a page",
            &[("designer".into(), "here is the layout".into())],
            None,
        );
        assert!(text.contains("You are the programmer."));
        assert!(text.contains("Original request: build a page"));
        assert!(text.contains("Previous step output (designer): here is the layout"));
    }

    #[test]
    fn a_send_back_note_is_appended_not_substituted() {
        let text =
            compose_instruction("g", "seed", &[("a".into(), "out".into())], Some("use bigger type"));
        assert!(text.contains("Original request: seed"));
        assert!(text.contains("Previous step output (a): out"));
        assert!(text.trim_end().ends_with("Human note: use bigger type"));
    }

    #[test]
    fn an_empty_guideline_leaves_no_dangling_separator() {
        let text = compose_instruction("   ", "seed", &[], None);
        assert_eq!(text, "Original request: seed");
    }

    /// D10/D23: a barrier node's instruction lists every upstream output,
    /// labeled by producing role, ordered by role name regardless of which
    /// one finished first — the merge has to be deterministic.
    #[test]
    fn multiple_upstream_outputs_render_as_a_deterministic_labeled_list() {
        let in_one_order = compose_instruction(
            "g",
            "seed",
            &[("auditor".into(), "style is fine".into()), ("reviewer".into(), "off-by-one risk".into())],
            None,
        );
        let in_the_other_order = compose_instruction(
            "g",
            "seed",
            &[("reviewer".into(), "off-by-one risk".into()), ("auditor".into(), "style is fine".into())],
            None,
        );
        assert_eq!(in_one_order, in_the_other_order, "merge order must not depend on arrival order");
        assert!(in_one_order.contains("Previous step output:\n- auditor: style is fine\n- reviewer: off-by-one risk"));
        // Reviewer sorts after auditor, so it must appear second regardless
        // of delivery order.
        let auditor_pos = in_one_order.find("- auditor").unwrap();
        let reviewer_pos = in_one_order.find("- reviewer").unwrap();
        assert!(auditor_pos < reviewer_pos);
    }

    // --------------------------------------------------------- forward walking

    #[test]
    fn a_two_node_forward_chain_runs_both_nodes_in_order_and_completes() {
        let r = FakeRunner::echoing();
        let outcome = run(two_node_chain(vec![forward()])).walk(&r, &mut FakeGates::none(), &no_cancel());
        assert_eq!(outcome, Outcome::Completed { output: "programmer output".into() });
        let calls = r.calls();
        let roles: Vec<&str> = calls.iter().map(|(role, _, _)| role.as_str()).collect();
        assert_eq!(roles, ["designer", "programmer"]);
    }

    #[test]
    fn the_second_nodes_instruction_carries_the_first_nodes_output() {
        let r = FakeRunner::echoing();
        run(two_node_chain(vec![forward()])).walk(&r, &mut FakeGates::none(), &no_cancel());
        let calls = r.calls();
        let (_, instruction, _) = &calls[1];
        assert!(instruction.contains("Previous step output (designer): designer output"), "{instruction}");
        assert!(instruction.contains("Original request: build me a settings page"));
    }

    #[test]
    fn each_node_reports_executing_then_done() {
        let r = FakeRunner::echoing();
        run(two_node_chain(vec![forward()])).walk(&r, &mut FakeGates::none(), &no_cancel());
        assert_eq!(
            r.states(),
            [
                ("designer".to_string(), NodeState::Executing),
                ("designer".to_string(), NodeState::Done),
                ("programmer".to_string(), NodeState::Executing),
                ("programmer".to_string(), NodeState::Done),
            ]
        );
    }

    // ---------------------------------------------------------------- fan-out

    /// N1: `chain.outgoing(&role).next()` used to take the first outgoing
    /// edge and silently drop every other one, so a second forward branch
    /// never ran. This is that regression test.
    #[test]
    fn a_node_with_two_forward_edges_runs_both_downstream_branches() {
        let chain = fan_in_chain(vec![]);
        let r = FakeRunner::echoing();
        let outcome = run(chain).walk(&r, &mut FakeGates::none(), &no_cancel());
        let calls = r.calls();
        let roles: HashSet<&str> = calls.iter().map(|(role, _, _)| role.as_str()).collect();
        assert!(roles.contains("reviewer"), "the second branch never ran (N1)");
        assert!(roles.contains("auditor"), "the second branch never ran (N1)");
        assert!(roles.contains("judge"), "the barrier node never ran");
        assert!(matches!(outcome, Outcome::Completed { .. }), "{outcome:?}");
    }

    /// D10: several sinks (nodes with nowhere left to go) concatenate their
    /// outputs, labeled by role and ordered by role name.
    #[test]
    fn multiple_sinks_concatenate_labeled_by_role_in_a_deterministic_order() {
        // Drop judge's in-edges so reviewer and auditor are themselves the
        // sinks (no outgoing edge at all).
        let mut chain = fan_in_chain(vec![]);
        chain.edges.retain(|e| e.to != "judge");
        chain.nodes.remove("judge");
        let r = FakeRunner::echoing();
        let outcome = run(chain).walk(&r, &mut FakeGates::none(), &no_cancel());
        assert_eq!(
            outcome,
            Outcome::Completed { output: "auditor: auditor output\n\nreviewer: reviewer output".into() }
        );
    }

    // ------------------------------------------------------------- the barrier

    /// D-e: a barrier node must not run until every forward in-edge has
    /// delivered, and while it waits it must render as `Blocked { met,
    /// required }` (N2) rather than an undifferentiated `Queued`.
    #[test]
    fn a_barrier_node_waits_for_every_forward_in_edge_and_renders_blocked() {
        let (release_tx, release_rx) = mpsc::channel();
        let runner = BarrierRunner::new("auditor", release_rx);
        let cancel = no_cancel();
        let mut chain_run = run(fan_in_chain(vec![]));

        std::thread::scope(|scope| {
            let handle = scope.spawn(|| chain_run.walk(&runner, &mut FakeGates::none(), &cancel));

            // Wait for reviewer (the branch that isn't held) to finish.
            while !runner.calls().iter().any(|(role, ..)| role == "reviewer") {
                std::thread::sleep(Duration::from_millis(1));
            }
            std::thread::sleep(Duration::from_millis(20));

            assert!(
                !runner.calls().iter().any(|(role, ..)| role == "judge"),
                "judge ran before both upstream branches delivered"
            );
            assert!(
                runner.states().contains(&("judge".to_string(), NodeState::Blocked { met: 1, required: 2 })),
                "a waiting barrier node must render Blocked{{met,required}}, not Queued: {:?}",
                runner.states()
            );

            release_tx.send(()).unwrap();
            let outcome = handle.join().unwrap();
            assert!(matches!(outcome, Outcome::Completed { .. }), "{outcome:?}");
            assert!(runner.calls().iter().any(|(role, ..)| role == "judge"));
        });
    }

    /// The single most important invariant in this rewrite: a loop-closing
    /// in-edge must never count toward its target's barrier requirement. If
    /// it did, a fan-in node that is also a loop head would need its own
    /// back edge to deliver before it could ever run for the first time —
    /// and the back edge can't deliver until the node downstream of the loop
    /// head (which needs the head to run first) completes. That's a
    /// deadlock, not a slow path, which is why this gets a dedicated test
    /// rather than relying on the loop tests above to catch it indirectly.
    #[test]
    fn a_loop_heads_barrier_ignores_its_own_back_edge() {
        // entry -> head (forward), head -> tail (forward), tail -> head
        // (loop, gated, approved once then finishes). If the loop edge
        // counted toward `head`'s barrier, `head` would need 2 deliveries
        // before its very first run and this would never complete.
        let chain = Chain {
            name: "loop-head-barrier".into(),
            nodes: HashMap::from([("entry".into(), node("entry")), ("head".into(), node("head")), ("tail".into(), node("tail"))]),
            edges: vec![
                edge("entry", "head"),
                edge("head", "tail"),
                ChainEdge { from: "tail".into(), to: "head".into(), gate: Some(Gate::Approval), max_iterations: Some(3) },
            ],
            entry: "entry".into(),
            timeout_seconds: 1800,
            retry: RetryPolicy { max_attempts: 1 },
            max_parallel: 0,
            layout: HashMap::new(),
        };
        let r = FakeRunner::echoing();
        let mut g = FakeGates::approving(vec![Ok(Approval::Approve)]);
        let outcome = run(chain).walk(&r, &mut g, &no_cancel());
        assert_eq!(outcome, Outcome::Completed { output: "tail output".into() });
        let roles: Vec<String> = r.calls().into_iter().map(|(role, _, _)| role).collect();
        assert_eq!(roles, ["entry", "head", "tail"], "head must run on entry's single delivery alone");
    }

    /// D10: when a loop repeats, every barrier tally reachable from
    /// `back_to` resets, so the second iteration waits for its own fresh
    /// deliveries rather than seeing the first iteration's satisfied edges
    /// (which would let the barrier fire early, on stale inputs).
    #[test]
    fn loop_re_entry_resets_barrier_tallies_in_the_reachable_subtree() {
        // scout -> reviewer, scout -> auditor, {reviewer,auditor} -> judge
        // (barrier), judge -> scout (loop, approval, cap 2).
        let chain = fan_in_chain(vec![ChainEdge {
            from: "judge".into(),
            to: "scout".into(),
            gate: Some(Gate::Approval),
            max_iterations: Some(2),
        }]);
        let r = FakeRunner::echoing();
        let mut g = FakeGates::approving(vec![Ok(Approval::SendBack("again".into())), Ok(Approval::Approve)]);
        let outcome = run(chain).walk(&r, &mut g, &no_cancel());
        assert_eq!(outcome, Outcome::Completed { output: "judge output".into() });

        let calls = r.calls();
        for role in ["scout", "reviewer", "auditor", "judge"] {
            let n = calls.iter().filter(|(r, ..)| r == role).count();
            assert_eq!(n, 2, "{role} should have run exactly twice across both iterations, ran {n}");
        }
        // Judge's second-iteration instruction must show both upstream
        // branches ran again, not reuse the first iteration's tally.
        let judges_second_call = calls.iter().filter(|(r, ..)| r == "judge").nth(1).unwrap();
        assert!(judges_second_call.1.contains("- auditor:"));
        assert!(judges_second_call.1.contains("- reviewer:"));
    }

    // ------------------------------------------------------------ verify gates

    #[test]
    fn a_verify_gated_loop_exits_when_the_command_passes() {
        let chain = two_node_chain(vec![forward(), back(Gate::Verify { command: "typecheck".into() }, 5)]);
        let r = FakeRunner::echoing();
        let mut g = FakeGates::verifying(vec![Ok(true)]);
        let outcome = run(chain).walk(&r, &mut g, &no_cancel());
        assert_eq!(outcome, Outcome::Completed { output: "programmer output".into() });
        assert_eq!(g.verify_calls, ["typecheck"]);
        assert_eq!(r.calls().len(), 2, "loop should not have gone back around");
    }

    #[test]
    fn a_verify_gated_loop_repeats_on_failure_then_exits_when_it_passes() {
        let chain = two_node_chain(vec![forward(), back(Gate::Verify { command: "typecheck".into() }, 5)]);
        let r = FakeRunner::echoing();
        let mut g = FakeGates::verifying(vec![Ok(false), Ok(true)]);
        let outcome = run(chain).walk(&r, &mut g, &no_cancel());
        assert_eq!(outcome, Outcome::Completed { output: "programmer output".into() });
        let roles: Vec<String> = r.calls().into_iter().map(|(role, _, _)| role).collect();
        assert_eq!(roles, ["designer", "programmer", "designer", "programmer"]);
    }

    #[test]
    fn a_loop_that_never_passes_stops_at_its_cap() {
        let chain = two_node_chain(vec![forward(), back(Gate::Verify { command: "typecheck".into() }, 2)]);
        let r = FakeRunner::echoing();
        let mut g = FakeGates::verifying(vec![Ok(false), Ok(false), Ok(false), Ok(false)]);
        let outcome = run(chain).walk(&r, &mut g, &no_cancel());
        assert_eq!(outcome, Outcome::CapReached { at: "designer".into(), max_iterations: 2 });
        // designer ran exactly twice; the third pass is what the cap refuses.
        assert_eq!(r.calls().iter().filter(|(role, _, _)| role == "designer").count(), 2);
    }

    /// D24: a forward-edge gate is a checkpoint, so failure ends the run
    /// rather than starting an uncapped repeat.
    #[test]
    fn a_failing_verify_gate_on_a_forward_edge_aborts_the_run() {
        let mut gated = forward();
        gated.gate = Some(Gate::Verify { command: "typecheck".into() });
        let r = FakeRunner::echoing();
        let mut g = FakeGates::verifying(vec![Ok(false)]);
        let outcome = run(two_node_chain(vec![gated])).walk(&r, &mut g, &no_cancel());
        assert_eq!(
            outcome,
            Outcome::GateFailed { at: "designer".into(), command: "typecheck".into() }
        );
        assert_eq!(r.calls().len(), 1, "the downstream node must not have run");
    }

    #[test]
    fn a_passing_verify_gate_on_a_forward_edge_advances() {
        let mut gated = forward();
        gated.gate = Some(Gate::Verify { command: "typecheck".into() });
        let r = FakeRunner::echoing();
        let outcome =
            run(two_node_chain(vec![gated])).walk(&r, &mut FakeGates::verifying(vec![Ok(true)]), &no_cancel());
        assert_eq!(outcome, Outcome::Completed { output: "programmer output".into() });
    }

    // ---------------------------------------------------------- approval gates

    #[test]
    fn approving_a_loop_gate_finishes_the_run() {
        let chain = two_node_chain(vec![forward(), back(Gate::Approval, 5)]);
        let r = FakeRunner::echoing();
        let mut g = FakeGates::approving(vec![Ok(Approval::Approve)]);
        assert_eq!(
            run(chain).walk(&r, &mut g, &no_cancel()),
            Outcome::Completed { output: "programmer output".into() }
        );
    }

    /// PLAN §4.5: the gate carries the judged node's actual text so both the
    /// canvas bar and the chat card can render it inline. Without this the
    /// critique's P1 ("gates render no evidence") is only half fixed.
    #[test]
    fn an_approval_gate_is_handed_the_judged_nodes_output() {
        let chain = two_node_chain(vec![forward(), back(Gate::Approval, 5)]);
        let r = FakeRunner::echoing();
        let mut g = FakeGates::approving(vec![Ok(Approval::Approve)]);
        run(chain).walk(&r, &mut g, &no_cancel());
        let (from, output) = g.approval_outputs.first().expect("the gate was consulted");
        assert_eq!(from, "programmer");
        assert!(!output.is_empty(), "a gate handed an empty output cannot show evidence");
        assert!(
            output.contains("programmer"),
            "the gate must receive `programmer`'s own turn output, got {output:?}"
        );
    }

    #[test]
    fn rejecting_an_approval_gate_aborts_the_run() {
        let chain = two_node_chain(vec![forward(), back(Gate::Approval, 5)]);
        let r = FakeRunner::echoing();
        let mut g = FakeGates::approving(vec![Ok(Approval::Reject)]);
        assert_eq!(run(chain).walk(&r, &mut g, &no_cancel()), Outcome::Rejected { at: "programmer".into() });
    }

    #[test]
    fn sending_back_re_runs_the_upstream_node_with_the_note_in_its_instruction() {
        let chain = two_node_chain(vec![forward(), back(Gate::Approval, 5)]);
        let r = FakeRunner::echoing();
        let mut g = FakeGates::approving(vec![
            Ok(Approval::SendBack("make the type bigger".into())),
            Ok(Approval::Approve),
        ]);
        let outcome = run(chain).walk(&r, &mut g, &no_cancel());
        assert_eq!(outcome, Outcome::Completed { output: "programmer output".into() });
        let calls = r.calls();
        let (role, instruction, _) = &calls[2];
        assert_eq!(role, "designer");
        assert!(instruction.contains("Human note: make the type bigger"), "{instruction}");
        // The note applies to that one turn only.
        let (_, next_instruction, _) = &calls[3];
        assert!(!next_instruction.contains("Human note"), "{next_instruction}");
    }

    #[test]
    fn sending_back_on_a_forward_edge_re_runs_the_gated_node_not_the_next_one() {
        // The approval bar names `edge.from` as the node waiting on a human,
        // so "send back" has to re-run that node. It used to jump to
        // `edge.to`, i.e. straight on to the downstream node.
        let mut chain = two_node_chain(vec![ChainEdge {
            from: "designer".into(),
            to: "programmer".into(),
            gate: Some(Gate::Approval),
            max_iterations: Some(5),
        }]);
        chain.entry = "designer".into();
        let r = FakeRunner::echoing();
        let mut g = FakeGates::approving(vec![
            Ok(Approval::SendBack("make the type bigger".into())),
            Ok(Approval::Approve),
        ]);
        let outcome = run(chain).walk(&r, &mut g, &no_cancel());
        assert_eq!(outcome, Outcome::Completed { output: "programmer output".into() });
        let calls = r.calls();
        let roles: Vec<&str> = calls.iter().map(|(role, _, _)| role.as_str()).collect();
        assert_eq!(roles, ["designer", "designer", "programmer"]);
        let (_, instruction, _) = &calls[1];
        assert!(instruction.contains("Human note: make the type bigger"), "{instruction}");
    }

    #[test]
    fn repeated_send_backs_still_stop_at_the_cap() {
        let chain = two_node_chain(vec![forward(), back(Gate::Approval, 2)]);
        let r = FakeRunner::echoing();
        let mut g = FakeGates::approving(vec![
            Ok(Approval::SendBack("again".into())),
            Ok(Approval::SendBack("again".into())),
            Ok(Approval::SendBack("again".into())),
        ]);
        assert_eq!(
            run(chain).walk(&r, &mut g, &no_cancel()),
            Outcome::CapReached { at: "designer".into(), max_iterations: 2 }
        );
    }

    // ------------------------------------------------------ runaway guardrails

    #[test]
    fn a_node_that_crashes_then_succeeds_is_retried() {
        let mut chain = two_node_chain(vec![forward()]);
        chain.retry = RetryPolicy { max_attempts: 2 };
        let r = FakeRunner::new(&[("designer", vec![Err("agent crashed".into()), Ok("recovered".into())])]);
        let outcome = run(chain).walk(&r, &mut FakeGates::none(), &no_cancel());
        assert_eq!(outcome, Outcome::Completed { output: "programmer output".into() });
        let attempts: Vec<u32> =
            r.calls().iter().filter(|(role, _, _)| role == "designer").map(|(_, _, a)| *a).collect();
        assert_eq!(attempts, [1, 2]);
        assert!(r.states().contains(&("designer".to_string(), NodeState::Retrying(2))));
    }

    #[test]
    fn a_node_that_crashes_every_attempt_aborts_with_the_reason() {
        let mut chain = two_node_chain(vec![forward()]);
        chain.retry = RetryPolicy { max_attempts: 3 };
        let r = FakeRunner::new(&[("designer", vec![Err("agent crashed".into())])]);
        let outcome = run(chain).walk(&r, &mut FakeGates::none(), &no_cancel());
        assert_eq!(
            outcome,
            Outcome::RetriesExhausted {
                at: "designer".into(),
                attempts: 3,
                message: "agent crashed".into()
            }
        );
        assert_eq!(r.calls().len(), 3);
    }

    #[test]
    fn a_per_node_retry_override_beats_the_chain_default() {
        let mut chain = two_node_chain(vec![forward()]);
        chain.retry = RetryPolicy { max_attempts: 1 };
        chain.nodes.get_mut("designer").unwrap().retry = Some(RetryPolicy { max_attempts: 3 });
        let r = FakeRunner::new(&[("designer", vec![Err("boom".into())])]);
        let outcome = run(chain).walk(&r, &mut FakeGates::none(), &no_cancel());
        assert!(matches!(outcome, Outcome::RetriesExhausted { attempts: 3, .. }), "{outcome:?}");
    }

    #[test]
    fn a_run_past_its_wall_clock_aborts_with_the_timeout_reason() {
        let chain = two_node_chain(vec![forward(), back(Gate::Verify { command: "t".into() }, 100)]);
        let r = FakeRunner::echoing();
        let mut g = FakeGates::verifying(vec![Ok(false); 50]);
        // Zero budget: the check fires before the first node even starts.
        let mut chain_run = ChainRun::new("run-1", chain, "seed").with_timeout(Duration::ZERO);
        std::thread::sleep(Duration::from_millis(2));
        let outcome = chain_run.walk(&r, &mut g, &no_cancel());
        assert_eq!(outcome, Outcome::TimedOut { at: "designer".into(), after_seconds: 0 });
        assert!(r.calls().is_empty());
    }

    #[test]
    fn a_gate_evaluation_error_blocks_rather_than_advancing() {
        let chain = two_node_chain(vec![forward(), back(Gate::Verify { command: "missing".into() }, 5)]);
        let r = FakeRunner::echoing();
        let mut g = FakeGates::verifying(vec![Err("no verify command named `missing`".into())]);
        assert_eq!(
            run(chain).walk(&r, &mut g, &no_cancel()),
            Outcome::Blocked { reason: "no verify command named `missing`".into() }
        );
    }

    #[test]
    fn a_single_node_chain_completes_immediately() {
        let mut chain = two_node_chain(vec![]);
        chain.nodes.remove("programmer");
        let r = FakeRunner::echoing();
        assert_eq!(
            run(chain).walk(&r, &mut FakeGates::none(), &no_cancel()),
            Outcome::Completed { output: "designer output".into() }
        );
    }

    // ---------------------------------------------------------- cancellation

    /// The first terminal failure wins: a sibling still mid-turn must notice
    /// and stop before its next attempt, rather than being retried after the
    /// run has already decided to stop.
    #[test]
    fn the_first_failure_cancels_a_sibling_before_its_next_retry_attempt() {
        let (a_started_tx, a_started_rx) = mpsc::channel();
        let (a_proceed_tx, a_proceed_rx) = mpsc::channel();
        let (r_proceed_tx, r_proceed_rx) = mpsc::channel();
        let runner = SiblingAbortRunner {
            auditor_started: Mutex::new(Some(a_started_tx)),
            auditor_proceed: Mutex::new(Some(a_proceed_rx)),
            reviewer_proceed: Mutex::new(Some(r_proceed_rx)),
            inner: FakeRunner::new(&[
                ("reviewer", vec![Err("reviewer crashed".into())]),
                ("auditor", vec![Err("auditor still going".into())]),
            ]),
        };
        let mut chain = fan_in_chain(vec![]);
        chain.retry = RetryPolicy { max_attempts: 1 };
        // Auditor gets room for a second attempt it must never take.
        chain.nodes.get_mut("auditor").unwrap().retry = Some(RetryPolicy { max_attempts: 3 });
        let cancel = no_cancel();
        let mut chain_run = run(chain);

        let outcome = std::thread::scope(|scope| {
            let handle = scope.spawn(|| chain_run.walk(&runner, &mut FakeGates::none(), &cancel));

            // Wait until auditor is blocked inside its first attempt — past
            // its own abort check, so it is guaranteed to have called
            // `run_turn` exactly once no matter how the OS schedules the
            // threads.
            a_started_rx.recv().unwrap();
            // Only now let reviewer fail, and wait for that failure to have
            // actually landed as the run's terminal outcome.
            r_proceed_tx.send(()).unwrap();
            while !runner.inner.states().contains(&("reviewer".to_string(), NodeState::Failed)) {
                std::thread::sleep(Duration::from_millis(1));
            }
            std::thread::sleep(Duration::from_millis(20));
            // Release auditor's first attempt now that abort is guaranteed
            // to already be set; it must check abort before a second
            // attempt and stop rather than retry.
            a_proceed_tx.send(()).unwrap();
            handle.join().unwrap()
        });

        assert_eq!(
            outcome,
            Outcome::RetriesExhausted { at: "reviewer".into(), attempts: 1, message: "reviewer crashed".into() },
            "the first failure must be the one reported, not whatever a cancelled sibling produces"
        );
        let auditor_calls = runner.inner.calls().into_iter().filter(|(r, ..)| r == "auditor").count();
        assert_eq!(auditor_calls, 1, "a sibling that notices the abort must not take another attempt");
        assert!(
            runner.inner.states().contains(&("auditor".to_string(), NodeState::Cancelled)),
            "a sibling stopped by another node's failure renders Cancelled: {:?}",
            runner.inner.states()
        );
    }

    /// D-i: `maxParallel` bounds how many nodes the scheduler dispatches at
    /// once; absent or zero is unbounded (D-f).
    #[test]
    fn max_parallel_bounds_dispatch_and_zero_is_unbounded() {
        let bounded = ConcurrencyProbe::new(Duration::from_millis(30));
        run(fan_out_chain(4, 2)).walk(&bounded, &mut FakeGates::none(), &no_cancel());
        assert_eq!(bounded.max_concurrent(), 2, "maxParallel: 2 must cap concurrent dispatch at 2");

        let unbounded = ConcurrencyProbe::new(Duration::from_millis(30));
        run(fan_out_chain(4, 0)).walk(&unbounded, &mut FakeGates::none(), &no_cancel());
        assert_eq!(unbounded.max_concurrent(), 4, "maxParallel: 0 (or absent) must not limit concurrency");
    }
}
