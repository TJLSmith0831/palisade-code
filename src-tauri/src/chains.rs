//! Chain definitions (`.palisade/chains/<name>.json`, D11/D20): a saved,
//! project-scoped DAG of role-bound agent nodes that a run walks end to end.
//!
//! This module owns the on-disk shape and its validation only — walking a
//! chain is `chain_runner.rs`'s job. Definitions are durable; runs are not
//! (D15).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::store::Res;

/// A node is a role name bound to a specific ACP agent, plus the free-text
/// guideline that shapes how it acts on the seed input and its upstream
/// node's output (D2/D23).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChainNode {
    /// Human-readable role, e.g. "designer". Also the node's key in `nodes`
    /// and the endpoint edges refer to — no separate numeric id (D10 defers
    /// fan-out, which is the only thing that would need one).
    pub role: String,
    /// Persistent behavioural guideline, applied on every turn this node
    /// takes rather than once at the start (D23).
    #[serde(default)]
    pub guideline: String,
    /// ACP agent id, resolved against the same cached registry preflight
    /// normal auto-detection uses (D16). Deliberately user-selectable, unlike
    /// a normal thread's executor.
    #[serde(default)]
    pub agent: String,
    /// Model this node's agent runs on. Unset follows the thread's model,
    /// which is what every node did before the picker existed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Overrides the chain-level retry policy for this node alone (D21).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry: Option<RetryPolicy>,
}

/// What has to happen on an edge before the run advances across it. Absent on
/// a plain forward pipe (D22); mandatory on a loop-closing edge (D3).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Gate {
    /// A named command from the project's `verify` map, run by Palisade with
    /// its exit code persisted (D8). Exit 0 advances; non-zero repeats.
    Verify { command: String },
    /// Suspends the run until a human approves, rejects, or sends back with a
    /// note (D9).
    Approval,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChainEdge {
    pub from: String,
    pub to: String,
    /// Optional on any edge, required on a loop-closing one (D22).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gate: Option<Gate>,
    /// Hard backstop on a cycle, mandatory wherever one exists regardless of
    /// gate type (D3). Meaningless on a forward edge.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_iterations: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RetryPolicy {
    /// Total attempts per node turn, including the first (D21). 1 = no retry.
    pub max_attempts: u32,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self { max_attempts: 2 }
    }
}

/// D19: 30 minutes, overridable per chain.
pub const DEFAULT_TIMEOUT_SECONDS: u64 = 1800;

