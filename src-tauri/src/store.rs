//! On-disk state for Palisade Code: the global project index, per-project
//! thread sidecars, and append-only JSONL session logs.
//!
//! Every function takes the palisade home directory explicitly rather than
//! reading it from the environment, so tests can point at a tempdir without
//! process-global state. `palisade_home()` is only called by the command layer.

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Every IPC command's result. The error carries a `kind` the frontend can
/// branch on rather than a bare string it has to pattern-match; see
/// `error.rs` for why the long tail still arrives as `ErrorKind::Unknown`.
pub type Res<T> = Result<T, crate::error::PalisadeError>;

fn e(ctx: &str, err: impl std::fmt::Display) -> crate::PalisadeError {
    crate::PalisadeError::from(format!("{ctx}: {err}"))
}

/// `~/.palisade-code` — the session store, deliberately outside any target repo.
pub fn palisade_home() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".palisade-code")
}

/// Store directories this app has used under earlier names, newest first.
const LEGACY_HOME_DIRS: [&str; 2] = [".sceilg-code", ".floo-network"];

/// Moves a pre-rename store (`~/.sceilg-code`, `~/.floo-network`) to
/// `~/.palisade-code` once, so a rename does not orphan existing projects,
/// threads and session logs. A no-op once the new path exists — never merges.
pub fn migrate_legacy_home(home: &Path) -> Res<()> {
    let Some(parent) = home.parent() else {
        return Ok(());
    };
    if home.exists() {
        return Ok(());
    }
    for name in LEGACY_HOME_DIRS {
        let legacy = parent.join(name);
        if legacy.is_dir() {
            return fs::rename(&legacy, home).map_err(|err| e("migrate legacy store", err));
        }
    }
    Ok(())
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

// ---------------------------------------------------------------- projects

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub hash: String,
    pub root: String,
    pub display_name: String,
    pub created_at: String,
    pub last_accessed_at: String,
}

/// On-disk key for a project: lowercase SHA-256 hex of its canonical root path.
pub fn project_hash(canonical_root: &str) -> String {
    format!("{:x}", Sha256::digest(canonical_root.as_bytes()))
}

fn index_path(home: &Path) -> PathBuf {
    home.join("projects.json")
}

pub fn project_dir(home: &Path, hash: &str) -> PathBuf {
    home.join("projects").join(hash)
}

pub fn threads_dir(home: &Path, hash: &str) -> PathBuf {
    project_dir(home, hash).join("threads")
}

fn read_json<T: serde::de::DeserializeOwned + Default>(path: &Path) -> Res<T> {
    match fs::read_to_string(path) {
        Ok(s) => serde_json::from_str(&s).map_err(|err| e(&format!("parse {}", path.display()), err)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(T::default()),
        Err(err) => Err(e(&format!("read {}", path.display()), err)),
    }
}

/// Write-then-rename, not write-in-place: `fs::write` truncates first, so a
/// concurrent reader — another project window (#33), or the file watcher — can
/// observe an empty or half-written file and report the store as corrupt.
/// `rename` is atomic within a filesystem, so a reader sees either the old
/// file or the new one.
fn write_json<T: Serialize>(path: &Path, value: &T) -> Res<()> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| e("create dir", err))?;
    }
    let body = serde_json::to_string_pretty(value).map_err(|err| e("serialize", err))?;
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(format!(
        ".{}.{}.tmp",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let tmp = path.with_file_name(name);
    // Data to disk before the rename: APFS may otherwise commit the rename
    // first and a power cut leaves a zero-length meta file, which
    // `list_threads` skips silently — the thread simply disappears.
    let written = File::create(&tmp)
        .and_then(|mut file| file.write_all(body.as_bytes()).and_then(|()| file.sync_all()));
    written.map_err(|err| {
        let _ = fs::remove_file(&tmp);
        e(&format!("write {}", tmp.display()), err)
    })?;
    fs::rename(&tmp, path).map_err(|err| {
        let _ = fs::remove_file(&tmp);
        e(&format!("write {}", path.display()), err)
    })
}

/// Serializes read-modify-write of the shared project index. Every project
/// window runs in this process (#33), so two windows registering or removing
/// projects at the same moment would otherwise each read the same list and
/// save theirs over the other's.
// ponytail: process-global lock — an advisory file lock only if two app
// instances ever share one home directory.
static INDEX_LOCK: Mutex<()> = Mutex::new(());

/// Held for the whole read-modify-write of `projects.json`. Not reentrant:
/// only the public mutators below take it, and nothing they call takes it again.
fn lock_index() -> std::sync::MutexGuard<'static, ()> {
    INDEX_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub fn list_projects(home: &Path) -> Res<Vec<Project>> {
    let _guard = lock_index();
    list_projects_locked(home)
}

/// The body of `list_projects`, for callers that already hold `INDEX_LOCK` —
/// `add_project`/`remove_project`/`update_project` read the list as part of
/// their own locked read-modify-write and must not lock again (the mutex
/// isn't reentrant), but still need the same orphan-adoption save that
/// `list_projects` does.
fn list_projects_locked(home: &Path) -> Res<Vec<Project>> {
    let mut projects: Vec<Project> = read_json(&index_path(home))?;
    projects.retain(|p| !project_dir(home, &p.hash).join("removed").exists());
    if adopt_orphan_projects(home, &mut projects) {
        save_projects(home, &projects)?;
    }
    projects.sort_by(|a, b| b.last_accessed_at.cmp(&a.last_accessed_at));
    Ok(projects)
}

/// The index and the `projects/` directory can diverge — a lost or rewritten
/// `projects.json` leaves real thread history permanently unreachable. Each
/// project dir keeps its own authoritative `project.json`, so any directory
/// holding a parseable one is adopted back into the index. Nothing is ever
/// deleted: a directory without a valid `project.json` is simply skipped.
/// Returns whether the index changed.
fn adopt_orphan_projects(home: &Path, projects: &mut Vec<Project>) -> bool {
    let Ok(entries) = fs::read_dir(home.join("projects")) else {
        return false;
    };
    let mut adopted = false;
    for entry in entries.flatten() {
        let hash = entry.file_name().to_string_lossy().to_string();
        if entry.path().join("removed").exists() || projects.iter().any(|p| p.hash == hash) {
            continue;
        }
        let body = match fs::read_to_string(entry.path().join("project.json")) {
            Ok(body) => body,
            Err(_) => continue,
        };
        match serde_json::from_str::<Project>(&body) {
            // A `project.json` naming a different hash than its own directory
            // isn't a project we can address; adopting it would key the index
            // on a path that doesn't exist.
            Ok(project) if project.hash == hash => {
                projects.push(project);
                adopted = true;
            }
            _ => continue,
        }
    }
    adopted
}

fn save_projects(home: &Path, projects: &[Project]) -> Res<()> {
    write_json(&index_path(home), &projects)
}

/// Register `dir` (or refresh it if already registered) and return its entry.
pub fn add_project(home: &Path, dir: &Path) -> Res<Project> {
    let _guard = lock_index();
    let canonical = fs::canonicalize(dir)
        .map_err(|err| e(&format!("resolve {}", dir.display()), err))?;
    if !canonical.is_dir() {
        return Err(format!("{} is not a directory", canonical.display()).into());
    }
    let root = canonical.to_string_lossy().to_string();
    let hash = project_hash(&root);

    let mut projects = list_projects_locked(home)?;
    let stamp = now();
    if let Some(existing) = projects.iter_mut().find(|p| p.hash == hash) {
        existing.last_accessed_at = stamp;
        let found = existing.clone();
        save_projects(home, &projects)?;
        return Ok(found);
    }

    let project = Project {
        hash: hash.clone(),
        root,
        display_name: canonical
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| canonical.to_string_lossy().to_string()),
        created_at: stamp.clone(),
        last_accessed_at: stamp,
    };
    fs::create_dir_all(threads_dir(home, &hash)).map_err(|err| e("create project dir", err))?;
    write_json(&project_dir(home, &hash).join("project.json"), &project)?;
    projects.push(project.clone());
    save_projects(home, &projects)?;
    let removed = project_dir(home, &hash).join("removed");
    if removed.exists() {
        fs::remove_file(removed).map_err(|err| e("restore saved project", err))?;
    }
    Ok(project)
}

/// Forget a saved project without deleting source files, worktrees or history.
/// The marker distinguishes intentional removal from a lost project index.
pub fn remove_project(home: &Path, hash: &str) -> Res<()> {
    let _guard = lock_index();
    let mut projects = list_projects_locked(home)?;
    if !projects.iter().any(|p| p.hash == hash) {
        return Err(format!("unknown project: {hash}").into());
    }
    fs::write(project_dir(home, hash).join("removed"), b"")
        .map_err(|err| e("remove saved project", err))?;
    projects.retain(|p| p.hash != hash);
    save_projects(home, &projects)
}

fn update_project(home: &Path, hash: &str, f: impl FnOnce(&mut Project)) -> Res<Project> {
    let _guard = lock_index();
    let mut projects = list_projects_locked(home)?;
    let project = projects
        .iter_mut()
        .find(|p| p.hash == hash)
        .ok_or_else(|| format!("unknown project: {hash}"))?;
    f(project);
    let updated = project.clone();
    save_projects(home, &projects)?;
    write_json(&project_dir(home, hash).join("project.json"), &updated)?;
    Ok(updated)
}

/// Rename the display name only — `root` and the hash identity are untouched.
pub fn rename_project(home: &Path, hash: &str, display_name: &str) -> Res<Project> {
    update_project(home, hash, |p| p.display_name = display_name.to_string())
}

/// Mark a project as the one just switched to.
pub fn touch_project(home: &Path, hash: &str) -> Res<Project> {
    update_project(home, hash, |p| p.last_accessed_at = now())
}

// ----------------------------------------------------------------- threads

/// serde default for a bool that is `true` on records written before the
/// field existed.
fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ThreadMeta {
    pub id: String,
    pub project_hash: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    /// "spec" | "go" — the thread's *intent*: what a new session starts as and
    /// what the UI preselects. Enforcement is per session (D19), so this no
    /// longer describes what is running.
    pub current_mode: String,
    pub open_spec_change_name: Option<String>,
    /// Per-thread executor override (an ACP registry agent id). None means
    /// fall back to the project's `executorOverride`, then auto-detection.
    #[serde(default)]
    pub executor: Option<String>,
    /// Per-thread model choice (the agent's config-option value id). Only
    /// meaningful together with `executor`; None means the agent's default.
    #[serde(default)]
    pub model: Option<String>,
    /// The spec-type framing the user picked when entering spec-mode
    /// (Feature/Bugfix/custom text). Framing context for the agent's opening
    /// turn; re-injected on agent handoff (D11/D12). None on old records.
    #[serde(default)]
    pub spec_type: Option<String>,
    /// Archived threads stay on disk and stay readable — they just drop out
    /// of the default History list. Deleting is the destructive option and
    /// remains separate. Absent on older records, which are not archived.
    #[serde(default)]
    pub archived: bool,
    /// The git worktree this thread's sessions run in, and the branch it is
    /// checked out on. Created lazily on the thread's first session start, so
    /// `None` means "not created yet" — for a thread that has never run, and
    /// for every thread that predates worktree isolation. Also stays `None`
    /// for projects that aren't git repos, which run in the project root.
    #[serde(default)]
    pub worktree_path: Option<String>,
    #[serde(default)]
    pub worktree_branch: Option<String>,
    /// The branch the worktree was cut from, captured at creation — the
    /// branch "Merge to <base>" merges into. `None` on threads that predate
    /// merge-back; those fall back to whatever the project is on now, which
    /// the gate says out loud rather than guessing silently.
    #[serde(default)]
    pub worktree_base_branch: Option<String>,
    /// Bootstrap status is durable so Review can explain a failed setup after
    /// the background process and the app window have both gone away.
    #[serde(default)]
    pub worktree_setup_state: Option<String>,
    #[serde(default)]
    pub worktree_setup_output: Option<String>,
    /// When this thread's branch was last merged into its base by Palisade.
    /// A recorded fact, not an inference: "merged" in the sidebar means this
    /// merge happened, never that the diffs happen to look empty.
    #[serde(default)]
    pub merged_at: Option<String>,
    /// Whether the most recent Palisade merge explicitly bypassed the
    /// current-commit verification gate. Absent on older records.
    #[serde(default)]
    pub merge_overridden: bool,
    /// `false` when the user turned isolation off at thread creation: the
    /// thread's sessions run in the project root and it gets no merge, PR or
    /// prune step. Absent on older records, which all had worktrees.
    #[serde(default = "yes")]
    pub worktree_enabled: bool,
    /// Who owns `title`: "auto" means Palisade named it (or hasn't yet) and
    /// may rename it, "manual" means the user did and it is never touched
    /// again. Threads that predate auto-titling default to "manual" — they
    /// carry names their users typed, and renaming those would be theft.
    #[serde(default = "manual_title_source")]
    pub title_source: String,
    /// Set when this thread's last turn died on the executor's own
    /// "needs authentication" signal (ACP `auth_required`, or an agent's
    /// prose fallback) — the detail text, so the composer can warn before
    /// the next message is even typed instead of only after it fails again.
    /// Cleared on the thread's next successful turn.
    #[serde(default)]
    pub auth_blocked: Option<String>,
    /// When the user last looked at this thread. Set by `mark_thread_viewed`;
    /// the Fleet board uses it to stop asking for a turn already read.
    /// Absent on records written before viewing was tracked.
    #[serde(default)]
    pub last_viewed_at: Option<String>,
}

fn manual_title_source() -> String {
    "manual".to_string()
}
// `executorSessionId` used to live here. It was a provider-private resume
// handle on a provider-independent entity, and it was written unconditionally
// even for Codex, which never used it. It now lives on `SessionRecord`; the
// field is still tolerated on disk (serde ignores unknown keys) and is read
// exactly once, by `read_sessions`' legacy shim.

fn meta_path(home: &Path, hash: &str, id: &str) -> PathBuf {
    threads_dir(home, hash).join(format!("{id}.meta.json"))
}

