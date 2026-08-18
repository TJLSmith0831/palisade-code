//! Session-start graph tool instruction.
//!
//! `ensure_graphify_mcp` puts Graphify's tools in the agent's tool list, but
//! nothing ever told the agent to reach for them — they sat next to grep, which
//! is what the agent defaults to. This is the missing half: one block of text,
//! injected once per session, saying which questions the graph answers.
//!
//! Prompt text rather than a skill file because ACP has no system-prompt
//! channel (`session/new` carries only cwd, roots, mcp_servers and a reserved
//! `_meta`), and because a skill file under `~/.claude` never ships to another
//! machine. Same shape as `grill_inject`: a bundled constant and a plain
//! function. Unlike grill, it fires once per session and in both modes — "what
//! breaks if I change this" is a mid-build question too.

use std::path::Path;

/// Tool names here are the ones `graphify-mcp` actually serves (verified
/// against its `tools/list`). Naming a tool that doesn't exist is the fastest
/// way to get the whole block ignored. The closing paragraph is load-bearing:
/// without it the agent routes literal-text searches through a semantic graph
/// and the answers get worse, not cheaper.
pub const GRAPH_NUDGE: &str = "\
This project has a prebuilt code graph, exposed as MCP tools from the `graphify` server: \
`query_graph` (semantic search over the graph), `get_neighbors` (direct callers/callees of \
a node), `shortest_path` (how two things connect), `get_node`, `god_nodes` (most-connected \
nodes), `graph_stats`.

Use them instead of a grep fan-out for structural questions:
- what calls / uses X → `get_neighbors`
- how does A reach B → `shortest_path`
- what breaks if I change X → `get_neighbors`, then `query_graph`
- where does concept X live in this codebase → `query_graph`
- first orientation in unfamiliar code → `god_nodes`

Keep using grep and file reads for exact strings, current file contents, and anything you \
are about to edit. The graph is a map of the code, not the code — confirm in the file \
before changing it.";

/// The instruction for this session, or `None` to stay quiet.
pub fn nudge(agent_id: &str, project_root: &Path) -> Option<&'static str> {
    let graph = crate::integrations::default_out_dir(project_root).join("graph.json");
    gate(
        agent_id,
        graph.exists(),
        crate::executor::find_on_path("graphify-mcp").is_some(),
    )
}

/// All three conditions or nothing: the first two mirror `ensure_graphify_mcp`
/// (no registration → the tools aren't in the agent's list), the third is the
/// one it doesn't check — `.mcp.json` can name a server whose graph was never
/// built, and then every tool this text recommends fails.
fn gate(agent_id: &str, has_graph: bool, has_mcp: bool) -> Option<&'static str> {
    let registered = matches!(agent_id, "claude-acp" | "codex-acp");
    (registered && has_graph && has_mcp).then_some(GRAPH_NUDGE)
}

/// Prepend the nudge to whatever prefix `ensure_session` already built, so the
/// order reaching the agent is nudge → handoff transcript → user message.
pub fn compose(nudge: Option<&'static str>, prefix: Option<String>) -> Option<String> {
    match (nudge, prefix) {
        (Some(nudge), Some(prefix)) => Some(format!("{nudge}\n\n{prefix}")),
        (Some(nudge), None) => Some(nudge.to_string()),
        (None, prefix) => prefix,
    }
}

// ------------------------------------------------------------------ tests

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// A root with a built graph, so only the agent-id gate is under test.
    fn root_with_graph() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("graphify-out");
        std::fs::create_dir_all(&out).unwrap();
        std::fs::write(out.join("graph.json"), "{}").unwrap();
        dir
    }

    // ------------------------------------------------------- 1.1: unknown agent

    /// RED→GREEN 1.1: an agent Palisade writes no MCP config for never has the
    /// tools, so describing them would send it after tools it cannot call.
    #[test]
    fn agent_without_mcp_registration_gets_no_nudge() {
        let dir = root_with_graph();
        assert_eq!(gate("gemini-acp", true, true), None);
        assert_eq!(nudge("gemini-acp", dir.path()), None);
    }

    // ------------------------------------------------------- 1.2: no graph built

    /// RED→GREEN 1.2: `.mcp.json` can name a server whose graph was never
    /// built. Every tool call would fail, which is worse than staying quiet.
    #[test]
    fn missing_graph_file_gets_no_nudge() {
        assert_eq!(gate("claude-acp", false, true), None);
        let empty = tempfile::tempdir().unwrap();
        assert_eq!(nudge("claude-acp", empty.path()), None);
    }

    /// RED→GREEN 1.2: the server binary missing means no tools either.
    #[test]
    fn missing_mcp_binary_gets_no_nudge() {
        assert_eq!(gate("claude-acp", true, false), None);
    }

    // ------------------------------------------------------- 1.3: the happy path

    /// RED→GREEN 1.3: all three conditions met → the instruction, naming the
    /// tools the server actually exposes.
    #[test]
    fn registered_agent_with_graph_gets_the_nudge() {
        for agent in ["claude-acp", "codex-acp"] {
            let text = gate(agent, true, true).expect("nudge for a registered agent");
            for tool in ["query_graph", "get_neighbors", "shortest_path"] {
                assert!(text.contains(tool), "{agent}: nudge must name {tool}");
            }
        }
    }

    // ------------------------------------------------------- 2.2: grep survives

    /// RED→GREEN 2.2: the block must keep grep as the answer for exact text and
    /// pre-edit reads. Without this the agent routes literal searches through a
    /// semantic graph and the change is a net loss — guards a later trim.
    #[test]
    fn nudge_keeps_grep_for_what_grep_is_good_at() {
        let text = gate("claude-acp", true, true).unwrap();
        assert!(text.contains("grep"), "nudge must name grep as still-correct");
    }

    // ------------------------------------------------------- 3.1: composition

    /// RED→GREEN 3.1: the nudge leads, the handoff prefix follows, blank line
    /// between. `send_to` then puts the user's message last.
    #[test]
    fn nudge_is_prepended_to_an_existing_prefix() {
        let composed = compose(Some("NUDGE"), Some("TRANSCRIPT".to_string())).unwrap();
        assert_eq!(composed, "NUDGE\n\nTRANSCRIPT");
    }

    /// Either side alone passes through; neither side means no prefix at all.
    #[test]
    fn compose_handles_each_side_missing() {
        assert_eq!(compose(Some("NUDGE"), None).as_deref(), Some("NUDGE"));
        assert_eq!(compose(None, Some("T".into())).as_deref(), Some("T"));
        assert_eq!(compose(None, None), None);
    }

    /// The PATH/graph checks are real IO, so this pins the paths `nudge` reads:
    /// a graph at `<root>/graphify-out/graph.json`.
    #[test]
    fn nudge_reads_the_graph_from_the_default_out_dir() {
        let dir = root_with_graph();
        let expected: PathBuf = crate::integrations::default_out_dir(dir.path()).join("graph.json");
        assert!(expected.exists());
    }
}