fn default_timeout() -> u64 {
    DEFAULT_TIMEOUT_SECONDS
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Chain {
    pub name: String,
    /// Keyed by role name; the key and `ChainNode::role` are the same string.
    pub nodes: HashMap<String, ChainNode>,
    /// Flat list rather than nested under nodes: a forward edge and a
    /// loop-closing edge are structurally identical, and a flat list already
    /// admits multiple edges per node when fan-out lands (D10).
    pub edges: Vec<ChainEdge>,
    /// Role key the run starts at.
    pub entry: String,
    #[serde(default = "default_timeout")]
    pub timeout_seconds: u64,
    #[serde(default)]
    pub retry: RetryPolicy,
    /// Caps how many nodes the frontier scheduler runs at once (D10/D-i).
    /// Absent or `0` means unbounded — the user's prerogative (D-f), not a
    /// harness-imposed limit. A pure number, so it stays portable (D-o).
    #[serde(default)]
    pub max_parallel: u32,
    /// Canvas node positions, keyed by role — presentation only, ignored by
    /// the runner.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub layout: HashMap<String, Point>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

impl Chain {
    /// Edges leaving `role`, in definition order.
    pub fn outgoing<'a>(&'a self, role: &'a str) -> impl Iterator<Item = &'a ChainEdge> {
        self.edges.iter().filter(move |e| e.from == role)
    }

    /// Indices of the edges that close a cycle, found as DFS back edges from
    /// `entry`: an edge is loop-closing when its target is still open on the
    /// walk that reached its source. Derived from the graph rather than a
    /// user-set flag, so rewiring the canvas can't leave the two out of sync.
    ///
    /// In a pure cycle both edges lie *on* the cycle, so "which one closes it"
    /// is only answerable relative to a traversal direction — which is what
    /// starting from `entry` supplies. designer → programmer → designer makes
    /// the back edge the second one, matching how the user drew it.
    pub fn loop_edges(&self) -> HashSet<usize> {
        let mut found = HashSet::new();
        let mut visited = HashSet::new();
        let mut open = Vec::new();
        self.walk(&self.entry, &mut open, &mut visited, &mut found);
        // Nodes unreachable from entry still get checked, so a disconnected
        // fragment with an ungated loop can't slip through validation.
        let roles: Vec<&String> = self.nodes.keys().collect();
        for role in roles {
            if !visited.contains(role.as_str()) {
                self.walk(role, &mut open, &mut visited, &mut found);
            }
        }
        found
    }

    fn walk(&self, role: &str, open: &mut Vec<String>, visited: &mut HashSet<String>, found: &mut HashSet<usize>) {
        visited.insert(role.to_string());
        open.push(role.to_string());
        for (index, edge) in self.edges.iter().enumerate() {
            if edge.from != role {
                continue;
            }
            if open.iter().any(|r| r == &edge.to) {
                found.insert(index);
            } else if !visited.contains(&edge.to) {
                self.walk(&edge.to, open, visited, found);
            }
        }
        open.pop();
    }

    /// Rejects a chain that can't be run or drawn coherently. Called on save
    /// so a broken definition never reaches disk, and on load so a
    /// hand-edited one is caught before a run starts.
    pub fn validate(&self) -> Res<()> {
        if self.name.trim().is_empty() {
            return Err("chain needs a name".into());
        }
        if self.nodes.is_empty() {
            return Err("chain needs at least one node".into());
        }
        if !self.nodes.contains_key(&self.entry) {
            return Err(format!("entry node `{}` isn't one of this chain's nodes", self.entry).into());
        }
        for (key, node) in &self.nodes {
            if node.role != *key {
                return Err(format!("node `{key}` has mismatched role `{}`", node.role).into());
            }
            if node.agent.trim().is_empty() {
                return Err(format!("node `{key}` has no agent bound to it").into());
            }
            if node.model.as_deref().unwrap_or("").trim().is_empty() {
                return Err(format!("node `{key}` has no model bound to it").into());
            }
        }
        for edge in &self.edges {
            for endpoint in [&edge.from, &edge.to] {
                if !self.nodes.contains_key(endpoint) {
                    return Err(format!("edge {} → {} refers to unknown node `{endpoint}`", edge.from, edge.to).into());
                }
            }
        }
        // Only reachable once every endpoint is known — the walk indexes by
        // role and would miss edges pointing at nodes that don't exist.
        let loops = self.loop_edges();
        for (index, edge) in self.edges.iter().enumerate() {
            if loops.contains(&index) {
                if edge.gate.is_none() {
                    return Err(format!(
                        "loop edge {} → {} needs a gate (a verify command or human approval)",
                        edge.from, edge.to
                    ).into());
                }
                match edge.max_iterations {
                    None => {
                        return Err(format!(
                            "loop edge {} → {} needs a maximum iteration count",
                            edge.from, edge.to
                        ).into())
                    }
                    Some(0) => {
                        return Err(format!(
                            "loop edge {} → {} needs a maximum iteration count above zero",
                            edge.from, edge.to
                        ).into())
                    }
                    Some(_) => {}
                }
            }
        }
        Ok(())
    }

    /// The effective retry policy for one node: its own override, else the
    /// chain's (D21).
    pub fn retry_for(&self, role: &str) -> RetryPolicy {
        self.nodes
            .get(role)
            .and_then(|n| n.retry.clone())
            .unwrap_or_else(|| self.retry.clone())
    }
}

const DIR: &str = ".palisade/chains";

/// Keeps a chain name to something that is safely one file in `chains/` —
/// rejected rather than sanitised, so what the user typed is what they get.
fn check_name(name: &str) -> Res<()> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("chain needs a name".into());
    }
    if trimmed != name {
        return Err("chain name can't start or end with whitespace".into());
    }
    if name.contains(['/', '\\', ':']) || name.contains("..") {
        return Err("chain name can't contain `/`, `\\`, `:` or `..`".into());
    }
    Ok(())
}

