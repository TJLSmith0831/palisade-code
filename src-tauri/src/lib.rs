mod acp_client;
mod attachments;
mod acp_events;
mod acp_preflight;
mod acp_registry;
mod agent_usage;
mod chain_exec;
mod chain_runner;
mod chains;
mod chain_history;
mod completion;
mod db;
mod error;
mod executor;
mod grill_inject;
mod handoff;
mod permissions;
mod fleet;
mod fswatch;
mod git;
mod git_repo;
mod locks;
mod lsp;
mod mcp;
mod native_menu;
mod notebook;
mod pidguard;
mod session_log_writer;
mod openspec_cache;
mod settings;
mod skills;
mod store;
mod project_path;
mod project_windows;
mod dap;
mod terminal;
mod test_parse;
mod plugins;
mod commands;

use plugins::mac_rounded_corners;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use tauri::{Emitter, Manager};

#[tauri::command]
fn sync_native_menu(
    menu: tauri::State<'_, native_menu::NativeMenu<tauri::Wry>>,
    states: std::collections::HashMap<String, native_menu::CommandState>,
) {
    menu.sync(states);
}

/// Process-wide unsaved-buffer state. Each webview reports only its own state;
/// quit collects every dirty Palisade window before allowing process exit.
#[derive(Default)]
struct QuitRegistry {
    dirty_windows: Mutex<std::collections::HashMap<String, bool>>,
    pending_confirmations: Mutex<Option<std::collections::HashSet<String>>>,
}

impl QuitRegistry {
    /// `live` is the set of window labels that still exist. A webview that is
    /// destroyed never runs its unmount cleanup, so its dirty flag would
    /// otherwise linger and block every later quit on a window nobody can
    /// answer for.
    fn begin_quit(&self, live: &std::collections::HashSet<String>) -> std::collections::HashSet<String> {
        let mut windows = self.dirty_windows.lock().expect("quit registry dirty lock poisoned");
        windows.retain(|label, _| live.contains(label));
        let dirty = windows.iter().filter_map(|(label, dirty)| dirty.then_some(label.clone())).collect::<std::collections::HashSet<_>>();
        drop(windows);
        *self.pending_confirmations.lock().expect("quit registry pending lock poisoned") = (!dirty.is_empty()).then_some(dirty.clone());
        dirty
    }

    /// Returns true only when this confirmation completes every dirty window.
    fn confirm(&self, label: &str) -> bool {
        let mut pending = self.pending_confirmations.lock().expect("quit registry pending lock poisoned");
        let Some(labels) = pending.as_mut() else { return false };
        labels.remove(label);
        if labels.is_empty() { *pending = None; true } else { false }
    }

    fn cancel(&self) {
        *self.pending_confirmations.lock().expect("quit registry pending lock poisoned") = None;
    }
}

// These commands take `Window`, never `WebviewWindow`, and look windows up with
// `windows()`/`get_window()`. Once a window hosts a second webview (the Preview
// pane's browser) Tauri stops treating it as a `WebviewWindow`: `webview_windows()`
// comes back empty, so quit would skip its unsaved-changes prompt.
#[tauri::command]
fn sync_window_dirty(window: tauri::Window, dirty: bool, registry: tauri::State<'_, QuitRegistry>) {
    registry.dirty_windows.lock().expect("quit registry dirty lock poisoned")
        .insert(window.label().to_string(), dirty);
}

#[tauri::command]
fn request_quit(app: tauri::AppHandle, registry: tauri::State<'_, QuitRegistry>) {
    let live = app.windows().into_keys().collect();
    let dirty = registry.begin_quit(&live);
    if dirty.is_empty() {
        app.exit(0);
        return;
    }
    for label in dirty { let _ = app.emit_to(label, "native-quit-confirm", ()); }
}

#[tauri::command]
fn confirm_quit_window(window: tauri::Window, app: tauri::AppHandle, registry: tauri::State<'_, QuitRegistry>) {
    if registry.confirm(window.label()) { app.exit(0); }
}

#[tauri::command]
fn cancel_quit(registry: tauri::State<'_, QuitRegistry>) {
    registry.cancel();
}

#[cfg(test)]
mod quit_registry_tests {
    use super::*;

    #[test]
    fn quit_waits_for_every_dirty_window_before_exiting() {
        let registry = QuitRegistry::default();
        let mut dirty = registry.dirty_windows.lock_or_recover();
        dirty.insert("project-alpha".into(), true);
        dirty.insert("project-bravo".into(), true);
        drop(dirty);

        let live = ["project-alpha".to_string(), "project-bravo".to_string()].into_iter().collect();
        assert_eq!(registry.begin_quit(&live).len(), 2);
        assert!(!registry.confirm("project-alpha"));
        assert!(registry.confirm("project-bravo"));
    }

    /// A destroyed webview never runs its React cleanup, so its dirty flag
    /// outlives it. Waiting on that ghost made Quit unreachable forever.
    #[test]
    fn quit_ignores_dirty_windows_that_no_longer_exist() {
        let registry = QuitRegistry::default();
        let mut dirty = registry.dirty_windows.lock_or_recover();
        dirty.insert("project-alpha".into(), true);
        dirty.insert("project-closed".into(), true);
        drop(dirty);

        let live = ["project-alpha".to_string()].into_iter().collect();
        assert_eq!(registry.begin_quit(&live), ["project-alpha".to_string()].into_iter().collect());
        assert!(registry.confirm("project-alpha"), "the only live dirty window completes the quit");
        assert!(!registry.dirty_windows.lock_or_recover().contains_key("project-closed"), "the ghost entry is dropped");
    }
}

use acp_preflight::Preflight;
use executor::{Envelope, ExecutorEvent, Harness, Sink};
use serde::Serialize;
use store::{palisade_home, Message, Project};
use crate::locks::MutexExt;
pub(crate) use error::PalisadeError;
pub(crate) use store::{Res, ThreadMeta};

#[derive(Debug, Clone, Serialize)]
pub(crate) struct DirEntry {
    name: String,
    is_dir: bool,
    path: String,
}

/// Resolves a project's root from the global index rather than trusting the
/// frontend — used by every command that reads/writes inside the project
/// filesystem (file editing, git, format-on-save).
pub(crate) fn project_root(hash: &str) -> Res<PathBuf> {
    let home = palisade_home();
    store::list_projects(&home)?
        .into_iter()
        .find(|p| p.hash == hash)
        .map(|p| PathBuf::from(p.root))
        .ok_or_else(|| crate::PalisadeError::not_found(format!("unknown project: {hash}")))
}

/// The tree a thread's OpenSpec files are read from. Spec sessions write to the
/// project root; once `/go` builds, the thread's worktree holds the newer copy
/// (ticked tasks). Use the worktree only when it actually has the thread's
/// change, so a worktree that predates the change never hides it.
pub(crate) fn spec_root(project_hash: &str, thread_id: Option<&str>) -> Res<PathBuf> {
    let root = project_root(project_hash)?;
    let meta = thread_id.and_then(|id| thread_meta(project_hash, id));
    Ok(match meta.map(|m| (m.worktree_path, m.open_spec_change_name)) {
        Some((Some(tree), Some(change))) => pick_spec_tree(root, PathBuf::from(tree), &change),
        // No linked change: nothing was written to the root for this thread,
        // so its worktree (where a go-only thread's agent works) is the tree.
        Some((Some(tree), None)) if Path::new(&tree).is_dir() => PathBuf::from(tree),
        _ => root,
    })
}

fn pick_spec_tree(root: PathBuf, worktree: PathBuf, change: &str) -> PathBuf {
    if worktree.join("openspec/changes").join(change).is_dir() { worktree } else { root }
}

/// A fresh Palisade process owns no chain workers. Sweep every persisted
/// project's open records before windows or IPC can surface them, closing
/// each as `interrupted` rather than attempting auto-resume (D-c).
fn reconcile_stale_chain_runs_on_startup(home: &Path) -> Res<()> {
    let hashes = store::list_projects(home)?.into_iter().map(|project| project.hash).collect::<Vec<_>>();
    reconcile_stale_chain_runs_for_hashes(home, &hashes)
}

/// Extracted so the multi-project startup rule is testable without Tauri.
fn reconcile_stale_chain_runs_for_hashes(home: &Path, hashes: &[String]) -> Res<()> {
    for hash in hashes {
        chain_history::close_stale_runs(home, hash, &[])?;
    }
    Ok(())
}

/// Where the `git` binary lives, or a readable error if it isn't there.
pub(crate) fn git_bin() -> Res<PathBuf> {
    executor::find_on_path("git").ok_or_else(|| "`git` is not on PATH.".into())
}