fn log_path(home: &Path, hash: &str, id: &str) -> PathBuf {
    threads_dir(home, hash).join(format!("{id}.jsonl"))
}

/// Readable suffix of an `@thread:<id>::<slug>` mention. Mirrors `threadSlug`
/// in `src/mentions.ts`; the ID is what selects the transcript.
pub fn thread_slug(title: &str) -> String {
    title.split_whitespace().collect::<Vec<_>>().join("-")
}

/// `content` with a "Referenced chats" list appended for every
/// `@thread:<slug>` it mentions, pointing the agent at that thread's
/// transcript so it can read the whole conversation with its own tools.
/// Unknown slugs are left as typed. Nothing is copied into the prompt.
pub fn expand_thread_mentions(home: &Path, hash: &str, content: &str) -> String {
    let slugs: Vec<&str> = content
        .split_whitespace()
        .filter_map(|word| word.strip_prefix("@thread:"))
        .filter(|slug| !slug.is_empty())
        .collect();
    if slugs.is_empty() {
        return content.to_string();
    }
    let threads = list_threads(home, hash).unwrap_or_default();
    let mut lines = Vec::new();
    for slug in slugs {
        // Exact first: an auto-title can itself end in "..." — then without
        // the sentence punctuation typed after the mention ("@thread:x,").
        let bare = slug.trim_end_matches(|c: char| ".,;:!?)".contains(c));
        let found = slug.split_once("::")
            .and_then(|(id, _)| threads.iter().find(|t| t.id == id))
            // Older mentions only carried a title; keep those readable.
            .or_else(|| threads.iter().find(|t| thread_slug(&t.title) == slug))
            .or_else(|| threads.iter().find(|t| thread_slug(&t.title) == bare));
        if let Some(thread) = found {
            let line = format!("- {} → {}", thread.title, log_path(home, hash, &thread.id).display());
            if !lines.contains(&line) {
                lines.push(line);
            }
        }
    }
    if lines.is_empty() {
        return content.to_string();
    }
    format!("{content}\n\nReferenced chats (JSONL transcripts, one message per line):\n{}", lines.join("\n"))
}

pub fn create_thread(home: &Path, hash: &str, title: &str) -> Res<ThreadMeta> {
    let id = ulid::Ulid::new().to_string();
    let stamp = now();
    let meta = ThreadMeta {
        id: id.clone(),
        project_hash: hash.to_string(),
        title: if title.trim().is_empty() { "Untitled thread".into() } else { title.trim().into() },
        created_at: stamp.clone(),
        updated_at: stamp,
        current_mode: "spec".into(),
        open_spec_change_name: None,
        executor: None,
        model: None,
        spec_type: None,
        archived: false,
        worktree_path: None,
        worktree_branch: None,
        worktree_base_branch: None,
        worktree_setup_state: None,
        worktree_setup_output: None,
        merged_at: None,
        merge_overridden: false,
        worktree_enabled: true,
        // A brand new thread's title is a placeholder ("New thread"), not a
        // choice — the first turn replaces it.
        title_source: "auto".into(),
        auth_blocked: None,
        last_viewed_at: None,
    };
    fs::create_dir_all(threads_dir(home, hash)).map_err(|err| e("create threads dir", err))?;
    write_json(&meta_path(home, hash, &id), &meta)?;
    File::create(log_path(home, hash, &id)).map_err(|err| e("create session log", err))?;
    Ok(meta)
}

/// Removes both files that make up a thread. `list_threads` is scan-based
/// (globs `*.meta.json`), so there's no separate index to keep in sync.
/// Idempotent: an already-missing file is not an error.
pub fn delete_thread(home: &Path, hash: &str, id: &str) -> Res<()> {
    let remove = |path: PathBuf| -> Res<()> {
        match fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(e(&format!("delete {}", path.display()), err)),
        }
    };
    remove(meta_path(home, hash, id))?;
    remove(sessions_path(home, hash, id))?;
    remove(log_path(home, hash, id))
}

pub fn list_threads(home: &Path, hash: &str) -> Res<Vec<ThreadMeta>> {
    let dir = threads_dir(home, hash);
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(err) => return Err(e("read threads dir", err)),
    };
    let mut threads = vec![];
    for entry in entries.flatten() {
        let path = entry.path();
        if path.to_string_lossy().ends_with(".meta.json") {
            if let Ok(meta) = fs::read_to_string(&path).map_err(|err| e("read meta", err)).and_then(
                |s| serde_json::from_str::<ThreadMeta>(&s).map_err(|err| e("parse meta", err)),
            ) {
                threads.push(meta);
            }
        }
    }
    // ULIDs sort lexicographically by creation time; newest thread first.
    threads.sort_by(|a, b| b.id.cmp(&a.id));
    Ok(threads)
}

/// Serializes read-modify-write of a thread's `.meta.json`. Two windows can
/// show the same project (#33) and both edit the same thread — e.g. an
/// auto-title from one window's turn landing while the other renames it —
/// so this needs the same lock-around-the-whole-RMW treatment as the project
/// index, not just the atomic write `write_json` already gives the file.
static THREAD_LOCK: Mutex<()> = Mutex::new(());

fn update_thread(home: &Path, hash: &str, id: &str, f: impl FnOnce(&mut ThreadMeta)) -> Res<ThreadMeta> {
    let _guard = THREAD_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let path = meta_path(home, hash, id);
    let body = fs::read_to_string(&path).map_err(|err| e(&format!("unknown thread {id}"), err))?;
    let mut meta: ThreadMeta = serde_json::from_str(&body).map_err(|err| e("parse meta", err))?;
    f(&mut meta);
    meta.updated_at = now();
    write_json(&path, &meta)?;
    Ok(meta)
}

/// Renaming by hand is how a user takes ownership of the title: auto-titling
/// never touches it again.
pub fn rename_thread(home: &Path, hash: &str, id: &str, title: &str) -> Res<ThreadMeta> {
    update_thread(home, hash, id, |m| {
        m.title = title.trim().to_string();
        m.title_source = "manual".into();
    })
}

/// The names Palisade gives a thread before it knows what it is about. Only
/// a title still sitting at one of these is Palisade's to replace.
const PLACEHOLDER_TITLES: [&str; 2] = ["New thread", "Untitled thread"];

/// Whether Palisade, rather than the user, chose the name a thread currently
/// carries. A name the user typed is never overwritten.
fn palisade_owns_title(m: &ThreadMeta) -> bool {
    m.title_source == "auto"
}

/// Whether a thread still carries a placeholder name Palisade may replace —
/// i.e. whether [`set_auto_title`] would change anything.
pub fn needs_auto_title(m: &ThreadMeta) -> bool {
    palisade_owns_title(m) && PLACEHOLDER_TITLES.contains(&m.title.as_str())
}

/// Name a thread after the turn that opened it, so the user never has to.
///
/// Fires once, on the first turn: a thread already named — by an earlier turn
/// or by the user — keeps that name, or every prompt would rename the thread
/// out from under whoever was reading the list.
/// `generated` is the model's title when one was available; the trimmed
/// prompt stands in when it wasn't, so a thread is always named.
pub fn set_auto_title(
    home: &Path,
    hash: &str,
    id: &str,
    prompt: &str,
    generated: Option<&str>,
) -> Res<()> {
    let Some(title) = generated.map(str::to_string).or_else(|| derive_title(prompt)) else {
        return Ok(());
    };
    update_thread(home, hash, id, |m| {
        if needs_auto_title(m) {
            m.title = title;
        }
    })?;
    Ok(())
}

/// Replace an auto-generated title with a better one — the agent's answer
/// arriving after the local model declined, or after the truncated first line
/// went up as a placeholder.
///
/// Only touches titles Palisade owns: a name the user typed is never
/// overwritten, however late a better suggestion turns up.
pub fn upgrade_auto_title(home: &Path, hash: &str, id: &str, title: &str) -> Res<()> {
    update_thread(home, hash, id, |m| {
        if palisade_owns_title(m) {
            m.title = title.to_string();
            m.title_source = "auto".into();
        }
    })?;
    Ok(())
}

/// A thread title from the turn that started it: the first real line, cut to
/// something that fits a sidebar row.
///
/// `None` when there is nothing worth showing — the title stays the
/// placeholder rather than becoming a worse name than "New thread".
pub fn derive_title(prompt: &str) -> Option<String> {
    let line = prompt
        .lines()
        // Skip quoted context and headings pasted above the actual request.
        .map(|l| l.trim().trim_start_matches(['#', '>', '-', '*', ' ']))
        .find(|l| !l.is_empty())?;
    let mut title = String::new();
    for word in line.split_whitespace() {
        // Cut on a word boundary, but never produce an empty title from one
        // very long first word.
        if !title.is_empty() && title.len() + 1 + word.len() > 48 {
            title.push('…');
            break;
        }
        if !title.is_empty() {
            title.push(' ');
        }
        title.push_str(word);
    }
    let mut chars = title.chars();
    let first = chars.next()?;
    Some(first.to_uppercase().collect::<String>() + chars.as_str())
}

/// Archive (or unarchive) a thread. Nothing is deleted: the log, the
/// sessions and the metadata all stay exactly where they were.
pub fn set_thread_archived(home: &Path, hash: &str, id: &str, archived: bool) -> Res<ThreadMeta> {
    update_thread(home, hash, id, |m| m.archived = archived)
}

/// Record that the user has looked at this thread just now. Idempotent:
/// calling it again only advances the timestamp.
pub fn mark_thread_viewed(home: &Path, hash: &str, id: &str) -> Res<ThreadMeta> {
    let stamp = now();
    update_thread(home, hash, id, |m| m.last_viewed_at = Some(stamp))
}

/// Record the worktree a thread's sessions run in. Written once, by the
/// thread's first session start; later starts read it back and reuse it.
pub fn set_thread_worktree(
    home: &Path,
    hash: &str,
    id: &str,
    path: &str,
    branch: &str,
    base: &str,
) -> Res<ThreadMeta> {
    update_thread(home, hash, id, |m| {
        m.worktree_path = Some(path.to_string());
        m.worktree_branch = Some(branch.to_string());
        m.worktree_base_branch = Some(base.to_string());
    })
}

/// Forget a thread's worktree after it has been pruned off disk. The branch
/// name stays recorded on purpose — it is how a pruned-but-unmerged thread
/// can still say which branch its work is on.
pub fn clear_thread_worktree(home: &Path, hash: &str, id: &str) -> Res<ThreadMeta> {
    update_thread(home, hash, id, |m| m.worktree_path = None)
}

pub fn set_thread_worktree_setup(home: &Path, hash: &str, id: &str, state: &str, output: Option<String>) -> Res<ThreadMeta> {
    update_thread(home, hash, id, |m| {
        m.worktree_setup_state = Some(state.to_string());
        m.worktree_setup_output = output;
    })
}

/// Record that this thread's branch landed on its base, when, and whether the
/// user explicitly bypassed verification.
pub fn set_thread_merged(
    home: &Path,
    hash: &str,
    id: &str,
    overridden: bool,
) -> Res<ThreadMeta> {
    update_thread(home, hash, id, |m| {
        m.merged_at = Some(now());
        m.merge_overridden = overridden;
    })
}

/// Whether this thread runs in its own worktree. Set once, at creation, and
/// locked by the UI after the first message.
pub fn set_thread_worktree_enabled(home: &Path, hash: &str, id: &str, on: bool) -> Res<ThreadMeta> {
    update_thread(home, hash, id, |m| m.worktree_enabled = on)
}

/// Link a thread to the OpenSpec change `/propose` created for it.
pub fn set_open_spec_change(home: &Path, hash: &str, id: &str, change: Option<&str>) -> Res<ThreadMeta> {
    update_thread(home, hash, id, |m| {
        m.open_spec_change_name = change.map(str::to_string)
    })
}

/// Set the thread's executor (and optionally model) preference. Both are
/// per-thread overrides: `None` falls back to the project default, then
/// auto-detection. No process is spawned here — the next session start
/// picks the change up, and `ensure_session` restarts a live session whose
/// agent no longer matches.
pub fn set_thread_executor(
    home: &Path,
    hash: &str,
    id: &str,
    executor: Option<&str>,
    model: Option<&str>,
) -> Res<ThreadMeta> {
    update_thread(home, hash, id, |m| {
        m.executor = executor.map(str::to_string);
        m.model = model.map(str::to_string);
    })
}

/// Record (or clear, with `None`) the thread's auth-blocked state (see
/// `ThreadMeta::auth_blocked`). Not a session-log entry: this is transient
/// "is the next turn likely to fail" status, not a durable turn outcome.
pub fn set_thread_auth_blocked(
    home: &Path,
    hash: &str,
    id: &str,
    detail: Option<&str>,
) -> Res<ThreadMeta> {
    update_thread(home, hash, id, |m| {
        m.auth_blocked = detail.map(str::to_string);
    })
}

/// Persist the spec-type framing on the thread (D11). Stored as `spec_type`
/// on `ThreadMeta`; survives mode switches and app restarts. Re-injected on
/// agent handoff (D12). Called by `spec_mode` when the user commits to a
/// spec type.
pub fn set_spec_type(home: &Path, hash: &str, id: &str, spec_type: &str) -> Res<ThreadMeta> {
    // Naming is deliberately not done here. A spec thread is named the same
    // way every other thread is — agent title, else the local model, else the
    // first line of what the user asked for — because "Feature" is the same
    // row for every feature the user ever specs (#30/#35). `spec_mode` runs
    // that chain over the user's request.
    update_thread(home, hash, id, |m| {
        m.spec_type = Some(spec_type.to_string());
    })
}

/// Flip a thread between "spec" and "go": persist the new mode and append one
/// `role: "tool"` marker to the session log. No process is spawned here.
pub fn set_thread_mode(home: &Path, hash: &str, id: &str, mode: &str) -> Res<ThreadMeta> {
    if mode != "spec" && mode != "go" {
        return Err(format!("invalid mode: {mode}").into());
    }
    let meta = update_thread(home, hash, id, |m| m.current_mode = mode.to_string())?;
    append_message(home, hash, id, "tool", mode, &format!("Switched to {mode} mode"), None)?;
    Ok(meta)
}