fn path_for(project_root: &Path, name: &str) -> Res<PathBuf> {
    check_name(name)?;
    Ok(project_root.join(DIR).join(format!("{name}.json")))
}

/// Every saved chain, name-sorted. A missing `.palisade/chains/` is the
/// common case (no chains built yet), not an error. An unreadable or
/// malformed file is skipped rather than failing the whole listing — the
/// canvas is how you'd fix it, and it can't open if listing errors out.
pub fn list(project_root: &Path) -> Vec<Chain> {
    let Ok(entries) = std::fs::read_dir(project_root.join(DIR)) else {
        return Vec::new();
    };
    let mut chains: Vec<Chain> = entries
        .filter_map(|entry| {
            let path = entry.ok()?.path();
            if path.extension()? != "json" {
                return None;
            }
            serde_json::from_str(&std::fs::read_to_string(&path).ok()?).ok()
        })
        .collect();
    chains.sort_by(|a, b| a.name.cmp(&b.name));
    chains
}

pub fn load(project_root: &Path, name: &str) -> Res<Chain> {
    let path = path_for(project_root, name)?;
    let raw = std::fs::read_to_string(&path).map_err(|_| crate::PalisadeError::from(format!("no chain named `{name}` in this project")))?;
    let chain: Chain = serde_json::from_str(&raw).map_err(|err| crate::PalisadeError::from(format!("chain `{name}` is malformed: {err}")))?;
    chain.validate()?;
    Ok(chain)
}

/// Validates first, then writes — a chain that wouldn't run never lands on
/// disk. Lazily creates `.palisade/chains/`, same as `settings::ensure_file`.
pub fn save(project_root: &Path, chain: &Chain) -> Res<()> {
    chain.validate()?;
    let path = path_for(project_root, &chain.name)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| crate::PalisadeError::from(format!("create {}: {err}", parent.display())))?;
    }
    let body = serde_json::to_string_pretty(chain).map_err(|err| crate::PalisadeError::from(err.to_string()))?;
    std::fs::write(&path, body + "\n").map_err(|err| crate::PalisadeError::from(format!("write chain `{}`: {err}", chain.name)))
}

