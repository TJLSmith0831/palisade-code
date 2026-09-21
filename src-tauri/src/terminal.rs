//! PTY-backed terminals: several per project, each its own tab (D4, D17, D18).
//!
//! A background thread owns the PTY + child, forwards raw output bytes to a
//! caller-supplied callback, and is torn down by `terminate()` / `Drop` — the
//! same swap-and-drop pattern `lib.rs` already uses for a project's
//! filesystem watcher.

use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};

use crate::executor::child_path_env;
use crate::store::Res;
use crate::locks::MutexExt;

/// How much output a tab remembers so a view that attaches late (a second
/// window, a remounted pane, the first Run of a fresh shell) can catch up.
const SCROLLBACK_BYTES: usize = 256 * 1024;

/// The tail of a PTY's output plus a running byte count. Every chunk is
/// stamped with the count before it, so a view that fetched a snapshot can
/// tell which live chunks the snapshot already contains.
#[derive(Default)]
struct Scrollback {
    tail: Vec<u8>,
    total: u64,
}

impl Scrollback {
    /// Appends `chunk` and returns its start offset.
    fn push(&mut self, chunk: &[u8]) -> u64 {
        let offset = self.total;
        self.total += chunk.len() as u64;
        self.tail.extend_from_slice(chunk);
        if self.tail.len() > SCROLLBACK_BYTES {
            let excess = self.tail.len() - SCROLLBACK_BYTES;
            self.tail.drain(..excess);
        }
        offset
    }
}

/// What a view gets when it attaches to a tab.
#[derive(Debug)]
pub struct Attach {
    /// False when the tab was already live and the caller merely re-attached.
    pub spawned: bool,
    /// Recent output, oldest first.
    pub backlog: Vec<u8>,
    /// Offset just past `backlog`; live chunks starting below it are duplicates.
    pub end: u64,
}

pub struct Terminal {
    writer: Mutex<Box<dyn Write + Send>>,
    master: Box<dyn MasterPty + Send>,
    stopping: Arc<AtomicBool>,
    /// Set by the reader thread when the shell's side of the PTY closes.
    exited: Arc<AtomicBool>,
    scrollback: Arc<Mutex<Scrollback>>,
    reader_handle: Option<thread::JoinHandle<()>>,
    child: Box<dyn Child + Send + Sync>,
}

impl Terminal {
    /// Spawns `$SHELL` (fallback `/bin/zsh`) as a login shell rooted at
    /// `project_root`. `on_output` is called from a background thread with
    /// each chunk of raw PTY bytes (with its start offset) as they arrive;
    /// `on_exit` runs once if the shell ends on its own — not when
    /// `terminate()` ends it.
    pub fn spawn(
        project_root: &Path,
        on_output: impl Fn(u64, Vec<u8>) + Send + 'static,
        on_exit: impl Fn() + Send + 'static,
    ) -> Res<Self> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .map_err(|err| crate::PalisadeError::from(format!("open pty: {err}")))?;

        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let mut cmd = CommandBuilder::new(&shell);
        cmd.arg("-l");
        cmd.cwd(project_root);
        // CommandBuilder inherits this process's env by default, which under
        // launchd is the same minimal PATH the executor already works around
        // (executor.rs's child_path_env doc comment) — reuse that fix here.
        cmd.env("PATH", child_path_env());
        // launchd also doesn't set TERM (it isn't a terminal-launched
        // process), so without this every curses/ncurses TUI program
        // (top, vim, less) refuses to start ("TERM environment variable
        // not set"). xterm.js speaks the xterm-256color terminfo dialect.
        cmd.env("TERM", "xterm-256color");

        let child = pair.slave.spawn_command(cmd).map_err(|err| crate::PalisadeError::from(format!("spawn shell: {err}")))?;
        // The child holds its own fd for the slave side; drop our copy so we
        // don't keep an extra reference alive past the child's lifetime.
        drop(pair.slave);

        let mut reader =
            pair.master.try_clone_reader().map_err(|err| crate::PalisadeError::from(format!("clone pty reader: {err}")))?;
        let writer = pair.master.take_writer().map_err(|err| crate::PalisadeError::from(format!("take pty writer: {err}")))?;

