//! Cross-restart child-process cleanup.
//!
//! `FsWatcher`/`Terminal` normally kill their child via `Drop` when replaced
//! or the app exits. That doesn't run when `tauri dev` hard-restarts the
//! whole Rust binary on a source change (observed: 20 orphaned watcher
//! processes accumulated across a single dev session, each still running and
//! burning CPU — D48). A PID file lets the *next* spawn find and kill what
//! the *previous* run's Drop never got to.
//!
//! Only ever used for children whose command line is distinctive enough to
//! safely re-identify after a PID could have been reused by an unrelated
//! process (D48's follow-up note) — `llama-server --model <path>` qualifies;
//! a bare login shell does not, so the PTY terminal deliberately doesn't use
//! this.
//!
//! ## What is covered, and what is deliberately not
//!
//! The orphaning is not theoretical. Beside the 20 orphaned watcher
//! processes above, an audit found `llama-server` PID 1659 reparented to
//! init, its owning app long gone, still holding a GPU-backed model some 31
//! hours later. Nothing would ever have reaped it.
//!
//! Covered, because each carries an absolute path unique to this app on its
//! command line:
//!
//! * `llama-server --model <model path>` — `completion.rs`
//! * `python3 <…>/notebook_driver.py` — `notebook.rs`
//!
//! Deliberately **not** covered, for the same reason as the login shell:
//!
//! * **Language servers** (`lsp.rs`). Spawned as `rust-analyzer` or
//!   `typescript-language-server --stdio` with the project as the working
//!   directory — and `ps -o command=` does not show a working directory. The
//!   command line is the bare binary and generic flags, which is exactly what
//!   the user's own editor is running. Reaping on that substring would kill
//!   the language server belonging to whatever VS Code, Zed or Neovim window
//!   happened to be open.
//! * **Debug adapters** (`dap.rs`). Same shape, same risk: the adapter's
//!   command and args come from a registry and carry nothing project-specific.
//!
//! Those two need the child to be made identifiable first — an argument
//! naming the project, or a marker in its environment — and that is a change
//! to how they are spawned, not to this module. Killing the wrong process is
//! worse than leaking one.

use std::path::Path;
use std::process::Command;

/// If `path` names a still-running process whose command line contains
/// `expect_substring`, kill it. Removes `path` either way — a stale file
/// naming a dead or unrelated (PID-reused) process shouldn't linger either.
pub fn reap_stale(path: &Path, expect_substring: &str) {
    let Ok(raw) = std::fs::read_to_string(path) else { return };
    let _ = std::fs::remove_file(path);
    let Ok(pid) = raw.trim().parse::<u32>() else { return };

    let Ok(output) = Command::new("ps").args(["-p", &pid.to_string(), "-o", "command="]).output()
    else {
        return;
    };
    if String::from_utf8_lossy(&output.stdout).contains(expect_substring) {
        let _ = Command::new("kill").arg(pid.to_string()).status();
    }
}

pub fn record(path: &Path, pid: u32) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(path, pid.to_string());
}