// ---------------------------------------------------------------- sessions

/// One run of one agent against one thread. Appended twice — once open, once
/// closed — to `<ulid>.sessions.jsonl`; the later row for an id wins, so the
/// log stays append-only and a torn close can never lose the open.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecord {
    pub id: String,
    pub thread_id: String,
    pub project_hash: String,
    /// Which agent ran — `"claude"`, `"codex"`, …
    pub agent_id: String,
    /// "spec" | "go" — the flag this session actually ran under.
    pub mode: String,
    /// The agent's own conversation handle. Provider-private: a Claude UUID
    /// means nothing to Codex, so it is only ever reused by the same agent.
    #[serde(default)]
    pub provider_handle: Option<String>,
    pub started_at: String,
    #[serde(default)]
    pub ended_at: Option<String>,
    /// "done" | "crashed" | "cancelled" | "interrupted"; `None` while live.
    #[serde(default)]
    pub outcome: Option<String>,
    #[serde(default)]
    pub git_head_before: Option<String>,
    #[serde(default)]
    pub git_head_after: Option<String>,
    /// Paths already dirty when the session opened. The *delta* against the
    /// tree now is what this session left uncommitted — exact only while no
    /// other session shares the root, which is why attribution carries its own
    /// ambiguity flag (D13).
    #[serde(default)]
    pub dirty_before: Option<Vec<String>>,
}

fn sessions_path(home: &Path, hash: &str, id: &str) -> PathBuf {
    threads_dir(home, hash).join(format!("{id}.sessions.jsonl"))
}

fn append_session(home: &Path, record: &SessionRecord) -> Res<()> {
    let path = sessions_path(home, &record.project_hash, &record.thread_id);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| e("create thread dir", err))?;
    }
    let line = serde_json::to_string(record).map_err(|err| e("serialize session", err))?;
    let writer = crate::session_log_writer::shared_session_log_writer();
    // Recover a poisoned writer the way `flush_shared` does: one panic in
    // an earlier append must not stop every later turn from persisting.
    let mut guard = writer.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    guard.append(&path, line.as_bytes()).map_err(|err| e("append session", err))
}

/// Record a session starting. The returned record is what `close_session`
/// later amends.
#[allow(clippy::too_many_arguments)]
pub fn open_session(
    home: &Path,
    hash: &str,
    thread_id: &str,
    id: &str,
    agent_id: &str,
    mode: &str,
    provider_handle: Option<&str>,
    git_head_before: Option<&str>,
    dirty_before: Option<Vec<String>>,
) -> Res<SessionRecord> {
    let record = SessionRecord {
        id: id.to_string(),
        thread_id: thread_id.to_string(),
        project_hash: hash.to_string(),
        agent_id: agent_id.to_string(),
        mode: mode.to_string(),
        provider_handle: provider_handle.map(str::to_string),
        started_at: now(),
        ended_at: None,
        outcome: None,
        git_head_before: git_head_before.map(str::to_string),
        git_head_after: None,
        dirty_before,
    };
    append_session(home, &record)?;
    Ok(record)
}

/// Record a session ending. Appends an amended copy rather than rewriting the
/// open row — closing an already-closed session is a no-op, so a crash
/// followed by a terminate can't overwrite the real cause.
pub fn close_session(
    home: &Path,
    hash: &str,
    thread_id: &str,
    id: &str,
    outcome: &str,
    git_head_after: Option<&str>,
) -> Res<Option<SessionRecord>> {
    // The matching open record may still be in the process-global buffer; flush
    // before reading so close_session can amend the record it opened.
    flush_session_log_writer()?;
    let Some(mut record) = read_sessions(home, hash, thread_id)?.into_iter().find(|r| r.id == id)
    else {
        return Ok(None);
    };
    if record.ended_at.is_some() {
        return Ok(Some(record));
    }
    record.ended_at = Some(now());
    record.outcome = Some(outcome.to_string());
    record.git_head_after = git_head_after.map(str::to_string);
    append_session(home, &record)?;
    Ok(Some(record))
}

/// Every session ever run against a thread, oldest first. The last row for an
/// id wins. A thread with no session log but a legacy `executorSessionId` on
/// its sidecar yields exactly one synthesized closed record (see below).
pub fn read_sessions(home: &Path, hash: &str, thread_id: &str) -> Res<Vec<SessionRecord>> {
    let path = sessions_path(home, hash, thread_id);
    let body = match fs::read_to_string(&path) {
        Ok(body) => body,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Ok(legacy_session(home, hash, thread_id).into_iter().collect())
        }
        Err(err) => return Err(e("read session log", err)),
    };

    let mut records: Vec<SessionRecord> = vec![];
    let mut offset = 0usize;
    for line in body.split_inclusive('\n') {
        let trimmed = line.trim_end_matches('\n');
        if !trimmed.trim().is_empty() {
            match serde_json::from_str::<SessionRecord>(trimmed) {
                Ok(record) => match records.iter_mut().find(|r| r.id == record.id) {
                    Some(existing) => *existing = record,
                    None => records.push(record),
                },
                Err(_) => log_corrupt_line(home, thread_id, offset),
            }
        }
        offset += line.len();
    }
    Ok(records)
}

/// Threads written before sessions existed carry the executor's handle on
/// their sidecar. `ensure_session` wrote that field unconditionally, including
/// for Codex — which never used it — so only Claude can consume such a handle,
/// and attributing it to Claude is the one reading that doesn't fabricate a
/// resumable session for an agent that never had one.
fn legacy_session(home: &Path, hash: &str, thread_id: &str) -> Option<SessionRecord> {
    let body = fs::read_to_string(meta_path(home, hash, thread_id)).ok()?;
    let meta: serde_json::Value = serde_json::from_str(&body).ok()?;
    let handle = meta.get("executorSessionId")?.as_str()?.to_string();
    let stamp = meta
        .get("updatedAt")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map_or_else(now, str::to_string);
    Some(SessionRecord {
        id: format!("legacy-{thread_id}"),
        thread_id: thread_id.to_string(),
        project_hash: hash.to_string(),
        agent_id: "claude".into(),
        mode: meta.get("currentMode").and_then(|v| v.as_str()).unwrap_or("spec").to_string(),
        provider_handle: Some(handle),
        started_at: stamp.clone(),
        ended_at: Some(stamp),
        outcome: Some("interrupted".into()),
        git_head_before: None,
        git_head_after: None,
        dirty_before: None,
    })
}

/// No process survives an app restart, so any record still open whose session
/// isn't in the live set was interrupted. Called from the read path rather
/// than a startup sweep: the invariant holds continuously, not just at launch,
/// and a thread nobody opens costs nothing.
pub fn close_stale_sessions(home: &Path, hash: &str, thread_id: &str, live: &[String]) -> Res<Vec<SessionRecord>> {
    for record in read_sessions(home, hash, thread_id)? {
        if record.ended_at.is_none() && !live.contains(&record.id) {
            close_session(home, hash, thread_id, &record.id, "interrupted", None)?;
        }
    }
    // The close records were buffered; flush before re-reading the log so the
    // returned set reflects the updated state.
    flush_session_log_writer()?;
    read_sessions(home, hash, thread_id)
}

// ----------------------------------------------------------- verification

/// One run of one verify command. The whole point of this record: a spec is
/// never complete because a model said so — it is green because a named
/// command exited 0 at a named commit (D3). Nothing here is a judgement; the
/// exit code is reported as-is and rendered as-is.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VerificationRun {
    pub id: String,
    pub project_hash: String,
    #[serde(default)]
    pub thread_id: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    /// The key from `.palisade/project-settings.json`'s `verify` map.
    pub name: String,
    pub command: String,
    pub exit_code: i32,
    pub output_tail: String,
    #[serde(default)]
    pub git_head: Option<String>,
    pub at: String,
    /// Per-test results parsed out of `output_tail`, when the output came
    /// from a recognised runner. Strictly a *view* of this run — the exit
    /// code above stays the evidence, and a green explorer is never a claim
    /// that a spec is satisfied (D3). Defaulted so runs recorded before the
    /// test explorer existed still parse.
    #[serde(default)]
    pub tests: Option<crate::test_parse::TestReport>,
}

fn verify_path(home: &Path, hash: &str) -> PathBuf {
    project_dir(home, hash).join("verify.jsonl")
}

pub fn append_verification(home: &Path, run: &VerificationRun) -> Res<VerificationRun> {
    let path = verify_path(home, &run.project_hash);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| e("create project dir", err))?;
    }
    let line = serde_json::to_string(run).map_err(|err| e("serialize verification", err))?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|err| e(&format!("open {}", path.display()), err))?;
    if !ends_with_newline(&path)? {
        file.write_all(b"\n").map_err(|err| e("close torn line", err))?;
    }
    file.write_all(line.as_bytes()).map_err(|err| e("append verification", err))?;
    file.write_all(b"\n").map_err(|err| e("append newline", err))?;
    file.sync_all().map_err(|err| e("fsync verify log", err))?;
    Ok(run.clone())
}

/// Every verification run for a project, oldest first.
pub fn read_verifications(home: &Path, hash: &str) -> Res<Vec<VerificationRun>> {
    let path = verify_path(home, hash);
    let body = match fs::read_to_string(&path) {
        Ok(body) => body,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(err) => return Err(e("read verify log", err)),
    };
    let mut runs = vec![];
    let mut offset = 0usize;
    for line in body.split_inclusive('\n') {
        let trimmed = line.trim_end_matches('\n');
        if !trimmed.trim().is_empty() {
            match serde_json::from_str::<VerificationRun>(trimmed) {
                Ok(run) => runs.push(run),
                Err(_) => log_corrupt_line(home, hash, offset),
            }
        }
        offset += line.len();
    }
    Ok(runs)
}

// ------------------------------------------------------------- breakpoints

fn breakpoints_path(home: &Path, hash: &str) -> PathBuf {
    project_dir(home, hash).join("breakpoints.json")
}

/// Every breakpoint the user has set in a project, keyed by project-relative
/// path.
///
/// Persisted, and deliberately: a breakpoint you have to re-place on every
/// launch is a breakpoint you stop using. Survives both a debug-session
/// restart and an app restart, and is not tied to a thread or a worktree —
/// breakpoints belong to the code, not to a run of it.
pub type BreakpointsByFile = std::collections::BTreeMap<String, Vec<crate::dap::Breakpoint>>;

pub fn read_breakpoints(home: &Path, hash: &str) -> Res<BreakpointsByFile> {
    let mut stored: BreakpointsByFile = read_json(&breakpoints_path(home, hash))?;
    // `verified` / `actualLine` describe what one adapter said in one
    // session, about a build that no longer exists. Reading them back as
    // still-true would show a green, confidently-placed breakpoint for code
    // that has been edited and never re-launched. Only what the user set —
    // the file, the line, the condition, whether it's enabled — survives.
    for breakpoints in stored.values_mut() {
        for breakpoint in breakpoints.iter_mut() {
            breakpoint.verified = None;
            breakpoint.actual_line = None;
            breakpoint.message = None;
        }
    }
    Ok(stored)
}

pub fn write_breakpoints(home: &Path, hash: &str, breakpoints: &BreakpointsByFile) -> Res<()> {
    // Files whose last breakpoint was removed are dropped rather than kept
    // as empty arrays, so the file doesn't grow forever with dead paths.
    let live: BreakpointsByFile = breakpoints
        .iter()
        .filter(|(_, list)| !list.is_empty())
        .map(|(path, list)| (path.clone(), list.clone()))
        .collect();
    write_json(&breakpoints_path(home, hash), &live)
}

// --------------------------------------------------------- session storage

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Message {
    pub seq: u64,
    pub ts: String,
    /// "user" | "assistant" | "system" | "tool"
    pub role: String,
    /// "spec" | "go" — the mode active when the message was written
    pub mode: String,
    pub content: String,
    /// Which session produced this message. Defaulted so rows written before
    /// sessions had identities still parse; `None` means "written by a build
    /// that had no session id to record", never "no session".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// ACP failure classification, if the producing build had structured data.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure_class: Option<crate::acp_client::FailureClass>,
    /// Images attached to a user turn: stored copies under the project's
    /// `attachments/` dir, so the history keeps showing them. Defaulted so
    /// every row written before attachments existed still parses.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<String>,
}

/// Next `seq` per log path, alongside the file length it was computed at.
/// Appending used to re-read the whole log every time (O(n) per append, O(n²)
/// per thread). The recorded length is the validity check: if anything other
/// than this process's own appends changed the file, the entry is stale and
/// the seq is recomputed from disk.
static SEQ_CACHE: Mutex<Option<HashMap<PathBuf, (u64, u64)>>> = Mutex::new(None);

/// A log's in-memory buffer is flushed once it passes this, not only at turn
/// end (D9): a turn that streams for hours would otherwise hold — and lose to a
/// crash — everything it emitted. 1 MiB is a few hundred messages.
const BUFFER_FLUSH_BYTES: u64 = 1024 * 1024;