        let stopping = Arc::new(AtomicBool::new(false));
        let exited = Arc::new(AtomicBool::new(false));
        let scrollback = Arc::new(Mutex::new(Scrollback::default()));
        let reader_handle = thread::spawn({
            let (stopping, exited, scrollback) = (stopping.clone(), exited.clone(), scrollback.clone());
            move || {
                let mut buf = [0u8; 4096];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            let chunk = buf[..n].to_vec();
                            let offset = scrollback.lock_or_recover().push(&chunk);
                            on_output(offset, chunk);
                        }
                    }
                }
                exited.store(true, Ordering::SeqCst);
                if !stopping.load(Ordering::SeqCst) {
                    on_exit();
                }
            }
        });

        Ok(Terminal {
            writer: Mutex::new(writer),
            master: pair.master,
            stopping,
            exited,
            scrollback,
            reader_handle: Some(reader_handle),
            child,
        })
    }

    pub fn has_exited(&self) -> bool {
        self.exited.load(Ordering::SeqCst)
    }

    /// The remembered output and the offset just past it.
    fn snapshot(&self) -> (Vec<u8>, u64) {
        let scrollback = self.scrollback.lock_or_recover();
        (scrollback.tail.clone(), scrollback.total)
    }

    pub fn write(&self, bytes: &[u8]) -> Res<()> {
        let mut writer = self.writer.lock_or_recover();
        writer.write_all(bytes).map_err(|err| crate::PalisadeError::from(format!("write to pty: {err}")))?;
        writer.flush().map_err(|err| crate::PalisadeError::from(format!("flush pty: {err}")))
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Res<()> {
        self.master
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|err| crate::PalisadeError::from(format!("resize pty: {err}")))
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
    /// Makes sure tab `id` is running against `project_root` and hands back
    /// what the caller needs to attach. A live tab is re-attached, not
    /// respawned; a tab whose shell has exited is replaced, which is how a
    /// view restarts a shell that ended.
    pub fn ensure(
        &self,
        id: &str,
        project_hash: &str,
        project_root: &Path,
        on_output: impl Fn(u64, Vec<u8>) + Send + 'static,
        on_exit: impl Fn() + Send + 'static,
    ) -> Res<Attach> {
        // Declared before the guard so the dead shell is dropped after the
        // lock is released: `Terminal::drop` joins threads.
        let mut stale: Option<Tab> = None;
        let mut tabs = self.tabs.lock_or_recover();
        let spawned = match tabs.get(id) {
            Some(tab) if !tab.terminal.has_exited() => false,
            _ => {
                stale = tabs.remove(id);
                let open_for_project =
                    tabs.values().filter(|tab| tab.project_hash == project_hash).count();
                if open_for_project >= MAX_TERMINALS_PER_PROJECT {
                    return Err(format!(
                        "at the limit of {MAX_TERMINALS_PER_PROJECT} terminal tabs for this project — close one first"
                    ).into());
                }
                let terminal = Terminal::spawn(project_root, on_output, on_exit)?;
                tabs.insert(id.to_string(), Tab { project_hash: project_hash.to_string(), terminal });
                true
            }
        };
        let (backlog, end) = tabs[id].terminal.snapshot();
        drop(tabs);
        drop(stale);
        Ok(Attach { spawned, backlog, end })
    }

    pub fn write(&self, id: &str, bytes: &[u8]) -> Res<()> {
        let tabs = self.tabs.lock_or_recover();
        let tab = tabs.get(id).ok_or_else(|| format!("no terminal running for tab `{id}`"))?;
        tab.terminal.write(bytes)
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Res<()> {
        let tabs = self.tabs.lock_or_recover();
        let tab = tabs.get(id).ok_or_else(|| format!("no terminal running for tab `{id}`"))?;
        tab.terminal.resize(cols, rows)
    }

    /// Closes one tab. Unknown ids are a no-op: a close racing a crash-driven
    /// removal is normal, not an error worth surfacing.
    pub fn kill(&self, id: &str) {
        // Dropped outside the lock: `Terminal::drop` waits on the reader
        // thread, and holding the registry lock through that would block
        // every other tab's I/O for the duration.
        let tab = self.tabs.lock_or_recover().remove(id);
        drop(tab);
    }

    /// Closes every tab belonging to one project, leaving other projects'
    /// tabs alone.
    pub fn kill_project(&self, project_hash: &str) {
        let doomed: Vec<Tab> = {
            let mut tabs = self.tabs.lock_or_recover();
            let ids: Vec<String> = tabs
                .iter()
                .filter(|(_, tab)| tab.project_hash == project_hash)
                .map(|(id, _)| id.clone())
                .collect();
            ids.iter().filter_map(|id| tabs.remove(id)).collect()
        };
        drop(doomed);
    }

    /// The ids of every tab with a running shell for one project, in no particular order —
    /// tab *ordering* is the frontend's business, liveness is this one's.
    pub fn list(&self, project_hash: &str) -> Vec<String> {
        self.tabs
            .lock_or_recover()
            .iter()
            .filter(|(_, tab)| tab.project_hash == project_hash && !tab.terminal.has_exited())
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
        let mut term = Terminal::spawn(dir.path(), move |_, bytes| {
            let _ = tx.send(bytes);
        }, || {})
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
        let mut term = Terminal::spawn(dir.path(), move |_, bytes| {
            let _ = tx.send(bytes);
        }, || {})
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
        let mut term = Terminal::spawn(dir.path(), |_, _| {}, || {}).unwrap();

        term.resize(100, 30).unwrap();

        term.terminate();
        term.terminate(); // must not panic or hang on a second call
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
            reg.ensure(id, "proj", dir.path(), |_, _| {}, || {}).unwrap();
        }
        let mut ids = reg.list("proj");
        ids.sort();
        assert_eq!(ids, vec!["t1", "t2", "t3"]);
    }

    #[test]
    fn ensure_is_idempotent_for_a_live_tab() {
        let dir = tempfile::tempdir().unwrap();
        let reg = TerminalRegistry::default();
        assert!(reg.ensure("t1", "proj", dir.path(), |_, _| {}, || {}).unwrap().spawned, "first ensure spawns");
        assert!(!reg.ensure("t1", "proj", dir.path(), |_, _| {}, || {}).unwrap().spawned, "re-attach must not respawn");
        assert_eq!(reg.list("proj").len(), 1);
    }

    #[test]
    fn each_tab_keeps_its_own_pty_state() {
        let dir = tempfile::tempdir().unwrap();
        let reg = TerminalRegistry::default();
        let (tx1, rx1) = mpsc::channel::<Vec<u8>>();
        let (tx2, rx2) = mpsc::channel::<Vec<u8>>();
        reg.ensure("t1", "proj", dir.path(), move |_, b| { let _ = tx1.send(b); }, || {}).unwrap();
        reg.ensure("t2", "proj", dir.path(), move |_, b| { let _ = tx2.send(b); }, || {}).unwrap();

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
        reg.ensure("t1", "proj", dir.path(), |_, _| {}, || {}).unwrap();
        reg.ensure("t2", "proj", dir.path(), move |_, b| { let _ = tx2.send(b); }, || {}).unwrap();

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
            reg.ensure(&id, "proj", dir.path(), |_, _| {}, || {}).unwrap();
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
            reg.ensure(&format!("t{n}"), "proj", dir.path(), |_, _| {}, || {}).unwrap();
        }
        let err = reg.ensure("one-too-many", "proj", dir.path(), |_, _| {}, || {}).unwrap_err();
        assert!(err.contains("terminal"), "unhelpful limit error: {err}");
        assert_eq!(reg.list("proj").len(), MAX_TERMINALS_PER_PROJECT);
        // The limit is per project, not global.
        reg.ensure("other-1", "other-proj", dir.path(), |_, _| {}, || {}).unwrap();
        assert_eq!(reg.list("other-proj").len(), 1);
    }

    #[test]
    fn closing_a_project_closes_only_its_own_tabs() {
        let dir = tempfile::tempdir().unwrap();
        let reg = TerminalRegistry::default();
        reg.ensure("a1", "a", dir.path(), |_, _| {}, || {}).unwrap();
        reg.ensure("a2", "a", dir.path(), |_, _| {}, || {}).unwrap();
        reg.ensure("b1", "b", dir.path(), |_, _| {}, || {}).unwrap();

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

    #[test]
    fn a_shell_that_exits_is_reported_and_replaced_on_the_next_ensure() {
        let dir = tempfile::tempdir().unwrap();
        let reg = TerminalRegistry::default();
        let (exit_tx, exit_rx) = mpsc::channel::<()>();
        reg.ensure("t1", "proj", dir.path(), |_, _| {}, move || {
            let _ = exit_tx.send(());
        })
        .unwrap();

        reg.write("t1", b"exit\n").unwrap();
        exit_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("a shell that exits on its own must report it");
        assert!(reg.list("proj").is_empty(), "a dead shell is not a live tab");

        let again = reg.ensure("t1", "proj", dir.path(), |_, _| {}, || {}).unwrap();
        assert!(again.spawned, "ensure on a dead tab must start a fresh shell");
        assert_eq!(reg.list("proj"), vec!["t1"]);
    }

    #[test]
    fn closing_a_tab_does_not_report_an_exit() {
        let dir = tempfile::tempdir().unwrap();
        let reg = TerminalRegistry::default();
        let (exit_tx, exit_rx) = mpsc::channel::<()>();
        reg.ensure("t1", "proj", dir.path(), |_, _| {}, move || {
            let _ = exit_tx.send(());
        })
        .unwrap();
        reg.kill("t1");
        assert!(
            exit_rx.recv_timeout(Duration::from_millis(500)).is_err(),
            "a deliberate close is not a crash"
        );
    }

    #[test]
    fn attaching_late_replays_earlier_output_without_overlap() {
        let dir = tempfile::tempdir().unwrap();
        let reg = TerminalRegistry::default();
        let (tx, rx) = mpsc::channel::<(u64, Vec<u8>)>();
        reg.ensure("t1", "proj", dir.path(), move |offset, b| { let _ = tx.send((offset, b)); }, || {}).unwrap();

        reg.write("t1", b"echo back''log-marker\n").unwrap();
        let mut live_end = 0;
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut seen = String::new();
        while std::time::Instant::now() < deadline && !seen.contains("backlog-marker") {
            if let Ok((offset, bytes)) = rx.recv_timeout(Duration::from_millis(200)) {
                assert_eq!(offset, live_end, "chunk offsets must be contiguous");
                live_end = offset + bytes.len() as u64;
                seen.push_str(&String::from_utf8_lossy(&bytes));
            }
        }
        assert!(seen.contains("backlog-marker"), "shell never echoed: {seen:?}");

        let late = reg.ensure("t1", "proj", dir.path(), |_, _| {}, || {}).unwrap();
        assert!(!late.spawned);
        assert!(String::from_utf8_lossy(&late.backlog).contains("backlog-marker"));
        assert!(late.end >= live_end, "the snapshot must cover everything already delivered");
    }
}
