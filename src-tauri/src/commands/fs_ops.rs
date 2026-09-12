use crate::executor::Harness;
use crate::settings;
use crate::project_path::ProjectPath;
use crate::{project_root, DirEntry, Res};
use tauri::Manager;

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use crate::locks::MutexExt;

/// Shared by `list_directory` and `list_all_files` so the two entry points
/// can't drift on which dirs/files they hide. `.git` is always hidden (huge,
/// never a browsable project file); with `include_hidden` the rest of the
/// usual dotfile/build-output skip list is left in for the caller to see
/// (the tree's "Show Hidden Files" toggle) — not real `.gitignore` parsing,
/// just the same skip rule inverted.
pub(crate) fn should_skip_entry(name: &str, include_hidden: bool) -> bool {
    if name == ".git" {
        return true;
    }
    if include_hidden {
        return false;
    }
    // `__pycache__` joins node_modules/target as generated build output: not
    // worth listing, and — because a test run writes into it — not a change
    // the UI should react to either. Left out of this list, a pytest run
    // reported its own `.pyc` writes as source edits and flagged its own
    // results as stale the moment it finished.
    // Palisade's own code-graph output. `list_all_files` asks git what to
    // ignore, and `ensure_graph_ignored` adds this directory to `.gitignore`
    // — but a project that is not a git repo has neither, and the cache's
    // 64-character filenames then flooded the `@` mention menu and ⌘P with
    // an artifact the app itself wrote. Palisade knows this name; it should
    // not need git to hide it.
    name.starts_with('.')
        || name == "node_modules"
        || name == "target"
        || name == "__pycache__"
        || name == crate::integrations::GRAPH_DIR
}

