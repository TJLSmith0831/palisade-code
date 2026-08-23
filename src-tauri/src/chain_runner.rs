//! Walks a saved chain (`chains.rs`) one node at a time, holding run state in
//! memory only — a run interrupted by an app restart is gone, same as any
//! other session (D15).
//!
//! The walk is generic over `NodeRunner`/`GateEvaluator` (D26) so the state
//! machine — gates, loops, caps, timeouts, retries — is testable without a
//! live ACP agent. `chain_exec.rs` supplies the production implementations.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::chains::{Chain, ChainEdge, Gate};

/// What one node turn produced, or why it couldn't.
pub type TurnResult = Result<String, String>;

/// Runs a single node turn against a real (or fake) agent session.
pub trait NodeRunner {
    /// Runs `role`'s bound agent with `instruction` and returns the text the
    /// node produced. `attempt` is 1-based; a retry gets a fresh session
    /// rather than continuing the crashed one's context (D21).
    fn run_turn(&mut self, role: &str, instruction: &str, attempt: u32) -> TurnResult;

    /// Called as each node changes state, so the live DAG view can highlight
    /// the executing node (D7). Default no-op keeps tests terse.
    fn on_state(&mut self, _role: &str, _state: NodeState) {}
}

/// Evaluates an edge's gate. Verify gates run a named project `verify`
/// command through the existing mechanism (D8); approval gates come back from
/// the user.
pub trait GateEvaluator {
    /// `Ok(true)` when the named command exited 0.
    fn verify(&mut self, command: &str) -> Result<bool, String>;

    /// Blocks until the human decides, or the run is torn down.
    fn approval(&mut self, from_role: &str, to_role: &str) -> Result<Approval, String>;
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
    Done,
    Failed,
}

