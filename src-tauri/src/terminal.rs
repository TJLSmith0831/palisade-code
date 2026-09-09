//! PTY-backed terminals: several per project, each its own tab (D4, D17, D18).
//!
//! Mirrors `integrations::Watcher`'s shape: a background thread owns the
//! PTY + child, forwards raw output bytes to a caller-supplied callback, and
//! is torn down by `terminate()` / `Drop` — the same swap-and-drop pattern
//! `lib.rs` already uses to replace one project's `graphify watch` with
//! another's.

use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};

use crate::executor::child_path_env;
use crate::store::Res;

pub struct Terminal {
    writer: Mutex<Box<dyn Write + Send>>,
    master: Box<dyn MasterPty + Send>,
    stopping: Arc<AtomicBool>,
    reader_handle: Option<thread::JoinHandle<()>>,
    child: Box<dyn Child + Send + Sync>,
}

impl Terminal {
    /// Spawns `$SHELL` (fallback `/bin/zsh`) as a login shell rooted at
    /// `project_root`. `on_output` is called from a background thread with
    /// each chunk of raw PTY bytes as they arrive.
    pub fn spawn(project_root: &Path, on_output: impl Fn(Vec<u8>) + Send + 'static) -> Res<Self> {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let mut cmd = CommandBuilder::new(&shell);
        cmd.arg("-l");
        cmd.cwd(project_root);
        Self::start(cmd, &[], on_output)
    }

    /// Spawns a specific command — not a login shell — rooted at
    /// `project_root`: what an ACP `terminal/create` needs to host an
    /// agent's named command with its own args/env (PLAN.md phase 4).
    /// `env` is applied on top of the same `PATH`/`TERM` baseline `spawn`
    /// uses, so a hosted command sees a real, curses-capable environment
    /// under launchd the same way the interactive shell does — and can still
    /// override either if the agent asked for a specific value.
    pub fn spawn_command(
        project_root: &Path,
        program: &str,
        args: &[String],
        env: &[(String, String)],
        on_output: impl Fn(Vec<u8>) + Send + 'static,
    ) -> Res<Self> {
        let mut cmd = CommandBuilder::new(program);
        for arg in args {
            cmd.arg(arg);
        }
        cmd.cwd(project_root);
        Self::start(cmd, env, on_output)
    }

    /// Common tail of `spawn`/`spawn_command`: apply the shared `PATH`/`TERM`
    /// baseline (overridable by `extra_env`), open the PTY, launch `cmd`,
    /// and start the reader thread.
    fn start(
        mut cmd: CommandBuilder,
        extra_env: &[(String, String)],
        on_output: impl Fn(Vec<u8>) + Send + 'static,
    ) -> Res<Self> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .map_err(|err| format!("open pty: {err}"))?;

        // CommandBuilder inherits this process's env by default, which under
        // launchd is the same minimal PATH the executor already works around
        // (executor.rs's child_path_env doc comment) — reuse that fix here.
        cmd.env("PATH", child_path_env());
        // launchd also doesn't set TERM (it isn't a terminal-launched
        // process), so without this every curses/ncurses TUI program
        // (top, vim, less) refuses to start ("TERM environment variable
        // not set"). xterm.js speaks the xterm-256color terminfo dialect.
        cmd.env("TERM", "xterm-256color");
        // Applied last so a caller-supplied value (an ACP terminal's own
        // env, e.g. a different PATH) wins over the baseline above.
        for (key, value) in extra_env {
            cmd.env(key, value);
        }

        let child = pair.slave.spawn_command(cmd).map_err(|err| format!("spawn command: {err}"))?;
        // The child holds its own fd for the slave side; drop our copy so we
        // don't keep an extra reference alive past the child's lifetime.
        drop(pair.slave);

        let mut reader =
            pair.master.try_clone_reader().map_err(|err| format!("clone pty reader: {err}"))?;
        let writer = pair.master.take_writer().map_err(|err| format!("take pty writer: {err}"))?;

