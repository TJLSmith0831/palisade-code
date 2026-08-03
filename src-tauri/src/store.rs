//! On-disk state for Floo Network: the global project index, per-project
//! thread sidecars, append-only JSONL session logs, and project-root notes.
//!
//! Every function takes the floo home directory explicitly rather than
//! reading it from the environment, so tests can point at a tempdir without
//! process-global state. `floo_home()` is only called by the command layer.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub type Res<T> = Result<T, String>;

fn e(ctx: &str, err: impl std::fmt::Display) -> String {
    format!("{ctx}: {err}")
}

/// `~/.floo-network` — the session store, deliberately outside any target repo.
pub fn floo_home() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".floo-network")
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

fn project_dir(home: &Path, hash: &str) -> PathBuf {
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

fn write_json<T: Serialize>(path: &Path, value: &T) -> Res<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| e("create dir", err))?;
    }
    let body = serde_json::to_string_pretty(value).map_err(|err| e("serialize", err))?;
    fs::write(path, body).map_err(|err| e(&format!("write {}", path.display()), err))
}

pub fn list_projects(home: &Path) -> Res<Vec<Project>> {
    let mut projects: Vec<Project> = read_json(&index_path(home))?;
    projects.sort_by(|a, b| b.last_accessed_at.cmp(&a.last_accessed_at));
    Ok(projects)
}

fn save_projects(home: &Path, projects: &[Project]) -> Res<()> {
    write_json(&index_path(home), &projects)
}

/// Register `dir` (or refresh it if already registered) and return its entry.
pub fn add_project(home: &Path, dir: &Path) -> Res<Project> {
    let canonical = fs::canonicalize(dir)
        .map_err(|err| e(&format!("resolve {}", dir.display()), err))?;
    if !canonical.is_dir() {
        return Err(format!("{} is not a directory", canonical.display()));
    }
    let root = canonical.to_string_lossy().to_string();
    let hash = project_hash(&root);

    let mut projects = list_projects(home)?;
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
    Ok(project)
}

fn update_project(home: &Path, hash: &str, f: impl FnOnce(&mut Project)) -> Res<Project> {
    let mut projects = list_projects(home)?;
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ThreadMeta {
    pub id: String,
    pub project_hash: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    /// "spec" | "go"
    pub current_mode: String,
    pub open_spec_change_name: Option<String>,
    /// The executor's own conversation id, so `/go` can carry history forward
    /// after an app restart. Defaulted so pre-existing sidecars still parse.
    #[serde(default)]
    pub executor_session_id: Option<String>,
}

fn meta_path(home: &Path, hash: &str, id: &str) -> PathBuf {
    threads_dir(home, hash).join(format!("{id}.meta.json"))
}

fn log_path(home: &Path, hash: &str, id: &str) -> PathBuf {
    threads_dir(home, hash).join(format!("{id}.jsonl"))
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
        executor_session_id: None,
    };
    fs::create_dir_all(threads_dir(home, hash)).map_err(|err| e("create threads dir", err))?;
    write_json(&meta_path(home, hash, &id), &meta)?;
    File::create(log_path(home, hash, &id)).map_err(|err| e("create session log", err))?;
    Ok(meta)
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

fn update_thread(home: &Path, hash: &str, id: &str, f: impl FnOnce(&mut ThreadMeta)) -> Res<ThreadMeta> {
    let path = meta_path(home, hash, id);
    let body = fs::read_to_string(&path).map_err(|err| e(&format!("unknown thread {id}"), err))?;
    let mut meta: ThreadMeta = serde_json::from_str(&body).map_err(|err| e("parse meta", err))?;
    f(&mut meta);
    meta.updated_at = now();
    write_json(&path, &meta)?;
    Ok(meta)
}

pub fn rename_thread(home: &Path, hash: &str, id: &str, title: &str) -> Res<ThreadMeta> {
    update_thread(home, hash, id, |m| m.title = title.trim().to_string())
}

/// Remember (or forget) the executor conversation backing this thread.
pub fn set_executor_session(home: &Path, hash: &str, id: &str, session: Option<&str>) -> Res<ThreadMeta> {
    update_thread(home, hash, id, |m| {
        m.executor_session_id = session.map(str::to_string)
    })
}

/// Link a thread to the OpenSpec change `/propose` created for it.
pub fn set_open_spec_change(home: &Path, hash: &str, id: &str, change: Option<&str>) -> Res<ThreadMeta> {
    update_thread(home, hash, id, |m| {
        m.open_spec_change_name = change.map(str::to_string)
    })
}

/// Flip a thread between "spec" and "go": persist the new mode and append one
/// `role: "tool"` marker to the session log. No process is spawned here.
pub fn set_thread_mode(home: &Path, hash: &str, id: &str, mode: &str) -> Res<ThreadMeta> {
    if mode != "spec" && mode != "go" {
        return Err(format!("invalid mode: {mode}"));
    }
    let meta = update_thread(home, hash, id, |m| m.current_mode = mode.to_string())?;
    append_message(home, hash, id, "tool", mode, &format!("Switched to {mode} mode"))?;
    Ok(meta)
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
}

/// Append one JSON line to the thread's log and fsync before returning.
pub fn append_message(home: &Path, hash: &str, id: &str, role: &str, mode: &str, content: &str) -> Res<Message> {
    let path = log_path(home, hash, id);
    // ponytail: next seq comes from re-reading the log — O(n) per append, fine
    // for a desktop chat log; cache the tail seq in memory if it ever bites.
    let seq = read_thread(home, hash, id)?.last().map_or(0, |m| m.seq + 1);
    let message = Message {
        seq,
        ts: now(),
        role: role.to_string(),
        mode: mode.to_string(),
        content: content.to_string(),
    };
    let line = serde_json::to_string(&message).map_err(|err| e("serialize message", err))?;

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| e("create thread dir", err))?;
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|err| e(&format!("open {}", path.display()), err))?;
    // A torn write leaves the file without its trailing newline; close that
    // line off first so this message doesn't get glued onto the broken one.
    if !ends_with_newline(&path)? {
        file.write_all(b"\n").map_err(|err| e("close torn line", err))?;
    }
    file.write_all(line.as_bytes()).map_err(|err| e("append message", err))?;
    file.write_all(b"\n").map_err(|err| e("append newline", err))?;
    file.sync_all().map_err(|err| e("fsync session log", err))?;
    Ok(message)
}

