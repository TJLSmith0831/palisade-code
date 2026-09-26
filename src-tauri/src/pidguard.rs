//! Cross-restart, cross-crash child-process cleanup.
//!
//! `FsWatcher`/`Terminal`/`CompletionServer`/`NotebookKernel` normally kill
//! their child via `Drop` when replaced or the app exits. That doesn't run
//! when `tauri dev` hard-restarts the whole Rust binary on a source change
//! (observed: 20 orphaned watcher processes accumulated across a single dev
//! session), nor when the app is SIGKILLed, crashes, or is force-quit
//! (reproduced: an app sent SIGTERM left its `llama-server` sidecar alive
//! with PPID 1 — reparented to launchd, orphaned instantly, no `Drop` to ever
//! run). Two complementary defenses:
//!
//! * **`spawn_supervised`** is the real fix: a tiny supervisor process sits
//!   between the app and the sidecar and kills the sidecar the moment the
//!   app dies, for any reason, with no polling. `completion.rs` and
//!   `notebook.rs` spawn their sidecars through it.
//! * **`reap_stale`** is belt-and-braces: a PID file lets the *next* spawn
//!   find and kill what somehow still survived (a bug in the above, or a
//!   leak from before this module grew it).
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

use std::io::{self, Read, Write};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::thread;

use sha2::{Digest, Sha256};

