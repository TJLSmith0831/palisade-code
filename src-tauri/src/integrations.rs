//! Graphify code maps.
//!
//! Results feed the executor the same way `/go` and `/propose` do — by
//! appending a `role: "tool"` message to the thread, which becomes part of
//! what the executor sees on its next turn. The injected summary is bounded so
//! one run can't dominate a thread's context; the full report and graph stay
//! in the results pane.
//!
//! Web search is deliberately absent: both executors have it built in, so a
//! harness-side search integration would only duplicate a tool the executor
//! already reaches for on its own (see I5 in this change's decision log).

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::store::Res;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphifyOptions {
    pub incremental: bool,
    pub code_only: bool,
    pub deep: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphifyRun {
    pub out_dir: String,
    pub report: String,
    pub graph: Option<Value>,
    pub summary: String,
}

pub const SUMMARY_LIMIT: usize = 4000;

/// D8's safe, key-less invocation, plus whichever toggles the user enabled.
pub fn graphify_args(target: &Path, out_dir: &Path, options: &GraphifyOptions) -> Vec<String> {
    let mut args = vec![
        "extract".to_string(),
        target.to_string_lossy().to_string(),
        "--out".to_string(),
        out_dir.to_string_lossy().to_string(),
        "--no-viz".to_string(),
        // --code-only is part of the safe default run; the toggle can't remove it.
        "--code-only".to_string(),
    ];
    if options.incremental {
        args.push("--update".to_string());
    }
    if options.deep {
        args.push("--mode".to_string());
        args.push("deep".to_string());
    }
    args
}

/// Bounded so one run can't dominate a thread's context.
pub fn summarize_report(report: &str, out_dir: &Path) -> String {
    // Truncate on a char boundary — reports are UTF-8 and may hold non-ASCII.
    let truncated: String = report.chars().take(SUMMARY_LIMIT).collect();
    let elided = report.chars().count() > SUMMARY_LIMIT;
    format!(
        "Graphify code map for {}{}\n\n{}\n\n(Full report and graph are in the Graph pane: {})",
        out_dir.display(),
        if elided { format!(" — first {SUMMARY_LIMIT} characters") } else { String::new() },
        truncated,
        out_dir.display()
    )
}

pub fn default_out_dir(project_root: &Path) -> PathBuf {
    project_root.join("graphify-out")
}

/// Read what a finished run left on disk. `graph.json` is optional so a report
/// still renders if the graph is missing or unreadable.
pub fn read_run(out_dir: &Path) -> Res<GraphifyRun> {
    let report = std::fs::read_to_string(out_dir.join("GRAPH_REPORT.md"))
        .map_err(|err| format!("no GRAPH_REPORT.md in {}: {err}", out_dir.display()))?;
    Ok(GraphifyRun {
        out_dir: out_dir.to_string_lossy().to_string(),
        summary: summarize_report(&report, out_dir),
        report,
        graph: std::fs::read_to_string(out_dir.join("graph.json"))
            .ok()
            .and_then(|body| serde_json::from_str::<Value>(&body).ok()),
    })
}

/// ponytail: written against D8's documented CLI shape but never run against a
/// real `graphify` — the binary isn't installed on this machine and isn't
/// published under that name on pip or npm. Re-verify the flags before
/// trusting a live run.
pub fn run_graphify(
    bin: &Path,
    target: &Path,
    out_dir: &Path,
    options: &GraphifyOptions,
) -> Res<GraphifyRun> {
    let output = Command::new(bin)
        .args(graphify_args(target, out_dir, options))
        .output()
        .map_err(|err| format!("could not run graphify: {err}"))?;
    if !output.status.success() {
        // A failed run injects nothing into the thread; the pane shows why.
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "graphify exited with {}:\n{}",
            output.status.code().unwrap_or(-1),
            if stderr.trim().is_empty() { "(no stderr output)" } else { stderr.trim() }
        ));
    }
    read_run(out_dir)
}