fn ends_with_newline(path: &Path) -> Res<bool> {
    use std::io::{Seek, SeekFrom};
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(true),
        Err(err) => return Err(e("open session log", err)),
    };
    let len = file.seek(SeekFrom::End(0)).map_err(|err| e("seek session log", err))?;
    if len == 0 {
        return Ok(true);
    }
    file.seek(SeekFrom::End(-1)).map_err(|err| e("seek session log", err))?;
    let mut last = [0u8; 1];
    file.read_exact(&mut last).map_err(|err| e("read session log", err))?;
    Ok(last[0] == b'\n')
}

/// Read a thread's history in `seq` order. A line that fails to parse — a torn
/// write from an unclean shutdown — is dropped and logged to `harness.log`
/// rather than surfaced to the user.
pub fn read_thread(home: &Path, hash: &str, id: &str) -> Res<Vec<Message>> {
    let path = log_path(home, hash, id);
    let mut body = String::new();
    match File::open(&path) {
        Ok(mut file) => {
            file.read_to_string(&mut body).map_err(|err| e("read session log", err))?;
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(err) => return Err(e("open session log", err)),
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
    Ok(messages)
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

// ------------------------------------------------------------------- notes

/// Notes live in `<project-root>/notes/`. Reject any name that could escape it.
fn note_path(project_root: &Path, name: &str) -> Res<PathBuf> {
    let name = name.trim();
    if name.is_empty() {
        return Err("note name is empty".into());
    }
    let rel = Path::new(name);
    if rel.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err(format!("invalid note name: {name}"));
    }
    let mut rel = rel.to_path_buf();
    if rel.extension().is_none() {
        rel.set_extension("md");
    }
    Ok(project_root.join("notes").join(rel))
}

/// Write a new note immediately (no approval gate) and return its path.
pub fn create_note(project_root: &Path, name: &str) -> Res<String> {
    let path = note_path(project_root, name)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| e("create notes dir", err))?;
    }
    if !path.exists() {
        let title = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        fs::write(&path, format!("# {title}\n\n")).map_err(|err| e("write note", err))?;
    }
    Ok(path.to_string_lossy().to_string())
}

pub fn list_notes(project_root: &Path) -> Res<Vec<String>> {
    let dir = project_root.join("notes");
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(err) => return Err(e("read notes dir", err)),
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter(|entry| entry.path().is_file())
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .collect();
    names.sort();
    Ok(names)
}

pub fn read_note(project_root: &Path, name: &str) -> Res<String> {
    let path = note_path(project_root, name)?;
    fs::read_to_string(&path).map_err(|err| e(&format!("read {}", path.display()), err))
}

/// Auto-save path for hand-edits — same guard, no re-prompt.
pub fn write_note(project_root: &Path, name: &str, content: &str) -> Res<()> {
    let path = note_path(project_root, name)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| e("create notes dir", err))?;
    }
    fs::write(&path, content).map_err(|err| e("write note", err))
}