        let stopping = Arc::new(AtomicBool::new(false));
        let reader_handle = thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => return,
                    Ok(n) => on_output(buf[..n].to_vec()),
                }
            }
        });

        Ok(Terminal {
            writer: Mutex::new(writer),
            master: pair.master,
            stopping,
            reader_handle: Some(reader_handle),
            child,
        })
    }

    /// Non-blocking check for whether the process has exited, and its exit
    /// code if so. `None` while still running, and also on a signal death
    /// (no numeric exit code to report — the caller already learns the
    /// terminal is dead some other way, e.g. `terminal/kill`).
    pub fn try_exit_code(&mut self) -> Option<i32> {
        match self.child.try_wait() {
            Ok(Some(status)) => Some(status.exit_code() as i32),
            _ => None,
        }
    }

    pub fn write(&self, bytes: &[u8]) -> Res<()> {
        let mut writer = self.writer.lock().unwrap();
        writer.write_all(bytes).map_err(|err| format!("write to pty: {err}"))?;
        writer.flush().map_err(|err| format!("flush pty: {err}"))
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Res<()> {
        self.master
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|err| format!("resize pty: {err}"))
    }

    pub fn terminate(&mut self) {
        self.stopping.store(true, Ordering::SeqCst);
        // `child.kill()` only reaps the shell itself, orphaning anything it
        // launched — a dev server keeps running and keeps holding its port.
        // The PTY child leads its own session, so its pgid is its pid.
        #[cfg(unix)]
        if let Some(pid) = self.child.process_id() {
            let _ = std::process::Command::new("kill").arg("--").arg(format!("-{pid}")).output();
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(handle) = self.reader_handle.take() {
            let _ = handle.join();
        }
    }
}

impl Drop for Terminal {
    fn drop(&mut self) {
        self.terminate();
    }
}

// --------------------------------------------------- ACP command terminals

/// Bytes an ACP-hosted terminal keeps buffered for `terminal/output` to
/// return — capped so a chatty command (a build log, an install) can't grow
/// this without bound (PLAN.md phase 4).
///
/// ponytail: a fixed head cap, not a ring buffer — if an agent needs the
/// *tail* of a huge log rather than its head, swap this for one.
pub const CAPTURED_OUTPUT_CAP: usize = 1_000_000; // ~1MB

/// A `Terminal` running one named command (not a login shell), with its
/// output captured up to `CAPTURED_OUTPUT_CAP` and its exit status pollable
/// — what ACP's `terminal/create`, `terminal/output`, `terminal/wait_for_exit`
/// and `terminal/kill` need. `on_output` still fires live for every chunk
/// (streaming to the UI, PLAN.md phase 3's `ToolOutputDelta`); this only adds
/// the capped copy those handlers read back.
pub struct CommandTerminal {
    terminal: Terminal,
    output: Arc<Mutex<Vec<u8>>>,
}

impl CommandTerminal {
    pub fn spawn(
        project_root: &Path,
        program: &str,
        args: &[String],
        env: &[(String, String)],
        on_output: impl Fn(&[u8]) + Send + 'static,
    ) -> Res<Self> {
        let output = Arc::new(Mutex::new(Vec::new()));
        let captured = output.clone();
        let terminal = Terminal::spawn_command(project_root, program, args, env, move |bytes| {
            on_output(&bytes);
            let mut buf = captured.lock().unwrap();
            let room = CAPTURED_OUTPUT_CAP.saturating_sub(buf.len());
            if room > 0 {
                let take = room.min(bytes.len());
                buf.extend_from_slice(&bytes[..take]);
            }
        })?;
        Ok(Self { terminal, output })
    }

    /// Everything captured so far, up to the cap.
    pub fn output(&self) -> Vec<u8> {
        self.output.lock().unwrap().clone()
    }

    /// Non-blocking: `None` while still running.
    pub fn try_exit_code(&mut self) -> Option<i32> {
        self.terminal.try_exit_code()
    }

    /// Ends the process. The captured buffer stays readable afterward —
    /// `terminal/kill` leaves the output in place, it just stops it growing.
    pub fn kill(&mut self) {
        self.terminal.terminate();
    }
}

// ------------------------------------------------------- terminal registry

/// How many tabs one project may hold open at once. A cap rather than
/// unbounded growth: every tab is a real shell with real file descriptors,
/// and a runaway "new terminal" keybinding shouldn't be able to exhaust them.
pub const MAX_TERMINALS_PER_PROJECT: usize = 8;

struct Tab {
    project_hash: String,
    terminal: Terminal,
}

/// Every live terminal in the app, keyed by tab id.
///
/// Replaces the previous single-slot `Option<(project, Terminal)>`, where
/// opening a second terminal evicted the first — a build running in one tab
/// died the moment another was opened. Tabs are independent: each owns its
/// own PTY, and killing or dropping one leaves the rest running.
#[derive(Default)]
pub struct TerminalRegistry {
    tabs: Mutex<std::collections::HashMap<String, Tab>>,
}