/// Why a run stopped. Every terminal state names a reason — a chain never
/// stops silently (D18).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Outcome {
    /// Reached a node with no outgoing edge left to follow.
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

    /// Walks the graph until it reaches a terminal state. Returns the reason
    /// it stopped; every branch below names one.
    pub fn walk<R: NodeRunner, G: GateEvaluator>(&mut self, runner: &mut R, gates: &mut G) -> Outcome {
        let mut role = self.chain.entry.clone();
        // What the previous node produced, and who produced it — the two
        // halves of the "Previous step output" segment (D23).
        let mut upstream: Option<(String, String)> = None;
        // Carried into the next turn of one node only, then cleared.
        let mut note: Option<String> = None;

        loop {
            if self.elapsed() > self.timeout {
                self.mark(runner, &role, NodeState::Failed);
                return Outcome::TimedOut { at: role, after_seconds: self.timeout.as_secs() };
            }

            let Some(node) = self.chain.nodes.get(&role).cloned() else {
                return Outcome::Blocked { reason: format!("chain has no node `{role}`") };
            };

            let instruction = compose_instruction(
                &node.guideline,
                &self.seed,
                upstream.as_ref().map(|(r, o)| (r.as_str(), o.as_str())),
                note.as_deref(),
            );
            note = None;

            let output = match self.run_with_retries(runner, &role, &instruction) {
                Ok(output) => output,
                Err(outcome) => return outcome,
            };
            *self.iterations.entry(role.clone()).or_insert(0) += 1;
            self.mark(runner, &role, NodeState::Done);

            // No outgoing edge: this is the end of the line.
            let Some(edge) = self.chain.outgoing(&role).next().cloned() else {
                return Outcome::Completed { output };
            };

            let is_loop = self.is_loop(&edge);
            match self.cross(gates, &edge, is_loop) {
                Crossing::Advance => {
                    upstream = Some((role.clone(), output));
                    role = edge.to.clone();
                }
                // A passed gate on a loop edge means the loop is done, not
                // that the run walks backwards (D3, tasks 4.1).
                Crossing::ExitLoop => return Outcome::Completed { output },
                Crossing::Repeat(back_to) => {
                    // The cap counts turns of the node we're going back to.
                    let cap = edge.max_iterations.unwrap_or(u32::MAX);
                    if self.iterations.get(&back_to).copied().unwrap_or(0) >= cap {
                        self.mark(runner, &role, NodeState::Failed);
                        return Outcome::CapReached { at: back_to, max_iterations: cap };
                    }
                    upstream = Some((role.clone(), output));
                    role = back_to;
                }
                Crossing::SendBack(back_to, human_note) => {
                    let cap = edge.max_iterations.unwrap_or(u32::MAX);
                    if self.iterations.get(&back_to).copied().unwrap_or(0) >= cap {
                        self.mark(runner, &role, NodeState::Failed);
                        return Outcome::CapReached { at: back_to, max_iterations: cap };
                    }
                    upstream = Some((role.clone(), output));
                    note = Some(human_note);
                    role = back_to;
                }
                Crossing::Stop(outcome) => {
                    self.mark(runner, &role, NodeState::Failed);
                    return outcome;
                }
            }
        }
    }

    /// One node turn, retried on crash up to its effective policy (D21). Each
    /// attempt is a fresh turn rather than a continuation, so a failed
    /// attempt's output never contaminates the retry's context.
    fn run_with_retries<R: NodeRunner>(
        &mut self,
        runner: &mut R,
        role: &str,
        instruction: &str,
    ) -> Result<String, Outcome> {
        let max_attempts = self.chain.retry_for(role).max_attempts.max(1);
        let mut last = String::new();
        for attempt in 1..=max_attempts {
            let state = if attempt == 1 { NodeState::Executing } else { NodeState::Retrying(attempt) };
            self.mark(runner, role, state);
            match runner.run_turn(role, instruction, attempt) {
                Ok(output) => return Ok(output),
                Err(message) => last = message,
            }
            // A retry that would outlive the run's budget is not worth
            // starting — report the timeout, which is the truer reason.
            if self.elapsed() > self.timeout {
                self.mark(runner, role, NodeState::Failed);
                return Err(Outcome::TimedOut { at: role.into(), after_seconds: self.timeout.as_secs() });
            }
        }
        self.mark(runner, role, NodeState::Failed);
        Err(Outcome::RetriesExhausted { at: role.into(), attempts: max_attempts, message: last })
    }

    fn is_loop(&self, edge: &ChainEdge) -> bool {
        self.chain
            .loop_edges()
            .iter()
            .any(|i| self.chain.edges.get(*i).is_some_and(|e| e.from == edge.from && e.to == edge.to))
    }

    /// What crossing this edge does, once its gate (if any) has spoken.
    fn cross<G: GateEvaluator>(&mut self, gates: &mut G, edge: &ChainEdge, is_loop: bool) -> Crossing {
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
            Gate::Approval => match gates.approval(&edge.from, &edge.to) {
                Ok(Approval::Approve) if is_loop => Crossing::ExitLoop,
                Ok(Approval::Approve) => Crossing::Advance,
                Ok(Approval::Reject) => Crossing::Stop(Outcome::Rejected { at: edge.from.clone() }),
                Ok(Approval::SendBack(note)) => Crossing::SendBack(edge.to.clone(), note),
                Err(err) => Crossing::Stop(Outcome::Blocked { reason: err }),
            },
        }
    }

    fn mark<R: NodeRunner>(&mut self, runner: &mut R, role: &str, state: NodeState) {
        self.node_states.insert(role.to_string(), state);
        runner.on_state(role, state);
    }
}

enum Crossing {
    /// Follow the edge to its target.
    Advance,
    /// A satisfied loop gate: the loop is finished, and so is the run.
    ExitLoop,
    /// Go back around the loop to this role.
    Repeat(String),
    /// Go back to this role, carrying the human's note.
    SendBack(String, String),
    Stop(Outcome),
}

