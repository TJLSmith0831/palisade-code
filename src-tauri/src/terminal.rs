//! PTY-backed terminal, one per active project (D4, D17, D18).
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
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .map_err(|err| format!("open pty: {err}"))?;

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

        let child = pair.slave.spawn_command(cmd).map_err(|err| format!("spawn shell: {err}"))?;
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
}