impl TerminalRegistry {
    /// Makes sure tab `id` is running against `project_root`. Returns whether
    /// a shell was actually spawned — `false` means the tab was already live
    /// and the caller has simply re-attached to it (re-opening the panel).
    pub fn ensure(
        &self,
        id: &str,
        project_hash: &str,
        project_root: &Path,
        on_output: impl Fn(Vec<u8>) + Send + 'static,
    ) -> Res<bool> {
        let mut tabs = self.tabs.lock().unwrap();
        if tabs.contains_key(id) {
            return Ok(false);
        }
        let open_for_project =
            tabs.values().filter(|tab| tab.project_hash == project_hash).count();
        if open_for_project >= MAX_TERMINALS_PER_PROJECT {
            return Err(format!(
                "at the limit of {MAX_TERMINALS_PER_PROJECT} terminal tabs for this project — close one first"
            ));
        }
        let terminal = Terminal::spawn(project_root, on_output)?;
        tabs.insert(id.to_string(), Tab { project_hash: project_hash.to_string(), terminal });
        Ok(true)
    }

    pub fn write(&self, id: &str, bytes: &[u8]) -> Res<()> {
        let tabs = self.tabs.lock().unwrap();
        let tab = tabs.get(id).ok_or_else(|| format!("no terminal running for tab `{id}`"))?;
        tab.terminal.write(bytes)
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Res<()> {
        let tabs = self.tabs.lock().unwrap();
        let tab = tabs.get(id).ok_or_else(|| format!("no terminal running for tab `{id}`"))?;
        tab.terminal.resize(cols, rows)
    }

    /// Closes one tab. Unknown ids are a no-op: a close racing a crash-driven
    /// removal is normal, not an error worth surfacing.
    pub fn kill(&self, id: &str) {
        // Dropped outside the lock: `Terminal::drop` waits on the reader
        // thread, and holding the registry lock through that would block
        // every other tab's I/O for the duration.
        let tab = self.tabs.lock().unwrap().remove(id);
        drop(tab);
    }

    /// Closes every tab belonging to one project, leaving other projects'
    /// tabs alone.
    pub fn kill_project(&self, project_hash: &str) {
        let doomed: Vec<Tab> = {
            let mut tabs = self.tabs.lock().unwrap();
            let ids: Vec<String> = tabs
                .iter()
                .filter(|(_, tab)| tab.project_hash == project_hash)
                .map(|(id, _)| id.clone())
                .collect();
            ids.iter().filter_map(|id| tabs.remove(id)).collect()
        };
        drop(doomed);
    }

    /// The ids of every live tab for one project, in no particular order —
    /// tab *ordering* is the frontend's business, liveness is this one's.
    pub fn list(&self, project_hash: &str) -> Vec<String> {
        self.tabs
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, tab)| tab.project_hash == project_hash)
            .map(|(id, _)| id.clone())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    fn collect_until(rx: &mpsc::Receiver<Vec<u8>>, pattern: &str, timeout: Duration) -> String {
        let mut collected = Vec::new();
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(200)) {
                collected.extend(chunk);
                let text = String::from_utf8_lossy(&collected);
                if text.contains(pattern) {
                    return text.into_owned();
                }
            }
        }
        String::from_utf8_lossy(&collected).into_owned()
    }

    #[test]
    fn spawns_a_shell_and_round_trips_input_and_output() {
        let dir = tempfile::tempdir().unwrap();
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let mut term = Terminal::spawn(dir.path(), move |bytes| {
            let _ = tx.send(bytes);
        })
        .unwrap();

        term.write(b"echo hello-from-pty\n").unwrap();

        let output = collect_until(&rx, "hello-from-pty", Duration::from_secs(5));
        assert!(output.contains("hello-from-pty"), "PTY output was: {output:?}");

        term.terminate();
    }

    #[test]
    #[cfg(unix)]
    fn terminate_kills_background_children_not_just_the_shell() {
        let dir = tempfile::tempdir().unwrap();
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let mut term = Terminal::spawn(dir.path(), move |bytes| {
            let _ = tx.send(bytes);
        })
        .unwrap();

        // Split quoting so the PTY's echo of the command line doesn't itself
        // contain the marker we're waiting for.
        term.write(b"sleep 60 & echo p''id=$!\n").unwrap();
        let output = collect_until(&rx, "pid=", Duration::from_secs(5));
        let pid = output
            .split("pid=")
            .nth(1)
            .and_then(|rest| rest.trim_start().split_whitespace().next())
            .and_then(|d| d.trim().parse::<u32>().ok())
            .unwrap_or_else(|| panic!("no pid in PTY output: {output:?}"));

        term.terminate();
        std::thread::sleep(Duration::from_millis(300));

        let alive = std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .output()
            .unwrap()
            .status
            .success();
        assert!(!alive, "sleep {pid} outlived the terminal it was launched from");
    }

    #[test]
    fn resize_does_not_error_and_terminate_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let mut term = Terminal::spawn(dir.path(), |_| {}).unwrap();

        term.resize(100, 30).unwrap();

        term.terminate();
        term.terminate(); // must not panic or hang on a second call
    }

    // ------------------------------------------------- ACP command terminals

    /// RED→GREEN: a command terminal (a named program, not a login shell)
    /// captures its output and reports its exit status once the process
    /// ends — what `terminal/output` needs (PLAN.md phase 4).
    #[test]
    fn a_command_terminal_captures_output_and_exit_status() {
        let dir = tempfile::tempdir().unwrap();
        let mut term = CommandTerminal::spawn(
            dir.path(),
            "/bin/sh",
            &["-c".to_string(), "echo hello-from-command".to_string()],
            &[],
            |_| {},
        )
        .unwrap();

        let deadline = Instant::now() + Duration::from_secs(5);
        let mut exit_code = None;
        while Instant::now() < deadline && exit_code.is_none() {
            exit_code = term.try_exit_code();
            if exit_code.is_none() {
                std::thread::sleep(Duration::from_millis(20));
            }
        }
        assert_eq!(exit_code, Some(0), "process should have exited cleanly");

        let output = String::from_utf8_lossy(&term.output()).into_owned();
        assert!(output.contains("hello-from-command"), "captured output was: {output:?}");
    }

    /// RED→GREEN: the captured buffer stops growing at the cap instead of
    /// holding an unbounded amount of a chatty command's output.
    #[test]
    fn output_is_capped_rather_than_growing_without_bound() {
        let dir = tempfile::tempdir().unwrap();
        // Print well past the cap so the test proves truncation, not luck.
        let script = format!(
            "yes x | head -c {}",
            CAPTURED_OUTPUT_CAP * 2
        );
        let mut term =
            CommandTerminal::spawn(dir.path(), "/bin/sh", &["-c".to_string(), script], &[], |_| {})
                .unwrap();

        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline && term.try_exit_code().is_none() {
            std::thread::sleep(Duration::from_millis(20));
        }

        assert!(
            term.output().len() <= CAPTURED_OUTPUT_CAP,
            "captured output ({} bytes) exceeded the cap ({} bytes)",
            term.output().len(),
            CAPTURED_OUTPUT_CAP
        );
    }
}