/// D23: the guideline shapes *how* the node acts on the seed and its
/// upstream's output — it doesn't replace either. The first node has no
/// upstream segment; a send-back appends the human's note rather than
/// inventing a fourth input channel (D9).
pub fn compose_instruction(
    guideline: &str,
    seed: &str,
    upstream: Option<(&str, &str)>,
    note: Option<&str>,
) -> String {
    let mut out = String::new();
    if !guideline.trim().is_empty() {
        out.push_str(guideline.trim());
        out.push_str("\n\n---\n\n");
    }
    out.push_str(&format!("Original request: {}", seed.trim()));
    if let Some((from_role, output)) = upstream {
        out.push_str(&format!("\n\nPrevious step output ({from_role}): {output}"));
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
        Outcome::Blocked { reason } => format!("could not run: {reason}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chains::{ChainNode, RetryPolicy};
    use std::collections::HashMap;

    /// Replays scripted turn results in order, recording what it was asked.
    struct FakeRunner {
        /// Per role, the results to return in order. A role that runs out
        /// repeats its last result.
        script: HashMap<String, Vec<TurnResult>>,
        pub calls: Vec<(String, String, u32)>,
        pub states: Vec<(String, NodeState)>,
    }

    impl FakeRunner {
        fn new(script: &[(&str, Vec<TurnResult>)]) -> Self {
            Self {
                script: script.iter().map(|(r, v)| (r.to_string(), v.clone())).collect(),
                calls: Vec::new(),
                states: Vec::new(),
            }
        }
        /// Always succeeds, echoing "<role> output".
        fn echoing() -> Self {
            Self { script: HashMap::new(), calls: Vec::new(), states: Vec::new() }
        }
    }

    impl NodeRunner for FakeRunner {
        fn run_turn(&mut self, role: &str, instruction: &str, attempt: u32) -> TurnResult {
            self.calls.push((role.into(), instruction.into(), attempt));
            let taken = self.calls.iter().filter(|(r, _, _)| r == role).count();
            match self.script.get(role) {
                Some(results) if !results.is_empty() => {
                    results[(taken - 1).min(results.len() - 1)].clone()
                }
                _ => Ok(format!("{role} output")),
            }
        }
        fn on_state(&mut self, role: &str, state: NodeState) {
            self.states.push((role.into(), state));
        }
    }

    /// Replays scripted gate decisions in order.
    struct FakeGates {
        verify: Vec<Result<bool, String>>,
        approval: Vec<Result<Approval, String>>,
        pub verify_calls: Vec<String>,
    }

    impl FakeGates {
        fn none() -> Self {
            Self { verify: Vec::new(), approval: Vec::new(), verify_calls: Vec::new() }
        }
        fn verifying(results: Vec<Result<bool, String>>) -> Self {
            Self { verify: results, approval: Vec::new(), verify_calls: Vec::new() }
        }
        fn approving(results: Vec<Result<Approval, String>>) -> Self {
            Self { verify: Vec::new(), approval: results, verify_calls: Vec::new() }
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
        fn approval(&mut self, _from: &str, _to: &str) -> Result<Approval, String> {
            if self.approval.is_empty() {
                return Ok(Approval::Approve);
            }
            self.approval.remove(0)
        }
    }

    fn node(role: &str) -> ChainNode {
        ChainNode {
            role: role.into(),
            guideline: format!("You are the {role}."),
            agent: "claude-code".into(),
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

    fn run(chain: Chain) -> ChainRun {
        ChainRun::new("run-1", chain, "build me a settings page")
    }

    // ------------------------------------------------- instruction composition

    #[test]
    fn the_first_node_gets_no_upstream_segment() {
        let text = compose_instruction("You are the designer.", "build a page", None, None);
        assert!(text.starts_with("You are the designer.\n\n---\n\n"));
        assert!(text.contains("Original request: build a page"));
        assert!(!text.contains("Previous step output"));
    }

    #[test]
    fn a_downstream_node_gets_guideline_seed_and_upstream_output() {
        let text = compose_instruction(
            "You are the programmer.",
            "build a page",
            Some(("designer", "here is the layout")),
            None,
        );
        assert!(text.contains("You are the programmer."));
        assert!(text.contains("Original request: build a page"));
        assert!(text.contains("Previous step output (designer): here is the layout"));
    }

    #[test]
    fn a_send_back_note_is_appended_not_substituted() {
        let text = compose_instruction("g", "seed", Some(("a", "out")), Some("use bigger type"));
        assert!(text.contains("Original request: seed"));
        assert!(text.contains("Previous step output (a): out"));
        assert!(text.trim_end().ends_with("Human note: use bigger type"));
    }

    #[test]
    fn an_empty_guideline_leaves_no_dangling_separator() {
        let text = compose_instruction("   ", "seed", None, None);
        assert_eq!(text, "Original request: seed");
    }

    // --------------------------------------------------------- forward walking

    #[test]
    fn a_two_node_forward_chain_runs_both_nodes_in_order_and_completes() {
        let mut r = FakeRunner::echoing();
        let outcome = run(two_node_chain(vec![forward()])).walk(&mut r, &mut FakeGates::none());
        assert_eq!(outcome, Outcome::Completed { output: "programmer output".into() });
        let roles: Vec<&str> = r.calls.iter().map(|(role, _, _)| role.as_str()).collect();
        assert_eq!(roles, ["designer", "programmer"]);
    }

    #[test]
    fn the_second_nodes_instruction_carries_the_first_nodes_output() {
        let mut r = FakeRunner::echoing();
        run(two_node_chain(vec![forward()])).walk(&mut r, &mut FakeGates::none());
        let (_, instruction, _) = &r.calls[1];
        assert!(instruction.contains("Previous step output (designer): designer output"), "{instruction}");
        assert!(instruction.contains("Original request: build me a settings page"));
    }

    #[test]
    fn each_node_reports_executing_then_done() {
        let mut r = FakeRunner::echoing();
        run(two_node_chain(vec![forward()])).walk(&mut r, &mut FakeGates::none());
        assert_eq!(
            r.states,
            [
                ("designer".to_string(), NodeState::Executing),
                ("designer".to_string(), NodeState::Done),
                ("programmer".to_string(), NodeState::Executing),
                ("programmer".to_string(), NodeState::Done),
            ]
        );
    }

    // ------------------------------------------------------------ verify gates

    #[test]
    fn a_verify_gated_loop_exits_when_the_command_passes() {
        let chain = two_node_chain(vec![forward(), back(Gate::Verify { command: "typecheck".into() }, 5)]);
        let mut r = FakeRunner::echoing();
        let mut g = FakeGates::verifying(vec![Ok(true)]);
        let outcome = run(chain).walk(&mut r, &mut g);
        assert_eq!(outcome, Outcome::Completed { output: "programmer output".into() });
        assert_eq!(g.verify_calls, ["typecheck"]);
        assert_eq!(r.calls.len(), 2, "loop should not have gone back around");
    }

    #[test]
    fn a_verify_gated_loop_repeats_on_failure_then_exits_when_it_passes() {
        let chain = two_node_chain(vec![forward(), back(Gate::Verify { command: "typecheck".into() }, 5)]);
        let mut r = FakeRunner::echoing();
        let mut g = FakeGates::verifying(vec![Ok(false), Ok(true)]);
        let outcome = run(chain).walk(&mut r, &mut g);
        assert_eq!(outcome, Outcome::Completed { output: "programmer output".into() });
        let roles: Vec<&str> = r.calls.iter().map(|(role, _, _)| role.as_str()).collect();
        assert_eq!(roles, ["designer", "programmer", "designer", "programmer"]);
    }

    #[test]
    fn a_loop_that_never_passes_stops_at_its_cap() {
        let chain = two_node_chain(vec![forward(), back(Gate::Verify { command: "typecheck".into() }, 2)]);
        let mut r = FakeRunner::echoing();
        let mut g = FakeGates::verifying(vec![Ok(false), Ok(false), Ok(false), Ok(false)]);
        let outcome = run(chain).walk(&mut r, &mut g);
        assert_eq!(outcome, Outcome::CapReached { at: "designer".into(), max_iterations: 2 });
        // designer ran exactly twice; the third pass is what the cap refuses.
        assert_eq!(r.calls.iter().filter(|(role, _, _)| role == "designer").count(), 2);
    }

    /// D24: a forward-edge gate is a checkpoint, so failure ends the run
    /// rather than starting an uncapped repeat.
    #[test]
    fn a_failing_verify_gate_on_a_forward_edge_aborts_the_run() {
        let mut gated = forward();
        gated.gate = Some(Gate::Verify { command: "typecheck".into() });
        let mut r = FakeRunner::echoing();
        let mut g = FakeGates::verifying(vec![Ok(false)]);
        let outcome = run(two_node_chain(vec![gated])).walk(&mut r, &mut g);
        assert_eq!(
            outcome,
            Outcome::GateFailed { at: "designer".into(), command: "typecheck".into() }
        );
        assert_eq!(r.calls.len(), 1, "the downstream node must not have run");
    }

    #[test]
    fn a_passing_verify_gate_on_a_forward_edge_advances() {
        let mut gated = forward();
        gated.gate = Some(Gate::Verify { command: "typecheck".into() });
        let mut r = FakeRunner::echoing();
        let outcome = run(two_node_chain(vec![gated])).walk(&mut r, &mut FakeGates::verifying(vec![Ok(true)]));
        assert_eq!(outcome, Outcome::Completed { output: "programmer output".into() });
    }

    // ---------------------------------------------------------- approval gates

    #[test]
    fn approving_a_loop_gate_finishes_the_run() {
        let chain = two_node_chain(vec![forward(), back(Gate::Approval, 5)]);
        let mut r = FakeRunner::echoing();
        let mut g = FakeGates::approving(vec![Ok(Approval::Approve)]);
        assert_eq!(
            run(chain).walk(&mut r, &mut g),
            Outcome::Completed { output: "programmer output".into() }
        );
    }

    #[test]
    fn rejecting_an_approval_gate_aborts_the_run() {
        let chain = two_node_chain(vec![forward(), back(Gate::Approval, 5)]);
        let mut r = FakeRunner::echoing();
        let mut g = FakeGates::approving(vec![Ok(Approval::Reject)]);
        assert_eq!(run(chain).walk(&mut r, &mut g), Outcome::Rejected { at: "programmer".into() });
    }

    #[test]
    fn sending_back_re_runs_the_upstream_node_with_the_note_in_its_instruction() {
        let chain = two_node_chain(vec![forward(), back(Gate::Approval, 5)]);
        let mut r = FakeRunner::echoing();
        let mut g = FakeGates::approving(vec![
            Ok(Approval::SendBack("make the type bigger".into())),
            Ok(Approval::Approve),
        ]);
        let outcome = run(chain).walk(&mut r, &mut g);
        assert_eq!(outcome, Outcome::Completed { output: "programmer output".into() });
        let (role, instruction, _) = &r.calls[2];
        assert_eq!(role, "designer");
        assert!(instruction.contains("Human note: make the type bigger"), "{instruction}");
        // The note applies to that one turn only.
        let (_, next_instruction, _) = &r.calls[3];
        assert!(!next_instruction.contains("Human note"), "{next_instruction}");
    }

    #[test]
    fn repeated_send_backs_still_stop_at_the_cap() {
        let chain = two_node_chain(vec![forward(), back(Gate::Approval, 2)]);
        let mut r = FakeRunner::echoing();
        let mut g = FakeGates::approving(vec![
            Ok(Approval::SendBack("again".into())),
            Ok(Approval::SendBack("again".into())),
            Ok(Approval::SendBack("again".into())),
        ]);
        assert_eq!(
            run(chain).walk(&mut r, &mut g),
            Outcome::CapReached { at: "designer".into(), max_iterations: 2 }
        );
    }

    // ------------------------------------------------------ runaway guardrails

    #[test]
    fn a_node_that_crashes_then_succeeds_is_retried() {
        let mut chain = two_node_chain(vec![forward()]);
        chain.retry = RetryPolicy { max_attempts: 2 };
        let mut r = FakeRunner::new(&[("designer", vec![Err("agent crashed".into()), Ok("recovered".into())])]);
        let outcome = run(chain).walk(&mut r, &mut FakeGates::none());
        assert_eq!(outcome, Outcome::Completed { output: "programmer output".into() });
        let attempts: Vec<u32> = r.calls.iter().filter(|(role, _, _)| role == "designer").map(|(_, _, a)| *a).collect();
        assert_eq!(attempts, [1, 2]);
        assert!(r.states.contains(&("designer".to_string(), NodeState::Retrying(2))));
    }

    #[test]
    fn a_node_that_crashes_every_attempt_aborts_with_the_reason() {
        let mut chain = two_node_chain(vec![forward()]);
        chain.retry = RetryPolicy { max_attempts: 3 };
        let mut r = FakeRunner::new(&[("designer", vec![Err("agent crashed".into())])]);
        let outcome = run(chain).walk(&mut r, &mut FakeGates::none());
        assert_eq!(
            outcome,
            Outcome::RetriesExhausted {
                at: "designer".into(),
                attempts: 3,
                message: "agent crashed".into()
            }
        );
        assert_eq!(r.calls.len(), 3);
    }

    #[test]
    fn a_per_node_retry_override_beats_the_chain_default() {
        let mut chain = two_node_chain(vec![forward()]);
        chain.retry = RetryPolicy { max_attempts: 1 };
        chain.nodes.get_mut("designer").unwrap().retry = Some(RetryPolicy { max_attempts: 3 });
        let mut r = FakeRunner::new(&[("designer", vec![Err("boom".into())])]);
        let outcome = run(chain).walk(&mut r, &mut FakeGates::none());
        assert!(matches!(outcome, Outcome::RetriesExhausted { attempts: 3, .. }), "{outcome:?}");
    }

    #[test]
    fn a_run_past_its_wall_clock_aborts_with_the_timeout_reason() {
        let chain = two_node_chain(vec![forward(), back(Gate::Verify { command: "t".into() }, 100)]);
        let mut r = FakeRunner::echoing();
        let mut g = FakeGates::verifying(vec![Ok(false); 50]);
        // Zero budget: the check fires before the first node even starts.
        let mut chain_run = ChainRun::new("run-1", chain, "seed").with_timeout(Duration::ZERO);
        std::thread::sleep(Duration::from_millis(2));
        let outcome = chain_run.walk(&mut r, &mut g);
        assert_eq!(outcome, Outcome::TimedOut { at: "designer".into(), after_seconds: 0 });
        assert!(r.calls.is_empty());
    }

    #[test]
    fn a_gate_evaluation_error_blocks_rather_than_advancing() {
        let chain = two_node_chain(vec![forward(), back(Gate::Verify { command: "missing".into() }, 5)]);
        let mut r = FakeRunner::echoing();
        let mut g = FakeGates::verifying(vec![Err("no verify command named `missing`".into())]);
        assert_eq!(
            run(chain).walk(&mut r, &mut g),
            Outcome::Blocked { reason: "no verify command named `missing`".into() }
        );
    }

    #[test]
    fn a_single_node_chain_completes_immediately() {
        let mut chain = two_node_chain(vec![]);
        chain.nodes.remove("programmer");
        let mut r = FakeRunner::echoing();
        assert_eq!(
            run(chain).walk(&mut r, &mut FakeGates::none()),
            Outcome::Completed { output: "designer output".into() }
        );
    }
}