#[tauri::command]
pub async fn list_directory(
    project_hash: String,
    relative_path: String,
    include_hidden: bool,
) -> Res<Vec<DirEntry>> {
    tokio::task::spawn_blocking(move || {
        let root = project_root(&project_hash)?;
        let target = ProjectPath::existing(&root, &relative_path)?.into_path_buf();
        let mut entries: Vec<DirEntry> = Vec::new();
        for entry in std::fs::read_dir(&target).map_err(|e| crate::PalisadeError::from(format!("cannot read directory: {e}")))? {
            let entry = entry.map_err(|e| crate::PalisadeError::from(format!("cannot read entry: {e}")))?;
            let name = entry.file_name().to_string_lossy().to_string();
            if should_skip_entry(&name, include_hidden) {
                continue;
            }
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            let full = entry.path();
            let path = full
                .strip_prefix(&root)
                .unwrap_or(&full)
                .to_string_lossy()
                .to_string();
            entries.push(DirEntry { name, is_dir, path });
        }
        entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));
        Ok(entries)
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

/// Recursive file listing for the fuzzy file-open palette (task 5.2). Applies
/// the same skip rules as `list_directory` (dotfiles, node_modules, target)
/// rather than a full `.gitignore` parser — matches what the tree already hides.
#[tauri::command]
pub async fn list_all_files(project_hash: String) -> Res<Vec<String>> {
    tokio::task::spawn_blocking(move || {
        let root = project_root(&project_hash)?;
        // FIL-02: the hardcoded skip list above misses project-specific
        // `.gitignore` entries (e.g. `graphify-out/`) — ask git what it
        // would ignore so a generated-cache tree doesn't leak into the
        // fuzzy-find palette. Empty outside a git repo; the walk still runs.
        let ignored = crate::git_bin()
            .map(|bin| crate::git::ignored_paths(&bin, &root))
            .unwrap_or_default();
        let mut files = Vec::new();
        let mut stack = vec![root.clone()];
        while let Some(dir) = stack.pop() {
            let Ok(read_dir) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in read_dir.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if should_skip_entry(&name, false) {
                    continue;
                }
                let full = entry.path();
                let rel = full
                    .strip_prefix(&root)
                    .unwrap_or(&full)
                    .to_string_lossy()
                    .to_string();
                let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
                let ignore_key = if is_dir { format!("{rel}/") } else { rel.clone() };
                if ignored.contains(&ignore_key) {
                    continue;
                }
                if is_dir {
                    stack.push(full);
                } else {
                    files.push(rel);
                }
            }
        }
        files.sort();
        Ok(files)
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct TextMatch {
    path: String,
    line: usize,
    text: String,
}

/// Raised from 200: at the old cap a common word stopped the walk a
/// fraction of the way into a real repo, and silently — the UI had no way
/// to say the list was cut short.
const MAX_TEXT_MATCHES: usize = 1000;

/// How the query is interpreted. Defaults match the old behaviour exactly
/// (case-insensitive substring), so existing callers see no change.
#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct SearchOptions {
    pub regex: bool,
    pub case_sensitive: bool,
    pub whole_word: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TextSearchResult {
    matches: Vec<TextMatch>,
    /// The walk stopped at the cap — there are more matches than these.
    truncated: bool,
}

/// A compiled query. `Substring` keeps the plain path allocation-light for
/// the common case rather than routing everything through the regex engine.
enum Matcher {
    Substring(String),
    Pattern(regex::Regex),
}

impl Matcher {
    fn build(query: &str, options: SearchOptions) -> Res<Self> {
        if !options.regex && !options.whole_word {
            return Ok(if options.case_sensitive {
                Matcher::Substring(query.to_string())
            } else {
                Matcher::Substring(query.to_lowercase())
            });
        }
        // Whole-word wraps whatever the user typed in boundaries; a literal
        // query has to be escaped first or its punctuation becomes syntax.
        let body = if options.regex {
            query.to_string()
        } else {
            regex::escape(query)
        };
        let pattern = if options.whole_word {
            format!(r"\b(?:{body})\b")
        } else {
            body
        };
        regex::RegexBuilder::new(&pattern)
            .case_insensitive(!options.case_sensitive)
            .build()
            // The user is mid-typing a regex most of the time this fires,
            // so it reports as a normal error rather than panicking.
            .map(Matcher::Pattern)
            .map_err(|err| crate::PalisadeError::from(format!("invalid search pattern: {err}")))
    }

    fn is_match(&self, line: &str, case_sensitive: bool) -> bool {
        match self {
            Matcher::Substring(needle) => {
                if case_sensitive {
                    line.contains(needle.as_str())
                } else {
                    line.to_lowercase().contains(needle.as_str())
                }
            }
            Matcher::Pattern(pattern) => pattern.is_match(line),
        }
    }
}

/// Walks `root` with the same skip rules as `list_all_files`, returning every
/// line matching `query`, capped at `MAX_TEXT_MATCHES`. Files that fail UTF-8
/// decoding (binaries, images) are silently skipped.
pub(crate) fn search_text_in(root: &Path, query: &str, options: SearchOptions) -> Res<TextSearchResult> {
    let mut matches = Vec::new();
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(TextSearchResult { matches, truncated: false });
    }
    let matcher = Matcher::build(trimmed, options)?;
    let mut truncated = false;

    let mut stack = vec![root.to_path_buf()];
    'walk: while let Some(dir) = stack.pop() {
        let Ok(read_dir) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in read_dir.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if should_skip_entry(&name, false) {
                continue;
            }
            let full = entry.path();
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                stack.push(full);
                continue;
            }
            let Ok(content) = std::fs::read_to_string(&full) else {
                continue;
            };
            let rel = full
                .strip_prefix(root)
                .unwrap_or(&full)
                .to_string_lossy()
                .to_string();
            for (i, line) in content.lines().enumerate() {
                if matcher.is_match(line, options.case_sensitive) {
                    matches.push(TextMatch {
                        path: rel.clone(),
                        line: i + 1,
                        text: line.trim().to_string(),
                    });
                    if matches.len() >= MAX_TEXT_MATCHES {
                        truncated = true;
                        break 'walk;
                    }
                }
            }
        }
    }
    Ok(TextSearchResult { matches, truncated })
}

