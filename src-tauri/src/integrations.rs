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
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

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
/// `--out` gets the project root (`out_dir`'s parent), not `out_dir` itself
/// — the real CLI writes its own nested `graphify-out/` under whatever
/// `--out` receives, so passing `out_dir` directly double-nests it (D25).
/// `--no-viz` is deliberately absent — not a recognized `extract` flag
/// (belongs on `cluster-only`, see below). Incremental runs never reach
/// this function; see `graphify_update_args`.
pub fn graphify_args(target: &Path, out_dir: &Path, options: &GraphifyOptions) -> Vec<String> {
    let project_root = out_dir.parent().unwrap_or(out_dir);
    let mut args = vec![
        "extract".to_string(),
        target.to_string_lossy().to_string(),
        "--out".to_string(),
        project_root.to_string_lossy().to_string(),
        // --code-only is part of the safe default run; the toggle can't remove it.
        "--code-only".to_string(),
    ];
    if options.deep {
        args.push("--mode".to_string());
        args.push("deep".to_string());
    }
    args
}

/// `extract` alone never writes `GRAPH_REPORT.md` (verified against the
/// real CLI, D25) — this has to run after a successful `extract` to
/// generate the report and community labels. Degrades gracefully with no
/// API key configured (keeps `Community N` placeholders).
pub fn cluster_only_args(project_root: &Path) -> Vec<String> {
    vec![
        "cluster-only".to_string(),
        project_root.to_string_lossy().to_string(),
        "--no-viz".to_string(),
    ]
}

/// Incremental rescanning is `graphify update <target>`, a separate
/// subcommand from `extract` — not a flag on it. Unlike `extract`, `update`
/// has no `--out` override: it always writes to `<target>/graphify-out`, so
/// callers must only use this when `target` is the project root that the
/// caller's `out_dir` was derived from (D24; enforced in `run_graphify`).
pub fn graphify_update_args(target: &Path) -> Vec<String> {
    vec!["update".to_string(), target.to_string_lossy().to_string()]
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

/// Run one graphify subcommand and surface a non-zero exit as an error. A
/// failed step injects nothing into the thread; the pane shows why.
fn run_step(bin: &Path, args: Vec<String>) -> Res<()> {
    let output = Command::new(bin)
        .args(args)
        .output()
        .map_err(|err| format!("could not run graphify: {err}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "graphify exited with {}:\n{}",
            output.status.code().unwrap_or(-1),
            if stderr.trim().is_empty() { "(no stderr output)" } else { stderr.trim() }
        ));
    }
    Ok(())
}

/// Verified against the real `graphify` (PyPI `graphifyy`) CLI.
pub fn run_graphify(
    bin: &Path,
    target: &Path,
    out_dir: &Path,
    options: &GraphifyOptions,
) -> Res<GraphifyRun> {
    let project_root = out_dir.parent().ok_or("graphify-out has no parent directory")?;
    if options.incremental {
        // D24: `update` has no `--out` override, so its output always lands
        // at `<target>/graphify-out` — refuse rather than silently writing
        // somewhere the results pane won't read from. `update` already
        // produces GRAPH_REPORT.md itself, unlike `extract` below.
        if target != project_root {
            return Err(
                "incremental updates can't be scoped to a subdirectory — \
                 `graphify update` always writes to the project root's graphify-out"
                    .into(),
            );
        }
        run_step(bin, graphify_update_args(target))?;
    } else {
        // D25: `extract` alone never writes GRAPH_REPORT.md — `cluster-only`
        // has to follow it.
        run_step(bin, graphify_args(target, out_dir, options))?;
        run_step(bin, cluster_only_args(project_root))?;
    }
    read_run(out_dir)
}

