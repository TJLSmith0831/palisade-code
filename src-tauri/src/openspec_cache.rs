//! Mtime-keyed cache over the `openspec` CLI.
//!
//! OpenSpec calls are a backend hot path: every spec list/show/status/validate
//! used to spawn a subprocess. The cache keys each project by the mtime of its
//! `openspec/` directory; while that mtime is unchanged, repeated reads return
//! the cached parse (D10).
//!
//! Every call answers with a `Result`, not an `Option`: a missing binary, a
//! failed run, and a hung run are three different answers, and collapsing them
//! into one `None` is what left the user reading "check that `openspec` is on
//! PATH" for an error the CLI had already explained (#16).

use std::collections::HashMap;
use std::fmt;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};
use crate::locks::MutexExt;

/// Why an `openspec` call produced no answer. Distinct variants because the
/// callers genuinely treat them differently: `validate` reports "invalid" for
/// a non-zero exit but "we can't tell" for the rest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpenSpecError {
    /// Neither `openspec` nor `npx` on PATH — nothing ran.
    NotInstalled,
    /// The binary is there but wouldn't start.
    Spawn(String),
    /// Still running when the deadline passed; killed.
    TimedOut { seconds: u64 },
    /// Ran and exited non-zero. `output` is the CLI's own stderr, falling back
    /// to stdout when the CLI reported there instead.
    Exit { code: Option<i32>, output: String },
}

impl fmt::Display for OpenSpecError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotInstalled => write!(f, "`openspec` is not on PATH, and there is no `npx` to fetch it"),
            Self::Spawn(e) => write!(f, "couldn't run `openspec`: {e}"),
            Self::TimedOut { seconds } => write!(f, "`openspec` timed out after {seconds}s"),
            Self::Exit { code, output } => {
                let code = code.map(|c| c.to_string()).unwrap_or_else(|| "signal".into());
                if output.trim().is_empty() {
                    write!(f, "`openspec` exited with status {code} and said nothing")
                } else {
                    write!(f, "`openspec` exited with status {code}: {}", output.trim())
                }
            }
        }
    }
}

pub type OpenSpecResult = Result<String, OpenSpecError>;

pub trait OpenSpecAdapter: Send + Sync + 'static {
    fn list(&self, project_root: &Path) -> OpenSpecResult;
    fn show(&self, project_root: &Path, name: &str) -> OpenSpecResult;
    fn status(&self, project_root: &Path, name: &str) -> OpenSpecResult;
    fn validate(&self, project_root: &Path) -> OpenSpecResult;
    fn archive(&self, project_root: &Path, name: &str) -> OpenSpecResult;
}

/// The newest mtime anywhere under `openspec/`. The folder's own mtime only
/// moves when a direct child is added or removed, so a change the agent
/// writes into `openspec/changes/<name>/` left the cache serving the empty
/// list from before it existed — the Specs pane stayed blank for the whole
/// Spec session. Walking the tree also catches in-place edits to a file.
/// ponytail: full stat walk per call; ~350 entries on this repo's own tree.
fn openspec_dir_mtime(project_root: &Path) -> Option<SystemTime> {
    fn newest(path: &Path) -> Option<SystemTime> {
        let meta = fs::symlink_metadata(path).ok()?;
        let mut latest = meta.modified().ok();
        if meta.is_dir() {
            for entry in fs::read_dir(path).ok()?.flatten() {
                latest = latest.max(newest(&entry.path()));
            }
        }
        latest
    }
    newest(&project_root.join("openspec"))
}

const TIMEOUT: Duration = Duration::from_secs(10);

/// The OpenSpec release Palisade runs when the user has none installed.
/// Pinned because Palisade parses its `--json` output; bump it deliberately
/// after checking `list`/`show`/`status`/`validate`/`archive`/`init` still
/// answer in the shape the parsers here expect.
pub const OPENSPEC_PACKAGE: &str = "@fission-ai/openspec@1.13.1";

/// A first `npx` run downloads the package before it answers.
const NPX_TIMEOUT: Duration = Duration::from_secs(90);

