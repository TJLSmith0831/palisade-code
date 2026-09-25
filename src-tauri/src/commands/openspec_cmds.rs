use crate::spec_root;
use crate::executor;
use crate::executor::Harness;
use crate::store;
use crate::{Res, ThreadMeta};
use tauri::Manager;

/// Read-only. Every one of these asks the `openspec` CLI and renders what it
/// says; nothing here writes a spec file, and nothing here writes to
/// `~/.palisade-code` (task 4.5). Palisade's only durable spec state stays the one
/// reference string on `ThreadMeta`.
///
/// OPE-01: an agent's proposal lands in the thread's isolated git worktree,
/// not the main project root — without `thread_id`, this always read the
/// project root and reported "no changes" for a real, on-disk proposal.
/// `spec_root` resolves the worktree once it holds the thread's change,
/// falling back to the project root (where spec sessions write) otherwise.
#[tauri::command]
pub async fn list_spec_changes(
    app: tauri::AppHandle,
    project_hash: String,
    thread_id: Option<String>,
) -> Res<Vec<executor::SpecChange>> {
    let cache = app.state::<Harness>().workspace.openspec_cache.clone();
    tokio::task::spawn_blocking(move || {
        Ok(executor::openspec_list(&cache, &spec_root(&project_hash, thread_id.as_deref())?))
    })
    .await
    .map_err(crate::PalisadeError::from)?
}

#[tauri::command]
pub async fn show_spec_change(
    app: tauri::AppHandle,
    project_hash: String,
    thread_id: Option<String>,
    name: String,
) -> Res<Option<serde_json::Value>> {
    let cache = app.state::<Harness>().workspace.openspec_cache.clone();
    tokio::task::spawn_blocking(move || {
        Ok(executor::openspec_show(&cache, &spec_root(&project_hash, thread_id.as_deref())?, &name))
    })
    .await
    .map_err(crate::PalisadeError::from)?
}

/// `None` when `openspec` isn't installed — "we can't tell", which is a
/// different answer from "invalid" and must not be rendered as one.
#[tauri::command]
pub async fn validate_spec_changes(
    app: tauri::AppHandle,
    project_hash: String,
    thread_id: Option<String>,
) -> Res<Option<bool>> {
    let cache = app.state::<Harness>().workspace.openspec_cache.clone();
    tokio::task::spawn_blocking(move || {
        Ok(executor::openspec_validate(&cache, &spec_root(&project_hash, thread_id.as_deref())?))
    })
    .await
    .map_err(crate::PalisadeError::from)?
}

#[tauri::command]
pub async fn archive_spec_change(
    app: tauri::AppHandle,
    project_hash: String,
    thread_id: Option<String>,
    name: String,
) -> Res<String> {
    let cache = app.state::<Harness>().workspace.openspec_cache.clone();
    tokio::task::spawn_blocking(move || {
        let root = crate::project_root(&project_hash)?;
        // The Specs panel passes the thread on screen, which need not be the
        // one that built this change: pull from every thread linked to it.
        let mut trees = vec![spec_root(&project_hash, thread_id.as_deref())?];
        for t in store::list_threads(&store::palisade_home(), &project_hash)? {
            if t.open_spec_change_name.as_deref() == Some(name.as_str()) {
                trees.extend(t.worktree_path.map(std::path::PathBuf::from));
            }
        }
        trees.retain(|t| *t != root);
        trees.sort();
        trees.dedup();
        archive_via_root(&cache, &root, &trees, &name)
    })
    .await
    .map_err(crate::PalisadeError::from)?
}

/// Set the thread's spec link by hand — how the user resolves the ambiguity
/// `spec-link-ambiguous` reports.
#[tauri::command]
pub async fn set_spec_change(
    project_hash: String,
    thread_id: String,
    name: Option<String>,
) -> Res<ThreadMeta> {
    tokio::task::spawn_blocking(move || {
        store::set_open_spec_change(&store::palisade_home(), &project_hash, &thread_id, name.as_deref())
    })
    .await
    .map_err(crate::PalisadeError::from)?
}