pub fn clear(path: &Path) {
    let _ = std::fs::remove_file(path);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Stdio;

    #[test]
    fn reaps_a_still_running_process_matching_the_expected_command() {
        let dir = tempfile::tempdir().unwrap();
        let pid_path = dir.path().join(".watch.pid");

        let mut child = Command::new("sleep").arg("30").stdout(Stdio::null()).spawn().unwrap();
        record(&pid_path, child.id());

        reap_stale(&pid_path, "sleep 30");

        // `wait` on an already-killed child returns promptly with a signal exit status.
        let status = child.wait().unwrap();
        assert!(!status.success());
        assert!(!pid_path.exists());
    }

    #[test]
    fn does_not_kill_a_live_process_whose_command_does_not_match() {
        let dir = tempfile::tempdir().unwrap();
        let pid_path = dir.path().join(".watch.pid");

        let mut child = Command::new("sleep").arg("30").stdout(Stdio::null()).spawn().unwrap();
        record(&pid_path, child.id());

        // Wrong expected substring — must not touch this process.
        reap_stale(&pid_path, "llama-server --model /some/other/model.gguf");

        assert_eq!(child.try_wait().unwrap(), None, "process should still be running");
        let _ = child.kill();
        let _ = child.wait();
    }

    #[test]
    fn missing_pid_file_is_a_silent_no_op() {
        let dir = tempfile::tempdir().unwrap();
        reap_stale(&dir.path().join("does-not-exist.pid"), "anything");
    }

    /// A process whose *real* command line contains `token`, so `ps` reports
    /// it the way the orphan being simulated would be reported.
    fn process_advertising(token: &str) -> std::process::Child {
        Command::new("/bin/sh")
            .args(["-c", &format!("sleep 30 # {token}")])
            .stdout(Stdio::null())
            .spawn()
            .unwrap()
    }

    /// Each covered child kind, as (name, the token its reaper matches on).
    /// The tokens come from the same functions the spawn paths call, so a
    /// change to either is caught here rather than at 3am.
    fn covered_kinds() -> Vec<(&'static str, String)> {
        let model = Path::new("/Applications/Palisade.app/Contents/Resources/models/Qwen.gguf");
        let driver = Path::new("/Applications/Palisade.app/Contents/Resources/driver/notebook_driver.py");
        vec![
            ("completion sidecar", crate::completion::sidecar_reap_token(model)),
            ("notebook kernel", crate::notebook::kernel_reap_token(driver)),
        ]
    }

    #[test]
    fn every_covered_child_kind_is_reaped_after_a_hard_restart() {
        for (kind, token) in covered_kinds() {
            let dir = tempfile::tempdir().unwrap();
            let pid_path = dir.path().join("child.pid");
            let mut child = process_advertising(&token);
            record(&pid_path, child.id());

            reap_stale(&pid_path, &token);

            let status = child.wait().unwrap();
            assert!(!status.success(), "{kind} survived its own reaper");
            assert!(!pid_path.exists(), "{kind} left its pid file behind");
        }
    }

    #[test]
    fn a_reused_pid_belonging_to_something_else_is_left_alone() {
        // The failure that matters. A PID recorded before a restart can have
        // been handed to an unrelated process by the time the next run looks
        // at it; killing on the PID alone would take out whatever now holds
        // it. Each kind's reaper must refuse to act on a command line that
        // is not its own.
        for (kind, token) in covered_kinds() {
            let dir = tempfile::tempdir().unwrap();
            let pid_path = dir.path().join("child.pid");
            let mut innocent = process_advertising("some other user's process");
            record(&pid_path, innocent.id());

            reap_stale(&pid_path, &token);

            assert_eq!(
                innocent.try_wait().unwrap(),
                None,
                "{kind}'s reaper killed an unrelated process holding a reused pid"
            );
            let _ = innocent.kill();
            let _ = innocent.wait();
        }
    }

    #[test]
    fn the_kinds_that_opt_out_are_the_ones_that_cannot_be_identified() {
        // Language servers and debug adapters are spawned as a bare binary
        // name with generic flags — exactly what the user's own editor runs —
        // so reaping on that substring would kill their editor's server. This
        // asserts the reason rather than the omission: if either ever grows a
        // project-specific argument, that is the moment to reconsider, and
        // this test is where the note lives.
        let lsp = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/lsp.rs")).unwrap();
        let dap = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/dap.rs")).unwrap();
        assert!(!lsp.contains("pidguard"), "lsp.rs now uses pidguard — see this module's header");
        assert!(!dap.contains("pidguard"), "dap.rs now uses pidguard — see this module's header");
        // Both still rely on the working directory, which `ps` does not show.
        assert!(lsp.contains("current_dir(project_root)"));
        assert!(dap.contains("current_dir(&project_root)"));
    }
}
