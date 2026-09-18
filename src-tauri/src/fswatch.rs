//! Watches the active project root for changes Palisade didn't make itself.
//!
//! `spawn` returns `Self` rather than `Res<Self>` (a failed spawn reports
//! through `on_crash` instead of blocking the caller), `Drop` calls
//! `terminate`, and the callbacks are moved into the watcher. The debouncer
//! owns its own thread, so there's no `AtomicBool`/`JoinHandle` pair to manage
//! here — dropping the debouncer stops it.
//!
//! It has to see every path under the project, so it uses FSEvents (via
//! `notify`) rather than a poll loop.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::commands::fs_ops::should_skip_entry;
use notify::RecursiveMode;
use notify_debouncer_full::{
    new_debouncer, DebounceEventResult, Debouncer, RecommendedCache,
};
use notify::RecommendedWatcher;
use crate::locks::MutexExt;

/// How long coalesced filesystem events are batched before firing. Long
/// enough that macOS's rename-as-delete+create arrives as one batch, short
/// enough that an agent edit shows up while you're still watching it happen.
const DEBOUNCE: Duration = Duration::from_millis(400);

/// How long after one of our own writes we ignore events for that path.
/// FSEvents can take a moment to deliver, so this outlives `DEBOUNCE`.
const SELF_WRITE_WINDOW: Duration = Duration::from_millis(1500);

type SelfWrites = Arc<Mutex<HashMap<PathBuf, Instant>>>;

pub struct FsWatcher {
    /// `None` when the watcher failed to start — reported through `on_crash`
    /// at spawn time, so the app keeps working without reconciliation rather
    /// than failing the project switch.
    debouncer: Option<Debouncer<RecommendedWatcher, RecommendedCache>>,
    /// Paths Palisade wrote itself, with when. Shared with the debouncer thread
    /// so a save doesn't bounce straight back as an external change.
    self_writes: SelfWrites,
}

impl FsWatcher {
    /// Starts watching `project_root` recursively. `on_change` receives
    /// project-relative paths, already filtered by `should_skip_entry` and
    /// with our own writes suppressed.
    pub fn spawn(
        project_root: PathBuf,
        on_change: impl Fn(Vec<String>) + Send + 'static,
        on_crash: impl Fn(String) + Send + Sync + 'static,
    ) -> Self {
        let self_writes: SelfWrites = Arc::new(Mutex::new(HashMap::new()));
        // Shared rather than moved: both the debouncer thread (per-event
        // watch errors) and this function (a failed start) report through it.
        let on_crash = Arc::new(on_crash);
        let handler_crash = Arc::clone(&on_crash);

        // FSEvents reports fully-resolved paths (/private/var, not /var), so
        // the root we strip against has to be resolved the same way or
        // nothing ever matches.
        let root = match std::fs::canonicalize(&project_root) {
            Ok(root) => root,
            Err(err) => {
                // Overwhelmingly this is a project whose folder was moved or
                // deleted since it was added. "No such file or directory" on
                // its own tells the user nothing about which directory or
                // what to do; naming it makes it actionable.
                on_crash(if err.kind() == std::io::ErrorKind::NotFound {
                    format!(
                        "this project's folder is missing — {} no longer exists. \
                         Move it back, or remove the project and add it again.",
                        project_root.display()
                    )
                } else {
                    format!("could not watch project files: {err}")
                });
                return Self { debouncer: None, self_writes };
            }
        };

        let handler_root = root.clone();
        let handler_writes = Arc::clone(&self_writes);
        let handler = move |result: DebounceEventResult| match result {
            Ok(events) => {
                let mut changed: Vec<String> = Vec::new();
                for event in events {
                    for path in &event.paths {
                        let Some(relative) = relative_if_interesting(&handler_root, path) else {
                            continue;
                        };
                        if was_self_write(&handler_writes, path) {
                            continue;
                        }
                        if !changed.contains(&relative) {
                            changed.push(relative);
                        }
                    }
                }
                if !changed.is_empty() {
                    on_change(changed);
                }
            }
            // Watch errors are per-event, not fatal — the watcher keeps
            // running, so this warns rather than tearing anything down.
            Err(errors) => {
                for err in errors {
                    handler_crash(format!("file watch error: {err}"));
                }
            }
        };

        let mut debouncer = match new_debouncer(DEBOUNCE, None, handler) {
            Ok(debouncer) => debouncer,
            Err(err) => {
                on_crash(format!("could not watch project files: {err}"));
                return Self { debouncer: None, self_writes };
            }
        };
        if let Err(err) = debouncer.watch(&root, RecursiveMode::Recursive) {
            on_crash(format!("could not watch project files: {err}"));
            return Self { debouncer: None, self_writes };
        }

        Self { debouncer: Some(debouncer), self_writes }
    }