/// Archive `name` in the project root, which is the source of truth for
/// OpenSpec. A build's worktree holds the newer copy (ticked tasks): pull
/// each one into the root first, archive there, then drop the worktree
/// copies so a later commit and merge can't bring the archived change back.
pub(crate) fn archive_via_root(
    cache: &crate::openspec_cache::OpenSpecCache,
    root: &std::path::Path,
    trees: &[std::path::PathBuf],
    name: &str,
) -> Res<String> {
    for tree in trees {
        // A failed pull must stop here: removing the worktree copy below
        // would otherwise throw away the only record of its ticked tasks.
        crate::sync_change(tree, root, name)
            .map_err(|err| crate::PalisadeError::from(format!("could not copy {name} into the project root: {err}")))?;
    }
    let archived = executor::openspec_archive(cache, root, name)?;
    for tree in trees {
        let _ = std::fs::remove_dir_all(tree.join(crate::change_dir(name)));
    }
    Ok(archived)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::openspec_cache::{OpenSpecAdapter, OpenSpecCache, OpenSpecError, OpenSpecResult};
    use std::path::Path;
    use std::sync::{Arc, Mutex};

    /// Records the tasks.md the root holds at the moment the CLI is asked to archive.
    struct Recording(Mutex<Option<String>>);
    impl OpenSpecAdapter for Recording {
        fn list(&self, _: &Path) -> OpenSpecResult { Err(OpenSpecError::NotInstalled) }
        fn show(&self, _: &Path, _: &str) -> OpenSpecResult { Err(OpenSpecError::NotInstalled) }
        fn status(&self, _: &Path, _: &str) -> OpenSpecResult { Err(OpenSpecError::NotInstalled) }
        fn validate(&self, _: &Path) -> OpenSpecResult { Err(OpenSpecError::NotInstalled) }
        fn archive(&self, root: &Path, name: &str) -> OpenSpecResult {
            let tasks = root.join("openspec/changes").join(name).join("tasks.md");
            *self.0.lock().unwrap() = std::fs::read_to_string(tasks).ok();
            Ok("archived".into())
        }
    }

    #[test]
    fn archiving_a_built_change_archives_the_worktrees_progress_and_leaves_no_live_copy() {
        let root = tempfile::tempdir().unwrap();
        let tree = tempfile::tempdir().unwrap();
        for (base, tasks) in [(root.path(), "- [ ] t"), (tree.path(), "- [x] t")] {
            let dir = base.join("openspec/changes/c");
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("tasks.md"), tasks).unwrap();
        }
        let adapter = Arc::new(Recording(Mutex::new(None)));
        let cache = OpenSpecCache::new(adapter.clone());

        archive_via_root(&cache, root.path(), &[tree.path().into()], "c").unwrap();

        assert_eq!(adapter.0.lock().unwrap().as_deref(), Some("- [x] t"), "the CLI must see the worktree's ticks");
        assert!(!tree.path().join("openspec/changes/c").exists(), "the worktree copy must not survive to be merged back");
    }

    #[test]
    fn a_failed_pull_keeps_the_worktree_copy_and_does_not_archive() {
        let root = tempfile::tempdir().unwrap();
        let tree = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("openspec/changes")).unwrap();
        // A file where the change directory should go makes the copy fail.
        std::fs::write(root.path().join("openspec/changes/c"), "").unwrap();
        let dir = tree.path().join("openspec/changes/c");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("tasks.md"), "- [x] t").unwrap();
        let adapter = Arc::new(Recording(Mutex::new(None)));
        let cache = OpenSpecCache::new(adapter.clone());

        assert!(archive_via_root(&cache, root.path(), &[tree.path().into()], "c").is_err());
        assert!(dir.join("tasks.md").exists(), "the ticked copy must survive a failed pull");
    }

    #[test]
    fn archiving_without_a_worktree_copy_leaves_the_root_alone_but_for_the_cli() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("openspec/changes/c");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("tasks.md"), "- [ ] t").unwrap();
        let adapter = Arc::new(Recording(Mutex::new(None)));
        let cache = OpenSpecCache::new(adapter.clone());

        archive_via_root(&cache, root.path(), &[], "c").unwrap();

        assert_eq!(adapter.0.lock().unwrap().as_deref(), Some("- [ ] t"));
        assert!(dir.exists(), "same tree: nothing to remove; the CLI owns the move");
    }
}