/// How to run OpenSpec on this machine: the user's own `openspec` when it is
/// on PATH, otherwise the pinned package through `npx`. Spec mode can't work
/// without the CLI, and Node is already there for npx-distributed agents, so
/// this makes OpenSpec part of Palisade rather than a manual install step.
pub fn openspec_command(
    find_on_path: &dyn Fn(&str) -> Option<PathBuf>,
) -> Option<(PathBuf, Vec<&'static str>, Duration)> {
    if let Some(bin) = find_on_path("openspec") {
        return Some((bin, vec![], TIMEOUT));
    }
    let npx = find_on_path("npx")?;
    Some((npx, vec!["-y", OPENSPEC_PACKAGE], NPX_TIMEOUT))
}

fn openspec_json(project_root: &Path, args: &[&str]) -> OpenSpecResult {
    let (bin, mut full, timeout) = openspec_command(&crate::executor::find_on_path).ok_or(OpenSpecError::NotInstalled)?;
    full.extend_from_slice(args);
    run_openspec(&bin, project_root, &full, timeout)
}

/// Give a project the `openspec/` root Spec mode writes into, via the CLI's
/// own `init` — Palisade still never writes a spec file. `--tools none` keeps
/// it to the `openspec/` folder: no agent command files land in the project.
/// A no-op when the root already exists.
pub fn init_if_missing(project_root: &Path) -> OpenSpecResult {
    if project_root.join("openspec").is_dir() {
        return Ok(String::new());
    }
    openspec_json(project_root, &["init", "--tools", "none", "--no-animation", "."])
}

/// Run one `openspec` invocation to completion, capturing both streams.
///
/// Split out from `openspec_json` so the failure paths can be tested against a
/// stand-in binary without touching PATH. Both pipes are drained on their own
/// threads: capturing stderr while only reading stdout after exit would hang
/// the parent the moment a chatty failure filled the stderr pipe buffer.
pub(crate) fn run_openspec(
    bin: &Path,
    project_root: &Path,
    args: &[&str],
    timeout: Duration,
) -> OpenSpecResult {
    let mut child = Command::new(bin)
        .args(args)
        .current_dir(project_root)
        .env("PATH", crate::executor::child_path_env())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .spawn()
        .map_err(|e| OpenSpecError::Spawn(e.to_string()))?;

    let drain = |pipe: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut body = String::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe.read_to_string(&mut body);
            }
            body
        })
    };
    let stdout = drain(child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let stderr = drain(child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>));

    let deadline = std::time::Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(25));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(OpenSpecError::TimedOut { seconds: timeout.as_secs() });
            }
            Err(e) => return Err(OpenSpecError::Spawn(e.to_string())),
        }
    };

    let out = stdout.join().unwrap_or_default();
    let err = stderr.join().unwrap_or_default();
    if status.success() {
        return Ok(out);
    }
    // Some subcommands report the failure on stdout; take whichever stream
    // actually said something rather than handing back an empty diagnostic.
    let output = if err.trim().is_empty() { out } else { err };
    Err(OpenSpecError::Exit { code: status.code(), output: output.trim().to_string() })
}

/// Real adapter: shells out to the `openspec` binary installed on PATH.
pub struct RealOpenSpecAdapter;

impl OpenSpecAdapter for RealOpenSpecAdapter {
    fn list(&self, project_root: &Path) -> OpenSpecResult {
        openspec_json(project_root, &["list", "--json"])
    }

    fn show(&self, project_root: &Path, name: &str) -> OpenSpecResult {
        openspec_json(project_root, &["show", name, "--json"])
    }

    fn status(&self, project_root: &Path, name: &str) -> OpenSpecResult {
        openspec_json(project_root, &["status", "--change", name, "--json"])
    }

    fn validate(&self, project_root: &Path) -> OpenSpecResult {
        openspec_json(project_root, &["validate", "--changes"])
    }

    fn archive(&self, project_root: &Path, name: &str) -> OpenSpecResult {
        openspec_json(project_root, &["archive", name, "--yes", "--json"])
    }
}

