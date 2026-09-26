//! Notebook kernel process management (design.md D2/D3/D4, decisions.md D16).
//!
//! Rust owns kernel *processes* only — never notebook content. The frontend
//! parses/edits/saves the `.ipynb` JSON itself (`src/notebook.ts`) via the
//! existing `read_file_content`/`write_file_content` commands; this module
//! spawns the bundled Python driver (`src-tauri/driver/notebook_driver.py`), which
//! wraps `jupyter_client` and owns the real kernel connection, and forwards
//! its JSON-line stdout events to the frontend verbatim as `notebook-event`.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command};
#[cfg(test)]
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};

use crate::executor::find_on_path;
use crate::store::Res;
use crate::locks::MutexExt;

/// Forwarded to the frontend verbatim — `event` is whatever JSON object the
/// driver wrote to stdout (see notebook_driver.py's docstring for the shape).
/// Rust only inspects the `event` field of a couple of variants (`Started`,
/// `Crashed`) to drive its own spawn/liveness bookkeeping; everything else
/// passes through opaquely rather than being re-declared as a matching Rust
/// enum the frontend's `NotebookEvent` type would then have to mirror too.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookEnvelope {
    pub notebook_id: String,
    pub event: Value,
}

/// One running (or starting) kernel, owned by its Python driver child
/// process. Mirrors `CompletionServer`'s spawn/reader-thread/terminate shape
/// (completion.rs) rather than `AcpSession`'s async bridge — a notebook
/// kernel talks a plain line-JSON protocol, nothing here needs an async
/// runtime.
pub struct NotebookKernel {
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
    reader_handle: Mutex<Option<thread::JoinHandle<()>>>,
    stderr_handle: Mutex<Option<thread::JoinHandle<()>>>,
    stopping: Arc<AtomicBool>,
    alive: Arc<AtomicBool>,
    /// Where this kernel's PID is recorded between runs, once it has been
    /// spawned and so has a notebook id to key it by. Mirrors `Watcher`'s
    /// field in integrations.rs.
    pid_path: Mutex<Option<PathBuf>>,
}

