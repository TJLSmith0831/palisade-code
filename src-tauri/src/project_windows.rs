//! Saved-project lifecycle and native window configuration.
use crate::{executor::Harness, store, Res};
use std::collections::HashSet;
use std::path::Path;

/// Record which project a window is showing. Several windows may share one
/// project (#33), so watchers are keyed by project, not by window.
pub fn track(harness: &Harness, window_label: &str, hash: &str) {
    harness
        .workspace.window_projects
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(window_label.to_string(), hash.to_string());
}

/// A window closed. Its project keeps its watchers only if another window is
/// still showing it.
pub fn untrack(harness: &Harness, window_label: &str) {
    harness
        .workspace.window_projects
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(window_label);
}

/// The window already showing `hash`, if any.
///
/// VS Code's rule, and the one users expect: opening a project that is
/// already open focuses that window instead of putting a second copy of the
/// same project on screen. Two windows on one project still happen when the
/// user asks for them from inside that project — this only stops the
/// accidental duplicate from the recents list.
pub fn window_showing(harness: &Harness, hash: &str) -> Option<String> {
    harness
        .workspace.window_projects
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .find(|(_, open)| open.as_str() == hash)
        .map(|(label, _)| label.clone())
}

/// Every project some window is currently showing.
pub fn open_project_hashes(harness: &Harness) -> HashSet<String> {
    harness
        .workspace.window_projects
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .values()
        .cloned()
        .collect()
}

/// Drop watchers for projects no window is showing any more. Called after
/// every switch and window close, so a long session does not accumulate one
/// `graphify watch` process per project the user has ever opened.
pub fn retire_unwatched(harness: &Harness) {
    let open = open_project_hashes(harness);
    harness
        .workspace.watch
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .retain(|hash, _| open.contains(hash));
    harness
        .workspace.fswatch
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .retain(|hash, _| open.contains(hash));
}

pub fn window_config(home: &Path, hash: &str) -> Res<tauri::utils::config::WindowConfig> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT_WINDOW: AtomicU64 = AtomicU64::new(1);
    let project = store::list_projects(home)?.into_iter()
        .find(|p| p.hash == hash).ok_or_else(|| format!("unknown project: {hash}"))?;
    Ok(tauri::utils::config::WindowConfig {
        label: format!("project-{}", NEXT_WINDOW.fetch_add(1, Ordering::Relaxed)),
        title: format!("{} — Palisade Code", project.display_name),
        url: tauri::WebviewUrl::App(format!("index.html?project={hash}").into()),
        width: 1280.0,
        height: 800.0,
        min_width: Some(800.0),
        min_height: Some(500.0),
        decorations: false,
        ..Default::default()
    })
}

pub fn remove_saved_project(home: &Path, harness: &Harness, hash: &str) -> Res<()> {
    {
        let sessions = harness.agent.acp_sessions.lock().unwrap_or_else(|e| e.into_inner());
        if sessions.values().any(|s| s.project_hash == hash && s.is_busy()) {
            return Err("This project has a turn in progress. Wait for it to finish before removing it.".into());
        }
    }
    store::remove_project(home, hash)
}

#[cfg(test)]
mod tests {
    use crate::locks::MutexExt;
    use super::*;

    #[test]
    fn removal_rejects_a_busy_project_but_not_other_projects() {
        let home = tempfile::tempdir().unwrap();
        let repo = tempfile::tempdir().unwrap();
        let project = store::add_project(home.path(), repo.path()).unwrap();
        let harness = Harness::default();
        let (mut session, _receiver) = crate::acp_client::stub_session(true);
        session.project_hash = project.hash.clone();
        harness.agent.acp_sessions.lock_or_recover().insert(session.id.clone(), session);
        assert!(remove_saved_project(home.path(), &harness, &project.hash).unwrap_err().contains("turn in progress"));
        assert_eq!(store::list_projects(home.path()).unwrap().len(), 1);
        harness.agent.acp_sessions.lock_or_recover().clear();
        let (session, _receiver) = crate::acp_client::stub_session(true);
        harness.agent.acp_sessions.lock_or_recover().insert(session.id.clone(), session);
        remove_saved_project(home.path(), &harness, &project.hash).unwrap();
        assert!(store::list_projects(home.path()).unwrap().is_empty());
    }

    /// #33: watchers used to live in a single slot, so opening a second
    /// project window stopped watching the first project's files.
    #[test]
    fn each_open_window_keeps_its_own_projects_watchers() {
        let harness = Harness::default();
        track(&harness, "main", "aaa");
        track(&harness, "project-1", "bbb");
        harness.workspace.fswatch.lock_or_recover().insert("aaa".into(), stub_fs_watcher());
        harness.workspace.fswatch.lock_or_recover().insert("bbb".into(), stub_fs_watcher());

        retire_unwatched(&harness);
        assert_eq!(harness.workspace.fswatch.lock_or_recover().len(), 2);

        // Closing the second window retires only that window's watcher.
        untrack(&harness, "project-1");
        retire_unwatched(&harness);
        let watching = harness.workspace.fswatch.lock_or_recover();
        assert!(watching.contains_key("aaa"));
        assert!(!watching.contains_key("bbb"));
    }

    /// Two windows on the same project share one watcher, and closing one of
    /// them must not stop the other window from seeing file changes.
    #[test]
    fn a_shared_project_keeps_its_watcher_until_the_last_window_closes() {
        let harness = Harness::default();
        track(&harness, "main", "aaa");
        track(&harness, "project-1", "aaa");
        harness.workspace.fswatch.lock_or_recover().insert("aaa".into(), stub_fs_watcher());

        untrack(&harness, "project-1");
        retire_unwatched(&harness);
        assert!(harness.workspace.fswatch.lock_or_recover().contains_key("aaa"));

        untrack(&harness, "main");
        retire_unwatched(&harness);
        assert!(harness.workspace.fswatch.lock_or_recover().is_empty());
    }

    /// VS Code focuses the window a project is already open in rather than
    /// opening a second copy of it.
    #[test]
    fn an_already_open_project_names_the_window_showing_it() {
        let harness = Harness::default();
        assert_eq!(window_showing(&harness, "aaa"), None);
        track(&harness, "main", "aaa");
        assert_eq!(window_showing(&harness, "aaa"), Some("main".into()));
        assert_eq!(window_showing(&harness, "bbb"), None);
        // A window that moved to another project no longer claims the old one.
        track(&harness, "main", "bbb");
        assert_eq!(window_showing(&harness, "aaa"), None);
        untrack(&harness, "main");
        assert_eq!(window_showing(&harness, "bbb"), None);
    }

    fn stub_fs_watcher() -> crate::fswatch::FsWatcher {
        crate::fswatch::FsWatcher::spawn(
            tempfile::tempdir().unwrap().keep(),
            |_| {},
            |_| {},
        )
    }

    #[test]
    fn project_windows_are_independent_and_load_the_requested_project() {
        let home = tempfile::tempdir().unwrap();
        let repo = tempfile::tempdir().unwrap();
        let project = store::add_project(home.path(), repo.path()).unwrap();
        let first = window_config(home.path(), &project.hash).unwrap();
        let second = window_config(home.path(), &project.hash).unwrap();
        assert_ne!(first.label, second.label);
        assert_eq!(first.url, tauri::WebviewUrl::App(format!("index.html?project={}", project.hash).into()));
        assert!(!first.decorations);
        assert!(first.min_width.unwrap() >= 800.0);
        assert!(window_config(home.path(), "missing").is_err());
    }
}