#[tauri::command]
async fn list_projects() -> Res<Vec<Project>> {
    tokio::task::spawn_blocking(|| store::list_projects(&palisade_home()))
        .await
        .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

#[tauri::command]
async fn add_project(app: tauri::AppHandle, path: String) -> Res<Project> {
    tokio::task::spawn_blocking(move || {
        let project = store::add_project(&palisade_home(), Path::new(&path))?;
        let _ = app.emit("projects-changed", &project.hash);
        Ok(project)
    })
        .await
        .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

/// Open a separate native window with its own frontend project state.
///
/// A project already on screen focuses its window instead of opening a second
/// copy of itself — the rule VS Code follows for the same action (#33).
#[tauri::command]
async fn open_project_window(app: tauri::AppHandle, hash: String) -> Res<String> {
    if let Some(label) = project_windows::window_showing(&app.state::<Harness>(), &hash) {
        if let Some(existing) = app.get_window(&label) {
            // Focus can fail on a window mid-teardown; falling through to open
            // a fresh one is better than reporting an error for "show me this".
            if existing.set_focus().is_ok() {
                return Ok(label);
            }
        }
    }
    let config = project_windows::window_config(&palisade_home(), &hash)?;
    let label = config.label.clone();
    tauri::WebviewWindowBuilder::from_config(&app, &config)
        .map_err(|e| crate::PalisadeError::from(format!("configure project window: {e}")))?
        .build()
        .map_err(|e| crate::PalisadeError::from(format!("open project window: {e}")))?;
    Ok(label)
}

#[tauri::command]
async fn remove_project(app: tauri::AppHandle, hash: String) -> Res<()> {
    tokio::task::spawn_blocking(move || {
        project_windows::remove_saved_project(&palisade_home(), &app.state::<Harness>(), &hash)?;
        let _ = app.emit("projects-changed", &hash);
        Ok(())
    }).await.map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

/// Amendment 8's Clone Repository card: clone, then register the result as
/// a project in one step.
#[tauri::command]
async fn clone_repository(app: tauri::AppHandle, url: String, parent: String) -> Res<Project> {
    tokio::task::spawn_blocking(move || {
        let target = git::clone(&git_bin()?, &url, Path::new(&parent))?;
        let project = store::add_project(&palisade_home(), &target)?;
        let _ = app.emit("projects-changed", &project.hash);
        Ok(project)
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

#[tauri::command]
async fn switch_project(window: tauri::Window, app: tauri::AppHandle, hash: String) -> Res<Project> {
    let label = window.label().to_string();
    tokio::task::spawn_blocking(move || {
        let project = store::touch_project(&palisade_home(), &hash)?;
        let harness: tauri::State<'_, Harness> = app.state();
        // Which window is showing what decides which watchers stay alive (#33).
        project_windows::track(&harness, &label, &project.hash);
        start_fs_watcher(&app, &harness, &project);

        let root = Path::new(&project.root);
        // Auto-create .palisade/project-settings.json (D14/D15) so there's always a real
        // file to open from the settings button — a no-op once it exists.
        if let Err(message) = settings::ensure_file(root) {
            let _ = app.emit("harness-warning", message);
        }
        // Surface malformed settings immediately on load, rather than only when
        // a save or an executor-override lookup happens to re-read them.
        let (_, warning) = settings::load(root);
        if let Some(message) = warning {
            let _ = app.emit("harness-warning", message);
        }
        repair_legacy_titles(app.clone(), project.hash.clone());
        Ok(project)
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

/// Payload for the `fs-changed` event. Carries the project hash so a late
/// event from the project the user just left can be ignored rather than
/// refreshing the new project's tree.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FsChanged {
    project_hash: String,
    paths: Vec<String>,
}

/// Ensures a filesystem watcher for the newly active project, so the editor
/// and file tree find out when the agent, a `git checkout`, or another editor
/// changes something underneath them. One watcher per project, shared by
/// every window showing it and dropped once the last of them moves on. A
/// watcher that can't start surfaces once through `harness-warning` and
/// leaves the app working without reconciliation.
fn start_fs_watcher(app: &tauri::AppHandle, harness: &tauri::State<'_, Harness>, project: &Project) {
    project_windows::retire_unwatched(harness);
    let mut watchers = harness.workspace.fswatch.lock_or_recover();
    if watchers.contains_key(&project.hash) {
        return;
    }

    let app_change = app.clone();
    let hash_change = project.hash.clone();
    let app_crash = app.clone();
    watchers.insert(project.hash.clone(), fswatch::FsWatcher::spawn(
        PathBuf::from(&project.root),
        move |paths| {
            let _ = app_change.emit(
                "fs-changed",
                FsChanged { project_hash: hash_change.clone(), paths },
            );
        },
        move |message| {
            let _ = app_crash.emit("harness-warning", message);
        },
    ));
}

#[tauri::command]
async fn rename_project(app: tauri::AppHandle, hash: String, display_name: String) -> Res<Project> {
    tokio::task::spawn_blocking(move || {
        let project = store::rename_project(&palisade_home(), &hash, &display_name)?;
        let _ = app.emit("projects-changed", &hash);
        Ok(project)
    })
        .await
        .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

#[tauri::command]
async fn create_thread(project_hash: String, title: String) -> Res<ThreadMeta> {
    tokio::task::spawn_blocking(move || store::create_thread(&palisade_home(), &project_hash, &title))
        .await
        .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

#[tauri::command]
async fn list_threads(project_hash: String) -> Res<Vec<ThreadMeta>> {
    tokio::task::spawn_blocking(move || store::list_threads(&palisade_home(), &project_hash))
        .await
        .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

#[tauri::command]
async fn rename_thread(
    project_hash: String,
    thread_id: String,
    title: String,
) -> Res<ThreadMeta> {
    tokio::task::spawn_blocking(move || {
        store::rename_thread(&palisade_home(), &project_hash, &thread_id, &title)
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

#[tauri::command]
async fn set_thread_mode(
    project_hash: String,
    thread_id: String,
    mode: String,
) -> Res<ThreadMeta> {
    tokio::task::spawn_blocking(move || {
        store::set_thread_mode(&palisade_home(), &project_hash, &thread_id, &mode)
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

/// Refused while this thread has an executor turn in flight — deleting the
/// files a live turn is about to append to would corrupt or orphan state.
#[tauri::command]
async fn set_thread_archived(
    project_hash: String,
    thread_id: String,
    archived: bool,
) -> Res<store::ThreadMeta> {
    tokio::task::spawn_blocking(move || {
        let meta = store::set_thread_archived(&palisade_home(), &project_hash, &thread_id, archived)?;
        // Archiving is the moment a worktree becomes prunable; sweeping here
        // means the safe case is already gone by the time anyone looks.
        if archived {
            sweep_archived_worktrees(&project_hash);
        }
        Ok(meta)
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

/// Record that the user has just looked at this thread. Idempotent — the
/// Fleet board calls it whenever the thread becomes the active one.
#[tauri::command]
async fn mark_thread_viewed(project_hash: String, thread_id: String) -> Res<()> {
    tokio::task::spawn_blocking(move || {
        store::mark_thread_viewed(&palisade_home(), &project_hash, &thread_id)?;
        Ok(())
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

/// Stop surfacing this exact crashed run as an outstanding notification.
#[tauri::command]
async fn acknowledge_thread_crash(
    project_hash: String,
    thread_id: String,
    session_id: Option<String>,
) -> Res<store::ThreadMeta> {
    tokio::task::spawn_blocking(move || {
        store::acknowledge_thread_crash(
            &palisade_home(),
            &project_hash,
            &thread_id,
            session_id.as_deref(),
        )
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

/// The dock badge: how many threads want a look — blocked on you, or finished
/// and unread. Tauri applies it app-wide, so whichever window called last
/// wins; every window derives the same count from the same fleet. Zero clears
/// it, because a "0" badge is noise.
#[tauri::command]
fn set_dock_badge(window: tauri::Window, count: u32) -> Res<()> {
    window
        .set_badge_count(if count == 0 { None } else { Some(i64::from(count)) })
        .map_err(|e| crate::PalisadeError::from(e.to_string()))
}

#[tauri::command]
async fn delete_thread(app: tauri::AppHandle, project_hash: String, thread_id: String) -> Res<()> {
    tokio::task::spawn_blocking(move || {
        let harness: tauri::State<'_, Harness> = app.state();
        if harness.thread_is_busy(&thread_id) {
            return Err(
                "This thread has a turn in progress — wait for it to finish before deleting.".into(),
            );
        }
        // The thread's worktree goes with it. Archiving deliberately does not
        // do this: an archived thread keeps its uncommitted work on disk.
        // Best-effort — a worktree git won't drop must not block the delete
        // the user asked for, and its metadata is about to be gone anyway.
        if let Some(meta) = thread_meta(&project_hash, &thread_id) {
            if let Some(path) = meta.worktree_path {
                if let (Ok(bin), Ok(root)) = (git_bin(), project_root(&project_hash)) {
                    let _ = git::remove_worktree(
                        &bin,
                        &root,
                        Path::new(&path),
                        meta.worktree_branch.as_deref(),
                    );
                }
            }
        }
        store::delete_thread(&palisade_home(), &project_hash, &thread_id)
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

#[tauri::command]
async fn append_message(
    project_hash: String,
    thread_id: String,
    role: String,
    mode: String,
    content: String,
) -> Res<Message> {
    tokio::task::spawn_blocking(move || {
        // A direct append is a harness/user write, not a session's output — it has
        // no producing session to name.
        store::append_message(
            &palisade_home(),
            &project_hash,
            &thread_id,
            &role,
            &mode,
            &content,
            None,
        )
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

/// A thread's history. With no options: all of it. `from_seq` returns every
/// message from that seq on (an incremental refresh); otherwise `limit`
/// returns the newest that many, only those before `before_seq` if given (the
/// "load earlier" page). Windowed reads touch only the tail of the log.
#[tauri::command]
async fn read_thread(
    project_hash: String,
    thread_id: String,
    before_seq: Option<u64>,
    from_seq: Option<u64>,
    limit: Option<usize>,
) -> Res<Vec<Message>> {
    tokio::task::spawn_blocking(move || {
        let home = palisade_home();
        match (from_seq, limit) {
            (Some(from), _) => store::read_thread_window(&home, &project_hash, &thread_id, store::Window::From(from)),
            (None, Some(limit)) => {
                store::read_thread_window(&home, &project_hash, &thread_id, store::Window::Last { before_seq, limit })
            }
            (None, None) => store::read_thread(&home, &project_hash, &thread_id),
        }
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

// ------------------------------------------------------- executor handoff

/// Payload for `spec-link-ambiguous`: a propose turn produced more than one
/// change, so the user picks which one this thread is working on.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SpecLinkAmbiguous {
    thread_id: String,
    names: Vec<String>,
}

/// Payload for `agent-commands`: the slash commands one session's agent
/// advertises. Keyed by session because two sessions can run at once with
/// different agents, and therefore different commands.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentCommands {
    session_id: String,
    thread_id: String,
    commands: Vec<crate::acp_events::AgentCommand>,
}

/// Forwards parsed executor events to the webview, and owns the two reactions
/// that must happen no matter which adapter produced them: a crash reverts the
/// thread to spec-mode, and a finished `/propose` turn records its new change.
struct AppSink {
    app: tauri::AppHandle,
    project_hash: String,
}

impl Sink for AppSink {
    /// The agent re-sends the whole list whenever it changes, so the payload
    /// replaces the session's commands rather than appending to them.
    fn emit_commands(
        &self,
        session_id: &str,
        thread_id: &str,
        commands: &[crate::acp_events::AgentCommand],
    ) {
        self.app
            .state::<Harness>()
            .agent
            .session_commands
            .lock_or_recover()
            .insert(session_id.to_string(), commands.to_vec());
        let _ = self.app.emit(
            "agent-commands",
            AgentCommands {
                session_id: session_id.to_string(),
                thread_id: thread_id.to_string(),
                commands: commands.to_vec(),
            },
        );
    }

    fn emit_image_support(&self, session_id: &str, thread_id: &str, images: bool) {
        let _ = self.app.emit(
            "agent-image-support",
            serde_json::json!({ "sessionId": session_id, "threadId": thread_id, "images": images }),
        );
    }

    fn emit_usage(
        &self,
        session_id: &str,
        _thread_id: &str,
        cost: Option<crate::acp_events::Cost>,
    ) {
        let Some(cost) = cost else { return };
        // Cost applies only to active chain turns in this wave. The watcher
        // is deliberately the hand-off rather than a new ExecutorEvent, so
        // normal transcript persistence and the capped event enum stay
        // untouched (D-d).
        if let Some(watch) = self
            .app
            .state::<Harness>()
            .chain.turn_watchers
            .lock()
            .unwrap()
            .get(session_id)
            .cloned()
        {
            watch.record_cost(cost);
        }
    }

    fn emit(&self, envelope: &Envelope) {
        // D22: detect the [READY_TO_PROPOSE] marker in agent text. If present,
        // strip it from the visible text and auto-fire `propose`. The user
        // never sees the marker — it's a machine-readable signal from the
        // agent that exploration is change-shaped and ready to propose.
        let mut propose_after_persist = false;
        let envelope_to_emit: Envelope;
        let envelope_ref: &Envelope = if let ExecutorEvent::Text { text } = &envelope.event {
            if let Some(stripped) = detect_and_strip_ready_to_propose(text) {
                propose_after_persist = true;
                envelope_to_emit = Envelope {
                    session_id: envelope.session_id.clone(),
                    thread_id: envelope.thread_id.clone(),
                    event: ExecutorEvent::Text { text: stripped },
                };
                &envelope_to_emit
            } else {
                envelope
            }
        } else {
            envelope
        };

        let _ = self.app.emit("executor-event", envelope_ref);

        // The thread these side effects belong to is the one the event came
        // from, not whichever thread the sink happened to be built for — with
        // concurrent sessions those stop being the same thing.
        let thread_id = envelope_ref.thread_id.clone();

        // Durable copy: the thread's JSONL log is the source of truth once a
        // turn ends. persist() decides what lands (text, tool rows, crash
        // markers) and what stays live-only (deltas, Done).
        let mode = self
            .app
            .state::<Harness>()
            .agent.acp_sessions
            .lock()
            .unwrap()
            .get(&envelope_ref.session_id)
            .map(|s| s.mode.clone())
            .unwrap_or_else(|| "spec".to_string());
        executor::persist(
            &palisade_home(),
            &self.project_hash,
            &thread_id,
            &envelope_ref.session_id,
            &mode,
            &envelope_ref.event,
        );

        // D22: auto-fire propose after the marker was detected and persisted.
        // Spawned as a tokio task because propose is async and the sink is sync.
        if propose_after_persist {
            let app = self.app.clone();
            let project_hash = self.project_hash.clone();
            let tid = thread_id.clone();
            tokio::spawn(async move {
                if let Err(e) = propose(app, project_hash, tid, None, false).await {
                    eprintln!("auto-propose failed: {e}");
                }
            });
        }

        // A chain run waiting on this session's turn collects its text here
        // and is released by the Done/Crashed arms below. Nothing happens for
        // an ordinary session — the watcher map is empty.
        if let Some(watch) = self
            .app
            .state::<Harness>()
            .chain.turn_watchers
            .lock()
            .unwrap()
            .get(&envelope_ref.session_id)
            .cloned()
        {
            match &envelope_ref.event {
                ExecutorEvent::Text { text } => watch.push_text(text),
                ExecutorEvent::Done => watch.finish(executor::TurnEnd::Done),
                ExecutorEvent::Crashed { message, .. } => {
                    watch.finish(executor::TurnEnd::Crashed(message.clone()))
                }
                _ => {}
            }
        }

        match &envelope_ref.event {
            ExecutorEvent::Crashed { message, failure_class, .. } => {
                self.app.state::<Harness>().agent.pending_changes.lock_or_recover().remove(&envelope_ref.session_id);
                end_session(&self.app.state::<Harness>(), &thread_id, &envelope_ref.session_id, "crashed");
                // #18: only a dead agent drops the thread back to spec. A
                // retryable turn failure (expired auth, a cancelled turn)
                // leaves the user's Go intent where they put it — the UI is
                // offering them a Retry for that very error.
                if executor::crash_resets_mode(&envelope_ref.event) {
                    let _ = executor::on_crash(&palisade_home(), &self.project_hash, &thread_id);
                }
                // Persist an auth-shaped failure on the thread so the
                // composer can warn before the *next* message is even typed,
                // not just after it fails the same way again.
                if *failure_class == Some(acp_client::FailureClass::AuthRequired) {
                    let _ = store::set_thread_auth_blocked(
                        &palisade_home(),
                        &self.project_hash,
                        &thread_id,
                        Some(message),
                    );
                }
                let _ = self.app.emit("thread-updated", &thread_id);
            }
            ExecutorEvent::Done => {
                let harness = self.app.state::<Harness>();
                let _ = store::flush_session_log_writer();
                // A turn made it to completion, so whatever auth problem
                // blocked an earlier one no longer applies.
                if thread_meta(&self.project_hash, &thread_id)
                    .is_some_and(|m| m.auth_blocked.is_some())
                {
                    let _ = store::set_thread_auth_blocked(
                        &palisade_home(),
                        &self.project_hash,
                        &thread_id,
                        None,
                    );
                    let _ = self.app.emit("thread-updated", &thread_id);
                }
                let watch = harness.agent.pending_changes.lock_or_recover().remove(&envelope_ref.session_id);
                if let Some(watch) = watch {
                    let after = executor::openspec_proposed_dirs(&watch.project_root);
                    match executor::newly_added_change(&watch.before, &after) {
                        executor::ProposeOutcome::One(name) => {
                            let _ = store::set_open_spec_change(
                                &palisade_home(),
                                &watch.project_hash,
                                &watch.thread_id,
                                Some(&name),
                            );
                            let _ = self.app.emit("thread-updated", &watch.thread_id);
                        }
                        // Two changes from one turn used to return `None` and
                        // record nothing — silent loss of a durable reference.
                        // Ask instead (D12).
                        executor::ProposeOutcome::Ambiguous(names) => {
                            let _ = self.app.emit(
                                "spec-link-ambiguous",
                                SpecLinkAmbiguous { thread_id: thread_id.clone(), names },
                            );
                        }
                        executor::ProposeOutcome::None => {
                            harness.agent.pending_changes.lock_or_recover().insert(envelope_ref.session_id.clone(), watch);
                        }
                    }
                }
            }
            _ => {}
        }
    }
}

fn sink_for(app: &tauri::AppHandle, project_hash: &str) -> Arc<dyn Sink> {
    Arc::new(AppSink { app: app.clone(), project_hash: project_hash.to_string() })
}

fn preflight_for_harness(harness: &Harness, refresh: bool) -> Preflight {
    let mut cached = harness.agent.preflight.lock_or_recover();
    if refresh || cached.is_none() {
        *cached = Some(acp_preflight::preflight(
            &store::palisade_home(),
            &|bin| executor::find_on_path(bin),
        ));
    }
    cached.clone().expect("preflight just populated")
}

/// Cached at startup; re-checked when the caller says the cache may be stale
/// (the `/go` path does exactly that before committing to a handoff).
#[tauri::command]
async fn preflight(app: tauri::AppHandle, refresh: bool) -> Res<Preflight> {
    Ok(tokio::task::spawn_blocking(move || {
        let harness: tauri::State<'_, Harness> = app.state();
        preflight_for_harness(&*harness, refresh)
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?)
}

/// Plan usage per installed agent. Blocking work (Keychain read, HTTP,
/// rollout-log scan) runs off the UI thread; every provider fails soft.
/// `force` bypasses the 60s per-agent cache — the manual refresh button and
/// a pending sign-in's fast poll pass it so a completed login isn't hidden
/// behind a stale cache hit.
#[tauri::command]
async fn agent_usage(app: tauri::AppHandle, force: Option<bool>) -> Res<Vec<agent_usage::AgentUsage>> {
    Ok(tokio::task::spawn_blocking(move || {
        let ids: Vec<String> = {
            let harness: tauri::State<'_, Harness> = app.state();
            preflight_for_harness(&*harness, false).agents.iter().map(|a| a.id.clone()).collect()
        };
        agent_usage::usage_for(&ids, force.unwrap_or(false))
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?)
}

/// User-level skills installed under `~/.claude/skills` and `~/.agents/skills`.
/// Read-only: Palisade lists what the CLIs own, it never writes a skill.
#[tauri::command]
async fn list_skills() -> Res<Vec<skills::Skill>> {
    Ok(tokio::task::spawn_blocking(skills::list_skills)
        .await
        .map_err(|e| crate::PalisadeError::from(e.to_string()))?)
}

/// Pure decision: which executor a project should use, given a preflight
/// snapshot and an optional `project-settings.json` override (D18).
fn resolve_executor<'a>(
    flight: &'a Preflight,
    override_id: Option<String>,
) -> Res<(&'a acp_preflight::AgentStatus, Option<String>)> {
    acp_preflight::resolve_executor(flight, override_id)
}

/// The thread's stored meta, if it exists.
pub(crate) fn thread_meta(project_hash: &str, thread_id: &str) -> Option<store::ThreadMeta> {
    store::list_threads(&palisade_home(), project_hash)
        .ok()?
        .into_iter()
        .find(|t| t.id == thread_id)
}

/// How a thread's executor slot names a saved chain rather than an agent
/// (D5). Reusing the existing slot is what keeps this inside the two-mode
/// invariant: a chain is one more thing go-mode's executor can resolve to,
/// not a third mode.
const CHAIN_EXECUTOR_PREFIX: &str = "chain:";

/// The chain a thread's executor slot names, if it names one.
fn selected_chain(project_hash: &str, thread_id: &str) -> Option<String> {
    thread_meta(project_hash, thread_id)?
        .executor?
        .strip_prefix(CHAIN_EXECUTOR_PREFIX)
        .map(str::to_string)
}

/// Resolves which agent a thread uses and its binary path. Selection order
/// (D9/D18): the thread's own picker choice, then the project's
/// `executorOverride`, then auto-detection (first installed agent).
///
/// A slot holding a chain (`chain:<name>`) is not an agent id, so it is
/// skipped here and falls through to the normal resolution — `go_mode` is
/// where the chain is actually noticed and run.
fn selected_executor(
    app: &tauri::AppHandle,
    harness: &tauri::State<'_, Harness>,
    project_hash: &str,
    thread_id: Option<&str>,
) -> Res<(acp_preflight::AgentStatus, PathBuf)> {
    let mut flight = {
        let mut cached = harness.agent.preflight.lock_or_recover();
        if cached.is_none() {
            *cached = Some(acp_preflight::preflight(
                &store::palisade_home(),
                &|bin| executor::find_on_path(bin),
            ));
        }
        cached.clone().expect("preflight just populated")
    };
    let thread_override = thread_id
        .and_then(|id| thread_meta(project_hash, id)?.executor)
        .filter(|choice| !choice.starts_with(CHAIN_EXECUTOR_PREFIX));
    let override_id = thread_override.or_else(|| {
        project_root(project_hash)
            .ok()
            .and_then(|root| settings::load(&root).0.executor_override)
    });
    // Preflight is a launch-time snapshot, so an agent installed while Palisade is
    // running reads as missing. Re-detect once before warning about an override.
    if let Some(id) = &override_id {
        if flight.agent(id).is_none_or(|a| a.path.is_none()) {
            flight = acp_preflight::preflight(&store::palisade_home(), &|bin| executor::find_on_path(bin));
            *harness.agent.preflight.lock_or_recover() = Some(flight.clone());
        }
    }
    let (agent, warning) = resolve_executor(&flight, override_id)?;
    if let Some(message) = warning {
        let _ = app.emit("harness-warning", message);
    }
    let path = agent.path.clone().ok_or("detected executor has no path")?;
    Ok((agent.clone(), PathBuf::from(path)))
}

/// Resolves one specific agent by id against the same cached registry
/// preflight auto-detection uses (D16), re-running detection once before
/// giving up — preflight is a launch-time snapshot, so an agent installed
/// while Palisade was running would otherwise read as missing.
///
/// A bound agent that really isn't installed is a hard error naming it, never
/// a silent substitution (D17).
fn resolve_agent(
    harness: &tauri::State<'_, Harness>,
    agent_id: &str,
) -> Res<(acp_preflight::AgentStatus, PathBuf)> {
    let mut flight = preflight_for_harness(harness, false);
    if flight.agent(agent_id).is_none_or(|a| a.path.is_none()) {
        flight = preflight_for_harness(harness, true);
    }
    let agent = flight
        .agent(agent_id)
        .ok_or_else(|| format!("`{agent_id}` isn't a known agent"))?;
    let path = agent
        .path
        .clone()
        .ok_or_else(|| format!("`{}` isn't installed or isn't on PATH", agent.name))?;
    Ok((agent.clone(), PathBuf::from(path)))
}

/// The id of a live session on this thread running under `mode`, if any.
///
/// Chain-owned sessions are skipped (D25): a chain node runs with go-mode
/// permissions, so without this a user pressing `/go` mid-run would be handed
/// a node's session and start typing into the middle of a chain.
fn find_live_session(harness: &tauri::State<'_, Harness>, thread_id: &str, mode: &str) -> Option<String> {
    let chain_owned = harness.chain.chain_sessions.lock_or_recover();
    harness
        .agent.acp_sessions
        .lock()
        .unwrap()
        .values()
        .find(|s| s.thread_id == thread_id && s.mode == mode && !chain_owned.contains(&s.id))
        .map(|s| s.id.clone())
}

/// The directory this thread's sessions run in: its own git worktree, so two
/// threads in one project never write to the same files.
///
/// Created lazily, on the thread's first session start — a thread that is
/// created and never run leaves no worktree or branch behind. Threads that
/// predate worktree isolation have no recorded path and pick one up here, so
/// no migration pass is needed.
///
/// Falls back to the project root, which is the pre-isolation behaviour, when
/// the project isn't a git repo (silently — that project never had isolation
/// to lose) or when git refuses to make the worktree (with a warning, since
/// that one is unexpected and the user is about to get uncoordinated edits).
fn thread_worktree(
    app: &tauri::AppHandle,
    home: &Path,
    project: &Path,
    project_hash: &str,
    thread_id: &str,
) -> PathBuf {
    let meta = thread_meta(project_hash, thread_id);
    // The user turned isolation off for this thread at creation: it runs in
    // the project root, live, and gets no merge/PR/prune step. The warning
    // that says so is shown once, in the composer, not on every turn.
    if meta.as_ref().is_some_and(|t| !t.worktree_enabled) {
        return project.to_path_buf();
    }
    if let Some(recorded) = meta.and_then(|t| t.worktree_path) {
        let path = PathBuf::from(recorded);
        if path.is_dir() {
            return path;
        }
    }
    // Isolation is decided once, at the thread's first run, and never
    // revisited: a thread that started in the project root stays there for
    // life. Letting it acquire a worktree on a later turn silently moved the
    // thread off the files it had already written — the work stayed in the
    // root while every later turn edited an empty worktree, and the UI called
    // that thread "Isolated" the whole time.
    let pin = |reason: Option<String>| -> PathBuf {
        let _ = store::set_thread_worktree_enabled(home, project_hash, thread_id, false);
        if let Some(reason) = reason {
            let _ = app.emit(
                "harness-warning",
                format!(
                    "{reason} — this thread runs in the project directory for its whole life, \
                     where concurrent edits are not coordinated and there is nothing to merge back."
                ),
            );
        }
        project.to_path_buf()
    };
    let Ok(bin) = git_bin() else {
        return pin(Some("git is not available".into()));
    };
    // A project that isn't a repo never had isolation to lose — no warning.
    if !git::is_git_repo(&bin, project) {
        return pin(None);
    }
    // An unborn branch has nothing to branch from, and `git worktree add`
    // does not fail there — it infers `--orphan` and hands back an *empty*
    // worktree that shares no history and no files with the project. Nothing
    // downstream can tell that apart from a real one, so refuse it here.
    if git::rev_parse_head(&bin, project).is_none() {
        return pin(None);
    }
    match git::add_worktree(&bin, project, thread_id) {
        Ok((path, branch)) => {
            // The branch the project is on right now is what this thread
            // branched from, and therefore what it merges back into.
            let base = git::current_branch_name(&bin, project).unwrap_or_else(|_| "HEAD".into());
            let _ = store::set_thread_worktree(
                home,
                project_hash,
                thread_id,
                &path.to_string_lossy(),
                &branch,
                &base,
            );
            bootstrap_worktree(app, project_hash, thread_id, project, &path, &bin);
            path
        }
        Err(err) => pin(Some(format!("Could not create an isolated worktree ({err})"))),
    }
}

/// Copy one change's artifacts between the project root and a worktree.
/// `overwrite` off keeps whatever the destination already has.
/// A missing source change is not an error; a failed copy is.
pub(crate) fn copy_change(from: &Path, to: &Path, change: &str, overwrite: bool) -> std::io::Result<()> {
    fn copy(src: &Path, dst: &Path, overwrite: bool) -> std::io::Result<()> {
        if src.is_dir() {
            std::fs::create_dir_all(dst)?;
            for entry in std::fs::read_dir(src)? {
                let entry = entry?;
                copy(&entry.path(), &dst.join(entry.file_name()), overwrite)?;
            }
        } else if overwrite || !dst.exists() {
            std::fs::copy(src, dst)?;
        }
        Ok(())
    }
    let rel = Path::new("openspec/changes").join(change);
    if !from.join(&rel).is_dir() {
        return Ok(());
    }
    copy(&from.join(&rel), &to.join(&rel), overwrite)
}

/// A go session starts with the proposal it will build: never overwrites, so a
/// worktree copy that already has progress is kept.
fn seed_change(project: &Path, worktree: &Path, change: &str) {
    if let Err(err) = copy_change(project, worktree, change, false) {
        eprintln!("[palisade] could not seed change {change} into worktree: {err}");
    }
}

/// Copies opted-in ignored files before dependency installation, then runs the
/// configured bootstrap away from the UI thread. No dependency directory is
/// shared or linked between worktrees.
fn bootstrap_worktree(app: &tauri::AppHandle, project_hash: &str, thread_id: &str, project: &Path, worktree: &Path, bin: &Path) {
    let (settings, _) = settings::load(project);
    let ignored = git::ignored_paths(bin, project);
    for relative in &settings.worktree_copy {
        if !ignored.contains(relative) { continue; }
        let source = project.join(relative);
        let destination = worktree.join(relative);
        if source.is_file() && !destination.exists() {
            if let Some(parent) = destination.parent() { let _ = std::fs::create_dir_all(parent); }
            if let Err(err) = std::fs::copy(source, destination) {
                let _ = store::set_thread_worktree_setup(&palisade_home(), project_hash, thread_id, "failed", Some(format!("Could not copy {relative}: {err}")));
                let _ = app.emit("worktree-setup-finished", format!("{project_hash}:{thread_id}:failed"));
                return;
            }
        }
    }
    let Some(command) = settings.worktree_setup.clone().or_else(|| settings::default_worktree_setup(project)) else {
        let _ = store::set_thread_worktree_setup(&palisade_home(), project_hash, thread_id, "ready", None);
        let _ = app.emit("worktree-setup-finished", format!("{project_hash}:{thread_id}:ready"));
        return;
    };
    let _ = store::set_thread_worktree_setup(&palisade_home(), project_hash, thread_id, "running", None);
    let app = app.clone();
    let hash = project_hash.to_string();
    let thread = thread_id.to_string();
    let tree = worktree.to_path_buf();
    let target = settings::cargo_target_dir(&settings, project, &palisade_home(), project_hash);
    std::thread::spawn(move || {
        let mut child = std::process::Command::new("sh");
        child.arg("-c").arg(&command).current_dir(tree).stdin(std::process::Stdio::null()).env("PATH", executor::child_path_env());
        if let Some(target) = target { child.env("CARGO_TARGET_DIR", target); }
        let (result, output) = child.output().map(|out| {
            let mut output = String::from_utf8_lossy(&out.stdout).into_owned();
            output.push_str(&String::from_utf8_lossy(&out.stderr));
            (if out.status.success() { "ready" } else { "failed" }, settings::tail(&output, 8 * 1024))
        }).unwrap_or_else(|err| ("failed", err.to_string()));
        let _ = store::set_thread_worktree_setup(&palisade_home(), &hash, &thread, result, if result == "ready" { None } else { Some(output) });
        let _ = app.emit("worktree-setup-finished", format!("{hash}:{thread}:{result}"));
    });
}

#[tauri::command]
async fn rerun_worktree_setup(app: tauri::AppHandle, project_hash: String, thread_id: String) -> Res<()> {
    tokio::task::spawn_blocking(move || {
        let project = project_root(&project_hash)?;
        let meta = thread_meta(&project_hash, &thread_id).ok_or("This thread has no worktree to set up.")?;
        let path = meta.worktree_path.ok_or("This thread has no worktree to set up.")?;
        bootstrap_worktree(&app, &project_hash, &thread_id, &project, Path::new(&path), &git_bin()?);
        Ok(())
    }).await.map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

/// Start a new ACP session on a thread and record it open.
fn start_session(
    app: &tauri::AppHandle,
    harness: &tauri::State<'_, Harness>,
    project_hash: &str,
    thread_id: &str,
    mode: &str,
    _carry_forward: bool,
    _model: Option<String>,
    bypass: bool,
) -> Res<String> {
    start_session_as(app, harness, project_hash, thread_id, mode, bypass, None, None)
}

/// `start_session`, but able to pin the agent rather than resolving the
/// thread's. Only a chain node passes `agent_override`: its agent binding is
/// the point of the node (D16), unlike a normal thread where the executor is
/// detected, not configured.
fn start_session_as(
    app: &tauri::AppHandle,
    harness: &tauri::State<'_, Harness>,
    project_hash: &str,
    thread_id: &str,
    mode: &str,
    bypass: bool,
    agent_override: Option<&str>,
    model_override: Option<String>,
) -> Res<String> {
    let (agent, bin) = match agent_override {
        Some(id) => resolve_agent(harness, id)?,
        None => selected_executor(app, harness, project_hash, Some(thread_id))?,
    };
    let agent_id = agent.id.clone();
    let home = palisade_home();
    // The thread meta is the source of truth for the model choice; the IPC
    // `model` parameter is legacy and ignored (the frontend passes null).
    // A chain node's own pick wins over it — that is the whole point of
    // binding a model per node rather than per thread.
    let model = model_override.or_else(|| thread_meta(project_hash, thread_id).and_then(|t| t.model));

    let project = project_root(project_hash)?;
    // Two threads in one project used to share this working tree, and all
    // Palisade could do was warn that "git is the arbiter". Each thread now
    // runs in its own worktree instead, so there is nothing to warn about.
    // Spec sessions write the proposal to the project root, where the spec
    // viewer reads it; the worktree is created for the go session, which
    // gets the proposal copied in (it is untracked, so a fresh worktree
    // wouldn't have it).
    let root = if mode == "spec" {
        project.clone()
    } else {
        let root = thread_worktree(app, &home, &project, project_hash, thread_id);
        if root != project {
            if let Some(change) = thread_meta(project_hash, thread_id).and_then(|t| t.open_spec_change_name) {
                seed_change(&project, &root, &change);
            }
        }
        root
    };
    let (settings, _) = settings::load(&project);
    let extra_env = settings::cargo_target_dir(&settings, &project, &home, project_hash)
        .map(|target| vec![("CARGO_TARGET_DIR".into(), target.to_string_lossy().into_owned())])
        .unwrap_or_default();
    let spawn = acp_client::AcpSpawn {
        agent_id: agent.id.clone(),
        agent_name: agent.name.clone(),
        bin: bin.clone(),
        cmd: agent.cmd.clone(),
        args: agent.args.clone(),
        project_root: root.clone(),
        project_hash: project_hash.to_string(),
        thread_id: thread_id.to_string(),
        mode: mode.to_string(),
        bypass,
        model,
        palisade_home: home.clone(),
        extra_env,
    };

    let session = acp_client::start_acp_session(spawn, sink_for(app, project_hash))?;
    let id = session.id.clone();

    let git = git_bin().ok();
    store::open_session(
        &home,
        project_hash,
        thread_id,
        &id,
        &agent_id,
        mode,
        None, // ACP sessions have no provider_handle
        git.as_ref().and_then(|bin| git::rev_parse_head(bin, &root)).as_deref(),
        git.as_ref().map(|bin| git::porcelain_snapshot(bin, &root)),
    )?;
    harness.agent.acp_sessions.lock_or_recover().insert(id.clone(), session);
    Ok(id)
}

/// Reuse this thread's live session for `mode`, or start one.
///
/// When the thread's executor choice no longer matches the live session's
/// agent, the old session is closed (`switched`) and the new agent starts
/// fresh — the previous turns ride along as a raw-text transcript prepended
/// to the first prompt (D6/D7).
///
/// That transcript is parked on the new session (`pending_prefix`) and drained
/// by `send_to`, rather than returned to the caller. `/go` brings a session up
/// without sending a prompt, so a returned prefix was simply dropped there and
/// the next turn reached the new agent with no history at all.
fn ensure_session(
    app: &tauri::AppHandle,
    harness: &tauri::State<'_, Harness>,
    project_hash: &str,
    thread_id: &str,
    mode: &str,
    model: Option<String>,
    bypass: bool,
) -> Res<String> {
    let (agent, _) = selected_executor(app, harness, project_hash, Some(thread_id))?;
    if let Some(id) = find_live_session(harness, thread_id, mode) {
        let matches = harness
            .agent.acp_sessions
            .lock()
            .unwrap()
            .get(&id)
            .is_some_and(|s| s.agent_id == agent.id);
        if matches {
            return Ok(id);
        }
        // Agent changed under a live session: hand off (D6). The transcript
        // budget is a fixed default until the new agent reports its context
        // window via usage_update (D8) — 100k tokens covers every current
        // agent's window conservatively enough for a text prefix.
        let turns: Vec<handoff::TranscriptTurn> = store::read_thread(
            &palisade_home(),
            project_hash,
            thread_id,
        )
        .unwrap_or_default()
        .into_iter()
        .filter(|m| m.role == "user" || m.role == "assistant")
        .map(|m| handoff::TranscriptTurn {
            role: m.role,
            content: m.content,
        })
        .collect();
        end_session(harness, thread_id, &id, "switched");
        let new_id = start_session(app, harness, project_hash, thread_id, mode, true, model, bypass)?;
        let transcript = handoff::build_handoff_transcript(&turns, 100_000);
        let transcript_prefix = if transcript.is_empty() {
            None
        } else {
            Some(format!(
                "This conversation was handed off from another agent. Transcript so far:\n\n{transcript}"
            ))
        };
        // D12: re-inject the stored spec_type as the first turn body on
        // handoff, so the new agent doesn't lose the framing if the original
        // turn was truncated by the 100k budget. Only when spec_type is set
        // and no open change exists. Prepended to the transcript prefix.
        //
        // Spec-mode only: the reinjection carries the grill-explore skill, and
        // pushing that into a go-mode handoff told an agent mid-build to start
        // interviewing the user about the concept instead.
        let reinjection = thread_meta(project_hash, thread_id)
            .and_then(|m| spec_type_reinjection(mode, &m));
        let prefix = match (reinjection, transcript_prefix) {
            (Some(reinjection), Some(tp)) => Some(format!("{reinjection}\n\n{tp}")),
            (Some(reinjection), None) => Some(reinjection),
            (None, tp) => tp,
        };
        park_prefix(harness, &new_id, prefix);
        return Ok(new_id);
    }
    let id = start_session(app, harness, project_hash, thread_id, mode, true, model, bypass)?;
    park_prefix(harness, &id, None);
    Ok(id)
}

/// Park a new session's first-turn prefix — only a handoff has a transcript to
/// carry. `send_to` drains and clears the slot, so it lands exactly once per
/// session; a `/go` that starts a session without prompting keeps it for the
/// next real turn.
fn park_prefix(harness: &Harness, session_id: &str, prefix: Option<String>) {
    if let Some(prefix) = prefix {
        harness.agent.pending_prefix.lock_or_recover().insert(session_id.to_string(), prefix);
    }
}

/// Drop a session from the live map and close its record. Idempotent.
fn end_session(harness: &Harness, thread_id: &str, session_id: &str, outcome: &str) {
    harness.agent.pending_changes.lock_or_recover().remove(session_id);
    harness.agent.pending_prefix.lock_or_recover().remove(session_id);
    harness.agent.session_commands.lock_or_recover().remove(session_id);
    if let Some(mut session) = harness.agent.acp_sessions.lock_or_recover().remove(session_id) {
        session.terminate();
        let head_after = git_bin()
            .ok()
            .and_then(|bin| git::rev_parse_head(&bin, &session.project_root));
        let _ = store::close_session(
            &palisade_home(),
            &session.project_hash,
            thread_id,
            session_id,
            outcome,
            head_after.as_deref(),
        );
    }
}

/// Release every idle session when the application is exiting.
///
/// An idle session is deliberately retained while the application is open.
/// Besides preserving its ACP conversation, the subprocess owns the
/// authentication state negotiated during `initialize`. Releasing it merely
/// because the user looked at another thread made thread navigation look like
/// an authentication boundary.
fn release_idle_sessions_on_exit(harness: &Harness) {
    let idle: Vec<(String, String)> = harness
        .agent.acp_sessions
        .lock_or_recover()
        .values()
        .filter(|s| !s.is_busy())
        .map(|s| (s.id.clone(), s.thread_id.clone()))
        .collect();
    for (id, thread) in idle {
        end_session(harness, &thread, &id, "done");
    }
}

/// Called when the user leaves a thread.
///
/// The session stays alive, idle or busy. Thread navigation must not destroy
/// an authenticated executor connection; explicit Stop, executor switching,
/// archiving, and app shutdown remain the lifecycle boundaries.
#[tauri::command]
async fn leave_thread(_app: tauri::AppHandle, _thread_id: String) -> Res<()> {
    tokio::task::spawn_blocking(move || {
        // The other half of prune-on-archive: a thread archived while its work
        // was still unmerged becomes prunable the moment that work lands, and
        // leaving a thread is the idle moment to notice. Cheap when there is
        // nothing to do — an archived thread with no worktree on disk costs a
        // directory check.
        for project in store::list_projects(&palisade_home()).unwrap_or_default() {
            sweep_archived_worktrees(&project.hash);
        }
        Ok(())
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

/// Record the user's turn, then forward it to the executor if one is live.
#[tauri::command]
async fn send_message(
    app: tauri::AppHandle,
    project_hash: String,
    thread_id: String,
    content: String,
    mode: String,
    model: Option<String>,
    bypass: bool,
    attachments: Option<Vec<String>>,
    skills: Option<Vec<String>>,
) -> Res<Message> {
    tokio::task::spawn_blocking(move || {
        let harness: tauri::State<'_, Harness> = app.state();
        // Recorded before the executor is resolved, deliberately: a chat-only
        // project still keeps the user's turn. There is no session to name yet.
        let message = store::append_row(
            &palisade_home(),
            &project_hash,
            &thread_id,
            Message {
                attachments: attachments.unwrap_or_default(),
                skills: skills.unwrap_or_default(),
                ..Message::row("user", &mode, &content)
            },
        )?;
        // Name the thread after the turn that opened it, so "New thread" is
        // never what the user has to live with. In the background and silent
        // on failure: a title is cosmetic and must not delay or cost the
        // user their message. No agent fallback here: a title must never
        // cause a throwaway executor process (and therefore an unexpected
        // auth flow); the truncated first line is enough.
        title_thread(&app, TitleRequest::new(&project_hash, &thread_id, title_source(&content)), false);
        let agent = match selected_executor(&app, &harness, &project_hash, Some(&thread_id)) {
            Ok((agent, _)) => agent,
            Err(_) => {
            // Chat-only mode: the turn is still recorded, nothing answers it.
            return Ok(message);
            }
        };
        let id = match ensure_session(
            &app,
            &harness,
            &project_hash,
            &thread_id,
            &mode,
            model,
            bypass,
        ) {
            Ok(id) => id,
            Err(error) if error.kind == crate::error::ErrorKind::AuthRequired => {
                harness.queue_pending_auth_turn(
                    &agent.id,
                    executor::PendingAuthTurn {
                        project_hash: project_hash.clone(),
                        thread_id: thread_id.clone(),
                        content: content.clone(),
                        mode: mode.clone(),
                        bypass,
                        attachments: message.attachments.clone(),
                        skills: message.skills.clone(),
                    },
                );
                // A system row keeps the recovery action durable and gives
                // EventView its existing sign-in controls once login methods
                // have been learned during initialize.
                let _ = store::append_message(
                    &palisade_home(),
                    &project_hash,
                    &thread_id,
                    "system",
                    &mode,
                    &format!(
                        "Palisade is waiting for you to sign in. It will resume this message automatically once.\n\n{error}"
                    ),
                    None,
                );
                let _ = app.emit("agent-auth-required", &thread_id);
                let _ = app.emit("thread-updated", &thread_id);
                return Ok(message);
            }
            Err(error) => return Err(error),
        };
        send_to(&harness, &project_hash, &id, &message)?;
        Ok(message)
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

/// Re-send a durable user turn after a failed prompt without appending a
/// second copy. Prompt requests are intentionally never retried by the ACP
/// bridge: a Go turn may have partially executed before its transport failed.
#[tauri::command]
async fn retry_message(
    app: tauri::AppHandle,
    project_hash: String,
    thread_id: String,
    message_seq: u64,
) -> Res<()> {
    tokio::task::spawn_blocking(move || {
        let home = palisade_home();
        let message = store::read_thread_window(&home, &project_hash, &thread_id, store::Window::From(message_seq))?
            .into_iter()
            .find(|message| message.seq == message_seq && message.role == "user")
            .ok_or_else(|| crate::PalisadeError::not_found("the original user message is no longer available"))?;
        let harness: tauri::State<'_, Harness> = app.state();
        let id = ensure_session(&app, &harness, &project_hash, &thread_id, &message.mode, None, false)?;
        send_to(&harness, &project_hash, &id, &message)
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

/// ACP agents use a structured `auth_required` error when they can, but a few
/// adapters still surface only provider prose. Keep this mirror intentionally
/// narrow and aligned with the frontend's auth error classification.
/// Ask the thread's own agent to name the thread, in the background, and
/// upgrade the title if it answers.
///
/// Detached on purpose: this spawns an agent process, which takes seconds,
/// and the user's message must not wait behind a cosmetic rename. Silent on
/// every failure — the truncated placeholder already on screen is a working
/// title, just a worse one.
fn agent_title_later(app: &tauri::AppHandle, project_hash: &str, thread_id: &str, prompt: &str) {
    let app = app.clone();
    let project_hash = project_hash.to_string();
    let thread_id = thread_id.to_string();
    let prompt: String = prompt.chars().take(600).collect();
    std::thread::spawn(move || {
        let harness: tauri::State<'_, Harness> = app.state();
        let Ok(root) = project_root(&project_hash) else {
            return;
        };
        let Ok((agent, bin)) = selected_executor(&app, &harness, &project_hash, Some(&thread_id))
        else {
            return;
        };
        let spawn = acp_client::AcpSpawn {
            agent_id: agent.id.clone(),
            agent_name: agent.name.clone(),
            bin,
            cmd: agent.cmd.clone(),
            args: agent.args.clone(),
            project_root: root,
            project_hash: project_hash.clone(),
            thread_id: String::new(),
            mode: "spec".into(),
            bypass: false,
            model: None,
            palisade_home: palisade_home(),
            extra_env: vec![],
        };
        let asked = format!(
            "Name this coding thread in 3-6 words, as a title. Reply with the title              and nothing else: no quotes, no punctuation at the end, no commentary.\n\n             Request: {prompt}"
        );
        let Ok(answer) = acp_client::agent_oneshot(spawn, &asked, std::time::Duration::from_secs(45)) else {
            return;
        };
        let Some(title) = completion::clean_title(&answer) else {
            return;
        };
        if store::upgrade_auto_title(&palisade_home(), &project_hash, &thread_id, &title).is_ok() {
            let _ = app.emit("thread-updated", &thread_id);
        }
    });
}

/// Which thread to name, and from what. Owned, because the naming finishes on
/// a background thread after the command that asked for it has returned.
struct TitleRequest {
    project_hash: String,
    thread_id: String,
    prompt: String,
}

impl TitleRequest {
    fn new(project_hash: &str, thread_id: &str, prompt: &str) -> Self {
        Self { project_hash: project_hash.into(), thread_id: thread_id.into(), prompt: prompt.into() }
    }
}

/// What a turn is *about*, for naming its thread: a command typed at the
/// head (`/tdd …`) says how, not what the user asked for. Tray skills are
/// stored apart from `content`, so only a typed one can be here.
fn title_source(content: &str) -> &str {
    match content.strip_prefix('/').or_else(|| content.strip_prefix('$')) {
        Some(rest) => match rest.split_once(char::is_whitespace) {
            Some((_, text)) if !text.trim().is_empty() => text.trim_start(),
            _ => content,
        },
        None => content,
    }
}

/// Payload of `thread-title-pending`: a thread's title is being written
/// (`pending`), or has landed.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TitlePending<'a> {
    thread_id: &'a str,
    pending: bool,
}

/// Threads whose local-model title is being written right now. A second turn
/// sent while the first is still being named must not start a second run —
/// that would call the model twice and clear the UI's skeleton early.
static TITLING: Mutex<std::collections::BTreeSet<String>> = Mutex::new(std::collections::BTreeSet::new());

/// A thread's place in [`TITLING`]; dropping it frees the thread for naming
/// again, even if the naming thread panics.
struct TitlingClaim(String);

impl TitlingClaim {
    /// `None` when the thread is already being named.
    fn take(thread_id: &str) -> Option<Self> {
        TITLING.lock_or_recover().insert(thread_id.to_string()).then(|| Self(thread_id.to_string()))
    }
}

impl Drop for TitlingClaim {
    fn drop(&mut self) {
        TITLING.lock_or_recover().remove(&self.0);
    }
}

/// Name a thread after the turn that opened it, without making that turn
/// wait on it.
///
/// The local model can need a cold start (up to 45s) before it answers, so it
/// runs on its own thread, bracketed by `thread-title-pending` events the UI
/// shows as a title skeleton. Only a thread still on its placeholder name is
/// touched, so every later turn costs nothing. With no local model
/// installed there is nothing to wait for: the truncated first line goes up
/// at once. `agent_fallback` asks the thread's own agent when the local
/// model has no answer.
fn title_thread(app: &tauri::AppHandle, request: TitleRequest, agent_fallback: bool) {
    let TitleRequest { project_hash, thread_id, prompt } = request;
    if !thread_meta(&project_hash, &thread_id).is_some_and(|m| store::needs_auto_title(&m)) {
        return;
    }
    if !local_title_installed(app) {
        let _ = store::set_auto_title(&palisade_home(), &project_hash, &thread_id, &prompt, None);
        if agent_fallback {
            agent_title_later(app, &project_hash, &thread_id, &prompt);
        }
        return;
    }
    let Some(claim) = TitlingClaim::take(&thread_id) else {
        return;
    };
    let _ = app.emit("thread-title-pending", TitlePending { thread_id: &thread_id, pending: true });
    let app = app.clone();
    std::thread::spawn(move || {
        let harness: tauri::State<'_, Harness> = app.state();
        let local = model_title(&app, &harness, &prompt);
        let _ = store::set_auto_title(&palisade_home(), &project_hash, &thread_id, &prompt, local.as_deref());
        drop(claim);
        let _ = app.emit("thread-updated", &thread_id);
        let _ = app.emit("thread-title-pending", TitlePending { thread_id: &thread_id, pending: false });
        if local.is_none() && agent_fallback {
            agent_title_later(&app, &project_hash, &thread_id, &prompt);
        }
    });
}

/// Give truncated automatic names the same local-model treatment as new
/// threads, once each. Work runs after project open; manual names and short
/// names stay put.
fn repair_legacy_titles(app: tauri::AppHandle, project_hash: String) {
    std::thread::spawn(move || {
        if !local_title_installed(&app) {
            return;
        }
        let home = palisade_home();
        let Ok(threads) = store::list_threads(&home, &project_hash) else {
            return;
        };
        for thread in threads.into_iter().filter(store::needs_model_retitle) {
            let Some(_claim) = TitlingClaim::take(&thread.id) else {
                continue;
            };
            let Ok(messages) = store::read_thread(&home, &project_hash, &thread.id) else {
                continue;
            };
            let Some(prompt) = messages
                .into_iter()
                .find(|m| m.role == "user")
                .map(|m| title_source(&m.content).to_string())
            else {
                continue;
            };
            let harness: tauri::State<'_, Harness> = app.state();
            let title = model_title(&app, &harness, &prompt);
            if store::finish_title_repair(&home, &project_hash, &thread.id, title.as_deref()).is_ok() && title.is_some() {
                let _ = app.emit("thread-updated", &thread.id);
            }
        }
    });
}

/// Whether the bundled sidecar and model are on disk. Checked before titling
/// rather than left to `ensure_completion_server`: a missing install makes it
/// emit a `harness-warning` ("AI completion is unavailable...") for FIM's
/// benefit, and a cosmetic title the user never asked for must not speak up
/// on their behalf.
fn local_title_installed(app: &tauri::AppHandle) -> bool {
    completion::resolve_sidecar_paths(app).is_ok_and(|(binary, model)| binary.exists() && model.exists())
}

/// The crash counter is FIM's (D33): its second strike warns and turns
/// ghost-text off. A sidecar that has already crashed once is left for FIM to
/// retry, so a title the user never asked for can never be that strike.
fn titling_may_start_sidecar(harness: &Harness) -> bool {
    *harness.completion.completion_crashes.lock_or_recover() == 0
}

/// A thread title written by the bundled local model, or `None` if it
/// didn't return anything usable.
///
/// Starts the sidecar on demand (same as `complete_code`) rather than
/// requiring FIM to already be warm: naming a thread must stay local and
/// free even for someone who turned ghost-text completion off, since the
/// model ships with every install regardless (AGENTS.md, D59). Blocks for a
/// cold start, which is why only [`title_thread`]'s background thread calls it.
fn model_title(app: &tauri::AppHandle, harness: &Harness, prompt: &str) -> Option<String> {
    if !local_title_installed(app) || !titling_may_start_sidecar(harness) {
        return None;
    }
    ensure_completion_server(app, harness).ok()?;
    let server = harness.completion.completion_server.lock_or_recover();
    let server = server.as_ref()?;
    server.title(prompt).ok()
}

/// One user turn as a caller hands it to [`send_to`]: the words, plus any
/// stored image paths and tray skills. Plain Palisade-authored prompts
/// (`/go`'s handoff, chain steps) convert from a string.
pub(crate) struct UserTurn<'a> {
    content: &'a str,
    attachments: &'a [String],
    skills: &'a [String],
}

impl<'a> From<&'a str> for UserTurn<'a> {
    fn from(content: &'a str) -> Self {
        Self { content, attachments: &[], skills: &[] }
    }
}

impl<'a> From<&'a String> for UserTurn<'a> {
    fn from(content: &'a String) -> Self {
        content.as_str().into()
    }
}

impl<'a> From<&'a Message> for UserTurn<'a> {
    fn from(m: &'a Message) -> Self {
        Self { content: &m.content, attachments: &m.attachments, skills: &m.skills }
    }
}

impl<'a> From<&'a executor::PendingAuthTurn> for UserTurn<'a> {
    fn from(p: &'a executor::PendingAuthTurn) -> Self {
        Self { content: &p.content, attachments: &p.attachments, skills: &p.skills }
    }
}

/// Send one turn to a named live session, carrying any handoff transcript
/// parked on it by `ensure_session`. Draining here — rather than at each call
/// site — is what keeps a caller that starts a session without prompting
/// (`/go`) from silently discarding the conversation so far.
fn send_to<'a>(
    harness: &Harness,
    project_hash: &str,
    session_id: &str,
    turn: impl Into<UserTurn<'a>>,
) -> Res<()> {
    let turn = turn.into();
    let home = palisade_home();
    let images = turn
        .attachments
        .iter()
        .map(|path| attachments::load(&home, project_hash, path))
        .collect::<Res<Vec<_>>>()?;
    let mut prompt = acp_client::Prompt {
        images,
        skills: turn.skills.to_vec(),
        chats: store::resolve_thread_mentions(&home, project_hash, turn.content),
        ..acp_client::Prompt::text(turn.content)
    };
    let prefix = harness.pending_prefix(session_id);
    let (mode, thread_id, root) = {
        let sessions = harness.agent.acp_sessions.lock_or_recover();
        let session = sessions.get(session_id).ok_or("executor session is not running")?;
        (session.mode.clone(), session.thread_id.clone(), session.project_root.clone())
    };
    if mode == "spec" {
        if thread_meta(project_hash, &thread_id).is_some_and(|meta| meta.open_spec_change_name.is_none()) {
            harness.agent.pending_changes.lock_or_recover()
                .entry(session_id.to_string())
                .or_insert_with(|| executor::ChangeWatch {
                    project_hash: project_hash.to_string(),
                    thread_id: thread_id.clone(),
                    before: executor::openspec_proposed_dirs(&root),
                    project_root: root.clone(),
                });
        }
        let already_framed = grill_inject::leads_with_skill(turn.content)
            || prefix.as_deref().is_some_and(grill_inject::leads_with_skill);
        prompt.context.extend(prepare_spec_turn(project_hash, &thread_id, &root, already_framed));
    }
    {
        let sessions = harness.agent.acp_sessions.lock_or_recover();
        let session = sessions.get(session_id).ok_or("executor session is not running")?;
        if let Err(error) = acp_client::send_acp_prompt(session, prefix.as_deref(), prompt) {
            harness.agent.pending_changes.lock_or_recover().remove(session_id);
            return Err(error.into());
        }
    }
    harness.clear_pending_prefix(session_id);
    Ok(())
}

/// Ready a Spec-mode turn: give the project the `openspec/` root it can
/// write into, and — unless the turn already leads with a grill skill —
/// return the context telling the agent this turn is spec work (D19).
/// Without it a plain Spec turn went out bare, the agent started building,
/// and the write guard cancelled the turn.
fn prepare_spec_turn(project_hash: &str, thread_id: &str, root: &Path, already_framed: bool) -> Option<String> {
    // Not installed or failing is not fatal: the grill skill's preflight
    // tells the user what to do.
    if let Err(e) = crate::openspec_cache::init_if_missing(root) {
        eprintln!("openspec init in {}: {e}", root.display());
    }
    if already_framed {
        return None;
    }
    let has_change = thread_meta(project_hash, thread_id).is_some_and(|m| m.open_spec_change_name.is_some());
    grill_inject::spec_turn_context(has_change)
}

/// Copy a dropped (`path`) or pasted (`data_base64` + `ext`) image into the
/// project's attachments dir. Returns the stored path the turn will carry.
#[tauri::command]
async fn save_attachment(
    project_hash: String,
    path: Option<String>,
    data_base64: Option<String>,
    ext: Option<String>,
) -> Res<String> {
    tokio::task::spawn_blocking(move || {
        use base64::prelude::*;
        let home = palisade_home();
        let stored = match (path, data_base64) {
            (Some(path), _) => attachments::save_from(&home, &project_hash, std::path::Path::new(&path))?,
            (None, Some(data)) => {
                // Refuse an oversized paste before decoding it into memory.
                if data.len() / 4 * 3 > attachments::MAX_BYTES as usize {
                    return Err("image is larger than 20 MB".into());
                }
                let bytes = BASE64_STANDARD
                    .decode(data)
                    .map_err(|e| crate::PalisadeError::from(format!("bad image data: {e}")))?;
                attachments::save(&home, &project_hash, &bytes, ext.as_deref().unwrap_or("png"))?
            }
            (None, None) => return Err("nothing to attach".into()),
        };
        Ok(stored.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

/// A stored attachment as a `data:` URL, for thumbnails.
#[tauri::command]
async fn read_attachment(project_hash: String, path: String) -> Res<String> {
    tokio::task::spawn_blocking(move || attachments::data_url(&palisade_home(), &project_hash, &path))
        .await
        .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

/// `/go`: bring up a write-enabled session on this thread.
#[tauri::command]
async fn go_mode(
    app: tauri::AppHandle,
    project_hash: String,
    thread_id: String,
    model: Option<String>,
    bypass: bool,
) -> Res<ThreadMeta> {
    tokio::task::spawn_blocking(move || {
        let harness: tauri::State<'_, Harness> = app.state();
        let flight = preflight_for_harness(&*harness, true);
        if flight.selected.is_none() {
            return Err("No executor found on PATH — chat-only mode.".into());
        }

        let meta = store::set_thread_mode(&palisade_home(), &project_hash, &thread_id, "go")?;
        // D5: when this thread's executor slot resolves to a saved chain, go
        // mode runs the chain instead of bringing up one agent session. Still
        // go mode — no third mode, just a different thing filling the same
        // slot. The frontend starts the run once it sees this on the meta.
        if let Some(chain) = selected_chain(&project_hash, &thread_id) {
            let loaded = chains::load(&project_root(&project_hash)?, &chain)?;
            check_agents_available(&harness, &loaded)?;
            return Ok(meta);
        }
        // No session is started here (#17). Flipping to go-mode is a statement
        // of intent, not a request: `send_message` calls `ensure_session`
        // itself, so the agent comes up when the user actually sends
        // something. The preflight and chain checks above stay — they are what
        // makes the toggle refuse a mode this thread can't run.
        //
        // `model` and `bypass` stay on the command: they describe the session
        // the *next* send will bring up, and `send_message` passes its own.
        let _ = (model, bypass);
        // Per amended D19: go-mode has no skill injection. The user toggles
        // go-mode to let the agent write code; grill-apply is a separate
        // UI-triggered one-shot in spec-mode.
        Ok(meta)
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

/// Wrap the spec_type in a sentence so the agent knows it is the starting
/// concept, not just an unexplained topic like "Feature" or "Bugfix".
/// What the built-in framing cards are *for*: each one pre-wires the questions
/// that kind of work always has to answer, so the agent opens on them instead
/// of on "what would you like to build?".
///
/// A framing the user typed themselves gets no invented guidance — Palisade
/// does not know what questions their framing implies, and guessing would put
/// words in the agent's mouth.
fn framing_guidance(spec_type: &str) -> Option<&'static str> {
    match spec_type.trim().to_ascii_lowercase().as_str() {
        "feature" => Some(
            "This is a feature: something that does not exist yet. Establish \
             the user-visible outcome, who it is for, and what is explicitly \
             out of scope before proposing any design.",
        ),
        "bugfix" => Some(
            "This is a bugfix: something already built is behaving wrongly. \
             Establish the observed behaviour, the expected behaviour, and how \
             to reproduce it. Trace it to a root cause before proposing a \
             change; do not patch the symptom.",
        ),
        _ => None,
    }
}

/// The first user turn: the framing card's guidance, then the user's own
/// request, verbatim and clearly marked as theirs.
///
/// The request used to be the framing label alone — "Start exploring the
/// following concept: Feature" — which told the agent nothing about what the
/// user actually wanted, and made the interview open by asking for it.
fn framed_spec_body(spec_type: &str, description: Option<&str>) -> String {
    let framing = spec_type.trim();
    let request = description.map(str::trim).filter(|d| !d.is_empty());
    let mut body = String::from("Start exploring.");
    if !framing.is_empty() {
        body = format!("Start exploring this {framing}.");
    }
    if let Some(guidance) = framing_guidance(framing) {
        body.push('\n');
        body.push_str(guidance);
    }
    match request {
        Some(request) => {
            body.push_str("\n\nWhat the user asked for, in their own words:\n");
            body.push_str(request);
        }
        // A thread framed before descriptions were required, or a handoff
        // re-injection, where the request is already in the transcript.
        None if !framing.is_empty() => {}
        None => {}
    }
    body
}

/// Per D12: on agent handoff (transcript rebuilt with 100k budget), re-inject
/// the stored `spec_type` as the first turn body if the thread has a spec_type
/// and no open change. Returns the grill-explore skill + spec_type prompt to
/// prepend to the handoff prefix. None when conditions aren't met — and
/// `ensure_session` only calls this in the handoff path (same-agent restart
/// returns None prefix, so no reinjection happens there).
fn spec_type_reinjection(mode: &str, meta: &store::ThreadMeta) -> Option<String> {
    // The reinjection is the grill-explore skill; go-mode injects no skill
    // (D19), and handing it to a go session mid-build restarts the interview.
    if mode != "spec" {
        return None;
    }
    match (&meta.spec_type, &meta.open_spec_change_name) {
        // No description here: on handoff the user's own words are already in
        // the rebuilt transcript, and repeating them would read as a second
        // request. Only the framing guidance has to be re-established.
        (Some(spec_type), None) => Some(grill_inject::build_prompt(
            "spec",
            false,
            &framed_spec_body(spec_type, None),
        )),
        _ => None,
    }
}

/// Decide what initial prompt (if any) to send when entering spec-mode.
/// Per amended D19: spec-mode with no open change auto-fires grill-explore.
/// Per D5: `spec_type` is the user turn body (replacing the bare "grill-explore"
/// literal). Per D10: when an existing change is open, spec_type is silently
/// dropped — no auto-injection, the user is past explore.
///
/// `start` is what separates the two callers (#17): picking a spec type in the
/// framing menu is a deliberate "begin exploring" act, while flipping the mode
/// toggle is not a request at all — it records intent and sends nothing.
fn spec_mode_initial_prompt(
    meta: &store::ThreadMeta,
    spec_type: &str,
    description: Option<&str>,
    start: bool,
) -> Option<String> {
    if !start {
        return None;
    }
    if meta.open_spec_change_name.is_none() {
        Some(grill_inject::build_prompt(
            "spec",
            false,
            &framed_spec_body(spec_type, description),
        ))
    } else {
        None
    }
}

/// Sets the thread's default mode back to spec. Under amended D19, *starting*
/// spec-mode with no open change auto-fires grill-explore — the first stage of
/// the explore → propose → apply progression. With an existing change, it just
/// sets the mode (the user is past explore).
///
/// `start` is false for the mode toggle, which must be inert: it records the
/// thread's intent and nothing else. It used to spawn a session, append a
/// visible user message and send a grill-explore turn on every flip back into
/// Spec, so switching modes with an empty composer fired a real agent request
/// (#17). Only the framing menu — where the user picks what they are exploring
/// — passes true.
#[tauri::command]
async fn spec_mode(
    app: tauri::AppHandle,
    project_hash: String,
    thread_id: String,
    spec_type: String,
    description: Option<String>,
    bypass: bool,
    start: bool,
    skills: Option<Vec<String>>,
) -> Res<ThreadMeta> {
    tokio::task::spawn_blocking(move || {
        let skills = skills.unwrap_or_default();
        let harness: tauri::State<'_, Harness> = app.state();
        let meta = store::set_thread_mode(&palisade_home(), &project_hash, &thread_id, "spec")?;
        // Persist the spec_type framing on the thread (D11) — survives restarts
        // and is re-injected on agent handoff (D12). Only stored when the user
        // commits to a spec type (non-empty).
        let meta = if spec_type.trim().is_empty() {
            meta
        } else {
            store::set_spec_type(&palisade_home(), &project_hash, &thread_id, &spec_type)?
        };
        let request = description.as_deref().map(str::trim).filter(|d| !d.is_empty());
        // A spec thread is named exactly the way every other thread is —
        // agent title, else the local model, else the first line of the
        // request — not after which card the user pressed. "Feature" is the
        // same row for every feature they will ever spec (#30/#35).
        if let Some(request) = request {
            title_thread(&app, TitleRequest::new(&project_hash, &thread_id, request), true);
        }
        if let Some(prompt) = spec_mode_initial_prompt(&meta, &spec_type, request, start) {
            if preflight_for_harness(&*harness, true).selected.is_some() {
                let id =
                    ensure_session(&app, &harness, &project_hash, &thread_id, "spec", None, bypass)?;
                // The visible user message is what the user actually typed —
                // the skill instructions and the framing guidance go to the
                // agent but are not shown in the chat. Older threads framed
                // before a request was required fall back to the label.
                store::append_row(
                    &palisade_home(),
                    &project_hash,
                    &thread_id,
                    store::Message {
                        session_id: Some(id.clone()),
                        skills: skills.clone(),
                        ..store::Message::row("user", "spec", request.unwrap_or(&spec_type))
                    },
                )?;
                send_to(&harness, &project_hash, &id, UserTurn { content: &prompt, attachments: &[], skills: &skills })?;
            }
        }
        Ok(meta)
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

/// The thread's executor picker choice (D9/D18). `None` reverts to the
/// project `executorOverride`, then auto-detection. Persisted on the thread;
/// the next `ensure_session` restarts a live session whose agent no longer
/// matches.
#[tauri::command]
async fn set_thread_executor(
    project_hash: String,
    thread_id: String,
    executor: Option<String>,
    model: Option<String>,
) -> Res<ThreadMeta> {
    tokio::task::spawn_blocking(move || {
        store::set_thread_executor(
            &palisade_home(),
            &project_hash,
            &thread_id,
            executor.as_deref(),
            model.as_deref(),
        )
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

/// The models an installed agent actually offers, learned by spawning it for
/// a throwaway `session/new` and reading its `model` config option (D11
/// reversal — the picker needs a real list, not a hardcoded one).
#[tauri::command]
async fn list_models(
    app: tauri::AppHandle,
    project_hash: Option<String>,
    agent_id: String,
) -> Res<acp_client::ModelState> {
    tokio::task::spawn_blocking(move || {
        let harness: tauri::State<'_, Harness> = app.state();
        let flight = preflight_for_harness(&*harness, false);
        let agent = flight
            .agent(&agent_id)
            .ok_or_else(|| format!("unknown or unavailable agent `{agent_id}`"))?;
        let path = agent.path.clone().ok_or("agent has no path")?;
        // The onboarding screen offers a provider/model picker before any
        // project is open (Amendment 8), and a model probe only needs *a*
        // working directory — fall back to home rather than refusing.
        let root = match project_hash.as_deref() {
            Some(hash) => project_root(hash)?,
            None => dirs_home(),
        };
        acp_client::probe_models(
            agent.id.clone(),
            agent.cmd.clone(),
            PathBuf::from(path),
            agent.args.clone(),
            root,
        )
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

/// One interactive login an agent advertised, as the frontend can offer it.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentLoginOption {
    method_id: String,
    label: String,
    /// "terminal" (run `shell_line`) or "protocol" (call `agent_authenticate`).
    kind: acp_client::AgentLoginKind,
    /// Empty for a protocol login — there is no command to run.
    shell_line: String,
}

/// The logins this thread's agent says the *client* should run.
///
/// ACP agents that own an interactive login advertise it at `initialize` and
/// expect the client to run it — their own `authenticate` refuses those
/// methods. Palisade has a terminal, so it can run one, which is what makes an
/// expired agent login fixable without leaving the app (#19). Empty for an
/// agent that advertises none.
#[tauri::command]
async fn agent_logins(
    app: tauri::AppHandle,
    project_hash: String,
    thread_id: Option<String>,
    agent_id: Option<String>,
) -> Res<Vec<AgentLoginOption>> {
    tokio::task::spawn_blocking(move || {
        let harness: tauri::State<'_, Harness> = app.state();
        // Named agent, or whatever this thread resolves to. The picker asks
        // by name — it offers a sign-in before any thread has been pointed at
        // that agent.
        let agent = match agent_id {
            Some(id) => preflight_for_harness(&*harness, false)
                .agent(&id)
                .cloned()
                .ok_or_else(|| format!("unknown or unavailable agent `{id}`"))?,
            None => selected_executor(&app, &harness, &project_hash, thread_id.as_deref())?.0,
        };
        // Do not spawn an executor simply to decorate the UI with login
        // methods. `initialize` may itself touch provider auth. A real session
        // start records its advertised methods, after which this command
        // returns them for the retry affordance.
        Ok(acp_client::logins_for(&agent.id)
            .into_iter()
            .map(|login| AgentLoginOption {
                method_id: login.method_id.clone(),
                label: login.label.clone(),
                kind: login.kind,
                shell_line: match login.kind {
                    acp_client::AgentLoginKind::Terminal => login.shell_line(),
                    acp_client::AgentLoginKind::Protocol => String::new(),
                },
            })
            .collect())
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

/// Run one of an agent's advertised logins that the protocol drives.
///
/// The counterpart to running a `terminal` login in Palisade's terminal: here
/// the client calls `authenticate` with the chosen method and the agent runs
/// its own flow. Between the two kinds, every agent that advertises anything
/// can be signed in from inside the app (#19).
#[tauri::command]
async fn agent_authenticate(
    app: tauri::AppHandle,
    project_hash: String,
    thread_id: Option<String>,
    agent_id: Option<String>,
    method_id: String,
) -> Res<()> {
    tokio::task::spawn_blocking(move || {
        let harness: tauri::State<'_, Harness> = app.state();
        let agent = match agent_id {
            Some(id) => preflight_for_harness(&*harness, false)
                .agent(&id)
                .cloned()
                .ok_or_else(|| format!("unknown or unavailable agent `{id}`"))?,
            None => selected_executor(&app, &harness, &project_hash, thread_id.as_deref())?.0,
        };
        let path = agent.path.clone().ok_or("agent has no path")?;
        acp_client::authenticate_agent(
            agent.id.clone(),
            agent.cmd.clone(),
            PathBuf::from(path),
            agent.args.clone(),
            project_root(&project_hash)?,
            method_id,
        )?;
        // The user has chosen and completed a protocol login. If this agent
        // was blocking one or more real turns, deliver every one of them, in
        // the order they were sent, rather than asking the user to copy or
        // retype anything (#43: a second blocked turn must not be dropped).
        let mut queued = harness.take_pending_auth_turns(&agent.id).into_iter();
        while let Some(pending) = queued.next() {
            match ensure_session(
                &app,
                &harness,
                &pending.project_hash,
                &pending.thread_id,
                &pending.mode,
                None,
                pending.bypass,
            ) {
                Ok(session_id) => send_to(&harness, &pending.project_hash, &session_id, &pending)?,
                Err(error) if error.kind == crate::error::ErrorKind::AuthRequired => {
                    let mut remaining = vec![pending];
                    remaining.extend(queued);
                    harness.requeue_pending_auth_turns(&agent.id, remaining);
                    return Err(error);
                }
                Err(error) => return Err(error),
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

/// The user's home directory, or the current directory if it can't be read.
fn dirs_home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

/// `/propose`: run `grill-propose` in the live spec-mode executor.
#[tauri::command]
async fn propose(
    app: tauri::AppHandle,
    project_hash: String,
    thread_id: String,
    model: Option<String>,
    bypass: bool,
) -> Res<()> {
    tokio::task::spawn_blocking(move || {
        let harness: tauri::State<'_, Harness> = app.state();
        let id =
            ensure_session(&app, &harness, &project_hash, &thread_id, "spec", model, bypass)?;
        let prompt = grill_inject::build_prompt("spec", true, "grill-propose");

        // Persist only the short label — the skill content goes to the agent
        // but is not shown in the chat.
        store::append_message(
            &palisade_home(),
            &project_hash,
            &thread_id,
            "user",
            "spec",
            "grill-propose",
            Some(&id),
        )?;
        send_to(&harness, &project_hash, &id, &prompt)
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

/// Which diff Generate should describe: whatever is staged, or — when
/// nothing is staged — the working tree. Deciding what to stage usually
/// comes *after* reading a summary of what changed, so refusing to draft
/// until something is staged makes the button useless in the common case
/// (raised by a reviewer working exactly that way).
fn diff_to_describe(
    staged: &str,
    working: &str,
    untracked: &[String],
) -> Option<(&'static str, String)> {
    if !staged.trim().is_empty() {
        return Some(("staged", staged.to_string()));
    }
    // `git diff` says nothing about untracked files, so a working-tree
    // fallback built from it alone described 1 of 18 changes in a project
    // that was mostly new files — and the draft read as confidently as if
    // it had seen everything. They are listed by name rather than by
    // content: naming them is honest and cheap, and `git add -N` to make
    // them diffable would mutate the index behind the user's back.
    let new_files = if untracked.is_empty() {
        String::new()
    } else {
        format!(
            "\n\nNew files, not yet tracked (no diff available — describe them \
             by their paths):\n{}",
            untracked
                .iter()
                .map(|path| format!("- {path}"))
                .collect::<Vec<_>>()
                .join("\n")
        )
    };
    if working.trim().is_empty() && new_files.is_empty() {
        return None;
    }
    Some(("working-tree", format!("{working}{new_files}")))
}

/// The prompt behind the Source Control panel's **Generate** button
/// (Amendment 7). A real summarisation of the diff through the project's
/// executor — deliberately not a canned template.
fn commit_message_prompt(scope: &str, diff: &str, rules: Option<&str>) -> String {
    let rules = rules
        .map(|rules| format!("This project's commit rules (they override the rules below):\n{rules}\n\n"))
        .unwrap_or_default();
    format!(
        "Write a git commit message for the {scope} diff below.\n\n\
         {rules}Rules:\n\
         - Conventional-commits subject line, imperative mood, <= 72 chars.\n\
         - Then a blank line and 1-3 short bullets on *why*, only if the diff \
           is not self-explanatory.\n\
         - Describe only what this diff actually changes. Do not invent scope.\n\
         - Reply with the commit message and nothing else: no preamble, no \
           code fences, no commentary.\n\n\
         ```diff\n{diff}\n```"
    )
}

/// Cap on the diff handed to the agent. A staged diff can be megabytes
/// (lockfiles, generated code); past this the tail adds nothing a subject
/// line will mention and just burns the agent's context.
const COMMIT_DIFF_CAP: usize = 48 * 1024;

fn cap_diff(diff: &str) -> String {
    if diff.len() <= COMMIT_DIFF_CAP {
        return diff.to_string();
    }
    let mut end = COMMIT_DIFF_CAP;
    while end > 0 && !diff.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n… [diff truncated]", &diff[..end])
}

/// The commit-message section of the repo's agent instructions: the part of
/// AGENTS.md (else CLAUDE.md) under a heading that mentions commits, or failing
/// that its lines about commit messages. `None` when the repo sets no rules.
fn commit_rules(root: &std::path::Path) -> Option<String> {
    ["AGENTS.md", "CLAUDE.md"]
        .iter()
        .filter_map(|name| std::fs::read_to_string(root.join(name)).ok())
        .find_map(|text| commit_rules_in(&text))
}

fn commit_rules_in(text: &str) -> Option<String> {
    let level = |line: &str| line.chars().take_while(|c| *c == '#').count();
    let lines: Vec<&str> = text.lines().collect();
    let section = lines
        .iter()
        .position(|l| level(l) > 0 && l.to_lowercase().contains("commit"))
        .map(|start| {
            let depth = level(lines[start]);
            lines[start + 1..]
                .iter()
                .take_while(|l| !(level(l) > 0 && level(l) <= depth))
                .copied()
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_else(|| {
            lines
                .iter()
                .filter(|l| l.to_lowercase().contains("commit message"))
                .copied()
                .collect::<Vec<_>>()
                .join("\n")
        });
    let section = section.trim();
    (!section.is_empty()).then(|| section.chars().take(1500).collect())
}

/// A commit subject from the local model, in the repo's style. `None` when no
/// local model is running, it produced nothing usable, or the repo's written
/// rules ask for more than Conventional Commits — a 0.5B model can't follow
/// prose rules, so those repos go to the agent, which gets them verbatim.
fn local_commit_subject(
    harness: &Harness,
    bin: &std::path::Path,
    root: &std::path::Path,
    diff: &str,
    rules: Option<&str>,
) -> Option<String> {
    let conventional = match rules {
        Some(rules) if rules.to_lowercase().contains("conventional commit") => true,
        Some(_) => return None,
        // No written rules: follow what the history already does.
        None => {
            let subjects: Vec<String> = git::log(bin, root, 20)
                .unwrap_or_default()
                .into_iter()
                .map(|entry| entry.subject)
                .filter(|subject| !subject.starts_with("Merge "))
                .collect();
            let conv = subjects.iter().filter(|s| completion::is_conventional_subject(s)).count();
            conv * 2 > subjects.len()
        }
    };
    let server = harness.completion.completion_server.lock_or_recover();
    server
        .as_ref()
        .filter(|s| s.is_alive())
        .and_then(|s| s.commit_subject(diff, conventional).ok())
}

/// Draft a commit message from the staged diff: the local model when one is
/// running, else the project's executor.
///
/// Runs on a throwaway session rather than the thread's own: the draft is a
/// value returned to the commit box, and routing it through a live thread
/// would dump an unrelated turn into the user's conversation. It still
/// borrows that thread's *choice* of provider and model — drafting on the
/// auto-detected agent's default model is a dead end on a machine where that
/// agent isn't installed, or where the user is over its usage limit.
/// A commit subject drafted by the *local* model, for the merge gate to
/// pre-fill with the moment it opens.
///
/// Empty string when there is no local model running — the gate shows an
/// empty box and the user writes their own (or asks the agent). Deliberately
/// not an error: "no model installed" is an ordinary state, not a failure,
/// and a red banner every time the gate opens would be noise.
#[tauri::command]
async fn suggest_commit_message(
    app: tauri::AppHandle,
    project_hash: String,
    thread_id: Option<String>,
) -> Res<String> {
    tokio::task::spawn_blocking(move || {
        let harness: tauri::State<'_, Harness> = app.state();
        let root = commands::git_cmds::tree_root(&project_hash, thread_id.as_deref())?;
        let bin = git_bin()?;
        let staged = git::staged_diff(&bin, &root)?;
        let working = git::working_tree_diff(&bin, &root)?;
        let untracked: Vec<String> = git::status(&bin, &root)?
            .into_iter()
            .filter(|file| file.code.trim() == "??")
            .map(|file| file.path)
            .collect();
        let Some((_scope, diff)) = diff_to_describe(&staged, &working, &untracked) else {
            return Ok(String::new());
        };
        let rules = commit_rules(&root);
        Ok(local_commit_subject(&harness, &bin, &root, &diff, rules.as_deref()).unwrap_or_default())
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

#[tauri::command]
async fn draft_commit_message(
    app: tauri::AppHandle,
    project_hash: String,
    thread_id: Option<String>,
) -> Res<String> {
    tokio::task::spawn_blocking(move || {
        let harness: tauri::State<'_, Harness> = app.state();
        // The tree the caller is looking at, not the project root: a thread's
        // worktree holds the diff being described, and drafting from the root
        // described a different set of changes entirely.
        let root = commands::git_cmds::tree_root(&project_hash, thread_id.as_deref())?;
        let bin = git_bin()?;
        let staged = git::staged_diff(&bin, &root)?;
        let working = git::working_tree_diff(&bin, &root)?;
        let untracked: Vec<String> = git::status(&bin, &root)?
            .into_iter()
            .filter(|file| file.code.trim() == "??")
            .map(|file| file.path)
            .collect();
        let Some((scope, diff)) = diff_to_describe(&staged, &working, &untracked) else {
            return Err("nothing to describe — the working tree is clean".into());
        };
        // Local model first: no agent process, no provider auth, sub-second.
        // The agent is the fallback, and the path for repos with custom rules.
        let rules = commit_rules(&root);
        if let Some(subject) = local_commit_subject(&harness, &bin, &root, &diff, rules.as_deref()) {
            return Ok(subject);
        }
        let (agent, bin) = selected_executor(&app, &harness, &project_hash, thread_id.as_deref())?;
        let model = thread_id
            .as_deref()
            .and_then(|id| thread_meta(&project_hash, id))
            .and_then(|meta| meta.model);
        let spawn = acp_client::AcpSpawn {
            agent_id: agent.id.clone(),
            agent_name: agent.name.clone(),
            bin,
            cmd: agent.cmd.clone(),
            args: agent.args.clone(),
            project_root: root,
            project_hash: project_hash.clone(),
            thread_id: String::new(),
            mode: "spec".into(),
            bypass: false,
            model,
            palisade_home: palisade_home(),
            extra_env: vec![],
        };
        acp_client::agent_oneshot(
            spawn,
            &commit_message_prompt(scope, &cap_diff(&diff), rules.as_deref()),
            std::time::Duration::from_secs(90),
        )
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

/// Build the grill-apply prompt for a one-shot injection in go-mode.
fn apply_skill_prompt(change: &str) -> String {
    grill_inject::inject_skill(&grill_inject::GrillSkill::Apply, &format!("grill-apply {change}"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ApplyLaunch {
    thread: store::ThreadMeta,
    chain_name: Option<String>,
    chain_run_id: Option<String>,
}

/// Apply a complete proposal in a write-enabled session without requiring a
/// separate mode switch. A failed launch restores Spec so Apply can be retried.
#[tauri::command]
async fn apply_skill(
    app: tauri::AppHandle,
    project_hash: String,
    thread_id: String,
    bypass: bool,
) -> Res<ApplyLaunch> {
    tokio::task::spawn_blocking(move || {
        let harness: tauri::State<'_, Harness> = app.state();
        let meta = store::list_threads(&palisade_home(), &project_hash)?
            .into_iter()
            .find(|t| t.id == thread_id)
            .ok_or("thread not found")?;
        if meta.current_mode != "spec" {
            return Err("Apply requires a Spec-mode thread".into());
        }
        let change = meta
            .open_spec_change_name
            .ok_or("no open spec change — apply requires a proposal")?;
        let spec_tree = spec_root(&project_hash, Some(&thread_id))?;
        if executor::openspec_change_status(&harness.workspace.openspec_cache, &spec_tree, &change) != Some(true) {
            return Err("Proposal is not complete yet — finish it before applying".into());
        }
        let thread = store::transition_thread_mode(
            &palisade_home(), &project_hash, &thread_id, "spec", "go",
        )?.ok_or("Apply requires a Spec-mode thread")?;
        let result = (|| {
            if let Some(chain_name) = selected_chain(&project_hash, &thread_id) {
                let chain = chains::load(&project_root(&project_hash)?, &chain_name)?;
                check_agents_available(&harness, &chain)?;
                let seed = format!("Apply the OpenSpec change \"{change}\".");
                let run_id = launch_chain_run(app.clone(), project_hash.clone(), chain, seed, thread_id.clone(), None)?;
                Ok(ApplyLaunch { thread, chain_name: Some(chain_name), chain_run_id: Some(run_id) })
            } else {
                let id = ensure_session(&app, &harness, &project_hash, &thread_id, "go", None, bypass)?;
                let prompt = apply_skill_prompt(&change);
                store::append_message(
                    &palisade_home(), &project_hash, &thread_id, "user", "go",
                    &format!("grill-apply {change}"), Some(&id),
                ).and_then(|_| send_to(&harness, &project_hash, &id, &prompt))?;
                Ok(ApplyLaunch { thread, chain_name: None, chain_run_id: None })
            }
        })();
        match result {
            Ok(launch) => Ok(launch),
            Err(error) => {
                let _ = store::transition_thread_mode(
                    &palisade_home(), &project_hash, &thread_id, "go", "spec",
                );
                Err(error)
            }
        }
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

/// `change_status`: whether a change's planning artifacts are all complete.
/// Returns `true` when `openspec status` reports `isComplete: true`, `false`
/// when it reports `false`, and `null` when `openspec` or the change is missing.
#[tauri::command]
async fn change_status(
    app: tauri::AppHandle,
    project_hash: String,
    thread_id: String,
    change_name: String,
) -> Res<Option<bool>> {
    let cache = app.state::<Harness>().workspace.openspec_cache.clone();
    tokio::task::spawn_blocking(move || {
        let root = spec_root(&project_hash, Some(&thread_id))?;
        Ok(executor::openspec_change_status(&cache, &root, &change_name))
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

/// Stop one session by id. With no id, stop the named thread's sessions —
/// the Stop button's fallback for a turn whose events haven't started
/// streaming yet, so it has no session id to aim at. Without `thread_id`
/// too, this stops everything, which is only ever what app teardown wants:
/// one thread's Stop must not cancel another thread's live session.
#[tauri::command]
async fn stop_executor(
    app: tauri::AppHandle,
    session_id: Option<String>,
    thread_id: Option<String>,
) -> Res<()> {
    tokio::task::spawn_blocking(move || {
        let harness: tauri::State<'_, Harness> = app.state();
        let targets: Vec<(String, String)> = harness
            .agent.acp_sessions
            .lock()
            .unwrap()
            .values()
            .filter(|s| session_id.as_ref().is_none_or(|wanted| *wanted == s.id))
            .filter(|s| {
                session_id.is_some()
                    || thread_id.as_ref().is_none_or(|wanted| *wanted == s.thread_id)
            })
            .map(|s| (s.id.clone(), s.thread_id.clone()))
            .collect();
        for (id, thread_id) in targets {
            // Emit a Crashed event so the frontend's event listener clears
            // the busy state. Without this, the UI stays stuck on "busy"
            // because end_session terminates the bridge before the prompt
            // response can arrive.
            let envelope = executor::Envelope {
                session_id: id.clone(),
                thread_id: thread_id.clone(),
                // The user stopped the turn; nothing died and nothing about
                // their mode choice should change (#18).
                event: executor::ExecutorEvent::turn_failed("Cancelled by user".into()),
            };
            let _ = app.emit("executor-event", &envelope);
            // This event is emitted straight at the frontend rather than
            // through the sink, so a chain waiting on this session's turn
            // never saw it — the node sat "executing" and the canvas sat
            // "running" until the 20-minute turn timeout finally fired.
            // Release that watcher here, the same way the sink's Crashed arm
            // would have.
            if let Some(watch) = harness.chain.turn_watchers.lock_or_recover().get(&id).cloned() {
                watch.finish(executor::TurnEnd::Crashed("Cancelled by user".into()));
            }
            end_session(&harness, &thread_id, &id, "cancelled");
        }
        Ok(())
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

/// Resolve a pending tool-call approval prompt (D7, D-design-2). A missing
/// or already-resolved `request_id` is a no-op success — the frontend may
/// hold a stale button after a fast session teardown.
#[tauri::command]
async fn answer_permission_prompt(
    app: tauri::AppHandle,
    session_id: String,
    request_id: String,
    decision: String,
) -> Res<()> {
    let answer = acp_client::PermissionAnswer::parse(&decision)
        .ok_or_else(|| format!("unknown permission decision: {decision}"))?;
    tokio::task::spawn_blocking(move || {
        let harness: tauri::State<'_, Harness> = app.state();
        if let Some(session) = harness.agent.acp_sessions.lock_or_recover().get(&session_id) {
            session.answer_permission_prompt(&request_id, answer);
        }
        Ok(())
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

/// What each live session is doing.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionStatus {
    id: String,
    thread_id: String,
    agent_id: String,
    mode: String,
    busy: bool,
    /// The model the agent actually settled on for this session — what a
    /// chain node's model pick has to survive into to have meant anything.
    model: Option<String>,
}

/// The `/` menu for a thread, from the commands its live sessions last
/// advertised. A webview reload loses every `agent-commands` event, and the
/// agent never re-sends them while its session lives, so this is how the
/// frontend re-seeds. Empty when no live session has advertised any.
fn thread_commands(harness: &Harness, thread_id: &str) -> Vec<crate::acp_events::AgentCommand> {
    let mut ids: Vec<String> = harness
        .agent.acp_sessions
        .lock_or_recover()
        .values()
        .filter(|s| s.thread_id == thread_id)
        .map(|s| s.id.clone())
        .collect();
    ids.sort();
    let cache = harness.agent.session_commands.lock_or_recover();
    ids.iter().find_map(|id| cache.get(id).cloned()).unwrap_or_default()
}

#[tauri::command]
async fn agent_commands(
    app: tauri::AppHandle,
    thread_id: String,
) -> Res<Vec<crate::acp_events::AgentCommand>> {
    let harness: tauri::State<'_, Harness> = app.state();
    Ok(thread_commands(&harness, &thread_id))
}

#[tauri::command]
async fn executor_status(app: tauri::AppHandle) -> Res<Vec<SessionStatus>> {
    tokio::task::spawn_blocking(move || {
        let harness: tauri::State<'_, Harness> = app.state();
        let mut statuses: Vec<SessionStatus> = harness
            .agent.acp_sessions
            .lock()
            .unwrap()
            .values()
            .map(|s| SessionStatus {
                id: s.id.clone(),
                thread_id: s.thread_id.clone(),
                agent_id: s.agent_id.clone(),
                mode: s.mode.clone(),
                busy: s.is_busy(),
                model: s.models.current.clone(),
            })
            .collect();
        statuses.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(statuses)
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

/// A thread's isolated worktree, and what has changed inside it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorktreeStatus {
    thread_id: String,
    branch: String,
    added: u32,
    removed: u32,
    /// The branch this thread merges back into.
    base_branch: String,
    /// Whether the checked-out base branch can accept a local merge. This is
    /// distinct from `mergeable`, which only answers whether commits conflict.
    base_state: String,
    /// Uncommitted files in the checked-out base worktree when it is dirty.
    base_change_count: Option<u32>,
    /// Commits on the thread's branch that the base does not have.
    ahead: u32,
    /// Nothing uncommitted or untracked in the worktree.
    clean: bool,
    /// A real trial merge said this lands without conflicts.
    mergeable: bool,
    /// "merged" | "conflict" | "ahead" | "clean" — what the sidebar dot shows.
    state: String,
    /// The worktree's HEAD, so a verification run can be matched to the exact
    /// commit it ran at instead of being assumed still current.
    head: Option<String>,
    setup_state: Option<String>,
    setup_output: Option<String>,
}

/// What each thread's worktree holds, for the sidebar's diff stat and the
/// chat header's branch.
///
/// Keyed by thread rather than by session on purpose: a thread's uncommitted
/// work outlives the session that produced it, and the moment a turn ends is
/// exactly when the user wants to see what it changed. Threads with no
/// worktree (never run, or a non-git project) are simply absent.
#[tauri::command]
async fn thread_worktrees(project_hash: String) -> Res<Vec<WorktreeStatus>> {
    tokio::task::spawn_blocking(move || {
        let bin = git_bin()?;
        let root = project_root(&project_hash)?;
        let mut out = vec![];
        for thread in store::list_threads(&palisade_home(), &project_hash)? {
            let (Some(path), Some(branch)) = (thread.worktree_path, thread.worktree_branch) else {
                continue;
            };
            let path = PathBuf::from(path);
            if !path.is_dir() {
                continue;
            }
            let base = git::base_or_current(&bin, &root, thread.worktree_base_branch.as_deref());
            // The same helper the Fleet board and the Review lane read, so
            // the three surfaces cannot report different numbers for the
            // same thread: work since the base, committed or not, minus the
            // machine-local paths nobody authored.
            let changes = fleet::thread_changes(&bin, &path, &root, Some(&base));
            let (added, removed) = (changes.added, changes.removed);
            // A readiness probe must never fail the whole list: a repo git
            // can't answer for reports as "nothing to land", not as an error.
            let ready = git::merge_readiness(&bin, &root, &path, &base, &branch)
                .unwrap_or(git::MergeReadiness { ahead: 0, clean: true, mergeable: true });
            let (base_state, base_change_count) = match git::base_worktree_state(&bin, &root, &base) {
                Ok(git::BaseWorktreeState::Clean) => ("clean".into(), None),
                Ok(git::BaseWorktreeState::Dirty(count)) => ("dirty".into(), Some(count)),
                Err(_) => ("unavailable".into(), None),
            };
            let state = if !ready.mergeable {
                "conflict"
            } else if ready.ahead > 0 || !ready.clean {
                "ahead"
            } else if thread.merged_at.is_some() {
                "merged"
            } else {
                "clean"
            };
            out.push(WorktreeStatus {
                thread_id: thread.id,
                branch,
                added,
                removed,
                base_branch: base,
                base_state,
                base_change_count,
                ahead: ready.ahead,
                clean: ready.clean,
                mergeable: ready.mergeable,
                state: state.into(),
                head: git::rev_parse_head(&bin, &path),
                setup_state: thread.worktree_setup_state,
                setup_output: thread.worktree_setup_output,
            });
        }
        Ok(out)
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

/// What one thread's live sessions say about it. Collapsed across sessions:
/// a thread can hold several at once, and the board shows one dot per thread.
#[derive(Debug, Clone, Default)]
struct LiveThread {
    busy: bool,
    awaiting_permission: bool,
    agent_id: Option<String>,
    agent_name: Option<String>,
}

/// Every unarchived thread in every open project, with what it is doing, what
/// it has changed, whether that lands, and who else is writing the same files.
///
/// One call for the whole board on purpose: the alternative is the frontend
/// fanning `thread_worktrees` + `list_sessions` + `list_verifications` out per
/// project and stitching them, and the cross-thread file overlap would have
/// nowhere to be computed. Every git probe here is best-effort — a project
/// that is not a repo reports no diff rather than failing the board.
#[tauri::command]
async fn fleet_overview(app: tauri::AppHandle) -> Res<Vec<fleet::FleetRow>> {
    tokio::task::spawn_blocking(move || {
        let harness: tauri::State<'_, Harness> = app.state();
        let open = project_windows::open_project_hashes(&harness);
        // One pass over the live sessions, guard dropped before any git call:
        // `acp_sessions` is the lock every subsystem eventually wants.
        let live: std::collections::HashMap<String, LiveThread> = {
            let sessions = harness.agent.acp_sessions.lock_or_recover();
            let mut map: std::collections::HashMap<String, LiveThread> = Default::default();
            for session in sessions.values() {
                let entry = map.entry(session.thread_id.clone()).or_default();
                entry.busy |= session.is_busy();
                entry.awaiting_permission |= session.needs_attention();
                entry.agent_id = Some(session.agent_id.clone());
                entry.agent_name = Some(session.agent_name.clone());
            }
            map
        };
        // Playbook runs share the board with threads. Both live maps are read
        // here, before any git call, for the same reason the session pass
        // above is: a held lock and a subprocess don't mix.
        let live_runs: std::collections::HashSet<String> =
            harness.chain.chain_cancels.lock_or_recover().keys().cloned().collect();
        let gated_runs: std::collections::HashSet<String> =
            harness.chain.chain_gates.lock_or_recover().keys().cloned().collect();
        let home = palisade_home();
        let bin = git_bin()?;
        let mut rows = vec![];
        for project in store::list_projects(&home)?.into_iter().filter(|p| open.contains(&p.hash)) {
            let root = PathBuf::from(&project.root);
            let verifications = store::read_verifications(&home, &project.hash).unwrap_or_default();
            let threads = store::list_threads(&home, &project.hash)?;
            let current_branch = git::current_branch_name(&bin, &root).ok();
            for thread in threads.into_iter().filter(|t| !t.archived) {
                // A thread with no worktree of its own edits the project
                // checkout, so that is the tree its diff is measured in.
                let worktree = thread.worktree_path.as_ref().map(PathBuf::from).filter(|p| p.is_dir());
                // A thread that had a worktree and lost it (pruned, or the
                // folder deleted) is not editing the checkout. Measuring the
                // checkout for it would show the user's own uncommitted work
                // as this thread's, identically on every such thread.
                let worktree_gone = thread.worktree_branch.is_some() && worktree.is_none();
                let tree = worktree.clone().unwrap_or_else(|| root.clone());
                // The merge target, only meaningful for a thread that has its
                // own worktree; without one the measurement stays vs HEAD.
                let base = worktree
                    .as_ref()
                    .map(|_| git::base_or_current(&bin, &root, thread.worktree_base_branch.as_deref()));
                // One helper for the board and the Review lane, and the only
                // place the skip-list and the inherited-file rule live.
                let changes = if worktree_gone {
                    fleet::ThreadChanges::default()
                } else {
                    fleet::thread_changes(&bin, &tree, &root, base.as_deref())
                };
                // Overlap must also see files already committed on the
                // thread's branch but not yet merged back — a thread that
                // commits as it goes would otherwise vanish from overlap
                // detection the moment its tree goes clean.
                let committed_paths = match (&thread.worktree_base_branch, &thread.worktree_branch) {
                    (Some(base), Some(branch)) => git::changed_between(&bin, &tree, base, branch)
                        .unwrap_or_default()
                        .into_iter()
                        .filter(|path| !fleet::is_skipped_path(path))
                        .collect(),
                    _ => vec![],
                };
                let files_touched = fleet::union_files_touched(changes.paths(), committed_paths);
                let merge = match (&worktree, &thread.worktree_branch, &base) {
                    (Some(path), Some(branch), Some(base)) => {
                        let ready = git::merge_readiness(&bin, &root, path, base, branch)
                            .unwrap_or(git::MergeReadiness { ahead: 0, clean: true, mergeable: true });
                        if !ready.mergeable {
                            fleet::FleetMerge::Conflicts
                        // Commits on the base this branch does not have: the
                        // same rev-list, asked the other way round.
                        } else if git::ahead_of(&bin, &root, branch, base).unwrap_or(0) > 0 {
                            fleet::FleetMerge::Behind
                        } else {
                            fleet::FleetMerge::Clean
                        }
                    }
                    _ => fleet::FleetMerge::NoWorktree,
                };
                let last_activity = store::last_activity(&home, &project.hash, &thread.id);
                let sessions = store::read_sessions(&home, &project.hash, &thread.id).unwrap_or_default();
                let last = sessions.last();
                let verify = if worktree_gone {
                    fleet::FleetVerify::not_run()
                } else {
                    fleet::current_verify(
                        &verifications,
                        &thread.id,
                        git::rev_parse_head(&bin, &tree).as_deref(),
                        git::status(&bin, &tree).is_ok_and(|status| status.is_empty()),
                    )
                };
                let live = live.get(&thread.id).cloned().unwrap_or_default();
                let (status, attention) = fleet::derive_status(&fleet::StatusInput {
                    awaiting_permission: live.awaiting_permission,
                    busy: live.busy,
                    turn_ended: last.is_some() && !live.busy,
                    // Against the agent's newest message, not the session's
                    // `ended_at`: an idle session stays open until quit, so
                    // that field is None all day and then newer than every
                    // view on the next launch (see `store::last_agent_activity`).
                    viewed_since_turn: fleet::viewed_since_turn(
                        thread.last_viewed_at.as_deref(),
                        store::last_agent_activity(&home, &project.hash, &thread.id).as_deref(),
                    ),
                    verify_failed: verify.state == fleet::VerifyState::Fail,
                    merge_conflict: merge == fleet::FleetMerge::Conflicts,
                    crashed: last.is_some_and(|s| {
                        s.outcome.as_deref() == Some("crashed")
                            && thread.acknowledged_crash_session_id.as_deref() != Some(&s.id)
                    }),
                });
                rows.push(fleet::FleetRow {
                    kind: fleet::FleetKind::Thread,
                    thread_id: thread.id.clone(),
                    run_id: None,
                    playbook_name: None,
                    seed: None,
                    title: thread.title.clone(),
                    project_id: project.hash.clone(),
                    project_name: project.display_name.clone(),
                    agent_id: live.agent_id.or_else(|| last.map(|s| s.agent_id.clone())),
                    agent_name: live.agent_name,
                    mode: thread.current_mode.clone(),
                    status,
                    attention,
                    branch: thread.worktree_branch.clone(),
                    worktree_path: worktree.map(|p| p.to_string_lossy().into_owned()),
                    merge_target: base.filter(|b| Some(b) != current_branch.as_ref()),
                    diff: fleet::FleetDiff {
                        added: changes.added,
                        removed: changes.removed,
                        files: changes.tracked,
                        untracked: changes.untracked,
                    },
                    files_touched,
                    overlap: vec![],
                    verify,
                    merge,
                    // Sort key: last touched. `thread.updated_at` moves when
                    // the thread is opened but not when it speaks, so the
                    // newer of the two is the whole story. Both are RFC 3339
                    // UTC from the same clock, which orders as text.
                    updated_at: last_activity
                        .clone()
                        .filter(|at| *at > thread.updated_at)
                        .unwrap_or_else(|| thread.updated_at.clone()),
                    created_at: thread.created_at.clone(),
                    last_activity_at: last_activity,
                    archivable: false,
                });
            }
            // One row per playbook run, from the same records the Playbooks
            // panel lists. Read-only on purpose: reconciling a stale record is
            // `list_chain_runs`'s job, and a record no live run owns is over
            // either way — which is all the board needs to say.
            // Default excludes archived, matching `list_chain_runs`'s own
            // convention (issue #53) — an archived run just isn't part of
            // the board's default view.
            for run in chain_history::list_runs(&home, &project.hash)
                .unwrap_or_default()
                .into_iter()
                .filter(|r| !r.archived)
            {
                let live = live_runs.contains(&run.id);
                let completed = matches!(
                    run.outcome,
                    Some(chain_history::OutcomeSnapshot::Completed { .. })
                );
                let (status, attention) = fleet::derive_playbook_status(&fleet::PlaybookInput {
                    awaiting_gate: gated_runs.contains(&run.id),
                    ended: !live,
                    failed: !live && !completed,
                });
                rows.push(fleet::FleetRow {
                    kind: fleet::FleetKind::Playbook,
                    // The run id is this row's identity, so the board keys and
                    // opens it the same way it does a thread.
                    thread_id: run.id.clone(),
                    run_id: Some(run.id.clone()),
                    playbook_name: Some(run.chain_name.clone()),
                    seed: (!run.seed.trim().is_empty()).then(|| run.seed.clone()),
                    title: run.chain_name.clone(),
                    project_id: project.hash.clone(),
                    project_name: project.display_name.clone(),
                    agent_id: None,
                    agent_name: None,
                    mode: "go".into(),
                    status,
                    attention,
                    branch: None,
                    worktree_path: None,
                    merge_target: None,
                    // A run has no worktree of its own — its nodes write in
                    // the thread's tree — so there is nothing git can measure
                    // here that the thread's own row doesn't already show.
                    diff: fleet::FleetDiff::default(),
                    files_touched: vec![],
                    overlap: vec![],
                    verify: fleet::FleetVerify::not_run(),
                    merge: fleet::FleetMerge::NoWorktree,
                    updated_at: run.ended_at.clone().unwrap_or_else(|| run.started_at.clone()),
                    created_at: run.started_at.clone(),
                    last_activity_at: None,
                    archivable: !live && run.ended_at.is_some(),
                });
            }
        }
        // Finished runs are history, and history is the Playbooks panel's job.
        // The board keeps the newest few so a run that just ended is still
        // where you left it; a run still walking, or stuck at a gate, is never
        // dropped.
        fleet::cap_finished_playbooks(&mut rows, fleet::FINISHED_PLAYBOOK_LIMIT);
        fleet::compute_overlap(&mut rows);
        // Most recently touched first: the board's own ordering, so two
        // clients render the same fleet in the same order.
        rows.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(rows)
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

/// The files one thread has changed, measured exactly as the Fleet board
/// measures them.
///
/// The Review lane used to parse `git_working_diff` itself, which sees no
/// untracked file and knows nothing of the skip-list — so the lane and the
/// board could disagree about what a thread had done. One helper now answers
/// both.
#[tauri::command]
async fn thread_review_files(
    project_hash: String,
    thread_id: String,
) -> Res<Vec<fleet::ReviewFile>> {
    tokio::task::spawn_blocking(move || {
        let bin = git_bin()?;
        let root = project_root(&project_hash)?;
        // A thread with no worktree of its own edits the project checkout,
        // and has no base branch to measure against either.
        let thread =
            store::list_threads(&palisade_home(), &project_hash)?.into_iter().find(|t| t.id == thread_id);
        let worktree = thread
            .as_ref()
            .and_then(|t| t.worktree_path.clone())
            .map(PathBuf::from)
            .filter(|p| p.is_dir());
        let base = worktree.as_ref().map(|_| {
            git::base_or_current(
                &bin,
                &root,
                thread.as_ref().and_then(|t| t.worktree_base_branch.as_deref()),
            )
        });
        let tree = worktree.clone().unwrap_or_else(|| root.clone());
        Ok(fleet::review_files(&bin, &tree, &root, base.as_deref()))
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

/// The full patch one thread has made since it branched, including committed
/// work and any staged, unstaged, or untracked changes still in its tree.
#[tauri::command]
async fn thread_review_diff(project_hash: String, thread_id: String) -> Res<String> {
    tokio::task::spawn_blocking(move || {
        let bin = git_bin()?;
        let root = project_root(&project_hash)?;
        let thread = store::list_threads(&palisade_home(), &project_hash)?
            .into_iter()
            .find(|t| t.id == thread_id);
        let worktree = thread
            .as_ref()
            .and_then(|t| t.worktree_path.clone())
            .map(PathBuf::from)
            .filter(|p| p.is_dir());
        let base = worktree.as_ref().map(|_| {
            git::base_or_current(
                &bin,
                &root,
                thread.as_ref().and_then(|t| t.worktree_base_branch.as_deref()),
            )
        });
        let tree = worktree.unwrap_or_else(|| root.clone());
        Ok(fleet::review_diff(&bin, &tree, base.as_deref()))
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

/// Turn this thread's worktree isolation on or off.
///
/// Decided once, at thread creation, and locked by the UI after the first
/// message: the directory an agent has been writing in cannot change
/// underneath a thread mid-conversation without stranding its work. Refused
/// outright once a worktree exists, so the flag can never disagree with what
/// is on disk.
#[tauri::command]
async fn set_thread_worktree_enabled(
    project_hash: String,
    thread_id: String,
    enabled: bool,
) -> Res<store::ThreadMeta> {
    tokio::task::spawn_blocking(move || {
        let home = palisade_home();
        // The lock is the first message, not the worktree: a thread that has
        // started one but never spoken has nothing invested in it, and the
        // empty worktree is removed rather than left orphaned. Once an agent
        // has written a turn, its working directory cannot move underneath it.
        if !store::thread_is_empty(&home, &project_hash, &thread_id)? {
            return Err(
                "This thread has already run — its worktree setting is fixed for the life of the thread."
                    .into(),
            );
        }
        if let Some(meta) = thread_meta(&project_hash, &thread_id) {
            if let Some(path) = meta.worktree_path {
                let (bin, root) = (git_bin()?, project_root(&project_hash)?);
                git::remove_worktree(&bin, &root, Path::new(&path), meta.worktree_branch.as_deref())?;
                store::clear_thread_worktree(&home, &project_hash, &thread_id)?;
            }
        }
        store::set_thread_worktree_enabled(&home, &project_hash, &thread_id, enabled)
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

/// What a merge-back attempt did, as the gate card renders it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MergeResult {
    merged: bool,
    /// Set when the merge conflicted: the worktree the half-merged state is
    /// parked in, for a session to resolve in place.
    conflict_path: Option<String>,
    conflict_branch: Option<String>,
    detail: String,
}

/// Merge a thread's branch into the branch it was cut from.
///
/// Refuses a busy thread (an agent mid-turn is still writing the commits this
/// would merge) and refuses an unclean worktree: uncommitted work is not part
/// of any commit, so merging would silently land less than the user sees.
#[tauri::command]
async fn merge_thread_worktree(
    app: tauri::AppHandle,
    project_hash: String,
    thread_id: String,
    override_verify: bool,
) -> Res<MergeResult> {
    tokio::task::spawn_blocking(move || {
        let harness: tauri::State<'_, Harness> = app.state();
        if harness.thread_is_busy(&thread_id) {
            return Err("This thread has a turn in progress — wait for it to finish before merging.".into());
        }
        let bin = git_bin()?;
        let root = project_root(&project_hash)?;
        let (path, branch, base) = thread_branch(&bin, &root, &project_hash, &thread_id)?;
        if !git::status(&bin, &path)?.is_empty() {
            return Err(
                "This thread has uncommitted changes — commit them before merging, so what lands is what you reviewed."
                    .into(),
            );
        }
        if !override_verify {
            let (settings, _) = settings::load(&root);
            if settings.verify.is_empty() {
                return Err("Verification is not configured for this project. Open Review and choose Configure Verification first.".into());
            }
            let head = git::rev_parse_head(&bin, &path)
                .ok_or_else(|| crate::PalisadeError::from("Could not determine the worktree commit before verification."))?;
            let runs = store::read_verifications(&palisade_home(), &project_hash)?;
            let cancel_key = format!("merge:{project_hash}:{thread_id}");
            let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            harness.chain.chain_cancels.lock_or_recover().insert(cancel_key.clone(), cancel.clone());
            let mut checks: Vec<_> = settings.verify.keys().cloned().collect();
            checks.sort_by_key(|name| match name.as_str() {
                "test" => 0,
                "typecheck" => 1,
                "lint" => 2,
                "build" => 3,
                _ => 4,
            });
            for name in checks {
                if cancel.load(std::sync::atomic::Ordering::SeqCst) {
                    return Err("Verification cancelled. Completed passing checks remain recorded; merge was not attempted.".into());
                }
                let passed = runs.iter().any(|run|
                    run.thread_id.as_deref() == Some(&thread_id)
                        && run.name == name
                        && run.exit_code == 0
                        && run.git_head.as_deref() == Some(&head));
                if passed { continue; }
                if record_verification(&app, &project_hash, &name, Some(thread_id.clone()), None)? != 0 {
                    let tail = store::read_verifications(&palisade_home(), &project_hash)?
                        .into_iter().rev()
                        .find(|run| run.thread_id.as_deref() == Some(&thread_id) && run.name == name)
                        .map(|run| run.output_tail)
                        .unwrap_or_default();
                    return Err(format!("Verification {name} failed. {}\nChoose Merge anyway to override.", tail));
                }
            }
            if cancel.load(std::sync::atomic::Ordering::SeqCst) {
                return Err("Verification cancelled. Completed passing checks remain recorded; merge was not attempted.".into());
            }
            if harness.thread_is_busy(&thread_id) {
                return Err("This thread started a turn while verification ran — wait for it to finish before merging.".into());
            }
            if !git::status(&bin, &path)?.is_empty() {
                return Err("The worktree changed while verification ran — commit or discard those changes, then merge again.".into());
            }
            if git::rev_parse_head(&bin, &path).as_deref() != Some(&head) {
                return Err("The branch changed while verification ran — its evidence is no longer current. Merge again to verify the new commit.".into());
            }
        }
        let out = git::merge_into_base(&bin, &root, &base, &branch)?;
        if out.merged {
            let _ = store::set_thread_merged(
                &palisade_home(),
                &project_hash,
                &thread_id,
                override_verify,
            );
        }
        Ok(MergeResult {
            merged: out.merged,
            conflict_path: out.conflict_path.map(|p| p.to_string_lossy().into_owned()),
            conflict_branch: out.conflict_branch,
            detail: out.detail,
        })
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
    .map_err(crate::PalisadeError::from)
}

#[tauri::command]
async fn cancel_merge_verification(app: tauri::AppHandle, project_hash: String, thread_id: String) -> Res<()> {
    let key = format!("merge:{project_hash}:{thread_id}");
    app.state::<Harness>().chain.chain_cancels.lock_or_recover()
        .get(&key)
        .ok_or("No merge verification is running for this thread.")?
        .store(true, std::sync::atomic::Ordering::SeqCst);
    Ok(())
}

/// Push the thread's branch and open a pull request for it, returning the URL
/// to open.
///
/// `gh` is discovered on PATH the same way every agent CLI is — when it is
/// missing, or not logged in, or the repo isn't on GitHub, this falls back to
/// the host's compare URL, which does the same job in the browser. No API
/// client, no token handling.
#[tauri::command]
async fn open_thread_pr(project_hash: String, thread_id: String) -> Res<String> {
    tokio::task::spawn_blocking(move || {
        let bin = git_bin()?;
        let root = project_root(&project_hash)?;
        let (path, branch, base) = thread_branch(&bin, &root, &project_hash, &thread_id)?;
        if !git::status(&bin, &path)?.is_empty() {
            return Err("This thread has uncommitted changes — commit them before opening a pull request.".into());
        }
        // A PR is a request to merge commits; a remote can only see pushed ones.
        git::push(&bin, &path)?;
        if let Some(gh) = executor::find_on_path("gh") {
            let out = std::process::Command::new(&gh)
                .args(["pr", "create", "--head", &branch, "--base", &base, "--fill"])
                .current_dir(&path)
                .env("PATH", executor::child_path_env())
                .output()
                .map_err(|err| crate::PalisadeError::from(format!("could not run gh: {err}")))?;
            if out.status.success() {
                if let Some(url) = String::from_utf8_lossy(&out.stdout)
                    .lines()
                    .rev()
                    .find(|l| l.starts_with("http"))
                {
                    return Ok(url.to_string());
                }
            }
            // A PR that already exists is a success as far as the user is
            // concerned — `gh pr view` knows its URL.
            let existing = std::process::Command::new(&gh)
                .args(["pr", "view", &branch, "--json", "url", "--jq", ".url"])
                .current_dir(&path)
                .env("PATH", executor::child_path_env())
                .output()
                .ok()
                .filter(|o| o.status.success())
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                .filter(|u| u.starts_with("http"));
            if let Some(url) = existing {
                return Ok(url);
            }
        }
        compare_url(&bin, &root, &base, &branch)
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

/// The thread's worktree path, branch, and base branch — the trio every
/// merge-back command needs, with the same "this thread has no worktree"
/// error for all of them.
fn thread_branch(
    bin: &Path,
    root: &Path,
    project_hash: &str,
    thread_id: &str,
) -> Res<(PathBuf, String, String)> {
    let meta = thread_meta(project_hash, thread_id)
        .ok_or_else(|| crate::PalisadeError::from("This thread no longer exists."))?;
    let (Some(path), Some(branch)) = (meta.worktree_path, meta.worktree_branch) else {
        return Err(
            "This thread has no worktree of its own, so there is nothing separate to merge back."
                .into(),
        );
    };
    let base = meta
        .worktree_base_branch
        .or_else(|| git::current_branch_name(bin, root).ok())
        .ok_or_else(|| crate::PalisadeError::from("Could not tell which branch to merge into."))?;
    Ok((PathBuf::from(path), branch, base))
}

/// `origin`'s web compare page for `base...branch`. Handles the two URL
/// shapes git remotes come in (`git@host:owner/repo` and `https://host/...`).
fn compare_url(bin: &Path, root: &Path, base: &str, branch: &str) -> Res<String> {
    let remote = git::remote_url(bin, root)?;
    let trimmed = remote.trim().trim_end_matches(".git");
    let web = match trimmed.split_once('@') {
        Some((_, rest)) if !trimmed.starts_with("http") => {
            format!("https://{}", rest.replacen(':', "/", 1))
        }
        _ => trimmed.to_string(),
    };
    Ok(format!("{web}/compare/{base}...{branch}?expand=1"))
}

/// Remove an archived thread's worktree.
///
/// Without `force` this only proceeds when the worktree is clean and its
/// branch holds nothing the base lacks — provably lossless, which is why the
/// idle sweep can do it with no confirmation. `force` is the explicit
/// "Archive & clean up" for unmerged work, and is confirmed in the UI the
/// same way deleting a thread is.
#[tauri::command]
async fn prune_thread_worktree(
    app: tauri::AppHandle,
    project_hash: String,
    thread_id: String,
    force: bool,
) -> Res<()> {
    tokio::task::spawn_blocking(move || {
        let harness: tauri::State<'_, Harness> = app.state();
        if harness.thread_is_busy(&thread_id) {
            return Err("This thread has a turn in progress — wait for it to finish.".into());
        }
        let bin = git_bin()?;
        let root = project_root(&project_hash)?;
        let (path, branch, base) = thread_branch(&bin, &root, &project_hash, &thread_id)?;
        if !force {
            let ready = git::merge_readiness(&bin, &root, &path, &base, &branch)?;
            if !ready.clean || ready.ahead > 0 {
                return Err(format!(
                    "`{branch}` still has work that `{base}` does not — merge it first, or clean up anyway to discard it."
                ).into());
            }
        }
        git::remove_worktree(&bin, &root, &path, Some(&branch))?;
        store::clear_thread_worktree(&palisade_home(), &project_hash, &thread_id)?;
        Ok(())
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

/// Drop the worktrees of archived threads whose work has provably landed.
///
/// Runs at the same idle moments that release sessions, and only ever removes
/// what a merge already carried into the base branch — so it needs no
/// confirmation and can never be the reason work went missing. Everything
/// else is left exactly where it is for the explicit clean-up action.
fn sweep_archived_worktrees(project_hash: &str) {
    let (Ok(bin), Ok(root)) = (git_bin(), project_root(project_hash)) else {
        return;
    };
    let Ok(threads) = store::list_threads(&palisade_home(), project_hash) else {
        return;
    };
    for thread in threads.into_iter().filter(|t| t.archived) {
        let (Some(path), Some(branch)) = (thread.worktree_path.clone(), thread.worktree_branch.clone())
        else {
            continue;
        };
        let path = PathBuf::from(path);
        if !path.is_dir() {
            continue;
        }
        let base = git::base_or_current(&bin, &root, thread.worktree_base_branch.as_deref());
        let Ok(ready) = git::merge_readiness(&bin, &root, &path, &base, &branch) else {
            continue;
        };
        if ready.clean && ready.ahead == 0 {
            if git::remove_worktree(&bin, &root, &path, Some(&branch)).is_ok() {
                let _ = store::clear_thread_worktree(&palisade_home(), project_hash, &thread.id);
            }
        }
    }
}

/// Every session ever run against a thread.
#[tauri::command]
async fn list_sessions(
    app: tauri::AppHandle,
    project_hash: String,
    thread_id: String,
) -> Res<Vec<store::SessionRecord>> {
    tokio::task::spawn_blocking(move || {
        let harness: tauri::State<'_, Harness> = app.state();
        let live: Vec<String> = harness.agent.acp_sessions.lock_or_recover().keys().cloned().collect();
        store::close_stale_sessions(&palisade_home(), &project_hash, &thread_id, &live)
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

// ------------------------------------------------------------ verification

/// Run one of the project's `verify` commands and persist what happened.
///
/// Detached on its own thread: a real test suite takes minutes, and blocking
/// the command thread would freeze the UI. The result arrives as a
/// `verification-finished` event, the same shape `pump` already uses.
#[tauri::command]
async fn run_verify(
    app: tauri::AppHandle,
    project_hash: String,
    name: String,
    thread_id: Option<String>,
    session_id: Option<String>,
) -> Res<()> {
    tokio::task::spawn_blocking(move || {
        let root = project_root(&project_hash)?;
        let (settings, _) = settings::load(&root);
        // Fail fast on an unknown name, before spawning a thread that can only
        // report the same error later and less visibly.
        if !settings.verify.contains_key(&name) {
            return Err(format!("no verify command named `{name}` in .palisade/project-settings.json").into());
        }

        std::thread::spawn(move || {
            let _ = record_verification(&app, &project_hash, &name, thread_id, session_id);
        });
        Ok(())
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

/// Runs one named verify command to completion, persists the run, emits
/// `verification-finished`, and hands back the exit code. Blocking — the IPC
/// command spawns a thread around it; a chain's verify gate (D8) calls it
/// directly, because a gate has to know the answer before deciding whether to
/// cross the edge.
pub(crate) fn record_verification(
    app: &tauri::AppHandle,
    project_hash: &str,
    name: &str,
    thread_id: Option<String>,
    session_id: Option<String>,
) -> Res<i32> {
    let root = project_root(project_hash)?;
    let tree = commands::git_cmds::tree_root(project_hash, thread_id.as_deref())?;
    let (settings, _) = settings::load(&root);
    // `-dirty` follows git-describe: a run against an uncommitted tree
    // cannot claim the commit it started from, or the evidence is a lie.
    let head = git_bin().ok().and_then(|bin| {
        let head = git::rev_parse_head(&bin, &tree)?;
        Some(match git::porcelain_snapshot(&bin, &tree).is_empty() {
            true => head,
            false => format!("{head}-dirty"),
        })
    });
    let target = settings::cargo_target_dir(&settings, &root, &palisade_home(), project_hash);
    let run = match settings::run_verify_with_env(&settings, &tree, name, target.as_deref()) {
        Ok(outcome) => store::VerificationRun {
            id: ulid::Ulid::new().to_string(),
            project_hash: project_hash.to_string(),
            thread_id,
            session_id,
            name: name.to_string(),
            command: outcome.command,
            exit_code: outcome.exit_code,
            output_tail: outcome.output_tail,
            git_head: head,
            at: chrono::Utc::now().to_rfc3339(),
            tests: None,
        },
        // A command that couldn't start is a failed verification, not a
        // missing one — recording nothing would leave it looking untested.
        Err(message) => store::VerificationRun {
            id: ulid::Ulid::new().to_string(),
            project_hash: project_hash.to_string(),
            thread_id,
            session_id,
            name: name.to_string(),
            command: String::new(),
            exit_code: -1,
            output_tail: message.message,
            git_head: head,
            at: chrono::Utc::now().to_rfc3339(),
            tests: None,
        },
    };
    // Parsed after the record is built, from exactly the text that was
    // stored: the explorer and the raw log can never disagree about what
    // this run said.
    let mut run = run;
    run.tests = Some(test_parse::report(&run.output_tail, run.exit_code));
    let exit_code = run.exit_code;
    let _ = store::append_verification(&palisade_home(), &run);
    let _ = app.emit("verification-finished", &run);
    Ok(exit_code)
}

#[tauri::command]
async fn list_verifications(project_hash: String) -> Res<Vec<store::VerificationRun>> {
    tokio::task::spawn_blocking(move || store::read_verifications(&palisade_home(), &project_hash))
        .await
        .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

// -------------------------------------------------------- language servers

/// Starts (or re-uses) the language server for `language` in this project.
/// Every message it emits comes back as an `lsp-message` event; the frontend
/// feeds those to `@codemirror/lsp-client`'s transport.
#[tauri::command]
async fn lsp_start(
    app: tauri::AppHandle,
    project_hash: String,
    language: String,
) -> Res<lsp::LspStatus> {
    tokio::task::spawn_blocking(move || start_language_server(&app, &project_hash, &language))
        .await
        .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

/// Spawns the server and wires its two callbacks. Recursive by design: the
/// exit callback calls this again after a backoff, which is how D14's
/// "restart up to 3 times" actually restarts. Routing that through a
/// frontend event would make the restart depend on a window being open.
fn start_language_server(
    app: &tauri::AppHandle,
    project_hash: &str,
    language: &str,
) -> Res<lsp::LspStatus> {
    let servers = app.state::<lsp::SharedLsp>().inner().clone();
    let root = project_root(project_hash)?;

    let out_app = app.clone();
    let out_lang = language.to_string();
    let exit_app = app.clone();
    let exit_servers = servers.clone();
    let (exit_hash, exit_lang) = (project_hash.to_string(), language.to_string());

    servers.ensure(
        project_hash,
        language,
        &root,
        move |body| {
            let _ = out_app.emit(
                "lsp-message",
                serde_json::json!({ "language": out_lang, "body": body }),
            );
        },
        move || {
            // A crash the user can't see is a crash they'll blame the editor
            // for, so every transition is announced before anything is retried.
            let state = exit_servers.record_exit(&exit_hash, &exit_lang);
            let status = exit_servers.status(&exit_hash, &exit_lang);
            let _ = exit_app.emit("lsp-status", &status);
            if state != lsp::LspState::Crashed {
                return;
            }
            let delay = lsp::LspServers::backoff_ms(status.restarts);
            let app = exit_app.clone();
            let (hash, lang) = (exit_hash.clone(), exit_lang.clone());
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(delay));
                let restarted = start_language_server(&app, &hash, &lang);
                let _ = app.emit(
                    "lsp-status",
                    restarted.unwrap_or_else(|err| lsp::LspStatus {
                        language: lang.clone(),
                        state: lsp::LspState::Disabled,
                        server: None,
                        restarts: status.restarts,
                        detail: Some(err.message),
                    }),
                );
            });
        },
    )
}

/// One JSON-RPC body, framed and written to the server's stdin.
#[tauri::command]
async fn lsp_send(
    app: tauri::AppHandle,
    project_hash: String,
    language: String,
    body: String,
) -> Res<()> {
    let servers = app.state::<lsp::SharedLsp>().inner().clone();
    tokio::task::spawn_blocking(move || servers.send(&project_hash, &language, &body))
        .await
        .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

#[tauri::command]
async fn lsp_status(
    app: tauri::AppHandle,
    project_hash: String,
    language: String,
) -> Res<lsp::LspStatus> {
    let servers = app.state::<lsp::SharedLsp>().inner().clone();
    Ok(servers.status(&project_hash, &language))
}

/// The install command Palisade would run for `language`, or None when it knows
/// none or the tool that would run it isn't on this machine. The status bar
/// uses this to decide whether to offer the button at all.
#[tauri::command]
async fn lsp_install_command(language: String) -> Res<Option<String>> {
    Ok(lsp::install_command(&language).map(|argv| argv.join(" ")))
}

/// Install the language server for `language` on the user's say-so, using the
/// toolchain already on the machine. Palisade still bundles nothing (D6) — this
/// is the one-click version of the instruction the status bar used to print.
#[tauri::command]
async fn lsp_install(language: String) -> Res<()> {
    tokio::task::spawn_blocking(move || lsp::install(&language))
        .await
        .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

/// Kills every server for a project — the frontend calls this on project
/// switch so nothing is left running against a directory nobody has open.
#[tauri::command]
async fn lsp_shutdown(app: tauri::AppHandle, project_hash: String) -> Res<()> {
    let servers = app.state::<lsp::SharedLsp>().inner().clone();
    tokio::task::spawn_blocking(move || servers.shutdown_project(&project_hash))
        .await
        .map_err(|e| crate::PalisadeError::from(e.to_string()))
}

// ------------------------------------------------------------ run commands

/// Amendment 1: the project's `run` map, sorted, for the title-bar split
/// button and the rail's Run panel — two views of one config.
#[tauri::command]
async fn run_commands(project_hash: String) -> Res<Vec<(String, String)>> {
    tokio::task::spawn_blocking(move || {
        let root = project_root(&project_hash)?;
        let mut commands: Vec<(String, String)> = settings::load(&root).0.run.into_iter().collect();
        commands.sort();
        Ok(commands)
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

/// Replaces the project's `run` map. The whole map, not one entry: the panel
/// edits a list and saves it, so a delete is just an absent key.
#[tauri::command]
async fn save_run_commands(project_hash: String, commands: Vec<(String, String)>) -> Res<()> {
    tokio::task::spawn_blocking(move || {
        let root = project_root(&project_hash)?;
        settings::save_run(&root, commands.into_iter().collect())
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

#[tauri::command]
async fn save_verify_commands(project_hash: String, commands: Vec<(String, String)>) -> Res<()> {
    tokio::task::spawn_blocking(move || {
        settings::save_verify(&project_root(&project_hash)?, commands.into_iter().collect())
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

/// Replaces the project's `verifyPins` map. The whole map, not one entry:
/// pin/unpin both read the current pins for a spec change and rewrite the
/// list (D8).
#[tauri::command]
async fn save_verify_pins(
    project_hash: String,
    pins: std::collections::HashMap<String, Vec<String>>,
) -> Res<()> {
    tokio::task::spawn_blocking(move || {
        let root = project_root(&project_hash)?;
        settings::save_verify_pins(&root, pins)
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

/// Replaces the project's `appearance` object. Opaque to Palisade — see
/// `settings::save_appearance`.
#[tauri::command]
async fn save_appearance(project_hash: String, appearance: serde_json::Value) -> Res<()> {
    tokio::task::spawn_blocking(move || {
        let root = project_root(&project_hash)?;
        settings::save_appearance(&root, appearance)
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

/* -------------------------------------------------------------------------- */
/* Agent chains                                                               */
/* -------------------------------------------------------------------------- */

/// Every chain saved in this project (D20: project-scoped), name-sorted. Feeds
/// both the Chains panel's list and the `|=` popup's chain source.
#[tauri::command]
async fn list_chains(project_hash: String) -> Res<Vec<chains::Chain>> {
    tokio::task::spawn_blocking(move || Ok(chains::list(&project_root(&project_hash)?)))
        .await
        .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

/// Writes a chain, keyed by its own `name`. Validation lives in
/// `chains::save`, so an ungated loop edge is refused here rather than at run
/// time (D3).
#[tauri::command]
async fn save_chain(project_hash: String, chain: chains::Chain) -> Res<()> {
    tokio::task::spawn_blocking(move || chains::save(&project_root(&project_hash)?, &chain))
        .await
        .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

#[tauri::command]
async fn delete_chain(project_hash: String, name: String) -> Res<()> {
    tokio::task::spawn_blocking(move || chains::delete(&project_root(&project_hash)?, &name))
        .await
        .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

/// Past chain runs for this project. Reading is also startup reconciliation:
/// records with no live cancellation flag belong to a previous process and
/// are closed `interrupted`, never auto-resumed (D-c).
#[tauri::command]
async fn list_chain_runs(
    app: tauri::AppHandle,
    project_hash: String,
    chain_name: Option<String>,
    include_archived: Option<bool>,
) -> Res<Vec<chain_history::ChainRunRecord>> {
    tokio::task::spawn_blocking(move || {
        let harness: tauri::State<'_, Harness> = app.state();
        let live = harness.chain.chain_cancels.lock_or_recover().keys().cloned().collect::<Vec<_>>();
        let mut records = chain_history::close_stale_runs(&palisade_home(), &project_hash, &live)?;
        if let Some(name) = chain_name {
            records.retain(|record| record.chain_name == name);
        }
        // Default excludes archived, same convention as the thread list
        // (issue #53) — nothing is deleted, an archived run just isn't the
        // default view.
        if !include_archived.unwrap_or(false) {
            records.retain(|record| !record.archived);
        }
        Ok(records)
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

/// Soft-flags a past run archived or unarchived (issue #53). Mirrors
/// `set_thread_archived`: nothing is deleted, the append-only store just gets
/// one more amendment with the flag flipped.
#[tauri::command]
async fn set_chain_run_archived(
    _app: tauri::AppHandle,
    project_hash: String,
    run_id: String,
    archived: bool,
) -> Res<chain_history::ChainRunRecord> {
    tokio::task::spawn_blocking(move || {
        let record = chain_history::get_run(&palisade_home(), &project_hash, &run_id)?
            .ok_or_else(|| crate::PalisadeError::from(format!("no chain run `{run_id}` in this project")))?;
        if archived && record.ended_at.is_none() {
            return Err("A running Playbook run cannot be archived. Stop or wait for it first.".into());
        }
        chain_history::set_archived(&palisade_home(), &project_hash, &run_id, archived)
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

/// Retrieves one past run. Like the list endpoint it first reconciles a
/// stale in-flight record, so opening a record directly cannot surface a run
/// that would otherwise look live forever after restart.
#[tauri::command]
async fn get_chain_run(
    app: tauri::AppHandle,
    project_hash: String,
    run_id: String,
) -> Res<Option<chain_history::ChainRunRecord>> {
    tokio::task::spawn_blocking(move || {
        let harness: tauri::State<'_, Harness> = app.state();
        let live = harness.chain.chain_cancels.lock_or_recover().keys().cloned().collect::<Vec<_>>();
        let _ = chain_history::close_stale_runs(&palisade_home(), &project_hash, &live)?;
        chain_history::get_run(&palisade_home(), &project_hash, &run_id)
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

/// D17: every node's bound agent must be installed before the run starts —
/// blocked with the specific node and agent named, never silently swapped for
/// whatever else is on PATH. Checked up front rather than per node, so a run
/// can't get three nodes deep and then discover it can't finish.
fn check_agents_available(harness: &tauri::State<'_, Harness>, chain: &chains::Chain) -> Res<()> {
    unavailable_agents(chain, |agent| resolve_agent(harness, agent).is_ok())
}

/// The decision half of the pre-run check, separated from agent resolution so
/// it can be tested without a live PATH.
fn unavailable_agents(chain: &chains::Chain, installed: impl Fn(&str) -> bool) -> Res<()> {
    let mut missing: Vec<String> = chain
        .nodes
        .values()
        .filter(|node| !installed(&node.agent))
        .map(|node| format!("`{}` needs {}", node.role, node.agent))
        .collect();
    if missing.is_empty() {
        return Ok(());
    }
    missing.sort();
    Err(format!(
        "This chain can't run — {} not installed or not on PATH: {}.",
        if missing.len() == 1 { "its agent is" } else { "some of its agents are" },
        missing.join(", ")
    ).into())
}

/// The portion of a persisted run definition that is safe to replay. Kept
/// independent of Tauri so it can be exercised as the same preflight the IPC
/// command uses: an invalid replay fails before a run id, cancellation flag,
/// or ACP turn exists.
#[derive(Debug, Clone, PartialEq)]
struct RerunStart {
    chain: chains::Chain,
    seed: String,
    role: String,
    inputs: Vec<(String, String)>,
}

/// Builds a replay frontier from the durable record, never from the current
/// project definition. An interior role needs every *forward* predecessor's
/// most recently recorded output, matching normal fan-in delivery exactly.
fn rerun_start(record: &chain_history::ChainRunRecord, from_role: Option<&str>) -> Res<RerunStart> {
    let chain = record.chain_snapshot.clone();
    let role = from_role.unwrap_or(&chain.entry).to_string();
    if !chain.nodes.contains_key(&role) {
        return Err(format!("chain run `{}` has no role `{role}`", record.id).into());
    }
    if from_role.is_none() {
        return Ok(RerunStart { chain, seed: record.seed.clone(), role, inputs: vec![] });
    }

    let loop_edges = chain.loop_edges();
    let mut inputs = vec![];
    for (index, edge) in chain.edges.iter().enumerate() {
        if edge.to != role || loop_edges.contains(&index) {
            continue;
        }
        let output = record
            .nodes
            .get(&edge.from)
            .and_then(|node| node.output.clone())
            .ok_or_else(|| {
                format!(
                    "chain run `{}` cannot re-run from `{role}`: required predecessor `{}` has no recorded output",
                    record.id, edge.from
                )
            })?;
        inputs.push((edge.from.clone(), output));
    }
    Ok(RerunStart { chain, seed: record.seed.clone(), role, inputs })
}

/// Starts a chain run and returns its id. The walk itself happens on a
/// blocking task: a run can legitimately take its whole 30-minute budget
/// (D19), so nothing waits on it here. Progress arrives as `chain-event`.
#[tauri::command]
async fn run_chain(
    app: tauri::AppHandle,
    project_hash: String,
    chain_name: String,
    seed_input: String,
    thread_id: String,
) -> Res<String> {
    let chain = {
        let hash = project_hash.clone();
        let name = chain_name.clone();
        let app = app.clone();
        tokio::task::spawn_blocking(move || {
            let chain = chains::load(&project_root(&hash)?, &name)?;
            let harness: tauri::State<'_, Harness> = app.state();
            check_agents_available(&harness, &chain)?;
            Ok::<_, String>(chain)
        })
        .await
        .map_err(|e| crate::PalisadeError::from(e.to_string()))??
    };

    launch_chain_run(app, project_hash, chain, seed_input, thread_id, None)
}

/// Launches either a fresh run or a replay from an already-validated
/// historical frontier. Keeping persistence, cancellation, events, and the
/// scheduler in one path makes re-runs inherit normal run semantics rather
/// than becoming a second, subtly different executor.
fn launch_chain_run(
    app: tauri::AppHandle,
    project_hash: String,
    chain: chains::Chain,
    seed_input: String,
    thread_id: String,
    replay_start: Option<(String, Vec<(String, String)>)>,
) -> Res<String> {
    let run_id = ulid::Ulid::new().to_string();

    let id = run_id.clone();
    let summary_hash = project_hash.clone();
    // Persist before any execution begins. A record is deliberately durable
    // even when the process exits mid-run; the read-side reconciliation then
    // closes it `interrupted` rather than trying to resume agents (D-c).
    let mut record = chain_history::ChainRunRecord::new(
        run_id.clone(),
        project_hash.clone(),
        thread_id.clone(),
        chain.clone(),
        seed_input.clone(),
    );
    // Capture the initial state as a real transition too: the history is a
    // complete node timeline, not merely terminal outcomes.
    for role in chain.nodes.keys() {
        record.nodes.entry(role.clone()).or_default();
    }
    chain_history::start_run(&palisade_home(), &record)?;
    for role in chain.nodes.keys() {
        chain_history::record_transition(
            &palisade_home(),
            &project_hash,
            &run_id,
            role,
            chain_runner::NodeState::Queued,
            None,
            0,
        )?;
    }
    // Shared with `Harness.chain_cancels` (§4.2): `cancel_chain_run` flips
    // this same flag, which `ChainRun::walk` rechecks between node
    // completions and `AcpNodeRunner` polls directly while a turn is
    // in-flight — one flag, not two mechanisms.
    let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    app.state::<Harness>().chain.chain_cancels.lock_or_recover().insert(id.clone(), cancel.clone());
    tokio::task::spawn_blocking(move || {
        let mut run = chain_runner::ChainRun::new(id.clone(), chain.clone(), seed_input);
        // Shared with `run` (D12): a node's human turn and an approval gate
        // both pause the same clock this run's own timeout check consults.
        let budget = run.budget();
        let mut runner = chain_exec::AcpNodeRunner::new(
            app.clone(),
            project_hash.clone(),
            thread_id.clone(),
            id.clone(),
            chain.clone(),
            cancel.clone(),
            budget.clone(),
        );
        let mut gates = chain_exec::AcpGateEvaluator::new(
            app.clone(),
            project_hash,
            thread_id.clone(),
            id.clone(),
            chain.name.clone(),
            budget,
            cancel.clone(),
        );
        let outcome = match replay_start {
            Some((role, inputs)) => run.walk_from(&runner, &mut gates, &cancel, &role, inputs),
            None => run.walk(&runner, &mut gates, &cancel),
        };
        runner.release();
        if let Err(err) = chain_history::end_run(&palisade_home(), &summary_hash, &id, outcome.clone()) {
            eprintln!("chain run {id}: could not persist terminal outcome: {err}");
        }
        app.state::<Harness>().chain.chain_cancels.lock_or_recover().remove(&id);
        chain_exec::post_thread_summary(
            &app,
            &summary_hash,
            &thread_id,
            &format!("Chain `{}` — {}", chain.name, chain_runner::describe(&outcome)),
        );
        let _ = app.emit(
            "chain-event",
            chain_exec::ChainEvent {
                run_id: id,
                thread_id,
                chain: chain.name,
                role: None,
                state: None,
                outcome: Some(outcome),
                awaiting_approval: None,
                session_id: None,
                cost: None,
            },
        );
    });
    Ok(run_id)
}

/// Replays a durable run's definition snapshot. `from_role` is optional:
/// absent re-runs the whole saved chain, present starts at that node using
/// the saved outputs of every required forward predecessor. The current
/// `.palisade/chains` definition is deliberately never read here.
#[tauri::command]
async fn rerun_chain_run(
    app: tauri::AppHandle,
    project_hash: String,
    run_id: String,
    from_role: Option<String>,
    thread_id: String,
) -> Res<String> {
    let history_app = app.clone();
    let history_hash = project_hash.clone();
    let requested_role = from_role.clone();
    let start = tokio::task::spawn_blocking(move || {
        let harness: tauri::State<'_, Harness> = history_app.state();
        let live = harness.chain.chain_cancels.lock_or_recover().keys().cloned().collect::<Vec<_>>();
        let _ = chain_history::close_stale_runs(&palisade_home(), &history_hash, &live)?;
        let record = chain_history::get_run(&palisade_home(), &history_hash, &run_id)?
            .ok_or_else(|| format!("no chain run `{run_id}` in this project"))?;
        let start = rerun_start(&record, requested_role.as_deref())?;
        check_agents_available(&harness, &start.chain)?;
        Ok::<_, String>(start)
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))??;

    launch_chain_run(
        app,
        project_hash,
        start.chain,
        start.seed,
        thread_id,
        from_role.map(|_| (start.role, start.inputs)),
    )
}

/// Signals a chain run's cancellation flag (§4.2) — the same `Arc` its
/// `ChainRun::walk` and `AcpNodeRunner` already hold, so this takes effect
/// the instant either next checks it, with no second mechanism to keep in
/// sync. Errors on an unknown or already-finished run rather than a no-op,
/// mirroring `resolve_chain_gate`'s deliberate error just above: it means the
/// UI is showing a run that has already moved on.
#[tauri::command]
async fn cancel_chain_run(app: tauri::AppHandle, run_id: String) -> Res<()> {
    let harness: tauri::State<'_, Harness> = app.state();
    cancel_chain_run_impl(&harness, &run_id)
}

fn cancel_chain_run_impl(harness: &Harness, run_id: &str) -> Res<()> {
    let cancel = harness
        .chain.chain_cancels
        .lock()
        .unwrap()
        .get(run_id)
        .cloned()
        .ok_or("that chain run isn't running")?;
    cancel.store(true, std::sync::atomic::Ordering::SeqCst);
    Ok(())
}

/// D9: the three things a human can do at a paused approval gate. A decision
/// for a run that isn't waiting is an error rather than a no-op — it means the
/// UI is showing a gate that has already moved on.
#[tauri::command]
async fn resolve_chain_gate(
    app: tauri::AppHandle,
    run_id: String,
    decision: String,
    note: Option<String>,
) -> Res<()> {
    let approval = match decision.as_str() {
        "approve" => chain_runner::Approval::Approve,
        "reject" => chain_runner::Approval::Reject,
        "sendBack" => chain_runner::Approval::SendBack(note.unwrap_or_default()),
        other => return Err(format!("unknown gate decision `{other}`").into()),
    };
    let harness: tauri::State<'_, Harness> = app.state();
    let sender = harness
        .chain.chain_gates
        .lock()
        .unwrap()
        .get(&run_id)
        .cloned()
        .ok_or("that chain run isn't waiting at an approval gate")?;
    sender.send(approval).map_err(|_| crate::PalisadeError::from("that chain run is no longer listening"))
}

/// What the project root suggests running. A proposal the user confirms —
/// this never writes anything.
#[tauri::command]
async fn detect_run_commands(project_hash: String) -> Res<Vec<(String, String)>> {
    tokio::task::spawn_blocking(move || {
        let root = project_root(&project_hash)?;
        Ok(settings::detect_run(&root))
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

/// The names a project has configured, so the UI can offer them.
#[tauri::command]
async fn verify_commands(project_hash: String) -> Res<Vec<(String, String)>> {
    tokio::task::spawn_blocking(move || {
        let root = project_root(&project_hash)?;
        let mut commands: Vec<(String, String)> =
            settings::load(&root).0.verify.into_iter().collect();
        commands.sort();
        Ok(commands)
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

#[tauri::command]
async fn detect_verify_commands(project_hash: String) -> Res<Vec<(String, String)>> {
    tokio::task::spawn_blocking(move || Ok(settings::detect_verify(&project_root(&project_hash)?)))
        .await
        .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

// ------------------------------------------------------------ attribution

/// What a session changed, with its own uncertainty attached.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Attribution {
    session_id: String,
    /// Exact: everything between the session's opening and closing HEAD.
    committed: Vec<String>,
    /// Paths dirty at close that weren't dirty at open.
    uncommitted: Vec<String>,
    /// How many sessions shared this project root while this one was live.
    concurrent_sessions: usize,
    /// Set whenever `concurrent_sessions > 1`: with two agents writing the
    /// same tree, the dirty set cannot honestly be split between them, and a
    /// heuristic guess presented as fact is worse than saying so (D13).
    ambiguous: bool,
}

#[tauri::command]
async fn session_attribution(
    app: tauri::AppHandle,
    project_hash: String,
    thread_id: String,
    session_id: String,
) -> Res<Attribution> {
    tokio::task::spawn_blocking(move || {
        let harness: tauri::State<'_, Harness> = app.state();
        let home = palisade_home();
        let record = store::read_sessions(&home, &project_hash, &thread_id)?
            .into_iter()
            .find(|r| r.id == session_id)
            .ok_or_else(|| format!("unknown session: {session_id}"))?;

        let root = project_root(&project_hash)?;
        let bin = git_bin().ok();
        let committed = match (&bin, &record.git_head_before, &record.git_head_after) {
            (Some(bin), Some(before), Some(after)) if before != after => {
                git::changed_between(bin, &root, before, after).unwrap_or_default()
            }
            _ => vec![],
        };
        let uncommitted = {
            let now = bin.as_ref().map(|bin| git::porcelain_snapshot(bin, &root)).unwrap_or_default();
            let before = record.dirty_before.clone().unwrap_or_default();
            now.into_iter().filter(|path| !before.contains(path)).collect()
        };

        let concurrent = harness.sessions_in_project(&project_hash).max(1);

        Ok(Attribution {
            session_id,
            committed,
            uncommitted,
            concurrent_sessions: concurrent,
            ambiguous: concurrent > 1,
        })
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

// --------------------------------------------------------------- completion

/// Starts the completion sidecar if it isn't already running.
fn start_completion_server(app: &tauri::AppHandle) -> Res<()> {
    let harness = app.state::<Harness>();
    let mut server_slot = harness.completion.completion_server.lock_or_recover();
    if let Some(server) = server_slot.as_ref() {
        if server.is_alive() {
            return Ok(());
        }
    }

    let (binary, model) = completion::resolve_sidecar_paths(app)?;
    if !binary.exists() || !model.exists() {
        return Err(format!(
            "completion sidecar or model missing: binary={}, model={}",
            binary.display(),
            model.display()
        ).into());
    }

    let server = completion::CompletionServer::default();
    if let Err(err) = server.spawn(&binary, &model) {
        return Err(format!("failed to start completion sidecar: {err}").into());
    }
    *server_slot = Some(server);
    Ok(())
}

fn stop_completion_server(harness: &Harness) {
    if let Some(server) = harness.completion.completion_server.lock_or_recover().take() {
        drop(server);
    }
    *harness.completion.completion_crashes.lock_or_recover() = 0;
}

/// Ensures the completion sidecar is running before a request, applying the
/// one-restart-then-disable policy from D33.
fn ensure_completion_server(app: &tauri::AppHandle, harness: &Harness) -> Res<()> {
    let mut server_slot = harness.completion.completion_server.lock_or_recover();

    if let Some(server) = server_slot.as_ref() {
        if server.is_alive() {
            return Ok(());
        }
    }

    *server_slot = None;

    let crashes = *harness.completion.completion_crashes.lock_or_recover();
    if crashes >= 2 {
        return Err("AI completion is disabled because the sidecar crashed twice.".into());
    }

    let (binary, model) = completion::resolve_sidecar_paths(app)?;
    if !binary.exists() || !model.exists() {
        *harness.completion.completion_crashes.lock_or_recover() = 2;
        let _ = app.emit(
            "harness-warning",
            "AI completion is unavailable: bundled sidecar or model is missing.",
        );
        return Err("completion sidecar or model missing".into());
    }

    let server = completion::CompletionServer::default();
    match server.spawn(&binary, &model) {
        Ok(()) => {
            *server_slot = Some(server);
            *harness.completion.completion_crashes.lock_or_recover() = 0;
            Ok(())
        }
        Err(err) => {
            *harness.completion.completion_crashes.lock_or_recover() += 1;
            if *harness.completion.completion_crashes.lock_or_recover() >= 2 {
                let _ = app.emit(
                    "harness-warning",
                    "AI completion disabled after the sidecar crashed twice.",
                );
            }
            Err(err)
        }
    }
}

#[tauri::command]
async fn complete_code(
    app: tauri::AppHandle,
    _project_hash: String,
    file_path: String,
    prefix: String,
    suffix: String,
) -> Res<completion::CompletionResponse> {
    tokio::task::spawn_blocking(move || {
        let harness = app.state::<Harness>();
        if !*harness.completion.completion_enabled.lock_or_recover() {
            return Err("AI completion is disabled.".into());
        }

        ensure_completion_server(&app, &harness)?;

        let guard = harness.completion.completion_server.lock_or_recover();
        let server = guard
            .as_ref()
            .ok_or("completion server is not running")?;
        server.complete(&file_path, &prefix, &suffix)
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

#[tauri::command]
async fn set_completion_enabled(
    app: tauri::AppHandle,
    enabled: bool,
) -> Res<bool> {
    tokio::task::spawn_blocking(move || {
        let harness = app.state::<Harness>();
        *harness.completion.completion_enabled.lock_or_recover() = enabled;
        if enabled {
            if let Err(err) = start_completion_server(&app) {
                eprintln!("completion: {err}");
            }
        } else {
            stop_completion_server(&harness);
        }
        Ok(enabled)
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

#[tauri::command]
async fn set_completion_keybinding(
    app: tauri::AppHandle,
    keybinding: String,
) -> Res<String> {
    tokio::task::spawn_blocking(move || {
        let harness = app.state::<Harness>();
        *harness.completion.completion_keybinding.lock_or_recover() = keybinding.clone();
        Ok(keybinding)
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

// ------------------------------------------------------------------ mcp
//
// `.mcp.json` in the project root is the store; `acp_client` additionally
// hands the enabled servers to each session over `session/new`. Every command
// here resolves the root from the global index rather than trusting a path
// from the frontend, same as the file and git commands.

#[tauri::command]
async fn list_mcp_servers(project_hash: String) -> Res<Vec<mcp::McpServer>> {
    tokio::task::spawn_blocking(move || Ok(mcp::list(&project_root(&project_hash)?)))
        .await
        .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

#[tauri::command]
async fn save_mcp_server(project_hash: String, server: mcp::McpServer) -> Res<()> {
    tokio::task::spawn_blocking(move || mcp::save(&project_root(&project_hash)?, &server))
        .await
        .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

#[tauri::command]
async fn remove_mcp_server(project_hash: String, name: String) -> Res<()> {
    tokio::task::spawn_blocking(move || mcp::remove(&project_root(&project_hash)?, &name))
        .await
        .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

#[tauri::command]
async fn set_mcp_server_enabled(
    project_hash: String,
    name: String,
    enabled: bool,
) -> Res<()> {
    tokio::task::spawn_blocking(move || {
        mcp::set_enabled(&project_root(&project_hash)?, &name, enabled)
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

#[tauri::command]
async fn search_mcp_registry(
    query: String,
    limit: u32,
    cursor: Option<String>,
) -> Res<mcp::RegistryPage> {
    tokio::task::spawn_blocking(move || mcp::search_registry(&query, limit, cursor.as_deref()))
        .await
        .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

#[tauri::command]
async fn flush_completion_telemetry(
    telemetry: completion::CompletionTelemetry,
) -> Res<()> {
    tokio::task::spawn_blocking(move || completion::flush_telemetry(&telemetry))
        .await
        .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

/// What a bug report needs attached that a tester cannot be asked to find.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostics {
    pub app_version: String,
    pub os_version: String,
    pub arch: String,
    pub executor: String,
    pub model_installed: bool,
}

#[tauri::command]
async fn collect_diagnostics(app: tauri::AppHandle) -> Res<Diagnostics> {
    tokio::task::spawn_blocking(move || {
        // The preflight's agent list, not `selected_executor`: that resolves
        // per project and thread, and a bug report has neither.
        let harness = app.state::<Harness>();
        let agents = harness
            .agent.preflight
            .lock()
            .unwrap()
            .as_ref()
            .map(|flight| {
                flight
                    .agents
                    .iter()
                    .map(|agent| agent.id.clone())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let executor = if agents.is_empty() {
            "none detected".to_string()
        } else {
            agents.join(", ")
        };
        let model_installed = completion::resolve_sidecar_paths(&app)
            .map(|(_, model)| model.is_file())
            .unwrap_or(false);

        Ok(Diagnostics {
            app_version: app.package_info().version.to_string(),
            os_version: os_release(),
            arch: std::env::consts::ARCH.to_string(),
            executor,
            model_installed,
        })
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

/// `sw_vers -productVersion`, or a placeholder. A diagnostic that fails must
/// never block the report it was attached to.
fn os_release() -> String {
    std::process::Command::new("sw_vers")
        .arg("-productVersion")
        .output()
        .ok()
        .filter(|out| out.status.success())
        .and_then(|out| String::from_utf8(out.stdout).ok())
        .map(|v| format!("macOS {}", v.trim()))
        .unwrap_or_else(|| "unknown".into())
}

#[tauri::command]
async fn get_completion_settings(app: tauri::AppHandle) -> Res<completion::CompletionSettings> {
    tokio::task::spawn_blocking(move || {
        let harness = app.state::<Harness>();
        let enabled = *harness.completion.completion_enabled.lock_or_recover();
        let accept_keybinding = harness.completion.completion_keybinding.lock_or_recover().clone();
        Ok(completion::CompletionSettings {
            enabled,
            accept_keybinding,
        })
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

// ---------------------------------------------------------- spec reference/// `None` when `openspec` isn't installed — "we can't tell", which is a/// Set the thread's spec link by hand — how the user resolves the ambiguity
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .on_page_load(commands::preview_cmds::hide_preview_on_reload);
    #[cfg(debug_assertions)]
    {
        // Default binds 0.0.0.0, which would expose the bridge to the LAN.
        builder = builder.plugin(
            tauri_plugin_mcp_bridge::Builder::new()
                .bind_address("127.0.0.1")
                .build(),
        );
    }
    builder
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                let menu = native_menu::install(&app.handle())?;
                app.manage(menu);
                app.on_menu_event(|handle, event| {
                    native_menu::dispatch_to_focused_window(handle, event.id().as_ref());
                });
            }
            app.manage(QuitRegistry::default());
            if let Err(err) = store::migrate_legacy_home(&palisade_home()) {
                eprintln!("store: {err}");
                let _ = app.emit("harness-warning", err);
            }
            if let Err(err) = reconcile_stale_chain_runs_on_startup(&palisade_home()) {
                eprintln!("chain history startup reconciliation: {err}");
                let _ = app.emit("harness-warning", err);
            }
            let harness: tauri::State<'_, Harness> = app.state();
            if *harness.completion.completion_enabled.lock_or_recover() {
                // Installing the model is a background job: copying it out of
                // the installer bundle takes seconds and downloading it takes
                // minutes, and neither should hold the window closed.
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    if let Err(err) = completion::ensure_model_installed(&handle) {
                        eprintln!("completion: {err}");
                        let _ = handle.emit("harness-warning", err);
                        return;
                    }
                    // A completion requested while the model was still landing
                    // latches the permanent-disable sentinel (see
                    // `ensure_completion_server`). Clear it now that the model
                    // is actually there, or AI completion stays off until the
                    // next launch.
                    let harness = handle.state::<Harness>();
                    *harness.completion.completion_crashes.lock_or_recover() = 0;
                    if let Err(err) = start_completion_server(&handle) {
                        eprintln!("completion: {err}");
                        let _ = handle.emit("harness-warning", err);
                    }
                });
            }
            Ok(())
        })
        .manage(Harness::default())
        .manage(lsp::SharedLsp::new(lsp::LspServers::new()))
        .invoke_handler(tauri::generate_handler![
            agent_commands,
            complete_code,
            agent_usage,
            list_skills,
            set_completion_enabled,
            set_completion_keybinding,
            get_completion_settings,
            sync_native_menu,
            sync_window_dirty,
            request_quit,
            confirm_quit_window,
            cancel_quit,
            collect_diagnostics,
            flush_completion_telemetry,
            list_mcp_servers,
            save_mcp_server,
            remove_mcp_server,
            set_mcp_server_enabled,
            search_mcp_registry,
            list_projects,
            open_project_window,
            remove_project,
            add_project,
            clone_repository,
            switch_project,
            rename_project,
            create_thread,
            list_threads,
            rename_thread,
            set_thread_mode,
            set_thread_executor,
            list_models,
            agent_logins,
            agent_authenticate,
            delete_thread,
            set_thread_archived,
            mark_thread_viewed,
            acknowledge_thread_crash,
            set_dock_badge,
            append_message,
            read_thread,
            preflight,
            send_message,
            save_attachment,
            read_attachment,
            retry_message,
            go_mode,
            spec_mode,
            propose,
            draft_commit_message,
            suggest_commit_message,
            apply_skill,
            change_status,
            stop_executor,
            answer_permission_prompt,
            executor_status,
            list_sessions,
            thread_worktrees,
            rerun_worktree_setup,
            fleet_overview,
            thread_review_files,
            thread_review_diff,
            merge_thread_worktree,
            cancel_merge_verification,
            open_thread_pr,
            prune_thread_worktree,
            set_thread_worktree_enabled,
            leave_thread,
            run_verify,
            list_verifications,
            verify_commands,
            detect_verify_commands,
            lsp_start,
            lsp_send,
            lsp_status,
            lsp_install,
            lsp_install_command,
            lsp_shutdown,
            run_commands,
            save_run_commands,
            save_verify_commands,
            save_verify_pins,
            save_appearance,
            detect_run_commands,
            session_attribution,
            commands::db_cmds::db_list_connections,
            commands::db_cmds::db_add_connection,
            commands::db_cmds::db_remove_connection,
            commands::db_cmds::db_rename_connection,
            commands::db_cmds::db_list_tables,
            commands::db_cmds::db_table_columns,
            commands::db_cmds::db_fetch_page,
            commands::db_cmds::db_run_query,
            commands::db_cmds::db_is_destructive,
            commands::db_cmds::db_parse_url,
            commands::db_cmds::db_preview_edits,
            commands::db_cmds::db_apply_edits,
            commands::openspec_cmds::list_spec_changes,
            commands::openspec_cmds::show_spec_change,
            commands::openspec_cmds::validate_spec_changes,
            commands::openspec_cmds::archive_spec_change,
            commands::openspec_cmds::set_spec_change,
            commands::preview_cmds::preview_open,
            commands::preview_cmds::preview_probe,
            commands::preview_cmds::preview_bounds,
            commands::preview_cmds::preview_hide,
            commands::preview_cmds::preview_close,
            commands::preview_cmds::preview_reload,
            commands::preview_cmds::preview_history,
            commands::terminal_cmds::terminal_spawn,
            commands::terminal_cmds::terminal_input,
            commands::terminal_cmds::terminal_resize,
            commands::terminal_cmds::terminal_kill,
            commands::terminal_cmds::terminal_kill_project,
            commands::terminal_cmds::terminal_list,
            commands::notebook_cmds::run_notebook_cell,
            commands::notebook_cmds::interrupt_notebook_kernel,
            commands::notebook_cmds::restart_notebook_kernel,
            commands::notebook_cmds::close_notebook_kernel,
            commands::debug_cmds::debug_breakpoints,
            commands::debug_cmds::debug_toggle_breakpoint,
            commands::debug_cmds::debug_set_breakpoint_enabled,
            commands::debug_cmds::debug_clear_breakpoints,
            commands::debug_cmds::debug_adapter,
            commands::debug_cmds::debug_status,
            commands::debug_cmds::debug_launch_options,
            commands::debug_cmds::debug_start,
            commands::debug_cmds::debug_stop,
            commands::debug_cmds::debug_step,
            commands::debug_cmds::debug_scopes,
            commands::debug_cmds::debug_variables,
            commands::debug_cmds::debug_evaluate,
            commands::git_cmds::git_status,
            commands::git_cmds::git_working_diff,
            commands::git_cmds::git_staged_diff,
            commands::git_cmds::git_stage_hunk,
            commands::git_cmds::git_unstage_hunk,
            commands::git_cmds::git_stage_file,
            commands::git_cmds::git_unstage_file,
            commands::git_cmds::git_commit,
            commands::git_cmds::git_log,
            commands::git_cmds::git_graph,
            commands::git_cmds::git_commit_diff,
            commands::git_cmds::git_branches,
            commands::git_cmds::git_checkout_branch,
            commands::git_cmds::git_worktrees,
            commands::git_cmds::git_create_branch,
            commands::git_cmds::git_delete_branch,
            commands::git_cmds::git_fetch,
            commands::git_cmds::git_pull,
            commands::git_cmds::git_push,
            commands::git_cmds::git_ahead_behind,
            commands::git_cmds::git_discard_file,
            commands::git_cmds::git_is_repo,
            commands::git_cmds::git_init,
            commands::fs_ops::list_directory,
            commands::fs_ops::list_any_directory,
            commands::fs_ops::list_all_files,
            commands::fs_ops::search_text,
            commands::fs_ops::read_file_content,
            commands::fs_ops::read_file_base64,
            commands::fs_ops::write_file_content,
            commands::fs_ops::rename_path,
            commands::fs_ops::delete_path,
            commands::fs_ops::create_directory,
            list_chains,
            save_chain,
            delete_chain,
            list_chain_runs,
            get_chain_run,
            set_chain_run_archived,
            run_chain,
            rerun_chain_run,
            cancel_chain_run,
            resolve_chain_gate,
            mac_rounded_corners::enable_rounded_corners,
            mac_rounded_corners::enable_modern_window_style,
            mac_rounded_corners::reposition_traffic_lights,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            // No process survives the app, so leaving records open would make
            // every clean quit look like an interrupt on next launch (D20).
            // A closed project window releases its project's watchers, unless
            // another window is still showing the same project (#33).
            if let tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::Destroyed,
                ..
            } = &event
            {
                let harness = app.state::<Harness>();
                project_windows::untrack(&harness, label);
                project_windows::retire_unwatched(&harness);
            }
            if matches!(event, tauri::RunEvent::Exit) {
                release_idle_sessions_on_exit(&app.state::<Harness>());
                let _ = store::flush_session_log_writer();
                stop_completion_server(&app.state::<Harness>());
                for (_, kernel) in app.state::<Harness>().tooling.notebook_kernels.lock_or_recover().drain() {
                    kernel.terminate();
                }
            }
        });
}

/// D22: The marker the agent emits when exploration is change-shaped and
/// the agent is ready to move to the proposal phase. Palisade strips it from
/// the visible text and auto-fires `propose`.
const READY_TO_PROPOSE_MARKER: &str = "[READY_TO_PROPOSE]";

/// D22: Pure helper — detects the `[READY_TO_PROPOSE]` marker in agent text
/// and returns the stripped text if found, or `None` if the marker is absent.
/// The marker may appear anywhere in the text, possibly surrounded by other
/// content. Stripping removes the marker and any extra whitespace it leaves
/// behind so the user never sees it.
fn detect_and_strip_ready_to_propose(text: &str) -> Option<String> {
    if !text.contains(READY_TO_PROPOSE_MARKER) {
        return None;
    }
    let stripped = text.replace(READY_TO_PROPOSE_MARKER, "");
    // Collapse the double-space (or double-newline) the marker may leave
    // behind, but preserve overall structure.
    let stripped = stripped
        .replace("  ", " ")
        .replace("\n \n", "\n\n")
        .replace(" \n", "\n")
        .replace("\n ", "\n")
        .trim()
        .to_string();
    Some(stripped)
}

#[cfg(test)]
mod tests {
    #[test]
    fn pulling_a_change_from_a_worktree_overwrites_the_roots_stale_copy() {
        let root = tempfile::tempdir().unwrap();
        let tree = tempfile::tempdir().unwrap();
        for (base, tasks) in [(root.path(), "- [ ] t"), (tree.path(), "- [x] t")] {
            let dir = base.join("openspec/changes/c");
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("tasks.md"), tasks).unwrap();
        }
        copy_change(tree.path(), root.path(), "c", true).unwrap();
        assert_eq!(std::fs::read_to_string(root.path().join("openspec/changes/c/tasks.md")).unwrap(), "- [x] t");
    }


    #[test]
    fn spec_tree_is_the_worktree_only_when_it_holds_the_change() {
        let root = PathBuf::from("/root");
        let tree = tempfile::tempdir().unwrap();
        assert_eq!(pick_spec_tree(root.clone(), tree.path().into(), "c"), root);
        std::fs::create_dir_all(tree.path().join("openspec/changes/c")).unwrap();
        assert_eq!(pick_spec_tree(root, tree.path().into(), "c"), tree.path());
    }

    #[test]
    fn seed_change_copies_a_proposal_into_a_worktree_without_overwriting() {
        let project = tempfile::tempdir().unwrap();
        let tree = tempfile::tempdir().unwrap();
        let src = project.path().join("openspec/changes/c");
        std::fs::create_dir_all(src.join("specs/a")).unwrap();
        std::fs::write(src.join("proposal.md"), "root").unwrap();
        std::fs::write(src.join("tasks.md"), "- [ ] t").unwrap();
        std::fs::write(src.join("specs/a/spec.md"), "s").unwrap();
        let dst = tree.path().join("openspec/changes/c");
        std::fs::create_dir_all(&dst).unwrap();
        std::fs::write(dst.join("tasks.md"), "- [x] t").unwrap();

        seed_change(project.path(), tree.path(), "c");

        assert_eq!(std::fs::read_to_string(dst.join("proposal.md")).unwrap(), "root");
        assert_eq!(std::fs::read_to_string(dst.join("specs/a/spec.md")).unwrap(), "s");
        assert_eq!(std::fs::read_to_string(dst.join("tasks.md")).unwrap(), "- [x] t");
    }

    /// A thread already being named can't be claimed again until the first
    /// claim is dropped — the guard against a second turn double-titling.
    #[test]
    fn a_thread_being_named_cannot_be_claimed_twice() {
        let first = super::TitlingClaim::take("titling-test-thread").expect("first claim");
        assert!(super::TitlingClaim::take("titling-test-thread").is_none(), "claimed twice");
        drop(first);
        assert!(super::TitlingClaim::take("titling-test-thread").is_some(), "not released on drop");
    }

    /// Titling may start the sidecar only while FIM has no strike against it,
    /// so a title can never be the second crash that turns ghost-text off.
    #[test]
    fn titling_never_restarts_a_sidecar_that_has_crashed() {
        let harness = super::Harness::default();
        assert!(super::titling_may_start_sidecar(&harness));
        *harness.completion.completion_crashes.lock_or_recover() = 1;
        assert!(!super::titling_may_start_sidecar(&harness), "a crashed sidecar was restarted for a title");
    }

    use crate::locks::MutexExt;

    mod chain_startup_reconciliation {
        use crate::chain_history::{self, ChainRunRecord, OutcomeSnapshot};
        use crate::chains::{Chain, RetryPolicy};
        use std::collections::HashMap;

        fn chain() -> Chain {
            Chain {
                name: "startup-sweep".into(),
                nodes: HashMap::new(),
                edges: vec![],
                entry: "none".into(),
                timeout_seconds: 60,
                retry: RetryPolicy::default(),
                max_parallel: 0,
                layout: HashMap::new(),
            }
        }

        #[test]
        fn startup_sweep_closes_open_runs_for_every_persisted_project() {
            let home = tempfile::tempdir().unwrap();
            let hashes = vec!["project-a".to_string(), "project-b".to_string()];
            for hash in &hashes {
                let record = ChainRunRecord::new(format!("run-{hash}"), hash, "thread-1", chain(), "seed");
                chain_history::start_run(home.path(), &record).unwrap();
            }

            crate::reconcile_stale_chain_runs_for_hashes(home.path(), &hashes).unwrap();

            for hash in &hashes {
                let record = chain_history::list_runs(home.path(), hash).unwrap().pop().unwrap();
                assert_eq!(record.outcome, Some(OutcomeSnapshot::Interrupted), "{hash} was not reconciled");
                assert!(record.ended_at.is_some());
            }
        }
    }

    #[test]
    fn legacy_untyped_auth_messages_remain_compatible() {
        for error in [
            "auth_required",
            "Authentication required",
            "Codex needs to be signed in",
            "session expired",
        ] {
            assert!(crate::acp_client::reads_as_auth_failure(error), "should classify as auth: {error}");
        }
        assert!(!crate::acp_client::reads_as_auth_failure("context window exceeded"));
    }

    /// D17: a chain whose bound agent isn't installed is blocked before it
    /// starts, naming the node and the agent — never silently substituted.
    mod chain_preflight {
        use crate::chains::{Chain, ChainNode, RetryPolicy};
        use std::collections::HashMap;

        fn chain(agents: &[(&str, &str)]) -> Chain {
            Chain {
                name: "design-loop".into(),
                nodes: agents
                    .iter()
                    .map(|(role, agent)| {
                        (
                            role.to_string(),
                            ChainNode {
                                role: role.to_string(),
                                guideline: String::new(),
                                agent: agent.to_string(),
                                model: None,
                                retry: None,
                            },
                        )
                    })
                    .collect::<HashMap<_, _>>(),
                edges: Vec::new(),
                entry: agents[0].0.to_string(),
                timeout_seconds: 1800,
                retry: RetryPolicy::default(),
                max_parallel: 0,
                layout: HashMap::new(),
            }
        }

        #[test]
        fn a_chain_whose_agents_are_all_installed_passes() {
            let c = chain(&[("designer", "gemini-cli"), ("programmer", "claude-code")]);
            assert!(crate::unavailable_agents(&c, |_| true).is_ok());
        }

        #[test]
        fn a_missing_agent_names_both_the_node_and_the_agent() {
            let c = chain(&[("designer", "gemini-cli"), ("programmer", "claude-code")]);
            let err = crate::unavailable_agents(&c, |a| a != "gemini-cli").unwrap_err();
            assert!(err.contains("`designer` needs gemini-cli"), "{err}");
            assert!(!err.contains("claude-code"), "{err}");
            assert!(err.contains("its agent is"), "{err}");
        }

        #[test]
        fn several_missing_agents_are_listed_in_a_stable_order() {
            let c = chain(&[("designer", "gemini-cli"), ("programmer", "claude-code")]);
            let err = crate::unavailable_agents(&c, |_| false).unwrap_err();
            assert!(err.contains("some of its agents are"), "{err}");
            let designer = err.find("`designer`").unwrap();
            let programmer = err.find("`programmer`").unwrap();
            assert!(designer < programmer, "{err}");
        }
    }

    mod chain_rerun_start {
        use crate::chain_history::{ChainRunRecord, NodeHistory};
        use crate::chains::{Chain, ChainEdge, ChainNode, RetryPolicy};
        use std::collections::HashMap;

        fn record() -> ChainRunRecord {
            let mut nodes = HashMap::new();
            for role in ["scout", "reviewer", "auditor", "judge"] {
                nodes.insert(
                    role.to_string(),
                    ChainNode {
                        role: role.into(),
                        guideline: if role == "judge" { "snapshot judge".into() } else { String::new() },
                        agent: "codex".into(),
                        model: None,
                        retry: None,
                    },
                );
            }
            let chain = Chain {
                name: "saved-version".into(),
                nodes,
                edges: vec![
                    ChainEdge { from: "scout".into(), to: "reviewer".into(), gate: None, max_iterations: None },
                    ChainEdge { from: "scout".into(), to: "auditor".into(), gate: None, max_iterations: None },
                    ChainEdge { from: "reviewer".into(), to: "judge".into(), gate: None, max_iterations: None },
                    ChainEdge { from: "auditor".into(), to: "judge".into(), gate: None, max_iterations: None },
                ],
                entry: "scout".into(), timeout_seconds: 60, retry: RetryPolicy::default(), max_parallel: 0, layout: HashMap::new(),
            };
            let mut record = ChainRunRecord::new("old-run", "project", "thread", chain, "old seed");
            record.nodes.insert("reviewer".into(), NodeHistory { output: Some("review output".into()), ..Default::default() });
            record.nodes.insert("auditor".into(), NodeHistory { output: Some("audit output".into()), ..Default::default() });
            record
        }

        #[test]
        fn rerun_from_node_uses_the_record_snapshot_and_its_predecessor_outputs() {
            let start = crate::rerun_start(&record(), Some("judge")).unwrap();

            assert_eq!(start.chain.name, "saved-version");
            assert_eq!(start.chain.nodes["judge"].guideline, "snapshot judge");
            assert_eq!(start.seed, "old seed");
            assert_eq!(start.role, "judge");
            assert_eq!(start.inputs, vec![
                ("reviewer".into(), "review output".into()),
                ("auditor".into(), "audit output".into()),
            ]);
        }

        #[test]
        fn rerun_from_node_refuses_to_start_without_every_required_recorded_output() {
            let mut record = record();
            record.nodes.remove("auditor");

            let err = crate::rerun_start(&record, Some("judge")).unwrap_err();

            assert!(err.contains("auditor"), "{err}");
            assert!(err.contains("no recorded output"), "{err}");
        }

        #[test]
        fn rerun_from_a_missing_role_fails_before_a_run_can_start() {
            let err = crate::rerun_start(&record(), Some("gone")).unwrap_err();
            assert!(err.contains("no role `gone`"), "{err}");
        }
    }

    /// §4.2: `cancel_chain_run` errors rather than no-ops for a run that
    /// isn't tracked — mirroring `resolve_chain_gate`'s deliberate error for
    /// the same reason, an unknown or already-finished run means the UI is
    /// showing something that has already moved on.
    mod chain_cancel {
        use crate::executor::Harness;
        use crate::locks::MutexExt;

        #[test]
        fn cancelling_an_unknown_run_errors_rather_than_no_ops() {
            let harness = Harness::default();
            let err = crate::cancel_chain_run_impl(&harness, "no-such-run").unwrap_err();
            assert!(err.contains("isn't running"), "{err}");
        }

        #[test]
        fn cancelling_a_tracked_run_flips_its_flag() {
            let harness = Harness::default();
            let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            harness.chain.chain_cancels.lock_or_recover().insert("run-1".into(), cancel.clone());
            assert!(crate::cancel_chain_run_impl(&harness, "run-1").is_ok());
            assert!(cancel.load(std::sync::atomic::Ordering::SeqCst));
        }

        /// A run that already finished removes its own entry from
        /// `chain_cancels` (mirrors `run_chain`'s cleanup) — cancelling it
        /// afterward must hit the same "isn't running" error as a run id
        /// that never existed, not a stale success.
        #[test]
        fn cancelling_a_run_thats_already_finished_errors_the_same_as_unknown() {
            let harness = Harness::default();
            let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            harness.chain.chain_cancels.lock_or_recover().insert("run-1".into(), cancel);
            harness.chain.chain_cancels.lock_or_recover().remove("run-1");
            let err = crate::cancel_chain_run_impl(&harness, "run-1").unwrap_err();
            assert!(err.contains("isn't running"), "{err}");
        }
    }

    #[test]
    fn generate_describes_the_staged_diff_when_there_is_one() {
        let picked = diff_to_describe("+staged line", "+working line", &[]).unwrap();
        assert_eq!(picked.0, "staged");
        assert_eq!(picked.1, "+staged line");
    }

    #[test]
    fn the_working_tree_fallback_names_untracked_files_too() {
        // `git diff` is blind to untracked files: a project of mostly new
        // files got a draft describing the one tracked edit, stated as
        // confidently as if it had seen everything.
        let untracked = vec!["src/new.ts".to_string(), "docs/added.md".to_string()];
        let (scope, diff) =
            diff_to_describe("", "+one tracked edit", &untracked).unwrap();
        assert_eq!(scope, "working-tree");
        assert!(diff.contains("+one tracked edit"), "{diff}");
        assert!(diff.contains("src/new.ts"), "{diff}");
        assert!(diff.contains("docs/added.md"), "{diff}");
    }

    #[test]
    fn a_tree_of_only_new_files_still_has_something_to_describe() {
        let untracked = vec!["a.ts".to_string()];
        let (_, diff) = diff_to_describe("", "", &untracked).unwrap();
        assert!(diff.contains("a.ts"), "{diff}");
    }

    #[test]
    fn generate_falls_back_to_the_working_tree_when_nothing_is_staged() {
        // Deciding what to stage usually comes after reading the summary —
        // refusing here made the button useless before the first `git add`.
        let picked = diff_to_describe("   \n", "+working line", &[]).unwrap();
        assert_eq!(picked.0, "working-tree");
        assert_eq!(picked.1, "+working line");
    }

    #[test]
    fn generate_has_nothing_to_say_about_a_clean_tree() {
        assert!(diff_to_describe("", "  \n", &[]).is_none());
    }

    #[test]
    fn the_prompt_names_which_diff_it_is_describing() {
        assert!(commit_message_prompt("working-tree", "+x", None).contains("working-tree diff"));
        assert!(commit_message_prompt("staged", "+x", Some("Prefix with JIRA-123")).contains("JIRA-123"));
        let agents = "# Repo\n## Commit messages\nUse Conventional Commits.\n### Scopes\nModule name.\n## Testing\nRun it.";
        assert_eq!(
            commit_rules_in(agents).as_deref(),
            Some("Use Conventional Commits.\n### Scopes\nModule name.")
        );
        assert_eq!(commit_rules_in("- Write commit messages in English.\n- Never commit .env").as_deref(), Some("- Write commit messages in English."));
        assert_eq!(commit_rules_in("## Gotchas\n- Never commit the key."), None);
    }

    use super::*;

    /// Builds an ACP preflight snapshot from named agent ids.
    fn flight(agent_ids: &[&str]) -> Preflight {
        let agents: Vec<acp_preflight::AgentStatus> = agent_ids
            .iter()
            .map(|id| acp_preflight::AgentStatus {
                id: id.to_string(),
                name: id.to_string(),
                version: None,
                path: Some(format!("/usr/bin/{id}")),
                cmd: id.to_string(),
                args: vec![],
            })
            .collect();
        Preflight {
            selected: agents.first().map(|a| a.id.clone()),
            agents,
            openspec: true,
            ready: true,
            registry_reachable: true,
            warnings: vec![],
            checked_at: "2026-08-07T00:00:00Z".into(),
        }
    }

    #[test]
    fn no_override_uses_auto_detection() {
        let f = flight(&["devin", "claude-acp"]);
        let (agent, warning) = resolve_executor(&f, None).unwrap();
        assert_eq!(agent.id, "devin");
        assert!(warning.is_none());
    }

    #[test]
    fn an_installed_override_wins_over_auto_detection() {
        let f = flight(&["devin", "claude-acp"]);
        let (agent, warning) =
            resolve_executor(&f, Some("claude-acp".into())).unwrap();
        assert_eq!(agent.id, "claude-acp");
        assert!(warning.is_none());
    }

    #[test]
    fn an_override_naming_an_uninstalled_executor_falls_back_and_warns() {
        // claude-acp is in the flight but has no PATH (simulating not installed).
        let mut f = flight(&["devin"]);
        f.agents.push(acp_preflight::AgentStatus {
            id: "claude-acp".into(),
            name: "Claude ACP".into(),
            version: None,
            path: None,
            cmd: "claude-acp".into(),
            args: vec![],
        });
        let (agent, warning) = resolve_executor(&f, Some("claude-acp".into())).unwrap();
        assert_eq!(agent.id, "devin", "must fall back to auto-detection, not error");
        let warning = warning.unwrap();
        assert!(warning.contains("claude-acp") && warning.contains("not on PATH"));
    }

    // --------------------------------------------------- 6a.1: spec_mode auto-injects explore

    fn thread_meta(change: Option<&str>) -> store::ThreadMeta {
        store::ThreadMeta {
            id: "t1".into(),
            project_hash: "p1".into(),
            title: "Test".into(),
            created_at: "2026-08-11T00:00:00Z".into(),
            updated_at: "2026-08-11T00:00:00Z".into(),
            current_mode: "spec".into(),
            open_spec_change_name: change.map(String::from),
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
            title_source: "manual".into(),
            auth_blocked: None,
            last_viewed_at: None,
            acknowledged_crash_session_id: None,
            title_retried: false,
        }
    }

    /// RED→GREEN 6a.1: spec-mode with no change auto-fires grill-explore.
    /// Amended by D5: the spec_type is the user turn body, not "grill-explore".
    #[test]
    fn spec_mode_initial_prompt_with_no_change_uses_spec_type_as_body() {
        let meta = thread_meta(None);
        let prompt = spec_mode_initial_prompt(&meta, "Feature", None, true).unwrap();
        // The grill-explore skill content is still prepended (it contains the
        // label "grill-explore" and a "---" separator before the body).
        assert!(prompt.contains("grill-explore"));
        assert!(prompt.contains("---"));
        // The spec_type is now the body — it appears after the separator.
        let after_sep = prompt.rsplit("---").next().unwrap();
        assert!(
            after_sep.contains("Feature"),
            "spec_type must be the body after the separator"
        );
    }

    /// The framing card is pre-wired guidance, not the request. The user's
    /// own words are what the agent is actually given — the body used to be
    /// the bare label ("Start exploring the following concept: Feature"),
    /// which told the agent nothing and made the interview open by asking
    /// for the request the user had already been asked for.
    #[test]
    fn a_framing_card_supplies_guidance_and_the_user_supplies_the_request() {
        let bugfix = framed_spec_body("Bugfix", Some("login loops on Safari"));
        assert!(bugfix.contains("login loops on Safari"));
        assert!(bugfix.contains("root cause"));
        assert!(bugfix.contains("reproduce"));

        let feature = framed_spec_body("Feature", Some("a CSV export for reports"));
        assert!(feature.contains("a CSV export for reports"));
        assert!(feature.contains("out of scope"));
        // Guidance is per framing, not one blob handed to every card.
        assert!(!feature.contains("root cause"));
    }

    /// A framing the user typed themselves gets no invented guidance —
    /// Palisade cannot know what questions it implies.
    #[test]
    fn a_custom_framing_carries_the_request_without_inventing_guidance() {
        let body = framed_spec_body("Migrate to Postgres", Some("downtime under a minute"));
        assert!(body.contains("Migrate to Postgres"));
        assert!(body.contains("downtime under a minute"));
        assert!(!body.contains("root cause"));
        assert!(!body.contains("out of scope"));
    }

    /// Handoff re-injection has no request to carry: the user's words are
    /// already in the rebuilt transcript, so only the framing is restated.
    #[test]
    fn a_body_with_no_request_still_frames_the_work() {
        let body = framed_spec_body("Bugfix", None);
        assert!(body.contains("root cause"));
        assert!(!body.contains("in their own words"));
        assert_eq!(framed_spec_body("", None), "Start exploring.");
        // Whitespace is not a request.
        assert_eq!(framed_spec_body("", Some("   ")), "Start exploring.");
    }

    /// RED→GREEN 6a.1: spec-mode with an existing change does NOT auto-inject.
    /// Amended by D10: spec_type is silently ignored when a change exists.
    #[test]
    fn spec_mode_initial_prompt_with_change_is_none() {
        let meta = thread_meta(Some("my-change"));
        assert!(spec_mode_initial_prompt(&meta, "Feature", None, true).is_none());
    }

    /// #17 RED: flipping the mode toggle is not a request. Nothing is typed,
    /// nothing is sent — the toggle only records the thread's intent, so
    /// there is no initial prompt to fire whatever the thread looks like.
    #[test]
    fn a_mode_toggle_never_produces_an_initial_prompt() {
        for change in [None, Some("my-change")] {
            let meta = thread_meta(change);
            assert!(
                spec_mode_initial_prompt(&meta, "Feature", None, false).is_none(),
                "the toggle must stay inert"
            );
            assert!(
                spec_mode_initial_prompt(&meta, "", None, false).is_none(),
                "even with no spec type to frame"
            );
        }
    }

    /// The deliberate act — picking a spec type in the framing menu — is what
    /// still starts the explore turn.
    #[test]
    fn an_explicit_start_with_no_open_change_still_fires_grill_explore() {
        let meta = thread_meta(None);
        assert!(spec_mode_initial_prompt(&meta, "Bugfix", None, true).is_some());
    }

    // ----------------------------------------------- D12: handoff re-injection

    fn thread_meta_with_spec_type(change: Option<&str>, spec_type: Option<&str>) -> store::ThreadMeta {
        let mut m = thread_meta(change);
        m.spec_type = spec_type.map(String::from);
        m
    }

    /// RED→GREEN D12: on agent handoff with stored spec_type and no open
    /// change, the reinjection is the grill-explore skill + spec_type as the
    /// first turn body. `ensure_session` prepends this to the handoff prefix.
    #[test]
    fn spec_type_reinjection_with_stored_type_and_no_change_returns_framing() {
        let meta = thread_meta_with_spec_type(None, Some("Feature"));
        let reinjection = spec_type_reinjection("spec", &meta).unwrap();
        // The grill-explore skill content is prepended.
        assert!(reinjection.contains("grill-explore"));
        assert!(reinjection.contains("---"));
        // The spec_type is the body after the separator.
        let after_sep = reinjection.rsplit("---").next().unwrap();
        assert!(
            after_sep.contains("Feature"),
            "spec_type must be the reinjected body"
        );
    }

    /// A handoff prefix parked by `ensure_session` must survive a caller that
    /// starts the session without prompting (`/go`) and ride along with the
    /// next turn instead. Without the parking, `/go` dropped the transcript
    /// and the new agent answered the next question with "NO CONTEXT".
    #[test]
    fn parked_handoff_prefix_rides_along_with_the_next_turn() {
        let harness = Harness::default();
        harness
            .agent.pending_prefix
            .lock()
            .unwrap()
            .insert("s1".into(), "TRANSCRIPT".into());

        // What `send_to` hands the agent.
        assert_eq!(harness.pending_prefix("s1").as_deref(), Some("TRANSCRIPT"));
        // Still parked until the send succeeds — a failed send must not eat it.
        assert_eq!(harness.pending_prefix("s1").as_deref(), Some("TRANSCRIPT"));
        harness.clear_pending_prefix("s1");
        // Sent once, not re-sent on every later turn.
        assert_eq!(harness.pending_prefix("s1"), None);
        // A session with nothing parked is untouched.
        assert_eq!(harness.pending_prefix("s2"), None);
    }

    /// A reloaded webview re-seeds its `/` menu from here: a live session's
    /// last advertised commands come back for its thread, and a session that
    /// ended takes its commands with it.
    #[test]
    fn a_live_sessions_commands_survive_for_its_thread_until_it_ends() {
        let (session, _rx) = acp_client::stub_session(false);
        let harness = Harness::default();
        let id = session.id.clone();
        let thread = session.thread_id.clone();
        harness.agent.acp_sessions.lock_or_recover().insert(id.clone(), session);
        let commands = vec![crate::acp_events::AgentCommand {
            name: "review".into(),
            description: "Review code changes".into(),
        }];
        harness.agent.session_commands.lock_or_recover().insert(id.clone(), commands.clone());
        // A stale entry for a session that is no longer live is ignored.
        harness.agent.session_commands.lock_or_recover().insert("gone".into(), vec![]);

        assert_eq!(thread_commands(&harness, &thread), commands);
        assert!(thread_commands(&harness, "other-thread").is_empty());

        end_session(&harness, &thread, &id, "cancelled");
        assert!(thread_commands(&harness, &thread).is_empty());
        assert!(!harness.agent.session_commands.lock_or_recover().contains_key(&id));
    }

    #[test]
    fn a_thread_is_named_for_the_request_not_the_skill_that_leads_it() {
        assert_eq!(title_source("/tdd fix the login form"), "fix the login form");
        assert_eq!(title_source("$tdd fix it"), "fix it");
        // A bare command has nothing else to name the thread for.
        assert_eq!(title_source("/review"), "/review");
        assert_eq!(title_source("plain request"), "plain request");
    }

    /// The bytes the agent actually receives. `/go` performs the handoff but
    /// sends no prompt of its own, so the transcript has to survive until the
    /// user's next turn — this asserts on what reaches the transport, not on
    /// what a model says about it.
    #[test]
    fn the_agent_receives_the_handoff_transcript_on_the_turn_after_go() {
        let (session, mut rx) = acp_client::stub_session(false);
        let harness = Harness::default();
        let id = session.id.clone();
        harness.agent.acp_sessions.lock_or_recover().insert(id.clone(), session);
        // What ensure_session parks when /go hands off to a new agent.
        harness
            .agent.pending_prefix
            .lock()
            .unwrap()
            .insert(id.clone(), "This conversation was handed off. Transcript:\n\nUser: use notes_index.py".into());

        send_to(&harness, "p1", &id, "carry on").unwrap();

        let sent = match rx.try_recv().expect("a prompt reached the transport") {
            acp_client::BridgeCommand::Prompt(prompt) => prompt.joined(),
            _ => panic!("expected a prompt"),
        };
        assert!(sent.contains("notes_index.py"), "the transcript must ride along: {sent}");
        assert!(sent.ends_with("carry on"), "the user's turn must be last: {sent}");

        // …and only on that turn: once sent, it is no longer parked, so the
        // next turn goes out bare. (A second send here would be rejected as
        // mid-turn — that is `send_acp_prompt`'s busy guard, not this path.)
        assert!(
            harness.agent.pending_prefix.lock_or_recover().is_empty(),
            "a delivered transcript must not be re-sent on the next turn"
        );
    }

    /// A turn typed straight into a Spec thread (no framing menu, no
    /// `/propose`) must still tell the agent to write specs — without it the
    /// agent scaffolded an app and the write guard cancelled the turn.
    #[test]
    fn a_plain_spec_turn_carries_the_grill_skill_once() {
        let (session, mut rx) = acp_client::stub_session(false);
        assert_eq!(session.mode, "spec");
        let harness = Harness::default();
        let id = session.id.clone();
        harness.agent.acp_sessions.lock_or_recover().insert(id.clone(), session);

        send_to(&harness, "p1", &id, "build a landing page").unwrap();
        let sent = match rx.try_recv().expect("a prompt reached the transport") {
            acp_client::BridgeCommand::Prompt(prompt) => prompt.joined(),
            _ => panic!("expected a prompt"),
        };
        assert!(sent.contains("name: grill-explore"), "spec turn lacks the skill: {sent}");
        assert!(sent.ends_with("build a landing page"), "the user's turn must be last: {sent}");

        // A turn Palisade already built with the skill is not doubled.
        harness.agent.acp_sessions.lock_or_recover().get(&id).unwrap().busy.store(false, std::sync::atomic::Ordering::SeqCst);
        send_to(&harness, "p1", &id, &grill_inject::build_prompt("spec", true, "grill-propose")).unwrap();
        let sent = match rx.try_recv().expect("a prompt reached the transport") {
            acp_client::BridgeCommand::Prompt(prompt) => prompt.joined(),
            _ => panic!("expected a prompt"),
        };
        assert_eq!(sent.matches("name: grill-").count(), 1, "skill doubled: {sent}");
    }

    #[test]
    fn a_missing_attachment_never_sends_an_incomplete_turn() {
        let (session, mut rx) = acp_client::stub_session(false);
        let harness = Harness::default();
        let id = session.id.clone();
        harness.agent.acp_sessions.lock_or_recover().insert(id.clone(), session);
        assert!(send_to(&harness, "p1", &id, &Message { attachments: vec!["/missing/image.png".into()], ..Message::row("user", "go", "look at this") }).is_err());
        assert!(rx.try_recv().is_err());
    }

    /// A go-mode handoff must not re-inject the grill-explore framing: the
    /// reinjection carries the skill, and a mid-build agent that receives it
    /// stops building and restarts the interview.
    #[test]
    fn spec_type_reinjection_is_spec_mode_only() {
        let meta = thread_meta_with_spec_type(None, Some("Feature"));
        assert!(spec_type_reinjection("spec", &meta).is_some());
        assert_eq!(spec_type_reinjection("go", &meta), None);
    }

    /// RED→GREEN D12: on same-agent restart (no handoff), `ensure_session`
    /// returns None prefix — no reinjection. The pure function also returns
    /// None when a change is open, so even if called it wouldn't inject.
    #[test]
    fn spec_type_reinjection_with_open_change_is_none() {
        let meta = thread_meta_with_spec_type(Some("my-change"), Some("Feature"));
        assert_eq!(spec_type_reinjection("spec", &meta), None);
    }

    /// RED→GREEN D12: no stored spec_type → no reinjection (nothing to re-inject).
    #[test]
    fn spec_type_reinjection_without_stored_type_is_none() {
        let meta = thread_meta_with_spec_type(None, None);
        assert_eq!(spec_type_reinjection("spec", &meta), None);
    }

    // --------------------------------------------------- 6a.2: apply_skill one-shot

    /// RED→GREEN 6a.2: apply_skill_prompt injects grill-apply for a change.
    #[test]
    fn apply_skill_prompt_injects_grill_apply() {
        let prompt = apply_skill_prompt("my-change");
        assert!(prompt.contains("grill-apply"));
        assert!(prompt.contains("my-change"));
        assert!(prompt.contains("---"));
    }

    #[test]
    fn an_override_naming_an_unknown_agent_falls_back_and_names_the_known_ones() {
        let f = flight(&["devin", "claude-acp"]);
        let (agent, warning) =
            resolve_executor(&f, Some("gpt-9".into())).unwrap();
        assert_eq!(agent.id, "devin");
        let warning = warning.unwrap();
        assert!(warning.contains("gpt-9"), "the warning must name what was asked for");
        assert!(warning.contains("devin"), "and what it could have been: devin");
        assert!(warning.contains("claude-acp"), "and what it could have been: claude-acp");
    }

    #[test]
    fn an_override_with_no_executors_installed_at_all_still_errors() {
        let f = flight(&[]);
        assert!(resolve_executor(&f, Some("devin".into())).is_err());
    }

    #[test]
    fn no_override_and_nothing_installed_errors() {
        let f = flight(&[]);
        let error = resolve_executor(&f, None).unwrap_err();
        assert!(error.contains("chat-only"));
    }

    #[tokio::test]
    async fn list_projects_command_returns_ok_when_index_missing() {
        let result = list_projects().await;
        assert!(result.is_ok());
    }

    #[test]
    fn detect_and_strip_ready_to_propose_strips_marker_and_returns_cleaned_text() {
        let input = "I've finished exploring.\n[READY_TO_PROPOSE]\nLet's move on.";
        let result = detect_and_strip_ready_to_propose(input);
        assert!(result.is_some());
        let stripped = result.unwrap();
        assert!(!stripped.contains("[READY_TO_PROPOSE]"));
        assert!(stripped.contains("I've finished exploring."));
        assert!(stripped.contains("Let's move on."));
    }

    #[test]
    fn detect_and_strip_ready_to_propose_returns_none_when_marker_absent() {
        let input = "I'm still exploring the codebase.";
        let result = detect_and_strip_ready_to_propose(input);
        assert!(result.is_none());
    }

    #[test]
    fn detect_and_strip_ready_to_propose_handles_marker_alone() {
        let input = "[READY_TO_PROPOSE]";
        let result = detect_and_strip_ready_to_propose(input);
        assert!(result.is_some());
        assert_eq!(result.unwrap(), "");
    }

    #[test]
    fn detect_and_strip_ready_to_propose_handles_marker_at_end() {
        let input = "Exploration complete. [READY_TO_PROPOSE]";
        let result = detect_and_strip_ready_to_propose(input);
        assert!(result.is_some());
        let stripped = result.unwrap();
        assert_eq!(stripped, "Exploration complete.");
    }
}