// ------------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;

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
    fn append_then_read_round_trips_in_seq_order() {
        let home = home();
        let repo = tempfile::tempdir().unwrap();
        let project = add_project(home.path(), repo.path()).unwrap();
        let thread = create_thread(home.path(), &project.hash, "t").unwrap();

        for i in 0..5 {
            append_message(home.path(), &project.hash, &thread.id, "user", "spec", &format!("m{i}")).unwrap();
        }
        let messages = read_thread(home.path(), &project.hash, &thread.id).unwrap();
        assert_eq!(messages.len(), 5);
        assert_eq!(messages.iter().map(|m| m.seq).collect::<Vec<_>>(), vec![0, 1, 2, 3, 4]);
        assert_eq!(messages[3].content, "m3");
    }

    #[test]
    fn torn_trailing_line_is_dropped_and_logged() {
        let home = home();
        let repo = tempfile::tempdir().unwrap();
        let project = add_project(home.path(), repo.path()).unwrap();
        let thread = create_thread(home.path(), &project.hash, "t").unwrap();
        append_message(home.path(), &project.hash, &thread.id, "user", "spec", "good").unwrap();

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
        append_message(home.path(), &project.hash, &thread.id, "user", "spec", "after").unwrap();
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

        let messages = read_thread(home.path(), &project.hash, &thread.id).unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].role, "tool");
        assert_eq!(messages[0].mode, "go");

        set_thread_mode(home.path(), &project.hash, &thread.id, "spec").unwrap();
        let messages = read_thread(home.path(), &project.hash, &thread.id).unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[1].mode, "spec");

        assert!(set_thread_mode(home.path(), &project.hash, &thread.id, "turbo").is_err());
    }

    /// `/go` carries history forward by resuming the executor's own session,
    /// so that id has to outlive the app process, not just the live child.
    #[test]
    fn the_executor_session_id_survives_on_the_sidecar() {
        let home = home();
        let repo = tempfile::tempdir().unwrap();
        let project = add_project(home.path(), repo.path()).unwrap();
        let thread = create_thread(home.path(), &project.hash, "t").unwrap();
        assert_eq!(thread.executor_session_id, None);

        set_executor_session(home.path(), &project.hash, &thread.id, Some("sess-1")).unwrap();
        // Re-reading from disk is what a restarted app actually does.
        let reloaded = list_threads(home.path(), &project.hash).unwrap();
        assert_eq!(reloaded[0].executor_session_id.as_deref(), Some("sess-1"));

        // A crash clears it so the next attempt isn't stuck resuming a session
        // the executor may no longer have.
        set_executor_session(home.path(), &project.hash, &thread.id, None).unwrap();
        let reloaded = list_threads(home.path(), &project.hash).unwrap();
        assert_eq!(reloaded[0].executor_session_id, None);
    }

    /// Sidecars written before this field existed must still load.
    #[test]
    fn a_sidecar_without_the_session_field_still_parses() {
        let legacy = r#"{
            "id": "01ABC", "projectHash": "h", "title": "t",
            "createdAt": "2026-08-03T00:00:00+00:00", "updatedAt": "2026-08-03T00:00:00+00:00",
            "currentMode": "spec", "openSpecChangeName": null
        }"#;
        let meta: ThreadMeta = serde_json::from_str(legacy).unwrap();
        assert_eq!(meta.executor_session_id, None);
        assert_eq!(meta.current_mode, "spec");
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

    #[test]
    fn notes_land_under_the_project_root_and_cannot_escape() {
        let repo = tempfile::tempdir().unwrap();
        let path = create_note(repo.path(), "design ideas").unwrap();
        assert!(path.ends_with("notes/design ideas.md"), "got {path}");
        assert_eq!(list_notes(repo.path()).unwrap(), vec!["design ideas.md"]);

        write_note(repo.path(), "design ideas", "# edited\n").unwrap();
        assert_eq!(read_note(repo.path(), "design ideas").unwrap(), "# edited\n");

        assert!(create_note(repo.path(), "../escape.md").is_err());
        assert!(create_note(repo.path(), "/etc/passwd").is_err());
        assert!(create_note(repo.path(), "  ").is_err());
    }

    #[test]
    fn creating_an_existing_note_does_not_clobber_it() {
        let repo = tempfile::tempdir().unwrap();
        create_note(repo.path(), "keep.md").unwrap();
        write_note(repo.path(), "keep.md", "important").unwrap();
        create_note(repo.path(), "keep.md").unwrap();
        assert_eq!(read_note(repo.path(), "keep.md").unwrap(), "important");
    }
}