/// If `path` names a still-running process whose command line contains
/// `expect_substring`, kill it (and, on unix, its whole process group — see
/// `spawn_supervised`, whose supervisor is always that group's leader).
/// Removes `path` either way — a stale file naming a dead or unrelated
/// (PID-reused) process shouldn't linger either.
pub fn reap_stale(path: &Path, expect_substring: &str) {
    let Ok(raw) = std::fs::read_to_string(path) else { return };
    let _ = std::fs::remove_file(path);
    let Ok(pid) = raw.trim().parse::<u32>() else { return };

    let Ok(output) = Command::new("ps").args(["-p", &pid.to_string(), "-o", "command="]).output()
    else {
        return;
    };
    if String::from_utf8_lossy(&output.stdout).contains(expect_substring) {
        kill_group(pid);
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

/// Folds a distinguishing command-line token (the model or driver's absolute
/// path — see `reap_stale`'s doc) into a short hex string safe to use in a
/// filename. Different builds/worktrees embed different absolute paths in
/// their sidecar's command line, so keying a pid-file's name by this hash
/// keeps concurrent instances (dev worktrees, hard restarts) from
/// overwriting each other's record and reaping a sibling's still-live
/// sidecar — the "keying the file by instance" fix `completion.rs` used to
/// defer as a known ponytail ceiling.
pub fn instance_key(token: &str) -> String {
    let digest = Sha256::digest(token.as_bytes());
    digest.iter().take(4).map(|byte| format!("{byte:02x}")).collect()
}

/// Kills `pid` and, on unix, its whole process group (`spawn_supervised`
/// always makes its supervisor a group leader, so this reaches the real
/// sidecar underneath it too — a plain single-pid kill would only take the
/// supervisor and orphan the sidecar one level further down).
pub fn kill_group(pid: u32) {
    #[cfg(unix)]
    {
        let _ = Command::new("kill").args(["-9", &format!("-{pid}")]).status();
    }
    #[cfg(not(unix))]
    {
        let _ = Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).status();
    }
}

/// Presence marks this process invocation as "act as a sidecar supervisor",
/// not the real app — read by `main.rs` before Tauri touches anything.
pub const SUPERVISE_ENV: &str = "__PALISADE_PIDGUARD_SUPERVISE";
const SUPERVISE_PROGRAM_ENV: &str = "__PALISADE_PIDGUARD_PROGRAM";
const SUPERVISE_ARGS_ENV: &str = "__PALISADE_PIDGUARD_ARGS";

/// Spawns `program` behind a tiny supervisor so it dies the instant *this*
/// process does — by any means, including SIGKILL or a crash, not just a
/// clean exit that would run `Drop`. See this module's header for why a
/// bare child isn't enough: reparented to launchd, it just keeps running.
///
/// The supervisor is this same executable, re-invoked with `SUPERVISE_ENV`
/// set (`main.rs` special-cases that before Tauri starts). It holds the read
/// end of a pipe whose write end only *we* hold: dropped explicitly by a
/// caller's `terminate()`, or closed automatically by the kernel the instant
/// this process exits for any reason at all — a dying process's fd table is
/// torn down unconditionally, so this needs no polling and misses nothing.
/// Either way the supervisor's blocking read of it unblocks with EOF, and it
/// kills `program` (and, being a process-group leader, anything `program`
/// itself spawned) and exits.
///
/// The returned `Child`'s stdin *is* that pipe: bytes written to it are
/// relayed straight through to `program`'s own stdin unchanged (the notebook
/// driver's real command protocol rides this unmodified); a program like
/// `llama-server` that ignores its stdin just never receives anything.
/// Used by `completion.rs`/`notebook.rs` in real (`#[cfg(not(test))]`)
/// builds only — the test binary compiles their `#[cfg(test)]` direct-spawn
/// double instead, so this looks unused from a `cargo test` build.
#[cfg_attr(test, allow(dead_code))]
pub fn spawn_supervised(program: &Path, args: &[String]) -> io::Result<Child> {
    let exe = std::env::current_exe()?;
    spawn_supervised_via(&exe, &[], program, args)
}

/// `spawn_supervised`, but re-invoking `supervisor_exe` (with `pre_args`
/// ahead of it) instead of `current_exe()`. Production always goes through
/// `spawn_supervised`; this exists so a test can re-invoke the *test*
/// binary with a name filter that runs only a dedicated supervisor-entry
/// test, instead of cargo test's default "run everything in this binary".
pub fn spawn_supervised_via(supervisor_exe: &Path, pre_args: &[&str], program: &Path, args: &[String]) -> io::Result<Child> {
    let args_json = serde_json::to_string(args).expect("args are plain strings, always serializable");
    let mut cmd = Command::new(supervisor_exe);
    cmd.args(pre_args)
        .env(SUPERVISE_ENV, "1")
        .env(SUPERVISE_PROGRAM_ENV, program)
        .env(SUPERVISE_ARGS_ENV, args_json)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    make_group_leader(&mut cmd);
    cmd.spawn()
}

/// Makes a not-yet-spawned command its own process-group leader. Every
/// caller that later kills a child via `kill_group` (`reap_stale`, and
/// `terminate`'s force-kill fallback in completion.rs/notebook.rs, including
/// their `#[cfg(test)]` direct-spawn paths) must apply this at spawn time —
/// `kill_group` sends to the negative pid, which only reaches anything if
/// that pid is really a group id. A plain child (not a leader) has some
/// *other* pid as its group id, so a group-kill aimed at it finds no such
/// group and silently does nothing, hanging whoever is waiting on it.
#[cfg(unix)]
pub(crate) fn make_group_leader(cmd: &mut Command) {
    use std::os::unix::process::CommandExt;
    cmd.process_group(0);
}
#[cfg(not(unix))]
pub(crate) fn make_group_leader(_cmd: &mut Command) {}

/// True if this process was re-invoked to act as a supervisor (see
/// `spawn_supervised`) — checked by `main.rs` before Tauri starts anything.
pub fn is_supervisor_invocation() -> bool {
    std::env::var_os(SUPERVISE_ENV).is_some()
}

/// Runs this process as a supervisor: spawns the program named by the
/// `SUPERVISE_*` env vars `spawn_supervised` set, relays this process's own
/// stdin to it, and kills it the moment that relay hits EOF (our parent
/// died, or explicitly closed its end — see `spawn_supervised`'s doc) or the
/// program exits on its own. Never returns.
pub fn run_supervisor() -> ! {
    let Some(program) = std::env::var_os(SUPERVISE_PROGRAM_ENV) else {
        eprintln!("pidguard supervisor: missing {SUPERVISE_PROGRAM_ENV}");
        std::process::exit(1);
    };
    let args_json = std::env::var(SUPERVISE_ARGS_ENV).unwrap_or_default();
    let args: Vec<String> = serde_json::from_str(&args_json).unwrap_or_default();

    let mut cmd = Command::new(&program);
    cmd.args(&args).stdin(Stdio::piped()).stdout(Stdio::inherit()).stderr(Stdio::inherit());
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(err) => {
            eprintln!("pidguard supervisor: failed to spawn {program:?}: {err}");
            std::process::exit(1);
        }
    };
    let mut child_stdin = child.stdin.take();

    // Exits this whole process the moment the supervised program exits on
    // its own (crash, normal completion) — nothing left to supervise.
    let waiter = thread::spawn(move || {
        let code = child.wait().ok().and_then(|status| status.code()).unwrap_or(1);
        std::process::exit(code);
    });

    // Relay our stdin to the program's stdin until EOF. A 0-byte read means
    // our write end closed: instantly, on our real parent's death by ANY
    // cause, or on purpose when a caller's `terminate()` drops it. Either
    // way the program has to go.
    let mut buf = [0u8; 4096];
    loop {
        match io::stdin().read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if let Some(stdin) = child_stdin.as_mut() {
                    if stdin.write_all(&buf[..n]).is_err() {
                        break;
                    }
                }
            }
        }
    }
    // Kill our *own* pid, not the child's: `make_group_leader` made this
    // process the group's leader when it was spawned, so this reaches the
    // supervised program (and anything it itself spawned) in one shot —
    // killing the child's bare pid would target a group that doesn't exist,
    // since the child is an ordinary member of this process's group, not a
    // leader of its own.
    kill_group(std::process::id());
    let _ = waiter.join();
    unreachable!("the waiter thread always calls process::exit");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Stdio;
    use std::time::{Duration, Instant};

    /// Every real caller's recorded pid is a process-group leader (see
    /// `make_group_leader`) — `kill_group` depends on that to reach a
    /// sidecar underneath its supervisor. Tests that exercise `kill_group`
    /// (directly or via `reap_stale`) must set up the same invariant, or a
    /// negative-pid kill targets a group that doesn't exist and silently
    /// does nothing.
    fn spawn_group_leader(program: &str, args: &[&str]) -> std::process::Child {
        let mut cmd = Command::new(program);
        cmd.args(args).stdout(Stdio::null());
        make_group_leader(&mut cmd);
        cmd.spawn().unwrap()
    }

    #[test]
    fn reaps_a_still_running_process_matching_the_expected_command() {
        let dir = tempfile::tempdir().unwrap();
        let pid_path = dir.path().join(".watch.pid");

        let mut child = spawn_group_leader("sleep", &["30"]);
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

        let mut child = spawn_group_leader("sleep", &["30"]);
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
        // Two commands, not one: a lone `sleep 30` lets sh exec it directly,
        // and then `ps` reports `sleep 30` — no token — and the reaper
        // (correctly) leaves the process alone, so the test waited 30s and
        // failed. A compound command keeps sh resident with its full
        // argv, which is how a real orphaned sidecar advertises itself.
        spawn_group_leader("/bin/sh", &["-c", &format!("sleep 30; true # {token}")])
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

    #[test]
    fn instance_key_differs_for_different_tokens_and_is_stable_for_the_same_one() {
        let a = instance_key("/worktree-a/Resources/models/Qwen.gguf");
        let b = instance_key("/worktree-b/Resources/models/Qwen.gguf");
        assert_ne!(a, b, "two builds' distinct model paths must not collide");
        assert_eq!(a, instance_key("/worktree-a/Resources/models/Qwen.gguf"));
    }

    // --- Cross-process SIGKILL-of-the-parent proof ---------------------
    //
    // `spawn_supervised` claims the sidecar dies even if this process is
    // SIGKILLed, not just on a clean exit. That can only be proven with a
    // real second process holding the pipe, because the whole point is
    // testing what the kernel does when a process's fd table is torn down
    // out from under it — nothing in-process can stand in for that.
    //
    // Three real processes, chained by re-invoking this very test binary
    // with a distinct filter each time so cargo test's default "run every
    // test" never recurses:
    //   outer test (this one)
    //     -> stand-in parent ("supervisor_stand_in_parent", below)
    //          -> supervisor  ("run_supervisor_test_entry", below)
    //               -> sleep 600
    // The outer test SIGKILLs the stand-in parent and asserts `sleep 600`
    // is gone shortly after — proof the supervisor reacted to nothing but
    // its own pipe closing, exactly as it would in production.

    const STAND_IN_ENV: &str = "__PIDGUARD_TEST_STAND_IN_PARENT";
    const HANDSHAKE_PATH_ENV: &str = "__PIDGUARD_TEST_HANDSHAKE_PATH";

    fn process_is_alive(pid: u32) -> bool {
        Command::new("kill").args(["-0", &pid.to_string()]).status().map(|s| s.success()).unwrap_or(false)
    }

    #[test]
    fn child_dies_when_the_supervising_parent_is_sigkilled() {
        let dir = tempfile::tempdir().unwrap();
        let handshake = dir.path().join("child.pid");
        let exe = std::env::current_exe().unwrap();

        // Re-invoke this test binary filtered to just the stand-in-parent
        // test below; the env var is what turns that test from a no-op into
        // "actually do the thing".
        let mut parent = Command::new(&exe)
            .args(["pidguard::tests::supervisor_stand_in_parent", "--exact", "--nocapture"])
            .env(STAND_IN_ENV, "1")
            .env(HANDSHAKE_PATH_ENV, &handshake)
            .stdout(Stdio::null())
            .spawn()
            .unwrap();

        // Wait for the stand-in parent to have actually spawned its
        // supervised child and recorded its pid.
        let deadline = Instant::now() + Duration::from_secs(10);
        let child_pid: u32 = loop {
            if let Ok(raw) = std::fs::read_to_string(&handshake) {
                if let Ok(pid) = raw.trim().parse() {
                    break pid;
                }
            }
            assert!(Instant::now() < deadline, "stand-in parent never recorded its supervised child's pid");
            thread::sleep(Duration::from_millis(50));
        };
        assert!(process_is_alive(child_pid), "supervised child should be running before the kill");

        // No cleanup, no Drop — exactly the crash/SIGKILL scenario a plain
        // `Child` field can't survive.
        let _ = Command::new("kill").args(["-9", &parent.id().to_string()]).status();
        let _ = parent.wait();

        let deadline = Instant::now() + Duration::from_secs(5);
        while process_is_alive(child_pid) {
            assert!(Instant::now() < deadline, "supervised child outlived its SIGKILLed parent");
            thread::sleep(Duration::from_millis(100));
        }
    }

    /// No-op under a normal `cargo test` run. Re-invoked by the test above
    /// (with `STAND_IN_ENV` set) to play the "stand-in parent": spawns a
    /// long-running child through the exact same `spawn_supervised`
    /// mechanism completion.rs/notebook.rs use, records its pid for the
    /// outer test to read, then idles forever holding the pipe open — until
    /// the outer test SIGKILLs this whole process.
    #[test]
    fn supervisor_stand_in_parent() {
        let Some(handshake) = std::env::var_os(STAND_IN_ENV).and(std::env::var_os(HANDSHAKE_PATH_ENV)) else {
            return;
        };
        let exe = std::env::current_exe().unwrap();
        let child = spawn_supervised_via(
            &exe,
            &["pidguard::tests::run_supervisor_test_entry", "--exact", "--nocapture"],
            Path::new("sleep"),
            &["600".to_string()],
        )
        .unwrap();
        std::fs::write(&handshake, child.id().to_string()).unwrap();

        // Deliberately never touch `child.stdin` — holding it open
        // (untouched) for as long as this process lives is the entire
        // mechanism under test.
        loop {
            thread::sleep(Duration::from_secs(60));
        }
    }

    /// No-op under a normal `cargo test` run. Re-invoked by
    /// `supervisor_stand_in_parent` to play the real supervisor role via the
    /// real, production `run_supervisor` — proving the exact function
    /// `main.rs` calls, not a test-only stand-in for it.
    #[test]
    fn run_supervisor_test_entry() {
        if !is_supervisor_invocation() {
            return;
        }
        run_supervisor();
    }
}
