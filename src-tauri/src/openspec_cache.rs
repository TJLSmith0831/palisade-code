//! Mtime-keyed cache over the `openspec` CLI.
//!
//! OpenSpec calls are a backend hot path: every spec list/show/status/validate
//! used to spawn a subprocess. The cache keys each project by the mtime of its
//! `openspec/` directory; while that mtime is unchanged, repeated reads return
//! the cached parse (D10).

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

pub trait OpenSpecAdapter: Send + Sync + 'static {
    fn list(&self, project_root: &Path) -> Option<String>;
    fn show(&self, project_root: &Path, name: &str) -> Option<String>;
    fn status(&self, project_root: &Path, name: &str) -> Option<String>;
    fn validate(&self, project_root: &Path) -> Option<String>;
    fn archive(&self, project_root: &Path, name: &str) -> Option<String>;
}

fn openspec_dir_mtime(project_root: &Path) -> Option<SystemTime> {
    fs::metadata(project_root.join("openspec")).ok()?.modified().ok()
}

fn openspec_json(project_root: &Path, args: &[&str]) -> Option<String> {
    const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
    let bin = crate::executor::find_on_path("openspec")?;
    let mut child = Command::new(bin)
        .args(args)
        .current_dir(project_root)
        .env("PATH", crate::executor::child_path_env())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .spawn()
        .ok()?;

    let deadline = std::time::Instant::now() + TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(Some(_)) => return None,
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Err(_) => return None,
        }
    }
    let mut body = String::new();
    std::io::Read::read_to_string(&mut child.stdout.take()?, &mut body).ok()?;
    Some(body)
}

/// Real adapter: shells out to the `openspec` binary installed on PATH.
pub struct RealOpenSpecAdapter;

impl OpenSpecAdapter for RealOpenSpecAdapter {
    fn list(&self, project_root: &Path) -> Option<String> {
        openspec_json(project_root, &["list", "--json"])
    }

    fn show(&self, project_root: &Path, name: &str) -> Option<String> {
        openspec_json(project_root, &["show", name, "--json"])
    }

    fn status(&self, project_root: &Path, name: &str) -> Option<String> {
        openspec_json(project_root, &["status", "--change", name, "--json"])
    }

    fn validate(&self, project_root: &Path) -> Option<String> {
        crate::executor::find_on_path("openspec")?;
        openspec_json(project_root, &["validate", "--changes"])
    }

    fn archive(&self, project_root: &Path, name: &str) -> Option<String> {
        openspec_json(project_root, &["archive", name, "--yes", "--json"])
    }
}

/// In-memory adapter for tests. Pre-load the answers you expect the cache to
/// return; no subprocess is ever spawned.
pub struct InMemoryOpenSpecAdapter {
    pub list: Option<String>,
    pub show: HashMap<String, String>,
    pub status: HashMap<String, String>,
    pub validate: Option<String>,
    pub archive: HashMap<String, String>,
}

impl Default for InMemoryOpenSpecAdapter {
    fn default() -> Self {
        Self {
            list: None,
            show: HashMap::new(),
            status: HashMap::new(),
            validate: None,
            archive: HashMap::new(),
        }
    }
}

impl OpenSpecAdapter for InMemoryOpenSpecAdapter {
    fn list(&self, project_root: &Path) -> Option<String> {
        let _ = project_root;
        self.list.clone()
    }

    fn show(&self, project_root: &Path, name: &str) -> Option<String> {
        let _ = project_root;
        self.show.get(name).cloned()
    }

    fn status(&self, project_root: &Path, name: &str) -> Option<String> {
        let _ = project_root;
        self.status.get(name).cloned()
    }

    fn validate(&self, project_root: &Path) -> Option<String> {
        let _ = project_root;
        self.validate.clone()
    }

    fn archive(&self, project_root: &Path, name: &str) -> Option<String> {
        let _ = project_root;
        self.archive.get(name).cloned()
    }
}

#[derive(Default, Clone)]
struct Entry {
    mtime: Option<SystemTime>,
    list: Option<Option<String>>,
    show: HashMap<String, Option<String>>,
    status: HashMap<String, Option<String>>,
    validate: Option<Option<String>>,
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
        let mut cache = self.cache.lock().unwrap();
        let current = openspec_dir_mtime(project_root);
        let entry = cache.entry(project_root.to_path_buf()).or_insert_with(|| Entry::new(current));
        if entry.mtime != current {
            *entry = Entry::new(current);
        }
        f(entry)
    }

    pub fn list(&self, project_root: &Path) -> Option<String> {
        self.with_entry(project_root, |entry| {
            if entry.list.is_none() {
                entry.list = Some(self.adapter.list(project_root));
            }
            entry.list.clone().unwrap()
        })
    }

    pub fn show(&self, project_root: &Path, name: &str) -> Option<String> {
        self.with_entry(project_root, |entry| {
            if !entry.show.contains_key(name) {
                let value = self.adapter.show(project_root, name);
                entry.show.insert(name.to_string(), value);
            }
            entry.show.get(name).cloned().unwrap()
        })
    }

    pub fn status(&self, project_root: &Path, name: &str) -> Option<String> {
        self.with_entry(project_root, |entry| {
            if !entry.status.contains_key(name) {
                let value = self.adapter.status(project_root, name);
                entry.status.insert(name.to_string(), value);
            }
            entry.status.get(name).cloned().unwrap()
        })
    }

    pub fn validate(&self, project_root: &Path) -> Option<String> {
        self.with_entry(project_root, |entry| {
            if entry.validate.is_none() {
                entry.validate = Some(self.adapter.validate(project_root));
            }
            entry.validate.clone().unwrap()
        })
    }

    pub fn archive(&self, project_root: &Path, name: &str) -> Option<String> {
        self.adapter.archive(project_root, name)
    }
}

impl Default for OpenSpecCache {
    fn default() -> Self {
        Self::with_real_adapter()
    }
}