/// In-memory adapter for tests. Pre-load the answers you expect the cache to
/// return; no subprocess is ever spawned. Anything not pre-loaded answers
/// `NotInstalled` — the "there was nothing to ask" case.
#[cfg(test)]
pub struct InMemoryOpenSpecAdapter {
    pub list: OpenSpecResult,
    pub show: HashMap<String, OpenSpecResult>,
    pub status: HashMap<String, OpenSpecResult>,
    pub validate: OpenSpecResult,
    pub archive: HashMap<String, OpenSpecResult>,
}

#[cfg(test)]
impl Default for InMemoryOpenSpecAdapter {
    fn default() -> Self {
        Self {
            list: Err(OpenSpecError::NotInstalled),
            show: HashMap::new(),
            status: HashMap::new(),
            validate: Err(OpenSpecError::NotInstalled),
            archive: HashMap::new(),
        }
    }
}

#[cfg(test)]
impl OpenSpecAdapter for InMemoryOpenSpecAdapter {
    fn list(&self, project_root: &Path) -> OpenSpecResult {
        let _ = project_root;
        self.list.clone()
    }

    fn show(&self, project_root: &Path, name: &str) -> OpenSpecResult {
        let _ = project_root;
        self.show.get(name).cloned().unwrap_or(Err(OpenSpecError::NotInstalled))
    }

    fn status(&self, project_root: &Path, name: &str) -> OpenSpecResult {
        let _ = project_root;
        self.status.get(name).cloned().unwrap_or(Err(OpenSpecError::NotInstalled))
    }

    fn validate(&self, project_root: &Path) -> OpenSpecResult {
        let _ = project_root;
        self.validate.clone()
    }

    fn archive(&self, project_root: &Path, name: &str) -> OpenSpecResult {
        let _ = project_root;
        self.archive.get(name).cloned().unwrap_or(Err(OpenSpecError::NotInstalled))
    }
}

#[derive(Default, Clone)]
struct Entry {
    mtime: Option<SystemTime>,
    list: Option<OpenSpecResult>,
    show: HashMap<String, OpenSpecResult>,
    status: HashMap<String, OpenSpecResult>,
    validate: Option<OpenSpecResult>,
}

impl Entry {
    fn new(mtime: Option<SystemTime>) -> Self {
        Self { mtime, ..Default::default() }
    }
}

pub struct OpenSpecCache {
    adapter: Arc<dyn OpenSpecAdapter>,
    cache: Mutex<HashMap<PathBuf, Entry>>,
}

impl OpenSpecCache {
    pub fn new(adapter: Arc<dyn OpenSpecAdapter>) -> Self {
        Self { adapter, cache: Mutex::new(HashMap::new()) }
    }

    pub fn with_real_adapter() -> Self {
        Self::new(Arc::new(RealOpenSpecAdapter))
    }

    /// Store the updated entry back into the cache after refreshing a field.
    fn with_entry<F, R>(&self, project_root: &Path, f: F) -> R
    where
        F: FnOnce(&mut Entry) -> R,
    {
        let mut cache = self.cache.lock_or_recover();
        let current = openspec_dir_mtime(project_root);
        let entry = cache.entry(project_root.to_path_buf()).or_insert_with(|| Entry::new(current));
        if entry.mtime != current {
            *entry = Entry::new(current);
        }
        f(entry)
    }

    pub fn list(&self, project_root: &Path) -> OpenSpecResult {
        self.with_entry(project_root, |entry| {
            entry.list.get_or_insert_with(|| self.adapter.list(project_root)).clone()
        })
    }

    pub fn show(&self, project_root: &Path, name: &str) -> OpenSpecResult {
        self.with_entry(project_root, |entry| {
            entry
                .show
                .entry(name.to_string())
                .or_insert_with(|| self.adapter.show(project_root, name))
                .clone()
        })
    }

    pub fn status(&self, project_root: &Path, name: &str) -> OpenSpecResult {
        self.with_entry(project_root, |entry| {
            entry
                .status
                .entry(name.to_string())
                .or_insert_with(|| self.adapter.status(project_root, name))
                .clone()
        })
    }

    pub fn validate(&self, project_root: &Path) -> OpenSpecResult {
        self.with_entry(project_root, |entry| {
            entry.validate.get_or_insert_with(|| self.adapter.validate(project_root)).clone()
        })
    }