pub(crate) fn file_len(path: &Path) -> u64 {
    fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

/// Append one JSON line to the thread's log. The write is buffered in-process
/// and only flushed + fsynced when a turn ends or the app quits (D9).
#[allow(clippy::too_many_arguments)]
pub fn append_message(
    home: &Path,
    hash: &str,
    id: &str,
    role: &str,
    mode: &str,
    content: &str,
    session_id: Option<&str>,
) -> Res<Message> {
    append_message_with_failure_class(home, hash, id, role, mode, content, session_id, None)
}

#[allow(clippy::too_many_arguments)]
pub fn append_message_with_failure_class(
    home: &Path,
    hash: &str,
    id: &str,
    role: &str,
    mode: &str,
    content: &str,
    session_id: Option<&str>,
    failure_class: Option<crate::acp_client::FailureClass>,
) -> Res<Message> {
    append_row(home, hash, id, role, mode, content, session_id, failure_class, Vec::new())
}

/// A user turn that carries attached images.
pub fn append_user_message(
    home: &Path,
    hash: &str,
    id: &str,
    mode: &str,
    content: &str,
    attachments: Vec<String>,
) -> Res<Message> {
    append_row(home, hash, id, "user", mode, content, None, None, attachments)
}

#[allow(clippy::too_many_arguments)]
fn append_row(
    home: &Path,
    hash: &str,
    id: &str,
    role: &str,
    mode: &str,
    content: &str,
    session_id: Option<&str>,
    failure_class: Option<crate::acp_client::FailureClass>,
    attachments: Vec<String>,
) -> Res<Message> {
    let path = log_path(home, hash, id);

    let (message, over_threshold) = {
        // Lock the writer first so no other thread can change the buffered byte
        // count while we compute the next seq and append.
        let writer = crate::session_log_writer::shared_session_log_writer();
        let mut writer = writer.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let expected_len = writer.disk_len(&path) + writer.buffered_len(&path);
        let mut cache = SEQ_CACHE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let cache = cache.get_or_insert_with(HashMap::new);
        let NextLine { seq, torn_newline_len } = next_line(&writer, &path, cache, expected_len)?;
        let message = Message {
            seq,
            ts: now(),
            role: role.to_string(),
            mode: mode.to_string(),
            content: content.to_string(),
            session_id: session_id.map(str::to_string),
            failure_class,
            attachments,
        };
        let line = serde_json::to_string(&message).map_err(|err| e("serialize message", err))?;

        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|err| e("create thread dir", err))?;
        }
        writer
            .append(&path, line.as_bytes())
            .map_err(|err| e("append message", err))?;
        // Update the seq cache with the expected on-disk length after the next flush.
        cache.insert(path.clone(), (expected_len + torn_newline_len + line.len() as u64 + 1, seq + 1));
        (message, writer.buffered_len(&path) >= BUFFER_FLUSH_BYTES)
    };
    // With the locks released: the fsync must never stall another session's append.
    if over_threshold {
        crate::session_log_writer::flush_shared(Some(&path), false)?;
    }
    Ok(message)
}

/// Where an appended line lands: its seq, and the byte a flush adds first to
/// close a torn tail (0 or 1).
struct NextLine {
    seq: u64,
    torn_newline_len: u64,
}

/// Resolve [`NextLine`] for `path` while `append_message` holds the writer
/// lock. A seq-cache hit (`expected_len` matches what our own appends left) is
/// pure arithmetic and never torn. Only a miss reads the file — the one disk
/// read an append makes under the lock, so it must stay the cold path.
fn next_line(
    writer: &crate::session_log_writer::SessionLogWriter,
    path: &Path,
    cache: &HashMap<PathBuf, (u64, u64)>,
    expected_len: u64,
) -> Res<NextLine> {
    if let Some(&(_, seq)) = cache.get(path).filter(|(len, _)| *len == expected_len) {
        return Ok(NextLine { seq, torn_newline_len: 0 });
    }
    // Only the newest line is needed, not the whole history.
    let (disk_len, tail) = writer.view(path);
    let seq = newest_tip(path, disk_len, &tail, |_| true).map_or(0, |tip| tip.seq + 1);
    let torn_newline_len = u64::from(!ends_with_newline_upto(path, disk_len)?);
    Ok(NextLine { seq, torn_newline_len })
}

/// Flush the process-global session log writer. Tests should call this before
/// reading back recently appended rows; production flushes on turn-done and
/// app-quit.
pub fn flush_session_log_writer() -> Res<()> {
    crate::session_log_writer::flush_shared(None, true)
}

pub(crate) fn ends_with_newline(path: &Path) -> Res<bool> {
    ends_with_newline_upto(path, u64::MAX)
}

/// Whether the first `len` bytes of the file (or all of it, if shorter) end in
/// a newline. Bytes past `len` may be a flush still being written.
fn ends_with_newline_upto(path: &Path, len: u64) -> Res<bool> {
    use std::io::{Seek, SeekFrom};
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(true),
        Err(err) => return Err(e("open session log", err)),
    };
    let len = file.seek(SeekFrom::End(0)).map_err(|err| e("seek session log", err))?.min(len);
    if len == 0 {
        return Ok(true);
    }
    file.seek(SeekFrom::Start(len - 1)).map_err(|err| e("seek session log", err))?;
    let mut last = [0u8; 1];
    file.read_exact(&mut last).map_err(|err| e("read session log", err))?;
    Ok(last[0] == b'\n')
}

/// One consistent view of a thread's log that a reader can use *without*
/// holding the writer lock. The log is append-only and only `flush` writes it
/// (under that lock), so once `file_len` and the buffered tail are captured
/// together, the first `file_len` bytes of the file never change — the reader
/// can take as long as it likes on file I/O without stalling any session's
/// append, and cannot see the same line both on disk and in `buffered`.
struct LogSnapshot {
    file_len: u64,
    buffered: Vec<u8>,
}

fn snapshot(path: &Path) -> Res<LogSnapshot> {
    let writer = crate::session_log_writer::shared_session_log_writer();
    let writer = writer.lock().map_err(|err| e("session log writer", err))?;
    let (file_len, buffered) = writer.view(path);
    Ok(LogSnapshot { file_len, buffered })
}

/// Read a thread's history in `seq` order. A line that fails to parse — a torn
/// write from an unclean shutdown — is dropped and logged to `harness.log`
/// rather than surfaced to the user. Unflushed bytes still held in the
/// process-global `SessionLogWriter` buffer are merged with disk so a read
/// mid-turn (before `Done` flushes) sees the same view `append_message` just
/// wrote — the user's turn and any buffered assistant events.
pub fn read_thread(home: &Path, hash: &str, id: &str) -> Res<Vec<Message>> {
    let snap = snapshot(&log_path(home, hash, id))?;
    read_thread_impl(home, hash, id, Some(snap.file_len), &snap.buffered)
}

/// True until the thread's first message. Does not parse the log.
pub fn thread_is_empty(home: &Path, hash: &str, id: &str) -> Res<bool> {
    let snap = snapshot(&log_path(home, hash, id))?;
    Ok(snap.file_len == 0 && snap.buffered.is_empty())
}

/// Which slice of a thread `read_thread_window` returns.
#[derive(Clone, Copy, Debug)]
pub enum Window {
    /// The newest `limit` messages, optionally only those older than `before_seq`
    /// (the "load earlier" page).
    Last { before_seq: Option<u64>, limit: usize },
    /// Every message with `seq >= from_seq` (an incremental refresh).
    From(u64),
}

/// First bytes read from the end of a log; a window grows 4x until it holds
/// what was asked for, so cost tracks the slice, not the thread's length.
const WINDOW_START_BYTES: u64 = 256 * 1024;

/// First bytes `last_activity` reads: a few messages, so almost always one read.
const TAIL_START_BYTES: u64 = 16 * 1024;

/// Read part of a thread by reading only the tail of its log. Same view and
/// same lock-free guarantee as `read_thread`, but a 50 MB thread opens as fast
/// as a 50 KB one.
pub fn read_thread_window(home: &Path, hash: &str, id: &str, window: Window) -> Res<Vec<Message>> {
    let path = log_path(home, hash, id);
    let snap = snapshot(&path)?;
    let mut span = WINDOW_START_BYTES;
    loop {
        let start = snap.file_len.saturating_sub(span);
        let mut messages = parse_log(home, id, tail_text(&path, start, snap.file_len)?, &snap.buffered);
        // The window is a suffix of the log, so anything outside it is older
        // than everything inside: these tests are exact, not heuristic.
        let done = match window {
            Window::From(from) => messages.first().is_some_and(|m| m.seq <= from),
            Window::Last { before_seq, limit } => {
                messages.iter().filter(|m| before_seq.is_none_or(|b| m.seq < b)).count() >= limit
            }
        };
        if !done && start > 0 {
            span = span.saturating_mul(4);
            continue;
        }
        match window {
            Window::From(from) => messages.retain(|m| m.seq >= from),
            Window::Last { before_seq, limit } => {
                messages.retain(|m| before_seq.is_none_or(|b| m.seq < b));
                let excess = messages.len().saturating_sub(limit);
                messages.drain(..excess);
            }
        }
        return Ok(messages);
    }
}