    /// Records that Palisade just wrote `path`, so the resulting event doesn't
    /// come back as an external change. Callers pass the resolved absolute
    /// path; it's canonicalized here to match what FSEvents will report.
    pub fn note_self_write(&self, path: &Path) {
        let key = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        let mut writes = self.self_writes.lock_or_recover();
        writes.retain(|_, at| at.elapsed() < SELF_WRITE_WINDOW);
        writes.insert(key, Instant::now());
    }

    pub fn terminate(&mut self) {
        self.debouncer = None;
    }
}

impl Drop for FsWatcher {
    fn drop(&mut self) {
        self.terminate();
    }
}

/// `Some(relative_path)` when the change is one the UI should react to, or
/// `None` for anything under a skipped directory. Uses the same skip rule as
/// the file tree so the two can't disagree about what exists.
fn relative_if_interesting(root: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(root).ok()?;
    if relative.as_os_str().is_empty() {
        return None;
    }
    for component in relative.components() {
        let name = component.as_os_str().to_string_lossy();
        if should_skip_entry(&name, false) {
            return None;
        }
    }
    Some(relative.to_string_lossy().to_string())
}

/// Whether `path` was written by Palisade within the suppression window. The
/// entry is consumed on match so a genuine external write to the same path a
/// moment later still reports.
fn was_self_write(writes: &SelfWrites, path: &Path) -> bool {
    let mut writes = writes.lock_or_recover();
    match writes.get(path) {
        Some(at) if at.elapsed() < SELF_WRITE_WINDOW => {
            writes.remove(path);
            true
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn a_missing_project_folder_says_which_folder_and_what_to_do() {
        let (tx, rx) = mpsc::channel::<String>();
        let gone = std::path::PathBuf::from("/tmp/palisade-does-not-exist-abc123");
        let _watcher = FsWatcher::spawn(
            gone.clone(),
            move |_| {},
            move |err| {
                let _ = tx.send(err);
            },
        );

        let message = rx.recv_timeout(std::time::Duration::from_secs(2)).unwrap();
        assert!(message.contains("palisade-does-not-exist-abc123"), "{message}");
        assert!(message.contains("folder is missing"), "{message}");
        // Bare io text is not something a user can act on.
        assert!(!message.contains("os error"), "{message}");
    }

    /// Waits for one batch of changed paths, or gives up. Generous because
    /// FSEvents latency plus `DEBOUNCE` is not instant.
    fn recv_changes(rx: &mpsc::Receiver<Vec<String>>) -> Option<Vec<String>> {
        rx.recv_timeout(Duration::from_secs(5)).ok()
    }

    fn watcher_on(root: &Path) -> (FsWatcher, mpsc::Receiver<Vec<String>>) {
        let (tx, rx) = mpsc::channel();
        let watcher = FsWatcher::spawn(root.to_path_buf(), move |paths| { let _ = tx.send(paths); }, |_| {});
        // Give FSEvents a moment to actually arm before the test mutates
        // anything, or the first write lands before the watch does.
        std::thread::sleep(Duration::from_millis(300));
        (watcher, rx)
    }

    #[test]
    fn reports_a_file_changed_by_someone_else() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("notes.txt"), "before").unwrap();
        let (_watcher, rx) = watcher_on(dir.path());

        std::fs::write(dir.path().join("notes.txt"), "after").unwrap();

        let changed = recv_changes(&rx).expect("an external write should report");
        assert!(changed.contains(&"notes.txt".to_string()), "got {changed:?}");
    }

    #[test]
    fn does_not_report_our_own_write() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("notes.txt");
        std::fs::write(&file, "before").unwrap();
        let (watcher, rx) = watcher_on(dir.path());

        watcher.note_self_write(&file);
        std::fs::write(&file, "after").unwrap();

        // Either nothing arrives, or a batch arrives without this path —
        // both mean the save didn't bounce back at the user.
        if let Some(changed) = recv_changes(&rx) {
            assert!(!changed.contains(&"notes.txt".to_string()), "own write reported back: {changed:?}");
        }
    }

    #[test]
    fn a_later_external_write_still_reports_after_a_self_write() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("notes.txt");
        std::fs::write(&file, "before").unwrap();
        let (watcher, rx) = watcher_on(dir.path());

        watcher.note_self_write(&file);
        std::fs::write(&file, "ours").unwrap();
        // Usually returns nothing: suppression eats the save, and no empty
        // batch is sent, so this burns its budget. It returns early only on a
        // machine slow enough that FSEvents outran SELF_WRITE_WINDOW and the
        // save was reported rather than swallowed.
        let _ = recv_changes(&rx);

        // Do not write again in the same breath. After an early return above
        // the entry is still armed, and a write landing in the same debounce
        // batch is exactly what it would eat — measured: two writes with no
        // gap produce one batch and one suppressed path, and nothing arrives.
        std::thread::sleep(DEBOUNCE * 2);
        while rx.try_recv().is_ok() {}

        // The suppression entry is one-shot, so the agent editing the same
        // file right after our save is not swallowed.
        std::fs::write(&file, "theirs").unwrap();
        // Deliberately generous, unlike `recv_changes`. This asserts an event
        // *will* arrive, where the drain above asserts nothing; delivery here
        // is ~450ms on a developer machine, and the CI failure this replaces
        // was a loaded shared runner missing a 5s budget. A high ceiling
        // costs nothing on the passing path.
        let changed = rx
            .recv_timeout(Duration::from_secs(30))
            .expect("a second, external write should report");
        assert!(changed.contains(&"notes.txt".to_string()), "got {changed:?}");
    }

    #[test]
    fn ignores_compiled_python_caches() {
        // Dogfood regression: running the test suite writes `__pycache__`
        // into the project. Those events reached the UI as real file
        // changes, which marked the test run's own results stale the moment
        // it finished — every run came back flagged, so the flag meant
        // nothing.
        let root = Path::new("/p");
        assert_eq!(
            relative_if_interesting(root, Path::new("/p/tests/__pycache__/test_app.cpython-313.pyc")),
            None
        );
        assert_eq!(
            relative_if_interesting(root, Path::new("/p/__pycache__/app.cpython-313.pyc")),
            None
        );
        // The source next to it is still very much interesting.
        assert_eq!(
            relative_if_interesting(root, Path::new("/p/tests/test_app.py")).as_deref(),
            Some("tests/test_app.py")
        );
    }

    #[test]
    fn ignores_paths_the_file_tree_hides() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("node_modules/pkg")).unwrap();
        std::fs::create_dir_all(dir.path().join(".git")).unwrap();
        let (_watcher, rx) = watcher_on(dir.path());

        std::fs::write(dir.path().join("node_modules/pkg/index.js"), "noise").unwrap();
        std::fs::write(dir.path().join(".git/COMMIT_EDITMSG"), "noise").unwrap();
        std::fs::write(dir.path().join("real.txt"), "signal").unwrap();

        let changed = recv_changes(&rx).expect("the real file should report");
        assert_eq!(changed, vec!["real.txt".to_string()], "skip list leaked: {changed:?}");
    }

    #[test]
    fn skipped_directories_never_reach_the_ui() {
        // This is the filter's real seam. FSEvents delivery is an OS service
        // and is not deterministic in a sandboxed test process; testing it
        // here turned a pure path-policy regression into an intermittent
        // five-second timeout. The callback above invokes this helper for
        // every event path, so these assertions prove generated output cannot
        // reach the UI while a sibling source file still can.
        let root = Path::new("/project");
        assert_eq!(
            relative_if_interesting(root, Path::new("/project/node_modules/pkg/index.js")),
            None
        );
        assert_eq!(
            relative_if_interesting(root, Path::new("/project/target/debug/build.log")),
            None
        );
        assert_eq!(
            relative_if_interesting(root, Path::new("/project/real.txt")).as_deref(),
            Some("real.txt")
        );
    }

    #[test]
    fn an_unwatchable_root_reports_a_crash_instead_of_panicking() {
        let (tx, rx) = mpsc::channel();
        let watcher = FsWatcher::spawn(
            PathBuf::from("/definitely/not/a/project"),
            |_| {},
            move |message| { let _ = tx.send(message); },
        );
        assert!(watcher.debouncer.is_none());
        let message = rx.recv_timeout(Duration::from_secs(2)).expect("on_crash should fire");
        // A path that isn't there is the missing-folder case, which names
        // the folder rather than repeating the io error.
        assert!(message.contains("/definitely/not/a/project"), "got {message}");
    }
}