/// `query`/`explain` take one positional question; `path` takes two
/// positional node names — the real CLI shape (`graphify path "A" "B"`),
/// not the single free-text field the old UI assumed.
pub fn graphify_query(bin: &Path, subcommand: &str, args: &[&str], out_dir: &Path) -> Res<String> {
    let expected = match subcommand {
        "query" | "explain" => 1,
        "path" => 2,
        _ => return Err(format!("unsupported graphify subcommand: {subcommand}")),
    };
    if args.len() != expected {
        return Err(format!(
            "graphify {subcommand} needs {expected} argument(s), got {}",
            args.len()
        ));
    }
    let mut cmd_args: Vec<String> = vec![subcommand.to_string()];
    cmd_args.extend(args.iter().map(|a| a.to_string()));
    cmd_args.push("--graph".to_string());
    cmd_args.push(out_dir.join("graph.json").to_string_lossy().to_string());

    let output = Command::new(bin)
        .args(&cmd_args)
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

// -------------------------------------------------------------- always-on

const WATCH_POLL_INTERVAL: Duration = Duration::from_millis(1000);

/// Supervises `graphify watch <project_root>` for the currently active
/// project. Everything — spawning, polling `graph.json`'s mtime for the
/// pane-refresh signal, and detecting a crash — runs on one background
/// thread, so `terminate()`/`Drop` never has to reach across threads to
/// touch the child process.
pub struct Watcher {
    stopping: Arc<AtomicBool>,
    handle: Option<thread::JoinHandle<()>>,
    pid_path: PathBuf,
}

impl Watcher {
    /// Returns immediately; a `bin` that can't be spawned is reported once
    /// through `on_crash`, not the return value, so a missing/bad graphify
    /// binary never blocks whoever is starting the watcher (non-blocking
    /// per the graphify-integration spec).
    pub fn spawn(
        bin: PathBuf,
        project_root: PathBuf,
        on_update: impl Fn() + Send + 'static,
        on_crash: impl Fn(String) + Send + 'static,
    ) -> Self {
        let pid_path = default_out_dir(&project_root).join(".watch.pid");
        // A predecessor's Drop may never have run (tauri dev's hard-restart
        // on a backend rebuild, D48) — clean up before adding a new one.
        crate::pidguard::reap_stale(&pid_path, "graphify watch");

        let stopping = Arc::new(AtomicBool::new(false));
        let handle = {
            let stopping = Arc::clone(&stopping);
            let pid_path = pid_path.clone();
            thread::spawn(move || {
                let mut child = match Command::new(&bin)
                    .arg("watch")
                    .arg(&project_root)
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                {
                    Ok(child) => child,
                    Err(err) => {
                        on_crash(format!("could not start graphify watch: {err}"));
                        return;
                    }
                };
                crate::pidguard::record(&pid_path, child.id());
                let graph_path = default_out_dir(&project_root).join("graph.json");
                let mut last_seen = std::fs::metadata(&graph_path).and_then(|m| m.modified()).ok();
                loop {
                    if stopping.load(Ordering::SeqCst) {
                        let _ = child.kill();
                        let _ = child.wait();
                        return;
                    }
                    match child.try_wait() {
                        Ok(Some(status)) => {
                            on_crash(format!("graphify watch exited unexpectedly ({status})"));
                            return;
                        }
                        Ok(None) => {}
                        Err(_) => {}
                    }
                    if let Ok(modified) = std::fs::metadata(&graph_path).and_then(|m| m.modified()) {
                        if last_seen != Some(modified) {
                            last_seen = Some(modified);
                            on_update();
                        }
                    }
                    thread::sleep(WATCH_POLL_INTERVAL);
                }
            })
        };
        Watcher { stopping, handle: Some(handle), pid_path }
    }

    pub fn terminate(&mut self) {
        self.stopping.store(true, Ordering::SeqCst);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
        // A clean stop already killed the child (the poll loop's stopping
        // check) — clear the record so the next spawn's reap_stale doesn't
        // find a PID that's already gone (harmless, but needless work).
        crate::pidguard::clear(&self.pid_path);
    }
}

impl Drop for Watcher {
    fn drop(&mut self) {
        self.terminate();
    }
}

// ------------------------------------------------------------------ tests

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::mpsc;
    use std::time::Duration;

    /// Writes an executable stand-in for `graphify watch` that just hangs
    /// (ignores its argv), so the test controls `graph.json` itself.
    fn hanging_stand_in(dir: &Path) -> PathBuf {
        let script = dir.join("fake-graphify-watch.sh");
        std::fs::write(&script, "#!/bin/sh\nsleep 100\n").unwrap();
        let mut perms = std::fs::metadata(&script).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script, perms).unwrap();
        script
    }

    #[test]
    fn watcher_calls_on_update_when_graph_json_changes() {
        let root = tempfile::tempdir().unwrap();
        let out = root.path().join("graphify-out");
        std::fs::create_dir_all(&out).unwrap();
        std::fs::write(out.join("graph.json"), "v1").unwrap();

        let (tx, rx) = mpsc::channel();
        let mut watcher = Watcher::spawn(
            hanging_stand_in(root.path()),
            root.path().to_path_buf(),
            move || {
                let _ = tx.send(());
            },
            |_| {},
        );

        // Give the poll loop one cycle to record the starting mtime, then
        // change the file — matches an incremental rebuild landing.
        std::thread::sleep(Duration::from_millis(50));
        std::fs::write(out.join("graph.json"), "v2").unwrap();
        rx.recv_timeout(Duration::from_secs(3)).expect("on_update should fire on mtime change");

        watcher.terminate();
    }

    #[test]
    fn watcher_calls_on_crash_when_the_process_exits_immediately() {
        let root = tempfile::tempdir().unwrap();
        let (tx, rx) = mpsc::channel();
        let mut watcher = Watcher::spawn(
            PathBuf::from("/usr/bin/true"), // exits immediately — stands in for a crash
            root.path().to_path_buf(),
            || {},
            move |message| {
                let _ = tx.send(message);
            },
        );
        let message = rx.recv_timeout(Duration::from_secs(3)).expect("on_crash should fire");
        assert!(message.contains("exited"), "got {message}");
        watcher.terminate();
    }

    #[test]
    fn watcher_calls_on_crash_when_the_binary_does_not_exist() {
        let root = tempfile::tempdir().unwrap();
        let (tx, rx) = mpsc::channel();
        let mut watcher = Watcher::spawn(
            PathBuf::from("/definitely/not/graphify"),
            root.path().to_path_buf(),
            || {},
            move |message| {
                let _ = tx.send(message);
            },
        );
        let message = rx.recv_timeout(Duration::from_secs(3)).expect("on_crash should fire");
        assert!(message.contains("could not start"), "got {message}");
        watcher.terminate();
    }

    #[test]
    fn graphify_args_passes_the_project_root_as_out_not_the_graphify_out_dir() {
        // The real CLI writes its own nested `graphify-out/` under whatever
        // `--out` receives (D25) — passing `out_dir` itself double-nests it.
        let target = Path::new("/p/sub");
        let out_dir = Path::new("/p/graphify-out");
        let args = graphify_args(target, out_dir, &GraphifyOptions::default());
        assert!(args.windows(2).any(|w| w == ["--out", "/p"]));
        assert!(!args.contains(&"/p/graphify-out".to_string()));
    }

    #[test]
    fn cluster_only_args_are_the_report_generation_shape() {
        assert_eq!(
            cluster_only_args(Path::new("/p")),
            vec!["cluster-only", "/p", "--no-viz"],
        );
    }

    #[test]
    fn a_successful_extract_is_followed_by_cluster_only_to_produce_the_report() {
        // extract alone never writes GRAPH_REPORT.md (D25, verified against
        // the real CLI) — this stand-in only succeeds at producing one on
        // `cluster-only`, so a passing test proves the chain runs both, not
        // just the first command.
        let root = tempfile::tempdir().unwrap();
        let script = root.path().join("fake-graphify.sh");
        std::fs::write(
            &script,
            "#!/bin/sh\nif [ \"$1\" = \"cluster-only\" ]; then\n  mkdir -p \"$2/graphify-out\"\n  echo '# report' > \"$2/graphify-out/GRAPH_REPORT.md\"\nfi\nexit 0\n",
        )
        .unwrap();
        let mut perms = std::fs::metadata(&script).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script, perms).unwrap();

        let out_dir = root.path().join("graphify-out");
        let run = run_graphify(&script, root.path(), &out_dir, &GraphifyOptions::default()).unwrap();
        assert!(run.report.contains("# report"));
    }

    #[test]
    fn graphify_args_are_the_safe_keyless_extract_shape() {
        let target = Path::new("/p/sub");
        let out = Path::new("/p/graphify-out");
        let base = graphify_args(target, out, &GraphifyOptions::default());
        assert_eq!(base[0], "extract");
        assert_eq!(base[1], "/p/sub");
        // --out is the project root (D25), not the graphify-out path itself.
        assert!(base.windows(2).any(|w| w == ["--out", "/p"]));
        assert!(base.contains(&"--code-only".to_string()));
        // --no-viz is not a real `extract` flag (only cluster-only/tree have it).
        assert!(!base.contains(&"--no-viz".to_string()));
        // Incremental is a separate subcommand now, never an `extract` flag.
        assert!(!base.contains(&"--update".to_string()));

        let deep = graphify_args(target, out, &GraphifyOptions { deep: true, ..Default::default() });
        assert!(deep.windows(2).any(|w| w == ["--mode", "deep"]));
    }

    #[test]
    fn update_args_are_the_bare_incremental_shape() {
        // `graphify update` has no `--out` override (D24) — just the subcommand
        // and the target, which must be the project root the caller already
        // verified matches `out_dir`'s parent.
        assert_eq!(graphify_update_args(Path::new("/p")), vec!["update", "/p"]);
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
        let error = graphify_query(Path::new("/usr/bin/true"), "rm", &["x"], out.path()).unwrap_err();
        assert!(error.contains("unsupported"), "got {error}");
        assert!(graphify_query(Path::new("/usr/bin/true"), "query", &["x"], out.path()).is_ok());
    }

    #[test]
    fn query_and_explain_need_exactly_one_argument() {
        let out = tempfile::tempdir().unwrap();
        let error = graphify_query(Path::new("/usr/bin/true"), "query", &[], out.path()).unwrap_err();
        assert!(error.contains("needs 1 argument"), "got {error}");
        let error =
            graphify_query(Path::new("/usr/bin/true"), "explain", &["a", "b"], out.path()).unwrap_err();
        assert!(error.contains("needs 1 argument"), "got {error}");
    }

    #[test]
    fn path_needs_exactly_two_node_names() {
        let out = tempfile::tempdir().unwrap();
        let error = graphify_query(Path::new("/usr/bin/true"), "path", &["a"], out.path()).unwrap_err();
        assert!(error.contains("needs 2 argument"), "got {error}");
        assert!(graphify_query(Path::new("/usr/bin/true"), "path", &["a", "b"], out.path()).is_ok());
    }

    #[test]
    fn incremental_run_uses_the_update_subcommand_not_extract() {
        let root = tempfile::tempdir().unwrap();
        let out = root.path().join("graphify-out");
        std::fs::write(
            out.join("GRAPH_REPORT.md"),
            "unreachable — /usr/bin/false always fails first",
        )
        .ok();
        let error = run_graphify(
            Path::new("/usr/bin/false"),
            root.path(),
            &out,
            &GraphifyOptions { incremental: true, ..Default::default() },
        )
        .unwrap_err();
        // /usr/bin/false takes no args and always exits 1 regardless of what
        // it's called with, so this only proves incremental reaches the
        // "run and check exit status" path, not the exact argv — see
        // `update_args_are_the_bare_incremental_shape` for the argv shape.
        assert!(error.contains("graphify exited with 1"), "got {error}");
    }

    #[test]
    fn incremental_refuses_a_target_that_is_not_out_dirs_parent() {
        // D24: `graphify update` has no `--out` override, so an incremental
        // run scoped to a subdirectory would silently write outside where
        // the results pane reads from. Caught before spawning anything.
        let out = tempfile::tempdir().unwrap();
        let out_dir = out.path().join("graphify-out");
        let error = run_graphify(
            Path::new("/usr/bin/true"),
            Path::new("/somewhere/else"),
            &out_dir,
            &GraphifyOptions { incremental: true, ..Default::default() },
        )
        .unwrap_err();
        assert!(error.contains("subdirectory"), "got {error}");
    }
}