#[cfg(test)]
mod registry_tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    fn wait_for(rx: &mpsc::Receiver<Vec<u8>>, pattern: &str) -> String {
        let mut collected = Vec::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(200)) {
                collected.extend(chunk);
                let text = String::from_utf8_lossy(&collected);
                if text.contains(pattern) {
                    return text.into_owned();
                }
            }
        }
        String::from_utf8_lossy(&collected).into_owned()
    }

    #[test]
    fn several_tabs_for_one_project_coexist() {
        let dir = tempfile::tempdir().unwrap();
        let reg = TerminalRegistry::default();
        for id in ["t1", "t2", "t3"] {
            reg.ensure(id, "proj", dir.path(), |_| {}).unwrap();
        }
        let mut ids = reg.list("proj");
        ids.sort();
        assert_eq!(ids, vec!["t1", "t2", "t3"]);
    }

    #[test]
    fn ensure_is_idempotent_for_a_live_tab() {
        let dir = tempfile::tempdir().unwrap();
        let reg = TerminalRegistry::default();
        assert!(reg.ensure("t1", "proj", dir.path(), |_| {}).unwrap(), "first ensure spawns");
        assert!(!reg.ensure("t1", "proj", dir.path(), |_| {}).unwrap(), "re-attach must not respawn");
        assert_eq!(reg.list("proj").len(), 1);
    }

    #[test]
    fn each_tab_keeps_its_own_pty_state() {
        let dir = tempfile::tempdir().unwrap();
        let reg = TerminalRegistry::default();
        let (tx1, rx1) = mpsc::channel::<Vec<u8>>();
        let (tx2, rx2) = mpsc::channel::<Vec<u8>>();
        reg.ensure("t1", "proj", dir.path(), move |b| { let _ = tx1.send(b); }).unwrap();
        reg.ensure("t2", "proj", dir.path(), move |b| { let _ = tx2.send(b); }).unwrap();

        reg.write("t1", b"MARK=one''-tab\n").unwrap();
        reg.write("t2", b"MARK=two''-tab\n").unwrap();
        reg.write("t1", b"echo tab-is-$MARK\n").unwrap();
        reg.write("t2", b"echo tab-is-$MARK\n").unwrap();

        let out1 = wait_for(&rx1, "tab-is-one-tab");
        let out2 = wait_for(&rx2, "tab-is-two-tab");
        assert!(out1.contains("tab-is-one-tab"), "tab 1 saw: {out1:?}");
        assert!(!out1.contains("tab-is-two-tab"), "tab 1 leaked tab 2's output: {out1:?}");
        assert!(out2.contains("tab-is-two-tab"), "tab 2 saw: {out2:?}");
    }

    #[test]
    fn killing_one_tab_leaves_the_others_running() {
        let dir = tempfile::tempdir().unwrap();
        let reg = TerminalRegistry::default();
        let (tx2, rx2) = mpsc::channel::<Vec<u8>>();
        reg.ensure("t1", "proj", dir.path(), |_| {}).unwrap();
        reg.ensure("t2", "proj", dir.path(), move |b| { let _ = tx2.send(b); }).unwrap();

        reg.kill("t1");
        assert_eq!(reg.list("proj"), vec!["t2"]);

        reg.write("t2", b"echo still''-alive\n").unwrap();
        let out = wait_for(&rx2, "still-alive");
        assert!(out.contains("still-alive"), "surviving tab was: {out:?}");
    }

    #[test]
    fn rapid_spawn_and_close_cycles_leave_no_leaks() {
        let dir = tempfile::tempdir().unwrap();
        let reg = TerminalRegistry::default();
        for round in 0..12 {
            let id = format!("cycle-{round}");
            reg.ensure(&id, "proj", dir.path(), |_| {}).unwrap();
            reg.kill(&id);
        }
        assert!(reg.list("proj").is_empty(), "registry leaked: {:?}", reg.list("proj"));
        // Killing an id that was never there is a no-op, not a panic.
        reg.kill("never-existed");
    }

    #[test]
    fn a_project_cannot_exceed_the_tab_limit() {
        let dir = tempfile::tempdir().unwrap();
        let reg = TerminalRegistry::default();
        for n in 0..MAX_TERMINALS_PER_PROJECT {
            reg.ensure(&format!("t{n}"), "proj", dir.path(), |_| {}).unwrap();
        }
        let err = reg.ensure("one-too-many", "proj", dir.path(), |_| {}).unwrap_err();
        assert!(err.contains("terminal"), "unhelpful limit error: {err}");
        assert_eq!(reg.list("proj").len(), MAX_TERMINALS_PER_PROJECT);
        // The limit is per project, not global.
        reg.ensure("other-1", "other-proj", dir.path(), |_| {}).unwrap();
        assert_eq!(reg.list("other-proj").len(), 1);
    }

    #[test]
    fn closing_a_project_closes_only_its_own_tabs() {
        let dir = tempfile::tempdir().unwrap();
        let reg = TerminalRegistry::default();
        reg.ensure("a1", "a", dir.path(), |_| {}).unwrap();
        reg.ensure("a2", "a", dir.path(), |_| {}).unwrap();
        reg.ensure("b1", "b", dir.path(), |_| {}).unwrap();

        reg.kill_project("a");
        assert!(reg.list("a").is_empty());
        assert_eq!(reg.list("b"), vec!["b1"]);
    }

    #[test]
    fn writing_to_an_unknown_tab_reports_which_one() {
        let reg = TerminalRegistry::default();
        let err = reg.write("ghost", b"x").unwrap_err();
        assert!(err.contains("ghost"), "error should name the tab: {err}");
        assert!(reg.resize("ghost", 80, 24).is_err());
    }
}
