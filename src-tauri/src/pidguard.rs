//! Cross-restart child-process cleanup.
//!
//! `Watcher`/`Terminal` normally kill their child via `Drop` when replaced
//! or the app exits. That doesn't run when `tauri dev` hard-restarts the
//! whole Rust binary on a source change (observed: 20 orphaned `graphify
//! watch` processes accumulated across a single dev session, each still
//! running and burning CPU — D48). A PID file lets the *next* spawn find
//! and kill what the *previous* run's Drop never got to.
//!
//! Only ever used for children whose command line is distinctive enough to
//! safely re-identify after a PID could have been reused by an unrelated
//! process (D48's follow-up note) — `graphify watch <path>` qualifies; a
//! bare login shell does not, so the PTY terminal deliberately doesn't use
//! this.

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
        reap_stale(&pid_path, "graphify watch /some/other/project");

        assert_eq!(child.try_wait().unwrap(), None, "process should still be running");
        let _ = child.kill();
        let _ = child.wait();
    }

    #[test]
    fn missing_pid_file_is_a_silent_no_op() {
        let dir = tempfile::tempdir().unwrap();
        reap_stale(&dir.path().join("does-not-exist.pid"), "anything");
    }
}