impl NotebookKernel {
    pub fn new() -> Self {
        Self {
            child: Mutex::new(None),
            stdin: Mutex::new(None),
            reader_handle: Mutex::new(None),
            stderr_handle: Mutex::new(None),
            stopping: Arc::new(AtomicBool::new(false)),
            alive: Arc::new(AtomicBool::new(false)),
            pid_path: Mutex::new(None),
        }
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    /// Spawns the driver and blocks until it reports `Started` (or fails).
    /// A no-op if a kernel is already running for this notebook.
    pub fn spawn(
        &self,
        app: &AppHandle,
        driver_path: &Path,
        kernelspec_name: Option<&str>,
        notebook_id: &str,
    ) -> Res<()> {
        if self.is_alive() {
            return Ok(());
        }
        self.terminate();

        let python = find_on_path("python3").ok_or("python3 not found on PATH")?;

        // A hard restart never runs Drop, so the previous run's driver — and
        // the Jupyter kernel it owns — outlive the app that started them.
        // notebook_driver.py is an absolute path unique to this app, so it
        // re-identifies the child safely even after PID reuse.
        let pid_path = kernel_pid_path(notebook_id);
        crate::pidguard::reap_stale(&pid_path, &kernel_reap_token(driver_path));
        *self.pid_path.lock_or_recover() = Some(pid_path.clone());

        let mut args: Vec<String> = vec![driver_path.display().to_string()];
        if let Some(name) = kernelspec_name {
            args.push("--kernelspec".into());
            args.push(name.to_string());
        }

        let mut child = spawn_maybe_supervised(&python, &args)
            .map_err(|err| crate::PalisadeError::from(format!("failed to spawn notebook driver: {err}")))?;
        crate::pidguard::record(&pid_path, child.id());

        let stdin = child.stdin.take().ok_or("notebook driver stdin unavailable")?;
        let stdout = child.stdout.take().ok_or("notebook driver stdout unavailable")?;
        let stderr = child.stderr.take().ok_or("notebook driver stderr unavailable")?;

        let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
        let stopping = self.stopping.clone();
        let alive = self.alive.clone();
        let app_for_reader = app.clone();
        let notebook_id_owned = notebook_id.to_string();

        let reader = thread::spawn(move || {
            let mut ready_tx = Some(ready_tx);
            for line in BufReader::new(stdout).lines() {
                if stopping.load(Ordering::SeqCst) {
                    break;
                }
                let Ok(line) = line else { break };
                let Ok(event) = serde_json::from_str::<Value>(&line) else { continue };

                match event.get("event").and_then(Value::as_str) {
                    Some("Started") => {
                        if let Some(tx) = ready_tx.take() {
                            let _ = tx.send(Ok(()));
                        }
                    }
                    Some("Crashed") => alive.store(false, Ordering::SeqCst),
                    _ => {}
                }

                let _ = app_for_reader.emit(
                    "notebook-event",
                    NotebookEnvelope { notebook_id: notebook_id_owned.clone(), event },
                );
            }
            alive.store(false, Ordering::SeqCst);
            if let Some(tx) = ready_tx.take() {
                let _ = tx.send(Err("notebook driver exited before starting".into()));
            }
        });

        // Drained so the pipe never fills and blocks the child; the driver's
        // own crash reason comes through as a `Crashed` stdout event, not
        // stderr, so nothing here needs to inspect these lines.
        let stderr_reader = thread::spawn(move || {
            for line in BufReader::new(stderr).lines() {
                let _ = line;
            }
        });

        *self.child.lock_or_recover() = Some(child);
        *self.stdin.lock_or_recover() = Some(stdin);
        *self.reader_handle.lock_or_recover() = Some(reader);
        *self.stderr_handle.lock_or_recover() = Some(stderr_reader);
        self.alive.store(true, Ordering::SeqCst);

        match ready_rx.recv_timeout(Duration::from_secs(30)) {
            Ok(Ok(())) => Ok(()),
            Ok(Err(message)) => {
                self.terminate();
                Err(message.into())
            }
            Err(_) => {
                self.terminate();
                Err("timed out waiting for the notebook kernel to start".into())
            }
        }
    }

    fn send(&self, request: Value) -> Res<()> {
        if !self.is_alive() {
            return Err("notebook kernel is not running".into());
        }
        let mut guard = self.stdin.lock_or_recover();
        let stdin = guard.as_mut().ok_or("notebook driver stdin unavailable")?;
        let line = serde_json::to_string(&request).map_err(|err| crate::PalisadeError::from(err.to_string()))?;
        writeln!(stdin, "{line}").map_err(|err| crate::PalisadeError::from(format!("write to notebook driver: {err}")))?;
        stdin.flush().map_err(|err| crate::PalisadeError::from(err.to_string()))
    }

    pub fn execute(&self, cell_id: &str, source: &str) -> Res<()> {
        self.send(serde_json::json!({"op": "execute", "cell_id": cell_id, "source": source}))
    }

    pub fn interrupt(&self) -> Res<()> {
        self.send(serde_json::json!({"op": "interrupt"}))
    }

    /// Restarts in place via the driver's own `restart` op (jupyter_client's
    /// `restart_kernel`) rather than tearing down and respawning the Rust
    /// child process — cheaper, and already the thing decisions.md D2's
    /// driver was built and verified against (manual test: execute →
    /// interrupt → restart → fresh execution_count numbering). Satisfies the
    /// same spec contract (kernel state discarded) either way.
    pub fn restart(&self) -> Res<()> {
        self.send(serde_json::json!({"op": "restart"}))
    }

    pub fn terminate(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        self.alive.store(false, Ordering::SeqCst);

        if let Some(path) = self.pid_path.lock_or_recover().take() {
            crate::pidguard::clear(&path);
        }

        // Closing stdin tells the driver's request loop to return. Do this
        // before waiting on the process so its `finally` block can stop the
        // Jupyter kernel it owns; killing the driver first orphaned that
        // kernel whenever a notebook tab closed.
        *self.stdin.lock_or_recover() = None;
        if let Some(mut child) = self.child.lock_or_recover().take() {
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            loop {
                match child.try_wait() {
                    Ok(Some(_)) => break,
                    Ok(None) if std::time::Instant::now() < deadline => {
                        thread::sleep(Duration::from_millis(25));
                    }
                    Ok(None) | Err(_) => {
                        crate::pidguard::kill_group(child.id());
                        let _ = child.wait();
                        break;
                    }
                }
            }
        }

        if let Some(handle) = self.reader_handle.lock_or_recover().take() {
            let _ = handle.join();
        }
        if let Some(handle) = self.stderr_handle.lock_or_recover().take() {
            let _ = handle.join();
        }

        self.stopping.store(false, Ordering::SeqCst);
    }
}

impl Default for NotebookKernel {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for NotebookKernel {
    fn drop(&mut self) {
        self.terminate();
    }
}

/// Where one notebook's kernel PID is recorded between runs. A notebook id is
/// `"{project_hash}::{relative_path}"` (D18), which contains separators a
/// filename cannot, so it is folded to a flat token rather than used raw.
pub(crate) fn kernel_pid_path(notebook_id: &str) -> PathBuf {
    let flat: String = notebook_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    crate::store::palisade_home().join("kernels").join(format!("{flat}.pid"))
}

/// What has to appear in a process's command line before it is recognised as
/// one of our kernel drivers. The absolute driver path — `python3` alone
/// would match every Python the user is running.
pub(crate) fn kernel_reap_token(driver_path: &Path) -> String {
    driver_path.display().to_string()
}

/// Spawns `python` with `args` (the driver script plus flags). Production
/// goes through `pidguard`'s supervisor so the driver — and the Jupyter
/// kernel it owns — dies the instant this process does, by any means (see
/// `pidguard`'s header). Tests spawn directly: they exercise kernel-resolution
/// logic, not leak prevention, which `pidguard`'s own tests cover against the
/// real mechanism in isolation; going through the supervisor here would
/// re-exec the *test binary*, which has no idea what to do with that.
#[cfg(not(test))]
fn spawn_maybe_supervised(python: &Path, args: &[String]) -> std::io::Result<Child> {
    crate::pidguard::spawn_supervised(python, args)
}
#[cfg(test)]
fn spawn_maybe_supervised(python: &Path, args: &[String]) -> std::io::Result<Child> {
    let mut cmd = Command::new(python);
    cmd.args(args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    // `terminate`'s force-kill fallback uses `pidguard::kill_group`, which
    // needs this child to be a process-group leader (see that fn's doc) —
    // true for the real supervised path via `spawn_supervised`, so the test
    // double needs it too or a stuck fake driver hangs `terminate` forever.
    crate::pidguard::make_group_leader(&mut cmd);
    cmd.spawn()
}

/// Every open notebook's kernel, keyed by notebook id (decisions.md D18:
/// `"{project_hash}::{relative_path}"` — simpler than a generated id that
/// survives a rename, at the cost of orphaning the kernel on a rename while
/// open; the user just restarts it).
pub type NotebookRegistry = Mutex<HashMap<String, Arc<NotebookKernel>>>;

pub fn notebook_id(project_hash: &str, relative_path: &str) -> String {
    format!("{project_hash}::{relative_path}")
}

/// design.md D4: does the notebook's own recorded kernel exist on this
/// machine? Separated from `list_kernelspecs`'s actual subprocess call so
/// the decision logic is testable without spawning `jupyter` (task 3.8).
pub enum KernelResolution {
    /// The requested kernelspec is installed; pass its name straight through.
    Found(String),
    /// No name was recorded, or the recorded one isn't installed — driver
    /// falls back to jupyter_client's own default kernel. Carries a
    /// non-fatal warning to surface to the user, unless there was nothing to
    /// warn about (no name was ever recorded).
    Fallback { warning: Option<String> },
}

pub fn resolve_from_available(requested: Option<&str>, available: &[String]) -> KernelResolution {
    let Some(name) = requested.filter(|n| !n.is_empty()) else {
        return KernelResolution::Fallback { warning: None };
    };
    if available.iter().any(|n| n == name) {
        return KernelResolution::Found(name.to_string());
    }
    KernelResolution::Fallback {
        warning: Some(format!(
            "This notebook's kernel \"{name}\" isn't installed — running against the default Python kernel instead."
        )),
    }
}

/// Names of every kernelspec Jupyter knows about, via `jupyter kernelspec
/// list --json`. Errors (jupyter missing, not on PATH, bad output) are
/// folded into an empty list by the caller — same as "kernelspec not
/// found", which already has a defined fallback behavior.
pub fn list_kernelspecs() -> Res<Vec<String>> {
    let output = Command::new("jupyter")
        .args(["kernelspec", "list", "--json"])
        .output()
        .map_err(|err| crate::PalisadeError::from(format!("jupyter kernelspec list: {err}")))?;
    if !output.status.success() {
        return Err("jupyter kernelspec list exited non-zero".into());
    }
    let parsed: Value = serde_json::from_slice(&output.stdout).map_err(|err| crate::PalisadeError::from(err.to_string()))?;
    let names = parsed
        .get("kernelspecs")
        .and_then(Value::as_object)
        .map(|specs| specs.keys().cloned().collect())
        .unwrap_or_default();
    Ok(names)
}

pub fn resolve_kernelspec_name(requested: Option<&str>) -> KernelResolution {
    let available = list_kernelspecs().unwrap_or_default();
    resolve_from_available(requested, &available)
}

/// Where the bundled driver script lives — debug builds read it straight out
/// of the source tree (mirrors `completion::resolve_sidecar_paths`'s debug
/// branch), release builds resolve the app bundle's `Resources/` dir.
pub fn resolve_driver_path(app: &AppHandle) -> Res<PathBuf> {
    #[cfg(debug_assertions)]
    {
        let _ = app;
        Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("driver").join("notebook_driver.py"))
    }
    #[cfg(not(debug_assertions))]
    {
        use tauri::path::BaseDirectory;
        use tauri::Manager;
        app.path()
            .resolve("driver/notebook_driver.py", BaseDirectory::Resource)
            .map_err(|err| crate::PalisadeError::from(format!("failed to resolve bundled notebook driver: {err}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn found_when_the_requested_kernelspec_is_installed() {
        let available = vec!["python3".to_string(), "pc-test".to_string()];
        match resolve_from_available(Some("python3"), &available) {
            KernelResolution::Found(name) => assert_eq!(name, "python3"),
            KernelResolution::Fallback { .. } => panic!("expected Found"),
        }
    }

    #[test]
    fn fallback_with_warning_when_the_requested_kernelspec_is_missing() {
        let available = vec!["python3".to_string()];
        match resolve_from_available(Some("some-venv-kernel"), &available) {
            KernelResolution::Fallback { warning: Some(msg) } => {
                assert!(msg.contains("some-venv-kernel"));
            }
            other => panic!("expected Fallback with a warning, got a different result: {}", matches!(other, KernelResolution::Found(_))),
        }
    }

    #[test]
    fn fallback_with_no_warning_when_no_kernelspec_was_ever_recorded() {
        let available = vec!["python3".to_string()];
        match resolve_from_available(None, &available) {
            KernelResolution::Fallback { warning: None } => {}
            _ => panic!("expected a silent fallback when the notebook recorded no kernelspec"),
        }
    }

    #[test]
    fn notebook_id_is_stable_and_scoped_to_the_project() {
        assert_eq!(notebook_id("abc123", "notebooks/demo.ipynb"), "abc123::notebooks/demo.ipynb");
        assert_ne!(
            notebook_id("abc123", "demo.ipynb"),
            notebook_id("def456", "demo.ipynb")
        );
    }

    #[test]
    fn a_freshly_constructed_kernel_is_not_alive() {
        let kernel = NotebookKernel::new();
        assert!(!kernel.is_alive());
    }

    #[test]
    fn sending_to_a_kernel_that_never_spawned_is_a_clean_error_not_a_panic() {
        let kernel = NotebookKernel::new();
        assert!(kernel.execute("c1", "1+1").is_err());
        assert!(kernel.interrupt().is_err());
        assert!(kernel.restart().is_err());
    }
}