pub fn graphify_query(bin: &Path, subcommand: &str, question: &str, out_dir: &Path) -> Res<String> {
    if !matches!(subcommand, "query" | "path" | "explain") {
        return Err(format!("unsupported graphify subcommand: {subcommand}"));
    }
    let output = Command::new(bin)
        .args([
            subcommand,
            question,
            "--graph",
            &out_dir.join("graph.json").to_string_lossy(),
        ])
        .output()
        .map_err(|err| format!("could not run graphify {subcommand}: {err}"))?;
    if !output.status.success() {
        return Err(format!(
            "graphify {subcommand} failed:\n{}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

// ------------------------------------------------------------------ tests

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn graphify_args_are_the_safe_keyless_shape_plus_toggles() {
        let target = Path::new("/p");
        let out = Path::new("/p/graphify-out");
        let base = graphify_args(target, out, &GraphifyOptions::default());
        assert_eq!(base[0], "extract");
        assert_eq!(base[1], "/p");
        assert!(base.windows(2).any(|w| w == ["--out", "/p/graphify-out"]));
        assert!(base.contains(&"--no-viz".to_string()));
        assert!(base.contains(&"--code-only".to_string()));
        assert!(!base.contains(&"--update".to_string()));

        let all = graphify_args(
            target,
            out,
            &GraphifyOptions { incremental: true, code_only: true, deep: true },
        );
        assert!(all.contains(&"--update".to_string()));
        assert!(all.windows(2).any(|w| w == ["--mode", "deep"]));
    }

    #[test]
    fn a_report_under_the_limit_is_not_truncated() {
        let summary = summarize_report("# Map\n\nsmall report", Path::new("/p/out"));
        assert!(summary.contains("small report"));
        assert!(!summary.contains("first 4000 characters"));
        assert!(summary.contains("Graph pane"));
    }

    #[test]
    fn a_long_report_is_truncated_at_the_limit_on_a_char_boundary() {
        // Multi-byte chars would panic a naive byte slice at the boundary.
        let report = "é".repeat(SUMMARY_LIMIT + 500);
        let summary = summarize_report(&report, Path::new("/p/out"));
        assert!(summary.contains(&format!("first {SUMMARY_LIMIT} characters")));
        assert!(summary.contains(&report.chars().take(SUMMARY_LIMIT).collect::<String>()));
        assert!(!summary.contains(&report), "the full report must not be inlined");
    }

    #[test]
    fn exactly_the_limit_is_not_reported_as_truncated() {
        let report = "x".repeat(SUMMARY_LIMIT);
        assert!(!summarize_report(&report, Path::new("/p")).contains("first 4000"));
    }

    #[test]
    fn a_run_reads_the_report_and_tolerates_a_missing_graph() {
        let out = tempfile::tempdir().unwrap();
        std::fs::write(out.path().join("GRAPH_REPORT.md"), "# Map\n\nnodes: 12").unwrap();

        let run = read_run(out.path()).unwrap();
        assert!(run.report.contains("nodes: 12"));
        assert!(run.graph.is_none(), "a missing graph.json must not fail the run");

        std::fs::write(out.path().join("graph.json"), r#"{"nodes":[{"id":"a"}]}"#).unwrap();
        assert!(read_run(out.path()).unwrap().graph.is_some());
    }

    #[test]
    fn a_run_with_no_report_is_an_error() {
        assert!(read_run(tempfile::tempdir().unwrap().path()).is_err());
    }

    #[test]
    fn a_failing_graphify_process_errors_and_reads_nothing() {
        let out = tempfile::tempdir().unwrap();
        // `false` exits non-zero, standing in for a failed extract.
        let error = run_graphify(
            Path::new("/usr/bin/false"),
            Path::new("/tmp"),
            out.path(),
            &GraphifyOptions::default(),
        )
        .unwrap_err();
        assert!(error.contains("graphify exited with 1"), "got {error}");
    }

    #[test]
    fn a_missing_graphify_binary_is_a_clean_error_not_a_panic() {
        let out = tempfile::tempdir().unwrap();
        assert!(run_graphify(
            Path::new("/definitely/not/graphify"),
            Path::new("/tmp"),
            out.path(),
            &GraphifyOptions::default()
        )
        .is_err());
    }

    #[test]
    fn only_the_three_documented_query_subcommands_are_allowed() {
        let out = tempfile::tempdir().unwrap();
        let error = graphify_query(Path::new("/usr/bin/true"), "rm", "x", out.path()).unwrap_err();
        assert!(error.contains("unsupported"), "got {error}");
        assert!(graphify_query(Path::new("/usr/bin/true"), "query", "x", out.path()).is_ok());
    }
}