#[tauri::command]
pub async fn search_text(
    project_hash: String,
    query: String,
    options: Option<SearchOptions>,
) -> Res<TextSearchResult> {
    tokio::task::spawn_blocking(move || {
        let root = project_root(&project_hash)?;
        search_text_in(&root, &query, options.unwrap_or_default())
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

/// Resolves `relative_path` against `root`, requiring it to already exist
/// and stay inside the project.
pub(crate) fn resolve_existing_path(root: &Path, relative_path: &str) -> Res<PathBuf> {
    Ok(ProjectPath::existing(root, relative_path)?.into_path_buf())
}

/// Above this, a file is refused rather than loaded. The whole document
/// crosses IPC and becomes one CodeMirror doc, so a multi-megabyte file
/// hangs the command thread and then the editor — better to say so.
const MAX_EDITABLE_BYTES: u64 = 8 * 1024 * 1024;

/// Distinguishable prefixes so the frontend can explain *why* a file didn't
/// open, instead of showing a generic read error for a perfectly healthy
/// 40 MB log or a `.png` that wandered out of the media list.
pub(crate) const TOO_LARGE_PREFIX: &str = "TOO_LARGE:";
pub(crate) const BINARY_PREFIX: &str = "BINARY:";

/// A NUL byte in the first few KB means this isn't text. Same heuristic
/// `git` uses to decide a file is binary, and it costs one short read.
pub(crate) fn looks_binary(path: &Path) -> bool {
    use std::io::Read;
    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    let mut head = [0u8; 8000];
    match file.read(&mut head) {
        Ok(n) => head[..n].contains(&0),
        Err(_) => false,
    }
}

#[tauri::command]
pub async fn read_file_content(
    project_hash: String,
    relative_path: String,
    thread_id: Option<String>,
) -> Res<String> {
    tokio::task::spawn_blocking(move || {
        // Same contract as the `git_*` commands: `thread_id` names the tree
        // to read, so a view rendered from a thread's worktree reads that
        // worktree instead of the project root's copy of the same path.
        let root = super::git_cmds::tree_root(&project_hash, thread_id.as_deref())?;
        let resolved = resolve_existing_path(&root, &relative_path)?;

        let size = std::fs::metadata(&resolved)
            .map_err(|err| crate::PalisadeError::from(format!("cannot read file: {err}")))?
            .len();
        if size > MAX_EDITABLE_BYTES {
            return Err(format!("{TOO_LARGE_PREFIX} {size}").into());
        }
        if looks_binary(&resolved) {
            return Err(BINARY_PREFIX.to_string().into());
        }

        std::fs::read_to_string(&resolved)
            .map_err(|err| crate::PalisadeError::from(format!("cannot read file: {err}")))
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

/// Reads a file as base64 for binary previews (images/video/gif) the editor
/// can't render as text.
#[tauri::command]
pub async fn read_file_base64(project_hash: String, relative_path: String) -> Res<String> {
    tokio::task::spawn_blocking(move || {
        use base64::prelude::*;
        let root = project_root(&project_hash)?;
        let resolved = resolve_existing_path(&root, &relative_path)?;
        let bytes = std::fs::read(&resolved).map_err(|err| crate::PalisadeError::from(format!("cannot read file: {err}")))?;
        Ok(BASE64_STANDARD.encode(&bytes))
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

/// Resolves `relative_path` against `root` for creating a file or directory
/// there — unlike `resolve_existing_path`, nothing (or only part of the
/// path) needs to exist yet. Rejects any `..` component outright (a
/// relative path with none can only ever join to somewhere under `root`),
/// then walks up to the nearest ancestor that *does* exist and canonicalizes
/// just that — catching a symlink escape planted partway down an existing
/// subtree — before creating whatever's missing beneath it.
pub(crate) fn resolve_creatable_path(root: &Path, relative_path: &str) -> Res<PathBuf> {
    let target = ProjectPath::creatable(root, relative_path)?.into_path_buf();
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|err| crate::PalisadeError::from(format!("create directory: {err}")))?;
    }
    Ok(target)
}

/// Prefix on the error a stale save returns, so the frontend can tell "your
/// buffer is out of date" apart from a real write failure and offer to
/// reload instead of just reporting it.
pub(crate) const CONFLICT_PREFIX: &str = "CONFLICT:";

/// Tells the filesystem watcher that the change it's about to see is ours,
/// so a save doesn't come straight back as a "changed on disk" banner. A
/// no-op when no project is active or the watcher failed to start.
pub(crate) fn note_self_write(harness: &tauri::State<'_, Harness>, resolved: &Path) {
    // Every open project's watcher (#33). The path is absolute, so only the
    // watcher that actually owns it can see the event this suppresses; the
    // others are told about a path they will never report.
    for watcher in harness.workspace.fswatch.lock_or_recover().values() {
        watcher.note_self_write(resolved);
    }
}

/// Saves the file (creating it, and any missing parent directories, if it
/// doesn't exist yet), then runs any matching `formatOnSave` command (D14)
/// and returns a summary of what it did — `None` when no pattern matched.
///
/// `expected_previous` is the content the caller believes is currently on
/// disk. When supplied and the file says otherwise, the write is refused —
/// the editor's backstop for a change that landed inside the filesystem
/// watcher's debounce window, where the reload banner wouldn't have appeared
/// yet. Callers that legitimately write blind (creating a file, seeding
/// `.palisade/project-settings.json`) pass `None` and are unaffected.
#[tauri::command]
pub async fn write_file_content(
    app: tauri::AppHandle,
    project_hash: String,
    relative_path: String,
    content: String,
    expected_previous: Option<String>,
    thread_id: Option<String>,
) -> Res<Option<String>> {
    tokio::task::spawn_blocking(move || {
        let harness: tauri::State<'_, Harness> = app.state();
        // Writes follow reads: an edit made in a view of a thread's worktree
        // has to land in that worktree, or it silently edits a different file
        // than the one on screen.
        let root = super::git_cmds::tree_root(&project_hash, thread_id.as_deref())?;
        let resolved = resolve_creatable_path(&root, &relative_path)?;

        check_not_stale(&resolved, expected_previous.as_deref(), &relative_path)?;

        // Recorded before the write so the event can't beat us to the watcher.
        note_self_write(&harness, &resolved);
        std::fs::write(&resolved, content).map_err(|err| crate::PalisadeError::from(format!("cannot write file: {err}")))?;

        let (settings, _) = settings::load(&root);
        Ok(settings::run_format_on_save(&settings, &root, &relative_path))
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

/// Refuses a delete that would take the whole project with it. An empty
/// relative path resolves straight to the project root, and `delete_path`
/// recurses — nothing in the UI can ask for that, but this is a reachable
/// IPC command. Both sides are canonicalized so a symlinked project root
/// can't sneak past the comparison.
pub(crate) fn check_not_project_root(root: &Path, target: &Path) -> Res<()> {
    let canonical_root = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let canonical_target = std::fs::canonicalize(target).unwrap_or_else(|_| target.to_path_buf());
    if canonical_target == canonical_root {
        return Err("refusing to delete the project root".into());
    }
    Ok(())
}

/// Refuses a save whose starting point no longer matches the file on disk.
/// `None` means the caller isn't claiming to know the previous content and
/// the write goes through unconditionally, which is what creating a new file
/// does. A file that doesn't exist yet can't be stale, and one that isn't
/// readable as text is left to the write itself to fail on.
pub(crate) fn check_not_stale(resolved: &Path, expected_previous: Option<&str>, relative_path: &str) -> Res<()> {
    let Some(expected) = expected_previous else {
        return Ok(());
    };
    let Ok(on_disk) = std::fs::read_to_string(resolved) else {
        return Ok(());
    };
    if on_disk == expected {
        return Ok(());
    }
    Err(format!(
        "{CONFLICT_PREFIX} {relative_path} changed on disk since you opened it"
    ).into())
}

/// Renames or moves a file or directory within the project (the file
/// palette's rename action — a full relative-path edit doubles as a move,
/// so this is also how "reorganize" works). Refuses to clobber an existing
/// file at the destination.
#[tauri::command]
pub async fn rename_path(
    app: tauri::AppHandle,
    project_hash: String,
    from: String,
    to: String,
) -> Res<()> {
    tokio::task::spawn_blocking(move || {
        let harness: tauri::State<'_, Harness> = app.state();
        let root = project_root(&project_hash)?;
        let source = resolve_existing_path(&root, &from)?;
        let target = resolve_creatable_path(&root, &to)?;
        if target.exists() {
            return Err(format!("{to} already exists").into());
        }
        note_self_write(&harness, &source);
        note_self_write(&harness, &target);
        std::fs::rename(&source, &target).map_err(|err| crate::PalisadeError::from(format!("rename: {err}")))
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

/// Deletes a file or directory (recursively) from the project.
#[tauri::command]
pub async fn delete_path(
    app: tauri::AppHandle,
    project_hash: String,
    relative_path: String,
) -> Res<()> {
    tokio::task::spawn_blocking(move || {
        let harness: tauri::State<'_, Harness> = app.state();
        let root = project_root(&project_hash)?;
        let target = resolve_existing_path(&root, &relative_path)?;
        check_not_project_root(&root, &target)?;
        note_self_write(&harness, &target);
        if target.is_dir() {
            std::fs::remove_dir_all(&target).map_err(|err| crate::PalisadeError::from(format!("delete directory: {err}")))
        } else {
            std::fs::remove_file(&target).map_err(|err| crate::PalisadeError::from(format!("delete file: {err}")))
        }
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

/// Creates a directory (and any missing parents) — the file tree's "New
/// Folder" action.
#[tauri::command]
pub async fn create_directory(project_hash: String, relative_path: String) -> Res<()> {
    tokio::task::spawn_blocking(move || {
        let root = project_root(&project_hash)?;
        let target = resolve_creatable_path(&root, &relative_path)?;
        std::fs::create_dir_all(&target).map_err(|err| crate::PalisadeError::from(format!("create directory: {err}")))
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A project that is not a git repo has no `.gitignore` to consult, and
    /// the code-graph cache used to fill the file palette and the `@` mention
    /// menu with 64-character generated filenames.
    #[test]
    fn generated_output_is_hidden_even_without_a_gitignore() {
        assert!(should_skip_entry(crate::integrations::GRAPH_DIR, false));
        assert!(should_skip_entry("node_modules", false));
        assert!(!should_skip_entry("src", false));
        assert!(!should_skip_entry("README.md", false));
        // "Show hidden files" still reveals it rather than lying to the user.
        assert!(!should_skip_entry(crate::integrations::GRAPH_DIR, true));
        // `.git` is never browsable, hidden files shown or not.
        assert!(should_skip_entry(".git", true));
    }

    #[test]
    fn resolve_creatable_path_allows_creating_a_brand_new_file() {
        let root = tempfile::tempdir().unwrap();
        let canonical_root = std::fs::canonicalize(root.path()).unwrap();
        let resolved = resolve_creatable_path(&canonical_root, "new-file.json").unwrap();
        assert_eq!(resolved, canonical_root.join("new-file.json"));
        assert!(!resolved.exists(), "must not require the file to already exist");
    }

    #[test]
    fn resolve_creatable_path_creates_missing_intermediate_directories() {
        let root = tempfile::tempdir().unwrap();
        let canonical_root = std::fs::canonicalize(root.path()).unwrap();
        let resolved = resolve_creatable_path(&canonical_root, "a/b/c/new-file.json").unwrap();
        assert_eq!(resolved, canonical_root.join("a/b/c/new-file.json"));
        assert!(canonical_root.join("a/b/c").is_dir(), "intermediate dirs must exist for the write");
    }

    #[test]
    fn resolve_creatable_path_rejects_a_parent_directory_traversal() {
        let root = tempfile::tempdir().unwrap();
        let canonical_root = std::fs::canonicalize(root.path()).unwrap();
        let error = resolve_creatable_path(&canonical_root, "../escape.json").unwrap_err();
        assert!(error.contains("stay inside"), "got {error}");
    }

    #[test]
    fn resolve_creatable_path_rejects_an_absolute_path() {
        let root = tempfile::tempdir().unwrap();
        let canonical_root = std::fs::canonicalize(root.path()).unwrap();
        assert!(resolve_creatable_path(&canonical_root, "/etc/passwd").is_err());
    }

    #[test]
    fn resolve_existing_path_requires_the_target_to_already_exist() {
        let root = tempfile::tempdir().unwrap();
        let canonical_root = std::fs::canonicalize(root.path()).unwrap();
        assert!(resolve_existing_path(&canonical_root, "missing.json").is_err());

        std::fs::write(canonical_root.join("present.json"), "{}").unwrap();
        assert_eq!(
            resolve_existing_path(&canonical_root, "present.json").unwrap(),
            canonical_root.join("present.json"),
        );
    }

    #[test]
    fn a_file_with_nul_bytes_is_reported_as_binary_rather_than_a_decode_error() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("thing.bin");
        std::fs::write(&file, [0x89, 0x50, 0x00, 0x4e, 0x47]).unwrap();
        assert!(looks_binary(&file));
    }

    #[test]
    fn ordinary_source_files_are_not_mistaken_for_binary() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("main.rs");
        std::fs::write(&file, "fn main() {\n    println!(\"hi — ünïcode\");\n}\n").unwrap();
        assert!(!looks_binary(&file));
    }

    #[test]
    fn an_empty_file_is_not_binary() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("empty.txt");
        std::fs::write(&file, "").unwrap();
        assert!(!looks_binary(&file));
    }

    #[test]
    fn a_save_whose_starting_point_still_matches_disk_goes_through() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("notes.txt");
        std::fs::write(&file, "line one\n").unwrap();

        assert!(check_not_stale(&file, Some("line one\n"), "notes.txt").is_ok());
    }

    #[test]
    fn a_save_based_on_stale_content_is_refused_as_a_conflict() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("notes.txt");
        std::fs::write(&file, "rewritten by someone else\n").unwrap();

        let error = check_not_stale(&file, Some("line one\n"), "notes.txt").unwrap_err();
        assert!(error.starts_with(CONFLICT_PREFIX), "frontend keys off this prefix: {error}");
        assert!(error.contains("notes.txt"), "got {error}");
    }

    #[test]
    fn a_caller_that_claims_no_starting_point_still_writes_blind() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("notes.txt");
        std::fs::write(&file, "anything at all\n").unwrap();

        assert!(check_not_stale(&file, None, "notes.txt").is_ok());
    }

    #[test]
    fn a_save_that_creates_a_new_file_is_never_stale() {
        let root = tempfile::tempdir().unwrap();
        let missing = root.path().join("brand-new.txt");

        assert!(check_not_stale(&missing, Some(""), "brand-new.txt").is_ok());
    }

    #[test]
    fn deleting_the_project_root_itself_is_refused() {
        let root = tempfile::tempdir().unwrap();
        let canonical_root = std::fs::canonicalize(root.path()).unwrap();
        let resolved = resolve_existing_path(&canonical_root, "").unwrap();

        let error = check_not_project_root(&canonical_root, &resolved).unwrap_err();
        assert!(error.contains("project root"), "got {error}");
    }

    #[test]
    fn deleting_a_file_inside_the_project_is_still_allowed() {
        let root = tempfile::tempdir().unwrap();
        let canonical_root = std::fs::canonicalize(root.path()).unwrap();
        std::fs::write(canonical_root.join("doomed.txt"), "bye").unwrap();
        let resolved = resolve_existing_path(&canonical_root, "doomed.txt").unwrap();

        assert!(check_not_project_root(&canonical_root, &resolved).is_ok());
    }

    fn plain(root: &Path, query: &str) -> Vec<TextMatch> {
        search_text_in(root, query, SearchOptions::default()).unwrap().matches
    }

    fn with(root: &Path, query: &str, options: SearchOptions) -> Vec<TextMatch> {
        search_text_in(root, query, options).unwrap().matches
    }

    #[test]
    fn a_case_sensitive_search_skips_the_other_casing() {
        let root = tempfile::tempdir().unwrap();
        let canonical_root = std::fs::canonicalize(root.path()).unwrap();
        std::fs::write(canonical_root.join("a.txt"), "Needle\nneedle\n").unwrap();

        let found = with(&canonical_root, "needle", SearchOptions { case_sensitive: true, ..Default::default() });
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].line, 2);
    }

    #[test]
    fn a_whole_word_search_does_not_match_inside_a_longer_word() {
        let root = tempfile::tempdir().unwrap();
        let canonical_root = std::fs::canonicalize(root.path()).unwrap();
        std::fs::write(canonical_root.join("a.txt"), "let count = 1;\nrecount()\n").unwrap();

        let found = with(&canonical_root, "count", SearchOptions { whole_word: true, ..Default::default() });
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].line, 1);
    }

    #[test]
    fn a_regex_search_matches_a_pattern_rather_than_a_literal() {
        let root = tempfile::tempdir().unwrap();
        let canonical_root = std::fs::canonicalize(root.path()).unwrap();
        std::fs::write(canonical_root.join("a.rs"), "fn alpha() {}\nfn beta() {}\nlet x = 1;\n").unwrap();

        let found = with(&canonical_root, r"fn \w+\(\)", SearchOptions { regex: true, ..Default::default() });
        assert_eq!(found.len(), 2);
    }

    #[test]
    fn a_literal_search_does_not_treat_punctuation_as_a_pattern() {
        let root = tempfile::tempdir().unwrap();
        let canonical_root = std::fs::canonicalize(root.path()).unwrap();
        std::fs::write(canonical_root.join("a.txt"), "a.b\naxb\n").unwrap();

        let found = with(&canonical_root, "a.b", SearchOptions { whole_word: true, ..Default::default() });
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].text, "a.b");
    }

    #[test]
    fn a_malformed_regex_reports_an_error_instead_of_panicking() {
        let root = tempfile::tempdir().unwrap();
        let canonical_root = std::fs::canonicalize(root.path()).unwrap();
        std::fs::write(canonical_root.join("a.txt"), "anything\n").unwrap();

        let error = search_text_in(&canonical_root, "(foo", SearchOptions { regex: true, ..Default::default() })
            .unwrap_err();
        assert!(error.contains("invalid search pattern"), "got {error}");
    }

    #[test]
    fn hitting_the_match_cap_reports_the_results_as_truncated() {
        let root = tempfile::tempdir().unwrap();
        let canonical_root = std::fs::canonicalize(root.path()).unwrap();
        let many = "needle\n".repeat(MAX_TEXT_MATCHES + 50);
        std::fs::write(canonical_root.join("a.txt"), many).unwrap();

        let result = search_text_in(&canonical_root, "needle", SearchOptions::default()).unwrap();
        assert_eq!(result.matches.len(), MAX_TEXT_MATCHES);
        assert!(result.truncated, "the UI needs to know the list was cut short");
    }

    #[test]
    fn a_result_set_under_the_cap_is_not_reported_as_truncated() {
        let root = tempfile::tempdir().unwrap();
        let canonical_root = std::fs::canonicalize(root.path()).unwrap();
        std::fs::write(canonical_root.join("a.txt"), "needle\n").unwrap();

        let result = search_text_in(&canonical_root, "needle", SearchOptions::default()).unwrap();
        assert!(!result.truncated);
    }

    #[test]
    fn search_text_in_finds_case_insensitive_matches_with_line_numbers() {
        let root = tempfile::tempdir().unwrap();
        let canonical_root = std::fs::canonicalize(root.path()).unwrap();
        std::fs::write(canonical_root.join("a.txt"), "hello\nWorld\nfoo bar\n").unwrap();

        let found = plain(&canonical_root, "world");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].path, "a.txt");
        assert_eq!(found[0].line, 2);
        assert_eq!(found[0].text, "World");
    }

    #[test]
    fn search_text_in_skips_the_same_directories_list_all_files_skips() {
        let root = tempfile::tempdir().unwrap();
        let canonical_root = std::fs::canonicalize(root.path()).unwrap();
        std::fs::create_dir_all(canonical_root.join("node_modules")).unwrap();
        std::fs::write(canonical_root.join("node_modules/dep.js"), "needle\n").unwrap();
        std::fs::write(canonical_root.join("real.js"), "needle\n").unwrap();

        let found = plain(&canonical_root, "needle");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].path, "real.js");
    }

    #[test]
    fn search_text_in_returns_nothing_for_a_blank_query() {
        let root = tempfile::tempdir().unwrap();
        let canonical_root = std::fs::canonicalize(root.path()).unwrap();
        std::fs::write(canonical_root.join("a.txt"), "anything\n").unwrap();
        assert!(plain(&canonical_root, "  ").is_empty());
    }

    #[test]
    fn rename_and_delete_round_trip_a_file() {
        let project_dir = tempfile::tempdir().unwrap();
        let canonical_root = std::fs::canonicalize(project_dir.path()).unwrap();
        std::fs::write(canonical_root.join("old.txt"), "hi").unwrap();

        let source = resolve_existing_path(&canonical_root, "old.txt").unwrap();
        let target = resolve_creatable_path(&canonical_root, "moved/new.txt").unwrap();
        std::fs::rename(&source, &target).unwrap();
        assert!(!canonical_root.join("old.txt").exists());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "hi");

        let to_delete = resolve_existing_path(&canonical_root, "moved/new.txt").unwrap();
        std::fs::remove_file(&to_delete).unwrap();
        assert!(!target.exists());
    }

    #[test]
    fn create_directory_creates_nested_empty_folders() {
        let project_dir = tempfile::tempdir().unwrap();
        let canonical_root = std::fs::canonicalize(project_dir.path()).unwrap();

        let target = resolve_creatable_path(&canonical_root, "src/new/nested").unwrap();
        std::fs::create_dir_all(&target).unwrap();

        assert!(canonical_root.join("src/new/nested").is_dir());
    }

    #[test]
    fn deleting_a_directory_removes_it_recursively() {
        let project_dir = tempfile::tempdir().unwrap();
        let canonical_root = std::fs::canonicalize(project_dir.path()).unwrap();
        std::fs::create_dir_all(canonical_root.join("a/b")).unwrap();
        std::fs::write(canonical_root.join("a/b/file.txt"), "x").unwrap();

        let target = resolve_existing_path(&canonical_root, "a").unwrap();
        assert!(target.is_dir());
        std::fs::remove_dir_all(&target).unwrap();

        assert!(!canonical_root.join("a").exists());
    }
}