pub fn delete(project_root: &Path, name: &str) -> Res<()> {
    let path = path_for(project_root, name)?;
    std::fs::remove_file(&path).map_err(|err| crate::PalisadeError::from(format!("delete chain `{name}`: {err}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(role: &str, agent: &str) -> ChainNode {
        ChainNode {
            role: role.into(),
            guideline: format!("You are the {role}."),
            agent: agent.into(),
            model: Some("default-model".into()),
            retry: None,
        }
    }

    /// designer → programmer, plus whatever extra edges the test wants.
    fn chain(edges: Vec<ChainEdge>) -> Chain {
        Chain {
            name: "design-loop".into(),
            nodes: HashMap::from([
                ("designer".into(), node("designer", "gemini-cli")),
                ("programmer".into(), node("programmer", "claude-code")),
            ]),
            edges,
            entry: "designer".into(),
            timeout_seconds: DEFAULT_TIMEOUT_SECONDS,
            retry: RetryPolicy::default(),
            max_parallel: 0,
            layout: HashMap::new(),
        }
    }

    fn forward() -> ChainEdge {
        ChainEdge { from: "designer".into(), to: "programmer".into(), gate: None, max_iterations: None }
    }

    fn back(gate: Option<Gate>, max_iterations: Option<u32>) -> ChainEdge {
        ChainEdge { from: "programmer".into(), to: "designer".into(), gate, max_iterations }
    }

    #[test]
    fn a_forward_only_chain_needs_no_gates() {
        assert!(chain(vec![forward()]).validate().is_ok());
    }

    #[test]
    fn a_nodes_model_survives_save_and_load() {
        // Without this the picker would look like it worked and every node
        // would still run on the thread's default model.
        let dir = std::env::temp_dir().join(format!("chain-model-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut c = chain(vec![forward()]);
        c.nodes.get_mut("designer").unwrap().model = Some("gemini-3-pro".into());
        save(&dir, &c).unwrap();

        let back = load(&dir, "design-loop").unwrap();
        assert_eq!(back.nodes["designer"].model.as_deref(), Some("gemini-3-pro"));
        // A node that didn't opt into a specific model still carries the
        // default `node()` picked — a model is required, not merely durable.
        assert_eq!(back.nodes["programmer"].model.as_deref(), Some("default-model"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_gated_capped_loop_is_valid() {
        let gate = Some(Gate::Verify { command: "typecheck".into() });
        assert!(chain(vec![forward(), back(gate, Some(5))]).validate().is_ok());
    }

    #[test]
    fn a_loop_edge_without_a_gate_is_rejected() {
        let err = chain(vec![forward(), back(None, Some(5))]).validate().unwrap_err();
        assert!(err.contains("needs a gate"), "{err}");
    }

    #[test]
    fn a_loop_edge_without_an_iteration_cap_is_rejected() {
        let err = chain(vec![forward(), back(Some(Gate::Approval), None)]).validate().unwrap_err();
        assert!(err.contains("iteration count"), "{err}");
    }

    #[test]
    fn a_zero_iteration_cap_is_rejected() {
        let err = chain(vec![forward(), back(Some(Gate::Approval), Some(0))]).validate().unwrap_err();
        assert!(err.contains("above zero"), "{err}");
    }

    #[test]
    fn an_edge_to_an_unknown_node_is_rejected() {
        let mut c = chain(vec![forward()]);
        c.edges.push(ChainEdge { from: "programmer".into(), to: "tester".into(), gate: None, max_iterations: None });
        let err = c.validate().unwrap_err();
        assert!(err.contains("unknown node `tester`"), "{err}");
    }

    #[test]
    fn an_entry_that_isnt_a_node_is_rejected() {
        let mut c = chain(vec![forward()]);
        c.entry = "nobody".into();
        assert!(c.validate().unwrap_err().contains("entry node"));
    }

    #[test]
    fn a_node_without_an_agent_is_rejected() {
        let mut c = chain(vec![forward()]);
        c.nodes.get_mut("designer").unwrap().agent = String::new();
        assert!(c.validate().unwrap_err().contains("no agent"));
    }

    #[test]
    fn a_node_without_a_model_is_rejected() {
        let mut c = chain(vec![forward()]);
        c.nodes.get_mut("designer").unwrap().model = None;
        assert!(c.validate().unwrap_err().contains("no model"));
    }

    /// A three-node cycle: the closing edge is detected through an
    /// intermediate hop, not just as a direct back-edge.
    #[test]
    fn a_multi_hop_cycle_is_detected() {
        let mut c = chain(vec![forward()]);
        c.nodes.insert("tester".into(), node("tester", "codex"));
        c.edges.push(ChainEdge { from: "programmer".into(), to: "tester".into(), gate: None, max_iterations: None });
        c.edges.push(ChainEdge { from: "tester".into(), to: "designer".into(), gate: None, max_iterations: None });
        let err = c.validate().unwrap_err();
        assert!(err.contains("loop edge tester → designer"), "{err}");
    }

    #[test]
    fn save_then_load_round_trips() {
        let root = tempfile::tempdir().unwrap();
        let gate = Some(Gate::Verify { command: "typecheck".into() });
        let original = chain(vec![forward(), back(gate, Some(3))]);
        save(root.path(), &original).unwrap();
        assert_eq!(load(root.path(), "design-loop").unwrap(), original);
    }

    #[test]
    fn saving_an_invalid_chain_writes_nothing() {
        let root = tempfile::tempdir().unwrap();
        let invalid = chain(vec![forward(), back(None, None)]);
        assert!(save(root.path(), &invalid).is_err());
        assert!(list(root.path()).is_empty());
    }

    #[test]
    fn listing_a_project_with_no_chains_yields_nothing() {
        let root = tempfile::tempdir().unwrap();
        assert!(list(root.path()).is_empty());
    }

    #[test]
    fn listing_skips_a_malformed_file_rather_than_failing() {
        let root = tempfile::tempdir().unwrap();
        save(root.path(), &chain(vec![forward()])).unwrap();
        std::fs::write(root.path().join(DIR).join("broken.json"), "{ not json").unwrap();
        let listed = list(root.path());
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "design-loop");
    }

    #[test]
    fn delete_removes_the_file() {
        let root = tempfile::tempdir().unwrap();
        save(root.path(), &chain(vec![forward()])).unwrap();
        delete(root.path(), "design-loop").unwrap();
        assert!(list(root.path()).is_empty());
    }

    #[test]
    fn a_name_that_escapes_the_chains_directory_is_rejected() {
        let root = tempfile::tempdir().unwrap();
        for name in ["../escape", "nested/chain", "a:b"] {
            assert!(path_for(root.path(), name).is_err(), "{name} should be rejected");
        }
    }

    #[test]
    fn a_missing_timeout_falls_back_to_the_default() {
        let raw = r#"{
          "name": "t", "entry": "a", "edges": [],
          "nodes": { "a": { "role": "a", "agent": "claude-code" } }
        }"#;
        let parsed: Chain = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.timeout_seconds, DEFAULT_TIMEOUT_SECONDS);
        assert_eq!(parsed.retry.max_attempts, 2);
        assert_eq!(parsed.nodes["a"].guideline, "");
        assert_eq!(parsed.max_parallel, 0, "absent maxParallel means unbounded (D-i)");
    }

    #[test]
    fn a_node_retry_override_wins_over_the_chain_default() {
        let mut c = chain(vec![forward()]);
        c.nodes.get_mut("designer").unwrap().retry = Some(RetryPolicy { max_attempts: 5 });
        assert_eq!(c.retry_for("designer").max_attempts, 5);
        assert_eq!(c.retry_for("programmer").max_attempts, 2);
    }

    /// D16: the worked example offered from the chains-panel empty state —
    /// mirrors `ChainsPanel.tsx`'s `workedExampleChain` (an agent drafts, a
    /// human reviews). Kept in lockstep deliberately: a schema change that
    /// invalidates this shape fails here rather than only surfacing when a
    /// user clicks "Open a worked example".
    #[test]
    fn the_worked_example_chain_is_valid_and_saves() {
        let raw = r#"{
          "name": "Example - draft then review",
          "entry": "drafter",
          "timeoutSeconds": 1800,
          "retry": { "maxAttempts": 2 },
          "edges": [
            { "from": "drafter", "to": "reviewer" },
            { "from": "reviewer", "to": "drafter", "gate": { "type": "approval" }, "maxIterations": 3 }
          ],
          "nodes": {
            "drafter": {
              "role": "drafter", "agent": "claude-code", "model": "claude-sonnet-5",
              "guideline": "Write a short first draft answering the request."
            },
            "reviewer": {
              "role": "reviewer", "agent": "claude-code", "model": "claude-sonnet-5",
              "guideline": "Critique the draft against the original request."
            }
          }
        }"#;
        let example: Chain = serde_json::from_str(raw).expect("worked example must deserialize");
        assert!(example.validate().is_ok());

        let root = tempfile::tempdir().unwrap();
        save(root.path(), &example).unwrap();
        assert_eq!(load(root.path(), &example.name).unwrap(), example);
    }
}