/// `[start, end)` of a log as text, dropping the partial line a mid-file
/// `start` lands in. A missing file is an empty log.
fn tail_text(path: &Path, start: u64, end: u64) -> Res<String> {
    let mut bytes = read_log_bytes(path, start, end)?;
    if start > 0 {
        let cut = bytes.iter().position(|b| *b == b'\n').map_or(bytes.len(), |i| i + 1);
        bytes.drain(..cut);
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn read_log_bytes(path: &Path, start: u64, end: u64) -> Res<Vec<u8>> {
    use std::io::{Seek, SeekFrom};
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(err) => return Err(e("open session log", err)),
    };
    file.seek(SeekFrom::Start(start)).map_err(|err| e("seek session log", err))?;
    let mut bytes = vec![];
    file.take(end.saturating_sub(start)).read_to_end(&mut bytes).map_err(|err| e("read session log", err))?;
    Ok(bytes)
}

/// When the thread last did something: the time of its newest message.
/// `updated_at` cannot say this — it is stamped by every metadata write, so
/// merely opening a thread moves it to "just now". `None` for a thread that
/// has never spoken.
///
/// Reads the log's tail, not the whole log: the fleet board asks this for
/// every thread on every refresh. The newest line is the newest message
/// because `seq` only ever grows by appending.
pub fn last_activity(home: &Path, hash: &str, id: &str) -> Option<String> {
    let path = log_path(home, hash, id);
    let snap = snapshot(&path).ok()?;
    newest_tip(&path, snap.file_len, &snap.buffered, |_| true).map(|tip| tip.ts)
}

/// When the agent last said something in this thread: the newest message
/// that is not the user's own. This is the moment a turn "finished" for the
/// Fleet board's Unreviewed band. A session record's `ended_at` is not: an
/// idle session stays open until the app quits, so it would read as "never
/// finished" all day and then as "finished after you last looked" for every
/// thread on the next launch.
pub fn last_agent_activity(home: &Path, hash: &str, id: &str) -> Option<String> {
    let path = log_path(home, hash, id);
    let snap = snapshot(&path).ok()?;
    newest_tip(&path, snap.file_len, &snap.buffered, |tip| tip.role != "user").map(|tip| tip.ts)
}

/// The fields of a message that say where a log has got to.
#[derive(Deserialize)]
struct Tip {
    seq: u64,
    ts: String,
    #[serde(default)]
    role: String,
}

/// The newest whole message line of a log, without parsing the rest of it: the
/// unwritten `tail` first, then the file's last `disk_len` bytes, reading
/// further back only when the last line is longer than what has been read. A
/// torn final line is skipped for the newest whole one.
fn newest_tip(path: &Path, disk_len: u64, tail: &[u8], want: impl Fn(&Tip) -> bool) -> Option<Tip> {
    let newest = |text: &str| {
        text.lines()
            .rev()
            .find_map(|line| serde_json::from_str::<Tip>(line).ok().filter(&want))
    };
    if let Some(tip) = newest(&String::from_utf8_lossy(tail)) {
        return Some(tip);
    }
    let mut span = TAIL_START_BYTES;
    loop {
        let start = disk_len.saturating_sub(span);
        if let Some(tip) = newest(&tail_text(path, start, disk_len).ok()?) {
            return Some(tip);
        }
        if start == 0 {
            return None;
        }
        span = span.saturating_mul(4);
    }
}

/// Inner reader that takes the buffered bytes directly, so callers already
/// holding the writer lock (e.g. `append_message`'s seq-cache fallback) can
/// read without re-locking and deadlocking. `limit` caps how much of the file
/// is read: lock-free callers pass their snapshot's length, lock-holding
/// callers pass `None` (nothing can flush while they hold the lock).
fn read_thread_impl(home: &Path, hash: &str, id: &str, limit: Option<u64>, buffered: &[u8]) -> Res<Vec<Message>> {
    let bytes = read_log_bytes(&log_path(home, hash, id), 0, limit.unwrap_or(u64::MAX))?;
    let body = String::from_utf8(bytes).map_err(|err| e("read session log", err))?;
    Ok(parse_log(home, id, body, buffered))
}

/// Merge unflushed buffered writes into `body`, parse every line, order by seq.
/// If the on-disk content doesn't end with a newline, insert one so the first
/// buffered line isn't glued to a torn tail — the same separator `flush`
/// inserts when it writes.
fn parse_log(home: &Path, id: &str, mut body: String, buffered: &[u8]) -> Vec<Message> {
    if !buffered.is_empty() {
        if !body.is_empty() && !body.ends_with('\n') {
            body.push('\n');
        }
        body.push_str(&String::from_utf8_lossy(buffered));
    }

    let mut messages = vec![];
    let mut offset = 0usize;
    for line in body.split_inclusive('\n') {
        let trimmed = line.trim_end_matches('\n');
        if !trimmed.trim().is_empty() {
            match serde_json::from_str::<Message>(trimmed) {
                Ok(message) => messages.push(message),
                Err(_) => log_corrupt_line(home, id, offset),
            }
        }
        offset += line.len();
    }
    messages.sort_by_key(|m| m.seq);
    messages
}

fn log_corrupt_line(home: &Path, thread_id: &str, offset: usize) {
    let _ = fs::create_dir_all(home);
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(home.join("harness.log")) {
        let _ = writeln!(
            file,
            "{} dropped unparseable line in thread {} at byte offset {}",
            now(),
            thread_id,
            offset
        );
    }
}

// ------------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;

    // --------------------------------------------------------- breakpoints

    #[test]
    fn breakpoints_survive_a_restart() {
        let home = tempfile::tempdir().unwrap();
        let mut set = BreakpointsByFile::new();
        set.insert(
            "src/lib.rs".into(),
            vec![
                crate::dap::Breakpoint::new("src/lib.rs", 9),
                crate::dap::Breakpoint {
                    condition: Some("i > 3".into()),
                    ..crate::dap::Breakpoint::new("src/lib.rs", 22)
                },
            ],
        );
        write_breakpoints(home.path(), "p1", &set).unwrap();

        // A fresh read is what the next launch of the app does.
        let restored = read_breakpoints(home.path(), "p1").unwrap();
        assert_eq!(restored, set);
        assert_eq!(restored["src/lib.rs"][1].condition.as_deref(), Some("i > 3"));
    }

    #[test]
    fn a_project_with_no_breakpoints_reads_as_empty_not_as_an_error() {
        let home = tempfile::tempdir().unwrap();
        assert!(read_breakpoints(home.path(), "never-seen").unwrap().is_empty());
    }

    #[test]
    fn breakpoints_are_scoped_to_their_own_project() {
        let home = tempfile::tempdir().unwrap();
        let mut one = BreakpointsByFile::new();
        one.insert("a.rs".into(), vec![crate::dap::Breakpoint::new("a.rs", 1)]);
        write_breakpoints(home.path(), "p1", &one).unwrap();
        write_breakpoints(home.path(), "p2", &BreakpointsByFile::new()).unwrap();

        assert_eq!(read_breakpoints(home.path(), "p1").unwrap().len(), 1);
        assert!(read_breakpoints(home.path(), "p2").unwrap().is_empty());
    }

    #[test]
    fn clearing_a_files_last_breakpoint_drops_the_file_entirely() {
        let home = tempfile::tempdir().unwrap();
        let mut set = BreakpointsByFile::new();
        set.insert("a.rs".into(), vec![crate::dap::Breakpoint::new("a.rs", 1)]);
        write_breakpoints(home.path(), "p1", &set).unwrap();

        set.insert("a.rs".into(), vec![]);
        write_breakpoints(home.path(), "p1", &set).unwrap();
        assert!(
            read_breakpoints(home.path(), "p1").unwrap().is_empty(),
            "an emptied file must not linger as a dead entry"
        );
    }

    #[test]
    fn adapter_verification_is_not_persisted_as_fact_across_restarts() {
        // `verified` describes what one adapter said in one session. Reading
        // it back as still-true would show a green breakpoint for a program
        // that has since been edited and never re-launched.
        let home = tempfile::tempdir().unwrap();
        let mut set = BreakpointsByFile::new();
        set.insert(
            "a.rs".into(),
            vec![crate::dap::Breakpoint {
                verified: Some(true),
                actual_line: Some(4),
                ..crate::dap::Breakpoint::new("a.rs", 3)
            }],
        );
        write_breakpoints(home.path(), "p1", &set).unwrap();

        let restored = read_breakpoints(home.path(), "p1").unwrap();
        let breakpoint = &restored["a.rs"][0];
        assert_eq!(breakpoint.line, 3, "the user's own line is what persists");
        assert_eq!(breakpoint.verified, None, "verification is per-session, not stored");
        assert_eq!(breakpoint.actual_line, None);
    }



    fn home() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn project_hash_is_deterministic_and_path_derived() {
        assert_eq!(project_hash("/a/b"), project_hash("/a/b"));
        assert_ne!(project_hash("/a/b"), project_hash("/a/c"));
        assert_eq!(project_hash("/a/b").len(), 64);
    }

    #[test]
    fn thread_executor_preference_round_trips() {
        let home = home();
        let project = add_project(home.path(), tempfile::tempdir().unwrap().path()).unwrap();
        let thread = create_thread(home.path(), &project.hash, "t").unwrap();
        assert_eq!(thread.executor, None);
        assert_eq!(thread.model, None);

        let updated = set_thread_executor(
            home.path(),
            &project.hash,
            &thread.id,
            Some("devin"),
            Some("model-b"),
        )
        .unwrap();
        assert_eq!(updated.executor.as_deref(), Some("devin"));
        assert_eq!(updated.model.as_deref(), Some("model-b"));

        // Persisted, not just in memory.
        let loaded = list_threads(home.path(), &project.hash).unwrap();
        let found = loaded.iter().find(|t| t.id == thread.id).unwrap();
        assert_eq!(found.executor.as_deref(), Some("devin"));
        assert_eq!(found.model.as_deref(), Some("model-b"));

        // Clearing returns to auto-detection.
        let cleared =
            set_thread_executor(home.path(), &project.hash, &thread.id, None, None).unwrap();
        assert_eq!(cleared.executor, None);
        assert_eq!(cleared.model, None);
    }

    #[test]
    fn thread_auth_blocked_round_trips_and_clears() {
        let home = home();
        let project = add_project(home.path(), tempfile::tempdir().unwrap().path()).unwrap();
        let thread = create_thread(home.path(), &project.hash, "t").unwrap();
        assert_eq!(thread.auth_blocked, None);

        let blocked =
            set_thread_auth_blocked(home.path(), &project.hash, &thread.id, Some("codex needs to be signed in"))
                .unwrap();
        assert_eq!(blocked.auth_blocked.as_deref(), Some("codex needs to be signed in"));

        // Persisted, not just in memory.
        let loaded = list_threads(home.path(), &project.hash).unwrap();
        let found = loaded.iter().find(|t| t.id == thread.id).unwrap();
        assert_eq!(found.auth_blocked.as_deref(), Some("codex needs to be signed in"));

        // A successful turn clears it.
        let cleared = set_thread_auth_blocked(home.path(), &project.hash, &thread.id, None).unwrap();
        assert_eq!(cleared.auth_blocked, None);
    }

    #[test]
    fn old_thread_meta_without_executor_fields_still_loads() {
        let home = home();
        let project = add_project(home.path(), tempfile::tempdir().unwrap().path()).unwrap();
        let thread = create_thread(home.path(), &project.hash, "t").unwrap();
        // Simulate a meta file written before the executor/model fields existed.
        let path = threads_dir(home.path(), &project.hash).join(format!("{}.meta.json", thread.id));
        let body = fs::read_to_string(&path).unwrap();
        let mut value: serde_json::Value = serde_json::from_str(&body).unwrap();
        value.as_object_mut().unwrap().remove("executor");
        value.as_object_mut().unwrap().remove("model");
        fs::write(&path, serde_json::to_string(&value).unwrap()).unwrap();

        let loaded = list_threads(home.path(), &project.hash).unwrap();
        let found = loaded.iter().find(|t| t.id == thread.id).unwrap();
        assert_eq!(found.executor, None);
        assert_eq!(found.model, None);
    }

    // ----------------------------------------------- spec_type field (D11)

    #[test]
    fn thread_meta_spec_type_round_trips() {
        let home = home();
        let project = add_project(home.path(), tempfile::tempdir().unwrap().path()).unwrap();
        let thread = create_thread(home.path(), &project.hash, "t").unwrap();
        // Set spec_type directly via update_thread (the persistence helper
        // set_spec_type arrives in Group 3; here we only exercise serde).
        let with_type = update_thread(home.path(), &project.hash, &thread.id, |m| {
            m.spec_type = Some("Feature".into());
        })
        .unwrap();
        assert_eq!(with_type.spec_type.as_deref(), Some("Feature"));

        // Reload from disk — the field must survive a serialize/deserialize cycle.
        let loaded = list_threads(home.path(), &project.hash).unwrap();
        let found = loaded.iter().find(|t| t.id == thread.id).unwrap();
        assert_eq!(found.spec_type.as_deref(), Some("Feature"));
    }

    #[test]
    fn old_thread_meta_without_spec_type_still_loads() {
        let home = home();
        let project = add_project(home.path(), tempfile::tempdir().unwrap().path()).unwrap();
        let thread = create_thread(home.path(), &project.hash, "t").unwrap();
        // Simulate a meta file written before spec_type existed.
        let path = threads_dir(home.path(), &project.hash).join(format!("{}.meta.json", thread.id));
        let body = fs::read_to_string(&path).unwrap();
        let mut value: serde_json::Value = serde_json::from_str(&body).unwrap();
        value.as_object_mut().unwrap().remove("specType");
        fs::write(&path, serde_json::to_string(&value).unwrap()).unwrap();

        let loaded = list_threads(home.path(), &project.hash).unwrap();
        let found = loaded.iter().find(|t| t.id == thread.id).unwrap();
        assert_eq!(found.spec_type, None);
    }

    // ----------------------------------------------- spec_type persistence (D11)

    #[test]
    fn set_spec_type_stores_the_spec_type_on_the_thread() {
        let home = home();
        let project = add_project(home.path(), tempfile::tempdir().unwrap().path()).unwrap();
        let thread = create_thread(home.path(), &project.hash, "t").unwrap();
        assert_eq!(thread.spec_type, None);

        let stored = set_spec_type(home.path(), &project.hash, &thread.id, "Bugfix").unwrap();
        assert_eq!(stored.spec_type.as_deref(), Some("Bugfix"));
    }

    /// #30/#35: the framing card is not the thread's name. A spec thread is
    /// named the way every other thread is — from what the user actually
    /// asked for — so "Feature" is never the row for every feature.
    #[test]
    fn framing_a_thread_stores_the_type_without_naming_the_thread() {
        let home = home();
        let project = add_project(home.path(), tempfile::tempdir().unwrap().path()).unwrap();
        let thread = create_thread(home.path(), &project.hash, "New thread").unwrap();

        let framed = set_spec_type(home.path(), &project.hash, &thread.id, "Bugfix").unwrap();
        assert_eq!(framed.spec_type.as_deref(), Some("Bugfix"));
        assert_eq!(framed.title, "New thread", "the card is not the name");

        // The request names it, through the same chain a go-mode turn uses.
        set_auto_title(
            home.path(),
            &project.hash,
            &thread.id,
            "login redirect loops on Safari",
            None,
        )
        .unwrap();
        assert_eq!(
            list_threads(home.path(), &project.hash).unwrap()[0].title,
            "Login redirect loops on Safari"
        );

        // A better title from the agent still wins, exactly as elsewhere.
        upgrade_auto_title(home.path(), &project.hash, &thread.id, "Fix Safari redirect loop")
            .unwrap();
        assert_eq!(
            list_threads(home.path(), &project.hash).unwrap()[0].title,
            "Fix Safari redirect loop"
        );
    }

    /// A long request is cut to something a sidebar row can show, the same
    /// way a long go-mode prompt is.
    #[test]
    fn a_long_spec_request_becomes_a_readable_thread_title() {
        let home = home();
        let project = add_project(home.path(), tempfile::tempdir().unwrap().path()).unwrap();
        let thread = create_thread(home.path(), &project.hash, "New thread").unwrap();
        set_spec_type(home.path(), &project.hash, &thread.id, "Bugfix").unwrap();
        let request = "figure out why the login redirect loops forever on Safari \
                       when a session cookie has already expired and the user retries";
        set_auto_title(home.path(), &project.hash, &thread.id, request, None).unwrap();

        let named = list_threads(home.path(), &project.hash).unwrap().remove(0);
        assert!(named.title.chars().count() <= 50, "got {:?}", named.title);
        assert!(named.title.starts_with("Figure out why the login redirect"));
        assert!(named.title.ends_with('…'));
        // The framing is still on the thread for the agent's benefit.
        assert_eq!(named.spec_type.as_deref(), Some("Bugfix"));
    }

    /// A late agent title must never overwrite a name the user typed, even
    /// when the thread was framed from the spec menu first.
    #[test]
    fn a_manual_rename_survives_a_late_agent_title_on_a_spec_thread() {
        let home = home();
        let project = add_project(home.path(), tempfile::tempdir().unwrap().path()).unwrap();
        let thread = create_thread(home.path(), &project.hash, "New thread").unwrap();
        set_spec_type(home.path(), &project.hash, &thread.id, "Feature").unwrap();
        rename_thread(home.path(), &project.hash, &thread.id, "Mine").unwrap();
        upgrade_auto_title(home.path(), &project.hash, &thread.id, "Agent's idea").unwrap();
        set_auto_title(home.path(), &project.hash, &thread.id, "another prompt", None).unwrap();
        assert_eq!(list_threads(home.path(), &project.hash).unwrap()[0].title, "Mine");
    }

    #[test]
    fn reading_a_thread_with_stored_spec_type_returns_the_value() {
        let home = home();
        let project = add_project(home.path(), tempfile::tempdir().unwrap().path()).unwrap();
        let thread = create_thread(home.path(), &project.hash, "t").unwrap();
        set_spec_type(home.path(), &project.hash, &thread.id, "Feature").unwrap();

        // Reload from disk — the spec_type must survive persistence.
        let loaded = list_threads(home.path(), &project.hash).unwrap();
        let found = loaded.iter().find(|t| t.id == thread.id).unwrap();
        assert_eq!(found.spec_type.as_deref(), Some("Feature"));
    }

    #[test]
    fn simultaneous_project_windows_do_not_lose_saved_projects() {
        let home = home();
        let repos: Vec<_> = (0..12).map(|_| tempfile::tempdir().unwrap()).collect();
        let barrier = std::sync::Barrier::new(repos.len());
        std::thread::scope(|scope| {
            let handles: Vec<_> = repos.iter().map(|repo| scope.spawn(|| {
                barrier.wait();
                add_project(home.path(), repo.path())
            })).collect();
            for handle in handles { handle.join().unwrap().unwrap(); }
        });
        assert_eq!(list_projects(home.path()).unwrap().len(), repos.len());
    }

    #[test]
    fn removing_a_saved_project_preserves_files_and_history_without_readopting_it() {
        let home = home();
        let repo = tempfile::tempdir().unwrap();
        fs::write(repo.path().join("keep.txt"), "precious work").unwrap();
        let project = add_project(home.path(), repo.path()).unwrap();
        let thread = create_thread(home.path(), &project.hash, "Keep history").unwrap();
        remove_project(home.path(), &project.hash).unwrap();
        assert!(list_projects(home.path()).unwrap().is_empty());
        assert!(list_projects(home.path()).unwrap().is_empty());
        assert_eq!(fs::read_to_string(repo.path().join("keep.txt")).unwrap(), "precious work");
        assert_eq!(list_threads(home.path(), &project.hash).unwrap()[0].id, thread.id);
        let restored = add_project(home.path(), repo.path()).unwrap();
        assert_eq!(restored.hash, project.hash);
        assert_eq!(list_projects(home.path()).unwrap().len(), 1);
        assert_eq!(list_threads(home.path(), &project.hash).unwrap()[0].id, thread.id);
    }

    #[test]
    fn adding_the_same_project_twice_reuses_the_entry() {
        let home = home();
        let repo = tempfile::tempdir().unwrap();
        let first = add_project(home.path(), repo.path()).unwrap();
        let second = add_project(home.path(), repo.path()).unwrap();
        assert_eq!(first.hash, second.hash);
        assert_eq!(list_projects(home.path()).unwrap().len(), 1);
    }

    #[test]
    fn rename_leaves_project_identity_unchanged() {
        let home = home();
        let repo = tempfile::tempdir().unwrap();
        let project = add_project(home.path(), repo.path()).unwrap();
        let renamed = rename_project(home.path(), &project.hash, "Renamed").unwrap();
        assert_eq!(renamed.display_name, "Renamed");
        assert_eq!(renamed.hash, project.hash);
        assert_eq!(renamed.root, project.root);
        assert_eq!(list_projects(home.path()).unwrap()[0].display_name, "Renamed");
    }

    #[test]
    fn thread_creation_writes_sidecar_and_empty_log() {
        let home = home();
        let repo = tempfile::tempdir().unwrap();
        let project = add_project(home.path(), repo.path()).unwrap();
        let thread = create_thread(home.path(), &project.hash, "First").unwrap();

        assert_eq!(thread.current_mode, "spec");
        assert_eq!(thread.open_spec_change_name, None);
        assert!(meta_path(home.path(), &project.hash, &thread.id).exists());
        assert!(log_path(home.path(), &project.hash, &thread.id).exists());
        assert!(read_thread(home.path(), &project.hash, &thread.id).unwrap().is_empty());

        let listed = list_threads(home.path(), &project.hash).unwrap();
        assert_eq!(listed, vec![thread]);
    }

    #[test]
    fn deleting_a_thread_removes_both_files_and_drops_it_from_the_list() {
        let home = home();
        let repo = tempfile::tempdir().unwrap();
        let project = add_project(home.path(), repo.path()).unwrap();
        let thread = create_thread(home.path(), &project.hash, "scratch").unwrap();

        delete_thread(home.path(), &project.hash, &thread.id).unwrap();

        assert!(!meta_path(home.path(), &project.hash, &thread.id).exists());
        assert!(!log_path(home.path(), &project.hash, &thread.id).exists());
        assert!(list_threads(home.path(), &project.hash).unwrap().is_empty());
    }

    #[test]
    fn deleting_an_already_deleted_thread_is_not_an_error() {
        // Idempotent: the log file always exists once a thread is created,
        // but a caller retrying after a partial failure shouldn't see this
        // as a new error.
        let home = home();
        let repo = tempfile::tempdir().unwrap();
        let project = add_project(home.path(), repo.path()).unwrap();
        let thread = create_thread(home.path(), &project.hash, "scratch").unwrap();

        delete_thread(home.path(), &project.hash, &thread.id).unwrap();
        assert!(delete_thread(home.path(), &project.hash, &thread.id).is_ok());
    }

    #[test]
    fn deleting_one_thread_leaves_others_untouched() {
        let home = home();
        let repo = tempfile::tempdir().unwrap();
        let project = add_project(home.path(), repo.path()).unwrap();
        let keep = create_thread(home.path(), &project.hash, "keep").unwrap();
        let gone = create_thread(home.path(), &project.hash, "gone").unwrap();

        delete_thread(home.path(), &project.hash, &gone.id).unwrap();

        let listed = list_threads(home.path(), &project.hash).unwrap();
        assert_eq!(listed, vec![keep]);
    }

    #[test]
    fn append_then_read_round_trips_in_seq_order() {
        let home = home();
        let repo = tempfile::tempdir().unwrap();
        let project = add_project(home.path(), repo.path()).unwrap();
        let thread = create_thread(home.path(), &project.hash, "t").unwrap();

        for i in 0..5 {
            append_message(home.path(), &project.hash, &thread.id, "user", "spec", &format!("m{i}"), None).unwrap();
        }
        flush_session_log_writer().unwrap();
        let messages = read_thread(home.path(), &project.hash, &thread.id).unwrap();
        assert_eq!(messages.len(), 5);
        assert_eq!(messages.iter().map(|m| m.seq).collect::<Vec<_>>(), vec![0, 1, 2, 3, 4]);
        assert_eq!(messages[3].content, "m3");
    }

    /// RED: read_thread must see messages that append_message has buffered
    /// in the in-memory SessionLogWriter but not yet flushed to disk. This is
    /// the live-during-a-turn case: the frontend calls read_thread right after
    /// send_message appends the user's turn, before the turn's Done flushes.
    /// A read that only sees disk returns stale history and the user's bubble
    /// vanishes for the whole turn.
    #[test]
    fn last_activity_is_the_newest_message_and_ignores_viewing() {
        let home = home();
        let project = add_project(home.path(), tempfile::tempdir().unwrap().path()).unwrap();
        let thread = create_thread(home.path(), &project.hash, "t").unwrap();
        assert_eq!(last_activity(home.path(), &project.hash, &thread.id), None);

        let sent = append_message(home.path(), &project.hash, &thread.id, "user", "go", "hi", None).unwrap();
        mark_thread_viewed(home.path(), &project.hash, &thread.id).unwrap();

        assert_eq!(last_activity(home.path(), &project.hash, &thread.id), Some(sent.ts));
    }

    /// The Unreviewed band asks "did the agent say something after you last
    /// looked?", so the user's own newest message must not count as agent
    /// activity — a prompt that never got a reply is not an unread reply.
    #[test]
    fn last_agent_activity_skips_the_users_own_messages() {
        let home = home();
        let project = add_project(home.path(), tempfile::tempdir().unwrap().path()).unwrap();
        let thread = create_thread(home.path(), &project.hash, "t").unwrap();
        assert_eq!(last_agent_activity(home.path(), &project.hash, &thread.id), None);

        append_message(home.path(), &project.hash, &thread.id, "user", "go", "hi", None).unwrap();
        assert_eq!(last_agent_activity(home.path(), &project.hash, &thread.id), None);

        let reply = append_message(home.path(), &project.hash, &thread.id, "assistant", "go", "hello", None).unwrap();
        append_message(home.path(), &project.hash, &thread.id, "user", "go", "and?", None).unwrap();
        assert_eq!(last_agent_activity(home.path(), &project.hash, &thread.id), Some(reply.ts));
    }

    fn thread_with(home: &Path) -> (Project, ThreadMeta) {
        let project = add_project(home, tempfile::tempdir().unwrap().path()).unwrap();
        let thread = create_thread(home, &project.hash, "t").unwrap();
        (project, thread)
    }

    fn say(home: &Path, p: &Project, t: &ThreadMeta, text: &str) -> Message {
        append_message(home, &p.hash, &t.id, "assistant", "go", text, None).unwrap()
    }

    fn seqs(messages: &[Message]) -> Vec<u64> {
        messages.iter().map(|m| m.seq).collect()
    }

    /// The reader used to hold the writer lock for its whole file read; now it
    /// snapshots length + buffer and reads outside the lock. A flush landing
    /// between the two must not show the same lines from disk *and* buffer.
    #[test]
    fn a_flush_between_snapshot_and_read_does_not_duplicate_messages() {
        let home = home();
        let (p, t) = thread_with(home.path());
        for i in 0..3 {
            say(home.path(), &p, &t, &format!("m{i}"));
        }
        let snap = snapshot(&log_path(home.path(), &p.hash, &t.id)).unwrap();
        flush_session_log_writer().unwrap();
        let seen = read_thread_impl(home.path(), &p.hash, &t.id, Some(snap.file_len), &snap.buffered).unwrap();
        assert_eq!(seqs(&seen), vec![0, 1, 2]);
    }

    /// A flush writes with the writer lock released. Mid-write, the file may hold
    /// some, all or none of the in-flight lines; readers and appenders must see
    /// each line exactly once, and a new append must not reuse a seq.
    #[test]
    fn mid_flush_readers_and_appenders_see_every_line_exactly_once() {
        use crate::session_log_writer::{shared_session_log_writer, write_out, FLUSH_GATE};
        let home = home();
        let (p, t) = thread_with(home.path());
        let path = log_path(home.path(), &p.hash, &t.id);
        flush_session_log_writer().unwrap();
        // This test plays the flusher by hand, so it must hold the gate a real
        // flush holds; otherwise a parallel test's flush claims this log too.
        let gate = FLUSH_GATE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        for i in 0..3 {
            say(home.path(), &p, &t, &format!("m{i}"));
        }
        let writer = shared_session_log_writer();
        let batch = writer.lock().unwrap().begin_flush(Some(&path));

        // Nothing written yet: the lines are "in flight" and still all visible.
        assert_eq!(seqs(&read_thread(home.path(), &p.hash, &t.id).unwrap()), vec![0, 1, 2]);
        // An append now must continue the numbering, not restart it.
        assert_eq!(say(home.path(), &p, &t, "m3").seq, 3);

        // Half the in-flight bytes reach the file (a write caught mid-way).
        assert!(std::fs::read(&path).unwrap().is_empty());
        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(b"{\"seq\":0,\"ts\":\"half").unwrap();
        assert_eq!(seqs(&read_thread(home.path(), &p.hash, &t.id).unwrap()), vec![0, 1, 2, 3]);
        std::fs::write(&path, b"").unwrap();

        // The write completes, then the flush retires.
        let in_flight_bytes: Vec<u8> = batch_bytes(&home, &p, &t);
        write_out(&path, &in_flight_bytes).unwrap();
        writer.lock().unwrap().finish_flush(&batch);
        assert_eq!(seqs(&read_thread(home.path(), &p.hash, &t.id).unwrap()), vec![0, 1, 2, 3]);
        assert_eq!(say(home.path(), &p, &t, "m4").seq, 4);
        drop(gate);
        flush_session_log_writer().unwrap();
        assert_eq!(seqs(&read_thread(home.path(), &p.hash, &t.id).unwrap()), vec![0, 1, 2, 3, 4]);
    }

    /// The in-flight lines exactly as the flusher holds them: what `view` reports
    /// beyond `disk_len`, minus whatever was appended after the flush began.
    fn batch_bytes(home: &tempfile::TempDir, p: &Project, t: &ThreadMeta) -> Vec<u8> {
        let path = log_path(home.path(), &p.hash, &t.id);
        let (_, tail) = crate::session_log_writer::shared_session_log_writer().lock().unwrap().view(&path);
        let text = String::from_utf8(tail).unwrap();
        // The first three lines were in flight; the fourth is the later append.
        text.split_inclusive('\n').take(3).collect::<String>().into_bytes()
    }

    /// Sessions appending, a flusher fsyncing and a reader reading, all at once:
    /// no lost, duplicated or reordered messages.
    #[test]
    fn concurrent_appends_flushes_and_reads_stay_consistent() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;
        let home = home();
        let project = add_project(home.path(), tempfile::tempdir().unwrap().path()).unwrap();
        let threads: Vec<ThreadMeta> =
            (0..4).map(|_| create_thread(home.path(), &project.hash, "t").unwrap()).collect();
        let done = Arc::new(AtomicBool::new(false));

        let flusher = {
            let done = done.clone();
            std::thread::spawn(move || {
                while !done.load(Ordering::Relaxed) {
                    flush_session_log_writer().unwrap();
                }
            })
        };
        let reader = {
            let (done, h, hash, ids) =
                (done.clone(), home.path().to_path_buf(), project.hash.clone(), threads.clone());
            std::thread::spawn(move || {
                while !done.load(Ordering::Relaxed) {
                    for t in &ids {
                        let got = seqs(&read_thread(&h, &hash, &t.id).unwrap());
                        let expected: Vec<u64> = (0..got.len() as u64).collect();
                        assert_eq!(got, expected, "a reader saw a gap, repeat or reorder");
                    }
                }
            })
        };
        let writers: Vec<_> = threads
            .iter()
            .map(|t| {
                let (h, hash, id) = (home.path().to_path_buf(), project.hash.clone(), t.id.clone());
                std::thread::spawn(move || {
                    for i in 0..300 {
                        append_message(&h, &hash, &id, "assistant", "go", &format!("m{i}-{}", "p".repeat(200)), None)
                            .unwrap();
                    }
                })
            })
            .collect();
        for w in writers {
            w.join().unwrap();
        }
        done.store(true, Ordering::Relaxed);
        flusher.join().unwrap();
        reader.join().unwrap();

        flush_session_log_writer().unwrap();
        for t in &threads {
            let got = seqs(&read_thread(home.path(), &project.hash, &t.id).unwrap());
            assert_eq!(got, (0..300).collect::<Vec<u64>>());
        }
    }

    #[test]
    fn windows_return_the_tail_and_grow_past_their_first_read() {
        let home = home();
        let (p, t) = thread_with(home.path());
        // ~20 KB each, so 40 of them overrun the 256 KB first window.
        let big = "x".repeat(20_000);
        for _ in 0..40 {
            say(home.path(), &p, &t, &big);
        }
        flush_session_log_writer().unwrap();
        say(home.path(), &p, &t, "still buffered");

        let win = |w| seqs(&read_thread_window(home.path(), &p.hash, &t.id, w).unwrap());
        assert_eq!(win(Window::Last { before_seq: None, limit: 3 }), vec![38, 39, 40]);
        assert_eq!(win(Window::Last { before_seq: Some(38), limit: 3 }), vec![35, 36, 37]);
        assert_eq!(win(Window::Last { before_seq: Some(2), limit: 10 }), vec![0, 1]);
        assert_eq!(win(Window::Last { before_seq: None, limit: 500 }).len(), 41);
        assert_eq!(win(Window::From(39)), vec![39, 40]);
        assert_eq!(win(Window::From(0)).len(), 41);
        assert_eq!(win(Window::From(99)), Vec::<u64>::new());
        assert_eq!(win(Window::Last { before_seq: None, limit: 0 }), Vec::<u64>::new());
    }

    #[test]
    fn last_activity_reads_the_tail_even_when_the_last_line_is_huge_or_torn() {
        let home = home();
        let (p, t) = thread_with(home.path());
        say(home.path(), &p, &t, "small");
        let last = say(home.path(), &p, &t, &"y".repeat(300_000));
        flush_session_log_writer().unwrap();
        assert_eq!(last_activity(home.path(), &p.hash, &t.id), Some(last.ts.clone()));

        // A torn final line (crash mid-write) is skipped for the newest whole one.
        let path = log_path(home.path(), &p.hash, &t.id);
        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(b"{\"seq\":9,\"ts\":\"broke").unwrap();
        assert_eq!(last_activity(home.path(), &p.hash, &t.id), Some(last.ts));

        // A buffered message is newer than anything on disk.
        let fresh = say(home.path(), &p, &t, "buffered");
        assert_eq!(last_activity(home.path(), &p.hash, &t.id), Some(fresh.ts));
    }

    #[test]
    fn thread_is_empty_until_the_first_message_without_parsing() {
        let home = home();
        let (p, t) = thread_with(home.path());
        assert!(thread_is_empty(home.path(), &p.hash, &t.id).unwrap());
        say(home.path(), &p, &t, "hi");
        assert!(!thread_is_empty(home.path(), &p.hash, &t.id).unwrap());
    }

    #[test]
    fn a_log_that_outgrows_its_buffer_is_flushed_without_waiting_for_done() {
        let home = home();
        let (p, t) = thread_with(home.path());
        let path = log_path(home.path(), &p.hash, &t.id);
        say(home.path(), &p, &t, &"z".repeat(BUFFER_FLUSH_BYTES as usize + 1));
        // The size trigger never waits: if another flush is running it skips, and
        // the next append tries again. Tests share the flusher, so allow for that.
        let mut appended = 1;
        while file_len(&path) <= BUFFER_FLUSH_BYTES && appended < 200 {
            say(home.path(), &p, &t, "tick");
            appended += 1;
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(file_len(&path) > BUFFER_FLUSH_BYTES, "over-threshold buffer should have hit disk");
        // Seq numbering carries on correctly across the automatic flush.
        assert_eq!(say(home.path(), &p, &t, "next").seq, appended);
        assert_eq!(
            seqs(&read_thread(home.path(), &p.hash, &t.id).unwrap()),
            (0..=appended).collect::<Vec<_>>()
        );
    }

    #[test]
    fn read_thread_sees_unflushed_buffered_messages() {
        let home = home();
        let repo = tempfile::tempdir().unwrap();
        let project = add_project(home.path(), repo.path()).unwrap();
        let thread = create_thread(home.path(), &project.hash, "t").unwrap();

        // One flushed message on disk, then a second that stays buffered.
        append_message(home.path(), &project.hash, &thread.id, "user", "spec", "on disk", None).unwrap();
        flush_session_log_writer().unwrap();
        append_message(home.path(), &project.hash, &thread.id, "user", "spec", "in buffer", None).unwrap();

        let messages = read_thread(home.path(), &project.hash, &thread.id).unwrap();
        assert_eq!(messages.len(), 2, "read_thread must merge the in-memory buffer with disk");
        assert_eq!(messages[0].content, "on disk");
        assert_eq!(messages[1].content, "in buffer");
    }

    #[test]
    fn torn_trailing_line_is_dropped_and_logged() {
        let home = home();
        let repo = tempfile::tempdir().unwrap();
        let project = add_project(home.path(), repo.path()).unwrap();
        let thread = create_thread(home.path(), &project.hash, "t").unwrap();
        append_message(home.path(), &project.hash, &thread.id, "user", "spec", "good", None).unwrap();
        flush_session_log_writer().unwrap();

        let path = log_path(home.path(), &project.hash, &thread.id);
        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(b"{\"seq\":1,\"ts\":\"2026").unwrap();

        let messages = read_thread(home.path(), &project.hash, &thread.id).unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].content, "good");

        let harness_log = fs::read_to_string(home.path().join("harness.log")).unwrap();
        assert!(harness_log.contains(&thread.id), "harness.log should name the thread");
        assert!(harness_log.contains("byte offset"));

        // A later good append still lands after the torn line.
        append_message(home.path(), &project.hash, &thread.id, "user", "spec", "after", None).unwrap();
        flush_session_log_writer().unwrap();
        let messages = read_thread(home.path(), &project.hash, &thread.id).unwrap();
        assert_eq!(messages.last().unwrap().content, "after");
    }

    #[test]
    fn mode_toggle_updates_sidecar_and_appends_one_marker() {
        let home = home();
        let repo = tempfile::tempdir().unwrap();
        let project = add_project(home.path(), repo.path()).unwrap();
        let thread = create_thread(home.path(), &project.hash, "t").unwrap();

        let meta = set_thread_mode(home.path(), &project.hash, &thread.id, "go").unwrap();
        assert_eq!(meta.current_mode, "go");
        assert_eq!(list_threads(home.path(), &project.hash).unwrap()[0].current_mode, "go");

        flush_session_log_writer().unwrap();
        let messages = read_thread(home.path(), &project.hash, &thread.id).unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].role, "tool");
        assert_eq!(messages[0].mode, "go");

        set_thread_mode(home.path(), &project.hash, &thread.id, "spec").unwrap();
        flush_session_log_writer().unwrap();
        let messages = read_thread(home.path(), &project.hash, &thread.id).unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[1].mode, "spec");

        assert!(set_thread_mode(home.path(), &project.hash, &thread.id, "turbo").is_err());
    }

    /// A sidecar still carrying the retired `executorSessionId` must load —
    /// the field is tolerated on disk, just no longer part of the type.
    #[test]
    fn a_sidecar_with_or_without_the_retired_session_field_still_parses() {
        let legacy = r#"{
            "id": "01ABC", "projectHash": "h", "title": "t",
            "createdAt": "2026-08-03T00:00:00+00:00", "updatedAt": "2026-08-03T00:00:00+00:00",
            "currentMode": "spec", "openSpecChangeName": null
        }"#;
        assert_eq!(serde_json::from_str::<ThreadMeta>(legacy).unwrap().current_mode, "spec");

        let with_field = legacy.replace(
            r#""openSpecChangeName": null"#,
            r#""openSpecChangeName": null, "executorSessionId": "sess-1""#,
        );
        let meta: ThreadMeta = serde_json::from_str(&with_field).unwrap();
        assert_eq!(meta.id, "01ABC");
        // And writing it back does not carry the retired field forward.
        assert!(!serde_json::to_string(&meta).unwrap().contains("executorSessionId"));
    }

    /// Task 2.14: the record is the durable answer to "what ran, and how did
    /// it end" — an open row on start, an amended row on close.
    #[test]
    fn a_session_is_recorded_open_then_closed_with_its_outcome() {
        let home = home();
        let repo = tempfile::tempdir().unwrap();
        let project = add_project(home.path(), repo.path()).unwrap();
        let thread = create_thread(home.path(), &project.hash, "t").unwrap();

        let opened = open_session(
            home.path(), &project.hash, &thread.id, "s1", "claude", "go", Some("uuid-1"), Some("abc123"), None,
        )
        .unwrap();
        assert_eq!(opened.ended_at, None);
        assert_eq!(opened.outcome, None);
        flush_session_log_writer().unwrap();

        let live = read_sessions(home.path(), &project.hash, &thread.id).unwrap();
        assert_eq!(live.len(), 1, "the open row is readable on its own");
        assert_eq!(live[0].provider_handle.as_deref(), Some("uuid-1"));

        for outcome in ["done", "crashed", "cancelled"] {
            let home = tempfile::tempdir().unwrap();
            let project = add_project(home.path(), repo.path()).unwrap();
            let thread = create_thread(home.path(), &project.hash, "t").unwrap();
            open_session(home.path(), &project.hash, &thread.id, "s1", "claude", "go", None, None, None).unwrap();
            close_session(home.path(), &project.hash, &thread.id, "s1", outcome, Some("def456")).unwrap();
            flush_session_log_writer().unwrap();

            let records = read_sessions(home.path(), &project.hash, &thread.id).unwrap();
            assert_eq!(records.len(), 1, "the close amends the open, it does not duplicate it");
            assert_eq!(records[0].outcome.as_deref(), Some(outcome));
            assert!(records[0].ended_at.is_some());
            assert_eq!(records[0].git_head_after.as_deref(), Some("def456"));
        }
    }

    /// Closing twice must not rewrite how a session actually ended — a crash
    /// followed by the harness tidying up stays a crash.
    #[test]
    fn closing_an_already_closed_session_keeps_the_first_outcome() {
        let home = home();
        let repo = tempfile::tempdir().unwrap();
        let project = add_project(home.path(), repo.path()).unwrap();
        let thread = create_thread(home.path(), &project.hash, "t").unwrap();

        open_session(home.path(), &project.hash, &thread.id, "s1", "claude", "go", None, None, None).unwrap();
        close_session(home.path(), &project.hash, &thread.id, "s1", "crashed", None).unwrap();
        close_session(home.path(), &project.hash, &thread.id, "s1", "cancelled", None).unwrap();
        flush_session_log_writer().unwrap();

        let records = read_sessions(home.path(), &project.hash, &thread.id).unwrap();
        assert_eq!(records[0].outcome.as_deref(), Some("crashed"));
    }

    /// Task 2.15: no process survives a restart, so a record left open by one
    /// is not "still running" — it was interrupted.
    #[test]
    fn a_record_left_open_by_a_dead_process_closes_as_interrupted() {
        let home = home();
        let repo = tempfile::tempdir().unwrap();
        let project = add_project(home.path(), repo.path()).unwrap();
        let thread = create_thread(home.path(), &project.hash, "t").unwrap();

        open_session(home.path(), &project.hash, &thread.id, "dead", "claude", "go", None, None, None).unwrap();
        open_session(home.path(), &project.hash, &thread.id, "alive", "codex", "spec", None, None, None).unwrap();
        flush_session_log_writer().unwrap();

        let records =
            close_stale_sessions(home.path(), &project.hash, &thread.id, &["alive".to_string()]).unwrap();
        let by_id = |id: &str| records.iter().find(|r| r.id == id).unwrap().clone();
        assert_eq!(by_id("dead").outcome.as_deref(), Some("interrupted"));
        assert_eq!(by_id("alive").outcome, None, "a session that is actually live stays open");
    }

    /// Task 2.16: `ensure_session` wrote the handle unconditionally, including
    /// for Codex, which never used it — so only Claude can be credited with it.
    #[test]
    fn a_thread_with_only_a_legacy_handle_yields_one_synthesized_claude_record() {
        let home = home();
        let repo = tempfile::tempdir().unwrap();
        let project = add_project(home.path(), repo.path()).unwrap();
        let thread = create_thread(home.path(), &project.hash, "t").unwrap();

        // Write the retired field back onto the sidecar, as an old build would.
        let path = meta_path(home.path(), &project.hash, &thread.id);
        let mut raw: serde_json::Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        raw["executorSessionId"] = serde_json::Value::String("legacy-uuid".into());
        fs::write(&path, serde_json::to_string_pretty(&raw).unwrap()).unwrap();

        let records = read_sessions(home.path(), &project.hash, &thread.id).unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].agent_id, "claude");
        assert_eq!(records[0].provider_handle.as_deref(), Some("legacy-uuid"));
        assert!(records[0].ended_at.is_some(), "a legacy session is not live");

        // Once the thread has a real session log, the shim stops firing.
        open_session(home.path(), &project.hash, &thread.id, "s1", "codex", "spec", None, None, None).unwrap();
        flush_session_log_writer().unwrap();
        let records = read_sessions(home.path(), &project.hash, &thread.id).unwrap();
        assert_eq!(records.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), vec!["s1"]);
    }

    #[test]
    fn a_thread_with_no_history_at_all_has_no_sessions() {
        let home = home();
        let repo = tempfile::tempdir().unwrap();
        let project = add_project(home.path(), repo.path()).unwrap();
        let thread = create_thread(home.path(), &project.hash, "t").unwrap();
        assert!(read_sessions(home.path(), &project.hash, &thread.id).unwrap().is_empty());
    }

    /// Task 0.6: `projects.json` is a cache over the per-project `project.json`
    /// files. If it loses an entry, that project's whole thread history becomes
    /// permanently unreachable — so listing reconciles instead of trusting it.
    #[test]
    fn a_project_missing_from_the_index_is_adopted_back_from_its_directory() {
        let home = home();
        let repo = tempfile::tempdir().unwrap();
        let project = add_project(home.path(), repo.path()).unwrap();

        // Simulate the divergence: index emptied, directory left intact.
        save_projects(home.path(), &[]).unwrap();

        let listed = list_projects(home.path()).unwrap();
        assert_eq!(listed, vec![project.clone()], "the orphaned directory is adopted");

        // The adoption is written back, not recomputed on every read.
        let index: Vec<Project> = read_json(&index_path(home.path())).unwrap();
        assert_eq!(index, vec![project]);
    }

    #[test]
    fn a_directory_without_a_valid_project_json_is_not_adopted() {
        let home = home();
        fs::create_dir_all(home.path().join("projects/nonsense")).unwrap();
        fs::write(home.path().join("projects/nonsense/project.json"), "{not json").unwrap();
        fs::create_dir_all(home.path().join("projects/bare")).unwrap();

        assert!(list_projects(home.path()).unwrap().is_empty());
        // And nothing was deleted to achieve that.
        assert!(home.path().join("projects/bare").exists());
        assert!(home.path().join("projects/nonsense/project.json").exists());
    }

    /// Task 0.7: appends used to re-read the whole log to find the next `seq`.
    /// Volume is what exposes both the cost and any off-by-one in the cache.
    #[test]
    fn five_hundred_appends_stay_monotonic_and_read_back_in_order() {
        let home = home();
        let repo = tempfile::tempdir().unwrap();
        let project = add_project(home.path(), repo.path()).unwrap();
        let thread = create_thread(home.path(), &project.hash, "t").unwrap();

        for i in 0..500 {
            let message =
                append_message(home.path(), &project.hash, &thread.id, "user", "spec", &format!("m{i}"), None)
                    .unwrap();
            assert_eq!(message.seq, i, "the returned message carries its own seq");
        }
        flush_session_log_writer().unwrap();

        let messages = read_thread(home.path(), &project.hash, &thread.id).unwrap();
        assert_eq!(messages.len(), 500);
        assert!(
            messages.iter().enumerate().all(|(i, m)| m.seq == i as u64 && m.content == format!("m{i}")),
            "seq must be gapless, duplicate-free, and in order"
        );
    }

    /// The cache is only valid while the file is exactly as this process left
    /// it; anything else on disk means recompute rather than trust it.
    #[test]
    fn the_seq_cache_falls_back_when_the_log_changed_underneath_it() {
        let home = home();
        let repo = tempfile::tempdir().unwrap();
        let project = add_project(home.path(), repo.path()).unwrap();
        let thread = create_thread(home.path(), &project.hash, "t").unwrap();

        append_message(home.path(), &project.hash, &thread.id, "user", "spec", "one", None).unwrap();
        flush_session_log_writer().unwrap();

        // Another writer appends a real message behind our back.
        let path = log_path(home.path(), &project.hash, &thread.id);
        let smuggled = Message {
            seq: 1,
            ts: now(),
            role: "user".into(),
            mode: "spec".into(),
            content: "smuggled".into(),
            session_id: None,
            failure_class: None,
            attachments: Vec::new(),
        };
        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(file, "{}", serde_json::to_string(&smuggled).unwrap()).unwrap();

        let next = append_message(home.path(), &project.hash, &thread.id, "user", "spec", "three", None).unwrap();
        assert_eq!(next.seq, 2, "a stale cache entry must not reuse a taken seq");
    }

    /// Task 1.9: every message written before sessions had identities is still
    /// history, and must load rather than be dropped as a corrupt line.
    #[test]
    fn a_message_without_a_session_id_still_parses() {
        let legacy = r#"{"seq":0,"ts":"2026-08-03T00:00:00+00:00","role":"user","mode":"spec","content":"hi"}"#;
        let message: Message = serde_json::from_str(legacy).unwrap();
        assert_eq!(message.session_id, None);
        assert_eq!(message.content, "hi");

        let stamped = append_message_fixture("sess-9");
        assert_eq!(stamped.session_id.as_deref(), Some("sess-9"));
        // The field is omitted rather than written as null, so old builds and
        // legacy rows stay byte-identical in shape.
        assert!(!serde_json::to_string(&message).unwrap().contains("sessionId"));
    }

    #[test]
    fn thread_mentions_expand_to_transcript_paths() {
        let home = home();
        let repo = tempfile::tempdir().unwrap();
        let project = add_project(home.path(), repo.path()).unwrap();
        let thread = create_thread(home.path(), &project.hash, "Auth  token fix").unwrap();
        assert_eq!(thread_slug(&thread.title), "Auth-token-fix");

        let out = expand_thread_mentions(home.path(), &project.hash, "redo @thread:Auth-token-fix, but faster");
        assert!(out.starts_with("redo @thread:Auth-token-fix, but faster\n\nReferenced chats"));
        assert!(out.contains(&format!("{}.jsonl", thread.id)));
        let duplicate = create_thread(home.path(), &project.hash, "Auth  token fix").unwrap();
        let out = expand_thread_mentions(home.path(), &project.hash, &format!("redo @thread:{}::Auth-token-fix", duplicate.id));
        assert!(out.contains(&format!("{}.jsonl", duplicate.id)));
        assert!(!out.contains(&format!("{}.jsonl", thread.id)));
        // A title that ends in punctuation (auto-titles end in "...") still resolves.
        let dotted = create_thread(home.path(), &project.hash, "Reply with exactly...").unwrap();
        let out = expand_thread_mentions(home.path(), &project.hash, "what did @thread:Reply-with-exactly... ask?");
        assert!(out.contains(&format!("{}.jsonl", dotted.id)), "{out}");
        // An unknown slug is left alone and adds nothing.
        let plain = "see @thread:Nope";
        assert_eq!(expand_thread_mentions(home.path(), &project.hash, plain), plain);
    }

    fn append_message_fixture(session: &str) -> Message {
        let home = home();
        let repo = tempfile::tempdir().unwrap();
        let project = add_project(home.path(), repo.path()).unwrap();
        let thread = create_thread(home.path(), &project.hash, "t").unwrap();
        append_message(home.path(), &project.hash, &thread.id, "assistant", "go", "out", Some(session))
            .unwrap();
        flush_session_log_writer().unwrap();
        read_thread(home.path(), &project.hash, &thread.id).unwrap().remove(0)
    }

    #[test]
    fn archiving_keeps_the_thread_and_its_messages() {
        let home = home();
        let repo = tempfile::tempdir().unwrap();
        let project = add_project(home.path(), repo.path()).unwrap();
        let thread = create_thread(home.path(), &project.hash, "t").unwrap();
        append_message(home.path(), &project.hash, &thread.id, "user", "go", "hello", None)
            .unwrap();

        let archived =
            set_thread_archived(home.path(), &project.hash, &thread.id, true).unwrap();
        assert!(archived.archived);

        // Archiving is not deleting: it still lists, and still reads back.
        let listed = list_threads(home.path(), &project.hash).unwrap();
        assert_eq!(listed.len(), 1);
        assert!(listed[0].archived);
        assert_eq!(
            read_thread(home.path(), &project.hash, &thread.id).unwrap().len(),
            1
        );

        let restored =
            set_thread_archived(home.path(), &project.hash, &thread.id, false).unwrap();
        assert!(!restored.archived);
    }

    #[test]
    fn marking_a_thread_viewed_sets_the_timestamp_and_is_idempotent() {
        let home = home();
        let repo = tempfile::tempdir().unwrap();
        let project = add_project(home.path(), repo.path()).unwrap();
        let thread = create_thread(home.path(), &project.hash, "t").unwrap();
        assert!(thread.last_viewed_at.is_none());

        let viewed = mark_thread_viewed(home.path(), &project.hash, &thread.id).unwrap();
        let first = viewed.last_viewed_at.clone();
        assert!(first.is_some());

        // Calling it again only advances the stamp; it never errors or resets.
        let viewed_again = mark_thread_viewed(home.path(), &project.hash, &thread.id).unwrap();
        assert!(viewed_again.last_viewed_at >= first);
    }

    #[test]
    fn merged_thread_records_whether_verification_was_overridden() {
        let home = home();
        let repo = tempfile::tempdir().unwrap();
        let project = add_project(home.path(), repo.path()).unwrap();
        let thread = create_thread(home.path(), &project.hash, "t").unwrap();

        let merged = set_thread_merged(home.path(), &project.hash, &thread.id, true).unwrap();
        assert!(merged.merged_at.is_some());
        assert!(merged.merge_overridden);
        assert!(list_threads(home.path(), &project.hash).unwrap()[0].merge_overridden);
    }

    #[test]
    fn a_thread_written_before_archiving_existed_is_not_archived() {
        let home = home();
        let repo = tempfile::tempdir().unwrap();
        let project = add_project(home.path(), repo.path()).unwrap();
        let thread = create_thread(home.path(), &project.hash, "t").unwrap();

        // Rewrite the metadata without the field, as an older build left it.
        let path = meta_path(home.path(), &project.hash, &thread.id);
        let raw = std::fs::read_to_string(&path).unwrap();
        let mut value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        value.as_object_mut().unwrap().remove("archived");
        std::fs::write(&path, serde_json::to_string(&value).unwrap()).unwrap();

        assert!(!list_threads(home.path(), &project.hash).unwrap()[0].archived);
    }

    #[test]
    fn legacy_home_moves_across_once_and_never_merges() {
        let parent = tempfile::tempdir().unwrap();
        let legacy = parent.path().join(".floo-network");
        let current = parent.path().join(".palisade-code");
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(legacy.join("projects.json"), "[]").unwrap();

        migrate_legacy_home(&current).unwrap();
        assert!(current.join("projects.json").exists());
        assert!(!legacy.exists());

        // A second run with both present leaves the live store alone.
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(legacy.join("projects.json"), "stale").unwrap();
        migrate_legacy_home(&current).unwrap();
        assert_eq!(
            std::fs::read_to_string(current.join("projects.json")).unwrap(),
            "[]"
        );
    }

    #[test]
    fn the_newest_legacy_home_wins() {
        let parent = tempfile::tempdir().unwrap();
        let current = parent.path().join(".palisade-code");
        for (name, body) in [(".floo-network", "oldest"), (".sceilg-code", "newest")] {
            let dir = parent.path().join(name);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("projects.json"), body).unwrap();
        }

        migrate_legacy_home(&current).unwrap();
        assert_eq!(
            std::fs::read_to_string(current.join("projects.json")).unwrap(),
            "newest"
        );
        // The older store is left untouched rather than silently discarded.
        assert!(parent.path().join(".floo-network").is_dir());
    }

    #[test]
    fn rename_thread_keeps_the_ulid() {
        let home = home();
        let repo = tempfile::tempdir().unwrap();
        let project = add_project(home.path(), repo.path()).unwrap();
        let thread = create_thread(home.path(), &project.hash, "old").unwrap();
        let renamed = rename_thread(home.path(), &project.hash, &thread.id, "new").unwrap();
        assert_eq!(renamed.id, thread.id);
        assert_eq!(renamed.title, "new");
    }

    // ------------------------------------------------------- auto titling

    #[test]
    fn derive_title_takes_the_first_real_line_and_capitalises_it() {
        assert_eq!(
            derive_title("\n\nadd validation to the orders API\nand then tests"),
            Some("Add validation to the orders API".into())
        );
    }

    /// Prompts routinely open with a markdown heading or a quote marker. The
    /// marker is punctuation, not part of the name.
    #[test]
    fn derive_title_strips_markdown_and_quote_markers() {
        assert_eq!(
            derive_title("## Context\nfix the login redirect"),
            Some("Context".into())
        );
        assert_eq!(derive_title("- fix the login redirect"), Some("Fix the login redirect".into()));
        assert_eq!(derive_title("> quoted\n"), Some("Quoted".into()));
    }

    #[test]
    fn derive_title_truncates_on_a_word_boundary() {
        let title = derive_title(
            "refactor the entire authentication subsystem and every one of its callers",
        )
        .unwrap();
        assert!(title.ends_with('…'), "{title}");
        assert!(title.chars().count() <= 50, "{title}");
        assert!(!title.contains("callers"));
    }

    #[test]
    fn derive_title_gives_up_rather_than_naming_a_thread_badly() {
        assert_eq!(derive_title(""), None);
        assert_eq!(derive_title("   \n\n  "), None);
    }

    #[test]
    fn a_new_threads_first_turn_names_it_and_later_turns_do_not_rename_it() {
        let home = home();
        let repo = tempfile::tempdir().unwrap();
        let project = add_project(home.path(), repo.path()).unwrap();
        let thread = create_thread(home.path(), &project.hash, "New thread").unwrap();

        set_auto_title(home.path(), &project.hash, &thread.id, "add order validation", None).unwrap();
        let named = list_threads(home.path(), &project.hash).unwrap().remove(0);
        assert_eq!(named.title, "Add order validation");
        assert_eq!(named.title_source, "auto");

        set_auto_title(home.path(), &project.hash, &thread.id, "now also fix the tests", None).unwrap();
        let after = list_threads(home.path(), &project.hash).unwrap().remove(0);
        assert_eq!(after.title, "Add order validation", "the second turn must not rename it");
    }

    /// The model writes the name when it is up; trimming the prompt is only
    /// the fallback, because a trimmed prompt makes a long, clumsy title.
    #[test]
    fn a_model_written_title_wins_over_the_trimmed_prompt() {
        let home = home();
        let repo = tempfile::tempdir().unwrap();
        let project = add_project(home.path(), repo.path()).unwrap();
        let thread = create_thread(home.path(), &project.hash, "New thread").unwrap();

        set_auto_title(
            home.path(),
            &project.hash,
            &thread.id,
            "the login page redirects to a 404 after signing in with google, can you look into it",
            Some("Fix Google sign-in redirect"),
        )
        .unwrap();

        let named = list_threads(home.path(), &project.hash).unwrap().remove(0);
        assert_eq!(named.title, "Fix Google sign-in redirect");
    }

    /// Background titling only starts for a thread still on its placeholder:
    /// once named — by an earlier turn or by the user — later turns skip it.
    #[test]
    fn only_a_placeholder_titled_thread_needs_an_auto_title() {
        let home = home();
        let repo = tempfile::tempdir().unwrap();
        let project = add_project(home.path(), repo.path()).unwrap();
        let named = create_thread(home.path(), &project.hash, "New thread").unwrap();
        let renamed = create_thread(home.path(), &project.hash, "New thread").unwrap();
        assert!(needs_auto_title(&named));

        set_auto_title(home.path(), &project.hash, &named.id, "add order validation", None).unwrap();
        rename_thread(home.path(), &project.hash, &renamed.id, "My own name").unwrap();

        for thread in list_threads(home.path(), &project.hash).unwrap() {
            assert!(!needs_auto_title(&thread), "{} should keep its name", thread.title);
        }
    }

    /// A name the user typed is theirs. Auto-titling never overwrites it.
    #[test]
    fn a_manually_renamed_thread_is_never_auto_titled() {
        let home = home();
        let repo = tempfile::tempdir().unwrap();
        let project = add_project(home.path(), repo.path()).unwrap();
        let thread = create_thread(home.path(), &project.hash, "New thread").unwrap();

        rename_thread(home.path(), &project.hash, &thread.id, "My own name").unwrap();
        set_auto_title(home.path(), &project.hash, &thread.id, "add order validation", None).unwrap();

        let after = list_threads(home.path(), &project.hash).unwrap().remove(0);
        assert_eq!(after.title, "My own name");
        assert_eq!(after.title_source, "manual");
    }

    /// Threads written before auto-titling existed carry names their users
    /// typed — reading one back must not mark it Palisade's to rename.
    #[test]
    fn a_thread_from_before_auto_titling_defaults_to_manual() {
        let meta: ThreadMeta = serde_json::from_str(
            r#"{"id":"01A","projectHash":"h","title":"Hand named","createdAt":"t",
                "updatedAt":"t","currentMode":"spec","openSpecChangeName":null}"#,
        )
        .unwrap();

        assert_eq!(meta.title_source, "manual");
        assert_eq!(meta.worktree_path, None);
    }
}