    /// Not cached: archiving moves the change on disk, so a second call has to
    /// actually run again.
    pub fn archive(&self, project_root: &Path, name: &str) -> OpenSpecResult {
        self.adapter.archive(project_root, name)
    }
}

impl Default for OpenSpecCache {
    fn default() -> Self {
        Self::with_real_adapter()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The grill skills tell the agent which OpenSpec to run when none is
    /// installed; it must be the same pin Palisade itself runs.
    #[test]
    fn the_skills_and_readme_name_the_pinned_openspec() {
        use crate::executor::{GRILL_APPLY, GRILL_ARCHIVE, GRILL_EXPLORE, GRILL_PROPOSE};
        for skill in [GRILL_APPLY, GRILL_ARCHIVE, GRILL_EXPLORE, GRILL_PROPOSE] {
            assert!(skill.contains(OPENSPEC_PACKAGE), "skill drifted from {OPENSPEC_PACKAGE}: {}", &skill[..60]);
        }
        assert!(
            include_str!("../../README.md").contains(OPENSPEC_PACKAGE),
            "README's install note drifted from {OPENSPEC_PACKAGE}"
        );
    }

    /// The user's own `openspec` wins; without it the pinned package runs
    /// through `npx`; with neither there is nothing to run.
    #[test]
    fn openspec_command_prefers_path_then_pinned_npx() {
        let only = |names: &'static [&'static str]| {
            move |bin: &str| names.contains(&bin).then(|| PathBuf::from(format!("/bin/{bin}")))
        };
        let (bin, args, _) = openspec_command(&only(&["openspec", "npx"])).unwrap();
        assert_eq!((bin, args), (PathBuf::from("/bin/openspec"), vec![]), "PATH openspec should win");
        let (bin, args, timeout) = openspec_command(&only(&["npx"])).unwrap();
        assert_eq!((bin, args), (PathBuf::from("/bin/npx"), vec!["-y", OPENSPEC_PACKAGE]), "npx fallback runs the pinned package");
        assert!(timeout > TIMEOUT, "a cold npx download needs longer than a local run");
        assert!(openspec_command(&only(&[])).is_none(), "no openspec and no npx means not installed");
    }

    /// A project that already has its `openspec/` root is left alone — the
    /// CLI is never run, so an existing config is never re-initialized.
    #[test]
    fn init_is_a_no_op_when_the_root_exists() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("openspec")).unwrap();
        assert_eq!(init_if_missing(dir.path()).unwrap(), "");
        assert_eq!(fs::read_dir(dir.path().join("openspec")).unwrap().count(), 0);
    }
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    /// A stand-in for the `openspec` binary: a script that prints what the
    /// test wants on each stream and exits with the code the test names.
    fn fake_openspec(dir: &Path, body: &str) -> PathBuf {
        let path = dir.join("openspec");
        fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        }
        path
    }

    /// Generous on purpose: these tests assert on the *outcome*, not on
    /// latency, and a 500ms budget flaked whenever the test binary spawned
    /// them all at once. The timeout test below sets its own short deadline.
    const QUICK: Duration = Duration::from_secs(10);

    #[test]
    fn a_successful_run_returns_stdout() {
        let dir = tempfile::tempdir().unwrap();
        let bin = fake_openspec(dir.path(), r#"printf '{"changes":[]}'"#);
        assert_eq!(
            run_openspec(&bin, dir.path(), &["list", "--json"], QUICK),
            Ok(r#"{"changes":[]}"#.to_string())
        );
    }

    /// #16: the whole point — a non-zero exit used to collapse to `None`,
    /// throwing away the one thing that says what went wrong.
    #[test]
    fn a_nonzero_exit_carries_the_cli_stderr() {
        let dir = tempfile::tempdir().unwrap();
        let bin = fake_openspec(dir.path(), "echo 'change not found: nope' >&2\nexit 3");
        let err = run_openspec(&bin, dir.path(), &["archive", "nope"], QUICK).unwrap_err();
        assert_eq!(
            err,
            OpenSpecError::Exit { code: Some(3), output: "change not found: nope".into() }
        );
        assert!(err.to_string().contains("change not found: nope"));
        assert!(err.to_string().contains('3'), "the exit code is part of the diagnostic");
    }

    /// Some CLIs report their failure on stdout. Falling back to it is the
    /// difference between a real message and an empty one.
    #[test]
    fn a_failing_run_falls_back_to_stdout_when_stderr_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        let bin = fake_openspec(dir.path(), "echo 'validation failed'\nexit 1");
        assert_eq!(
            run_openspec(&bin, dir.path(), &["validate"], QUICK).unwrap_err(),
            OpenSpecError::Exit { code: Some(1), output: "validation failed".into() }
        );
    }

    #[test]
    fn a_failing_run_with_no_output_still_names_the_exit_code() {
        let dir = tempfile::tempdir().unwrap();
        let bin = fake_openspec(dir.path(), "exit 2");
        let err = run_openspec(&bin, dir.path(), &["list"], QUICK).unwrap_err();
        assert_eq!(err, OpenSpecError::Exit { code: Some(2), output: String::new() });
        assert!(err.to_string().contains('2'));
    }

    /// A hung CLI is a different answer from a failed one, and the old code
    /// reported both as the same `None`.
    #[test]
    fn a_hung_run_reports_a_timeout_not_a_generic_failure() {
        let dir = tempfile::tempdir().unwrap();
        let bin = fake_openspec(dir.path(), "sleep 30");
        let err = run_openspec(&bin, dir.path(), &["list"], Duration::from_millis(150)).unwrap_err();
        assert!(matches!(err, OpenSpecError::TimedOut { .. }), "got {err:?}");
        assert!(err.to_string().contains("timed out"));
    }

    /// More output than a pipe buffer holds: without draining both streams
    /// concurrently, capturing stderr would deadlock the parent instead.
    #[test]
    fn a_chatty_failure_does_not_deadlock_the_reader() {
        let dir = tempfile::tempdir().unwrap();
        let bin = fake_openspec(
            dir.path(),
            "i=0; while [ $i -lt 4000 ]; do echo 'noisy diagnostic line' >&2; i=$((i+1)); done\nexit 1",
        );
        let err = run_openspec(&bin, dir.path(), &["archive", "x"], Duration::from_secs(20)).unwrap_err();
        let OpenSpecError::Exit { output, .. } = err else { panic!("expected Exit, got {err:?}") };
        assert!(output.len() > 64 * 1024, "the whole stderr is captured, not a pipe-buffer's worth");
    }

    #[test]
    fn an_unspawnable_binary_reports_the_spawn_error() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("not-here");
        let err = run_openspec(&missing, dir.path(), &["list"], QUICK).unwrap_err();
        assert!(matches!(err, OpenSpecError::Spawn(_)), "got {err:?}");
    }

    #[test]
    fn a_missing_binary_is_its_own_error_not_a_failed_run() {
        assert_eq!(OpenSpecError::NotInstalled.to_string(), "`openspec` is not on PATH, and there is no `npx` to fetch it");
    }

    /// Counts calls so the cache's memoization can be asserted on directly.
    struct CountingAdapter {
        result: OpenSpecResult,
        calls: AtomicUsize,
    }

    impl CountingAdapter {
        fn new(result: OpenSpecResult) -> Self {
            Self { result, calls: AtomicUsize::new(0) }
        }
        fn hit(&self) -> OpenSpecResult {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.result.clone()
        }
    }

    impl OpenSpecAdapter for Arc<CountingAdapter> {
        fn list(&self, _: &Path) -> OpenSpecResult {
            self.hit()
        }
        fn show(&self, _: &Path, _: &str) -> OpenSpecResult {
            self.hit()
        }
        fn status(&self, _: &Path, _: &str) -> OpenSpecResult {
            self.hit()
        }
        fn validate(&self, _: &Path) -> OpenSpecResult {
            self.hit()
        }
        fn archive(&self, _: &Path, _: &str) -> OpenSpecResult {
            self.hit()
        }
    }

    /// Failures stay memoized exactly like successes — the cache's job is to
    /// stop respawning the CLI, and an error is an answer too.
    #[test]
    fn the_cache_remembers_a_failure_instead_of_respawning() {
        let dir = tempfile::tempdir().unwrap();
        let counter = Arc::new(CountingAdapter::new(Err(OpenSpecError::NotInstalled)));
        let cache = OpenSpecCache::new(Arc::new(counter.clone()));

        assert_eq!(cache.list(dir.path()), Err(OpenSpecError::NotInstalled));
        assert_eq!(cache.list(dir.path()), Err(OpenSpecError::NotInstalled));
        assert_eq!(counter.calls.load(Ordering::SeqCst), 1);
    }

    /// A change written deep under `openspec/` must refresh the list while
    /// the Spec session is still running. The folder's own mtime never moves
    /// for it, which kept the Specs pane blank until the flow was over.
    #[test]
    fn a_change_written_below_openspec_refreshes_the_cache() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("openspec/changes")).unwrap();
        let counter = Arc::new(CountingAdapter::new(Ok("{}".into())));
        let cache = OpenSpecCache::new(Arc::new(counter.clone()));
        let later = |secs| SystemTime::now() + Duration::from_secs(secs);

        let _ = cache.list(dir.path());
        let _ = cache.list(dir.path());
        assert_eq!(counter.calls.load(Ordering::SeqCst), 1, "unchanged tree is served from cache");

        // Explicit future mtimes: a same-tick write must not make this flaky.
        fs::create_dir_all(dir.path().join("openspec/changes/landing-page")).unwrap();
        let proposal = dir.path().join("openspec/changes/landing-page/proposal.md");
        fs::write(&proposal, "# Proposal").unwrap();
        fs::File::options().write(true).open(&proposal).unwrap().set_modified(later(60)).unwrap();
        let _ = cache.list(dir.path());
        assert_eq!(counter.calls.load(Ordering::SeqCst), 2, "a new change must refresh the list");

        // Rewriting an existing file changes no directory — only its own mtime.
        fs::File::options().write(true).open(&proposal).unwrap().set_modified(later(120)).unwrap();
        let _ = cache.list(dir.path());
        assert_eq!(counter.calls.load(Ordering::SeqCst), 3, "an edit to a spec file must refresh the list");
    }

    /// Archiving mutates the project, so it has never been cached — a second
    /// click has to actually run again.
    #[test]
    fn archive_is_never_cached() {
        let dir = tempfile::tempdir().unwrap();
        let counter = Arc::new(CountingAdapter::new(Err(OpenSpecError::Exit {
            code: Some(1),
            output: "boom".into(),
        })));
        let cache = OpenSpecCache::new(Arc::new(counter.clone()));

        let _ = cache.archive(dir.path(), "c");
        let _ = cache.archive(dir.path(), "c");
        assert_eq!(counter.calls.load(Ordering::SeqCst), 2);
    }

    /// Every read path carries the adapter's error through unchanged; none of
    /// them may flatten it back into "we can't tell".
    #[test]
    fn errors_propagate_through_every_cached_read() {
        let dir = tempfile::tempdir().unwrap();
        let failure = OpenSpecError::Exit { code: Some(1), output: "bad spec".into() };
        let cache = OpenSpecCache::new(Arc::new(Arc::new(CountingAdapter::new(Err(failure.clone())))));

        assert_eq!(cache.list(dir.path()), Err(failure.clone()));
        assert_eq!(cache.show(dir.path(), "c"), Err(failure.clone()));
        assert_eq!(cache.status(dir.path(), "c"), Err(failure.clone()));
        assert_eq!(cache.validate(dir.path()), Err(failure));
    }

    #[test]
    fn the_in_memory_adapter_defaults_to_not_installed() {
        let dir = tempfile::tempdir().unwrap();
        let cache = OpenSpecCache::new(Arc::new(InMemoryOpenSpecAdapter::default()));
        assert_eq!(cache.list(dir.path()), Err(OpenSpecError::NotInstalled));
        assert_eq!(cache.show(dir.path(), "c"), Err(OpenSpecError::NotInstalled));
    }
}
