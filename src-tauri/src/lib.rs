mod acp_client;
mod acp_events;
mod acp_preflight;
mod acp_registry;
mod chain_exec;
mod chain_runner;
mod chains;
mod completion;
mod db;
mod executor;
mod graph_nudge;
mod grill_inject;
mod handoff;
mod permissions;
mod fswatch;
mod git;
mod git_repo;
mod integrations;
mod lsp;
mod mcp;
mod notebook;
mod pidguard;
mod session_log_writer;
mod openspec_cache;
mod settings;
mod store;
mod project_windows;
mod dap;
mod terminal;
mod test_parse;
mod plugins;
mod commands;

use plugins::mac_rounded_corners;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::{Emitter, Manager};

use acp_preflight::Preflight;
use executor::{Envelope, ExecutorEvent, Harness, Sink};
use serde::Serialize;
use store::{palisade_home, Message, Project};
pub(crate) use store::{Res, ThreadMeta};

#[derive(Debug, Clone, Serialize)]
pub(crate) struct DirEntry {
    name: String,
    is_dir: bool,
    path: String,
}

/// Resolves a project's root from the global index rather than trusting the
/// frontend — used by every command that reads/writes inside the project
/// filesystem (file editing, git, Graphify, format-on-save).
pub(crate) fn project_root(hash: &str) -> Res<PathBuf> {
    let home = palisade_home();
    store::list_projects(&home)?
        .into_iter()
        .find(|p| p.hash == hash)
        .map(|p| PathBuf::from(p.root))
        .ok_or_else(|| format!("unknown project: {hash}"))
}

/// Where the `git` binary lives, or a readable error if it isn't there.
pub(crate) fn git_bin() -> Res<PathBuf> {
    executor::find_on_path("git").ok_or_else(|| "`git` is not on PATH.".into())
}

#[tauri::command]
async fn list_projects() -> Res<Vec<Project>> {
    tokio::task::spawn_blocking(|| store::list_projects(&palisade_home()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn add_project(app: tauri::AppHandle, path: String) -> Res<Project> {
    tokio::task::spawn_blocking(move || {
        let project = store::add_project(&palisade_home(), Path::new(&path))?;
        let _ = app.emit("projects-changed", &project.hash);
        Ok(project)
    })
        .await
        .map_err(|e| e.to_string())?
}

/// Open a separate native window with its own frontend project state.
///
/// A project already on screen focuses its window instead of opening a second
/// copy of itself — the rule VS Code follows for the same action (#33).
#[tauri::command]
async fn open_project_window(app: tauri::AppHandle, hash: String) -> Res<String> {
    if let Some(label) = project_windows::window_showing(&app.state::<Harness>(), &hash) {
        if let Some(existing) = app.get_webview_window(&label) {
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
        .map_err(|e| format!("configure project window: {e}"))?
        .build().map_err(|e| format!("open project window: {e}"))?;
    Ok(label)
}

#[tauri::command]
async fn remove_project(app: tauri::AppHandle, hash: String) -> Res<()> {
    tokio::task::spawn_blocking(move || {
        project_windows::remove_saved_project(&palisade_home(), &app.state::<Harness>(), &hash)?;
        let _ = app.emit("projects-changed", &hash);
        Ok(())
    }).await.map_err(|e| e.to_string())?
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
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn switch_project(window: tauri::Window, app: tauri::AppHandle, hash: String) -> Res<Project> {
    let label = window.label().to_string();
    tokio::task::spawn_blocking(move || {
        let project = store::touch_project(&palisade_home(), &hash)?;
        let harness: tauri::State<'_, Harness> = app.state();
        // Which window is showing what decides which watchers stay alive (#33).
        project_windows::track(&harness, &label, &project.hash);
        start_watcher(&app, &harness, &project);
        start_fs_watcher(&app, &harness, &project);
        ensure_graphify_mcp(&app, &harness, &project);

        let root = Path::new(&project.root);
        // Auto-create .palisade/project-settings.json (D14/D15) so there's always a real
        // file to open from the settings button — a no-op once it exists.
        if let Err(message) = settings::ensure_file(root) {
            let _ = app.emit("harness-warning", message);
        }
        // Keep the code graph out of git: unignored, it shows up in the diff
        // pane as untracked work and lands in whatever the agent stages. A
        // no-op once anything already ignores it, and skipped in a non-repo.
        if let Ok(bin) = git_bin() {
            if let Err(message) = integrations::ensure_graph_ignored(&bin, root) {
                let _ = app.emit("harness-warning", message);
            }
        }
        // Surface malformed settings immediately on load, rather than only when
        // a save or an executor-override lookup happens to re-read them.
        let (_, warning) = settings::load(root);
        if let Some(message) = warning {
            let _ = app.emit("harness-warning", message);
        }
        Ok(project)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Idempotently registers Graphify's MCP server (D9/D21) with whichever
/// executor is detected, so the agent gets graph tools mid-turn instead of
/// a pre-injected summary. A missing `graphify-mcp` binary or no detected
/// executor is skipped silently — the general `graphify` PATH warning
/// already covers a missing install. A registration failure (e.g. an
/// unwritable project dir) surfaces through the same `harness-warning`
/// event a failed watcher spawn already uses.
fn ensure_graphify_mcp(app: &tauri::AppHandle, harness: &tauri::State<'_, Harness>, project: &Project) {
    let Some(bin) = executor::find_on_path("graphify-mcp") else {
        return;
    };
    let Ok((agent, _)) = selected_executor(app, harness, &project.hash, None) else {
        return;
    };

    let root = PathBuf::from(&project.root);
    let graph_path = integrations::default_out_dir(&root).join("graph.json");
    // Kept as an explicit per-agent match (task 3.6): each agent's MCP config
    // file has its own real format, which is not BYOA friction to abstract
    // away. An agent with no MCP story is simply skipped.
    let result = match agent.id.as_str() {
        "claude-acp" => integrations::ensure_claude_mcp(&root, &bin, &graph_path),
        "codex-acp" => {
            integrations::ensure_codex_mcp(&root, &bin, &graph_path, &executor::home().join(".codex"))
        }
        _ => return,
    };
    if let Err(message) = result {
        let _ = app.emit("harness-warning", format!("Graphify MCP registration failed: {message}"));
    }
}

/// Replaces whatever `graphify watch` was running (if any — `Watcher`'s
/// `Drop` terminates it) with one scoped to the newly active project. A
/// missing `graphify` binary is already covered by the persistent preflight
/// warning, so it's silently skipped here rather than also flashing a
/// one-off error every time the user switches projects; a watcher that
/// fails to spawn for some other reason, or crashes later, surfaces once
/// through the `harness-warning` event instead.
fn start_watcher(app: &tauri::AppHandle, harness: &tauri::State<'_, Harness>, project: &Project) {
    // Keyed by project, not a single slot: a second project window used to
    // stop the first window's watcher (#33). Retire first, so switching away
    // from a project no window still shows also stops its graphify process.
    project_windows::retire_unwatched(harness);
    let mut watchers = harness.watch.lock().unwrap();
    if watchers.contains_key(&project.hash) {
        return;
    }

    let Some(bin) = executor::find_on_path("graphify") else {
        return;
    };

    let app_update = app.clone();
    let hash_update = project.hash.clone();
    let app_crash = app.clone();
    watchers.insert(project.hash.clone(), integrations::Watcher::spawn(
        bin,
        PathBuf::from(&project.root),
        move || {
            let _ = app_update.emit("graphify-updated", &hash_update);
        },
        move |message| {
            let _ = app_crash.emit("harness-warning", message);
        },
    ));
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
/// leaves the app working without reconciliation — the same degradation as a
/// missing `graphify`.
fn start_fs_watcher(app: &tauri::AppHandle, harness: &tauri::State<'_, Harness>, project: &Project) {
    project_windows::retire_unwatched(harness);
    let mut watchers = harness.fswatch.lock().unwrap();
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
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn create_thread(project_hash: String, title: String) -> Res<ThreadMeta> {
    tokio::task::spawn_blocking(move || store::create_thread(&palisade_home(), &project_hash, &title))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn list_threads(project_hash: String) -> Res<Vec<ThreadMeta>> {
    tokio::task::spawn_blocking(move || store::list_threads(&palisade_home(), &project_hash))
        .await
        .map_err(|e| e.to_string())?
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
    .map_err(|e| e.to_string())?
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
    .map_err(|e| e.to_string())?
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
    .map_err(|e| e.to_string())?
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
    .map_err(|e| e.to_string())?
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
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn read_thread(project_hash: String, thread_id: String) -> Res<Vec<Message>> {
    tokio::task::spawn_blocking(move || store::read_thread(&palisade_home(), &project_hash, &thread_id))
        .await
        .map_err(|e| e.to_string())?
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
        let _ = self.app.emit(
            "agent-commands",
            AgentCommands {
                session_id: session_id.to_string(),
                thread_id: thread_id.to_string(),
                commands: commands.to_vec(),
            },
        );
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
            .acp_sessions
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
            .turn_watchers
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
            ExecutorEvent::Crashed { .. } => {
                end_session(&self.app.state::<Harness>(), &thread_id, &envelope_ref.session_id, "crashed");
                // #18: only a dead agent drops the thread back to spec. A
                // retryable turn failure (expired auth, a cancelled turn)
                // leaves the user's Go intent where they put it — the UI is
                // offering them a Retry for that very error.
                if executor::crash_resets_mode(&envelope_ref.event) {
                    let _ = executor::on_crash(&palisade_home(), &self.project_hash, &thread_id);
                }
                let _ = self.app.emit("thread-updated", &thread_id);
            }
            ExecutorEvent::Done => {
                let harness = self.app.state::<Harness>();
                let _ = harness.session_log_writer.lock().unwrap().flush();
                let watch = harness.pending_propose.lock().unwrap().take();
                if let Some(watch) = watch {
                    let after = executor::openspec_changes(&harness.openspec_cache, &watch.project_root);
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
                        executor::ProposeOutcome::None => {}
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
    let mut cached = harness.preflight.lock().unwrap();
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
    .map_err(|e| e.to_string())?)
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
        let mut cached = harness.preflight.lock().unwrap();
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
            *harness.preflight.lock().unwrap() = Some(flight.clone());
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
    let chain_owned = harness.chain_sessions.lock().unwrap();
    harness
        .acp_sessions
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
            path
        }
        Err(err) => pin(Some(format!("Could not create an isolated worktree ({err})"))),
    }
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
    let root = thread_worktree(app, &home, &project, project_hash, thread_id);
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
    harness.acp_sessions.lock().unwrap().insert(id.clone(), session);
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
            .acp_sessions
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
        park_prefix(harness, &new_id, &agent.id, project_hash, prefix);
        return Ok(new_id);
    }
    let id = start_session(app, harness, project_hash, thread_id, mode, true, model, bypass)?;
    park_prefix(harness, &id, &agent.id, project_hash, None);
    Ok(id)
}

/// Park a new session's first-turn prefix, with the graph-tool nudge ahead of
/// it. Both live here because every new session gets the nudge — spec and go
/// alike — while only a handoff has a transcript to carry. `send_to` drains and
/// clears the slot, so the nudge lands exactly once per session; a `/go` that
/// starts a session without prompting keeps it for the next real turn.
fn park_prefix(
    harness: &Harness,
    session_id: &str,
    agent_id: &str,
    project_hash: &str,
    prefix: Option<String>,
) {
    let nudge = project_root(project_hash)
        .ok()
        .and_then(|root| graph_nudge::nudge(agent_id, &root));
    if let Some(combined) = graph_nudge::compose(nudge, prefix) {
        harness.pending_prefix.lock().unwrap().insert(session_id.to_string(), combined);
    }
}

/// Drop a session from the live map and close its record. Idempotent.
fn end_session(harness: &Harness, thread_id: &str, session_id: &str, outcome: &str) {
    harness.pending_prefix.lock().unwrap().remove(session_id);
    if let Some(mut session) = harness.acp_sessions.lock().unwrap().remove(session_id) {
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

/// Release every idle session on a thread, closing each `done`.
fn release_idle_sessions(harness: &Harness, thread_id: Option<&str>) {
    let idle: Vec<(String, String)> = harness
        .acp_sessions
        .lock()
        .unwrap()
        .values()
        .filter(|s| !s.is_busy() && thread_id.is_none_or(|t| s.thread_id == t))
        .map(|s| (s.id.clone(), s.thread_id.clone()))
        .collect();
    for (id, thread) in idle {
        end_session(harness, &thread, &id, "done");
    }
}

/// Called when the user leaves a thread. Sessions mid-turn keep running — that
/// is the whole point of concurrency; only idle ones are released.
#[tauri::command]
async fn leave_thread(app: tauri::AppHandle, thread_id: String) -> Res<()> {
    tokio::task::spawn_blocking(move || {
        let harness: tauri::State<'_, Harness> = app.state();
        release_idle_sessions(&harness, Some(&thread_id));
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
    .map_err(|e| e.to_string())?
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
) -> Res<Message> {
    tokio::task::spawn_blocking(move || {
        let harness: tauri::State<'_, Harness> = app.state();
        // Recorded before the executor is resolved, deliberately: a chat-only
        // project still keeps the user's turn. There is no session to name yet.
        let message =
            store::append_message(&palisade_home(), &project_hash, &thread_id, "user", &mode, &content, None)?;
        // Name the thread after the turn that opened it, so "New thread" is
        // never what the user has to live with. Silent on failure: a title is
        // cosmetic and must not cost the user their message.
        let local = model_title(&harness, &content);
        let _ = store::set_auto_title(
            &palisade_home(),
            &project_hash,
            &thread_id,
            &content,
            local.as_deref(),
        );
        // Local model first (fast, free), the thread's own agent second, and
        // the truncated first line only as the last resort — which is what a
        // machine with no local model was getting every time. The agent call
        // is detached: a title is cosmetic and must never delay the turn.
        if local.is_none() {
            agent_title_later(&app, &project_hash, &thread_id, &content);
        }
        if selected_executor(&app, &harness, &project_hash, Some(&thread_id)).is_err() {
            // Chat-only mode: the turn is still recorded, nothing answers it.
            return Ok(message);
        }
        let id =
            ensure_session(&app, &harness, &project_hash, &thread_id, &mode, model, bypass)?;
        send_to(&harness, &project_hash, &id, &content)?;
        Ok(message)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// A thread title written by the bundled local model, or `None` if it isn't
/// up yet or didn't return anything usable.
///
/// Deliberately does *not* start the sidecar: this runs on the user's first
/// turn, and spawning a model to earn a nicer label would delay the message
/// they actually sent. If inline completion has the model warm, titles get
/// the good path; otherwise the caller trims the prompt instead.
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

fn model_title(harness: &Harness, prompt: &str) -> Option<String> {
    let server = harness.completion_server.lock().unwrap();
    let server = server.as_ref()?;
    if !server.is_alive() {
        return None;
    }
    server.title(prompt).ok()
}

/// Send one turn to a named live session, carrying any handoff transcript
/// parked on it by `ensure_session`. Draining here — rather than at each call
/// site — is what keeps a caller that starts a session without prompting
/// (`/go`) from silently discarding the conversation so far.
fn send_to(
    harness: &Harness,
    _project_hash: &str,
    session_id: &str,
    content: &str,
) -> Res<()> {
    let prefixed = harness.with_pending_prefix(session_id, content);
    {
        let sessions = harness.acp_sessions.lock().unwrap();
        let session = sessions.get(session_id).ok_or("executor session is not running")?;
        acp_client::send_acp_prompt(session, &prefixed)?;
    }
    harness.clear_pending_prefix(session_id);
    Ok(())
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
    .map_err(|e| e.to_string())?
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
) -> Res<ThreadMeta> {
    tokio::task::spawn_blocking(move || {
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
            let local = model_title(&harness, request);
            let _ = store::set_auto_title(
                &palisade_home(),
                &project_hash,
                &thread_id,
                request,
                local.as_deref(),
            );
            if local.is_none() {
                agent_title_later(&app, &project_hash, &thread_id, request);
            }
        }
        if let Some(prompt) = spec_mode_initial_prompt(&meta, &spec_type, request, start) {
            if preflight_for_harness(&*harness, true).selected.is_some() {
                let id =
                    ensure_session(&app, &harness, &project_hash, &thread_id, "spec", None, bypass)?;
                // The visible user message is what the user actually typed —
                // the skill instructions and the framing guidance go to the
                // agent but are not shown in the chat. Older threads framed
                // before a request was required fall back to the label.
                store::append_message(
                    &palisade_home(),
                    &project_hash,
                    &thread_id,
                    "user",
                    "spec",
                    request.unwrap_or(&spec_type),
                    Some(&id),
                )?;
                send_to(&harness, &project_hash, &id, &prompt)?;
            }
        }
        Ok(meta)
    })
    .await
    .map_err(|e| e.to_string())?
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
    .map_err(|e| e.to_string())?
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
    .map_err(|e| e.to_string())?
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
        // Nothing cached means no session has reached this agent yet this run.
        // A probe completes the same handshake, which is where the methods are
        // advertised — cheap, and only on the path that needs an answer.
        if acp_client::logins_for(&agent.id).is_empty() {
            if let Some(path) = agent.path.clone() {
                let _ = acp_client::probe_models(
                    agent.id.clone(),
                    agent.cmd.clone(),
                    PathBuf::from(path),
                    agent.args.clone(),
                    project_root(&project_hash)?,
                );
            }
        }
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
    .map_err(|e| e.to_string())?
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
        )
    })
    .await
    .map_err(|e| e.to_string())?
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
        let root = project_root(&project_hash)?;
        let id =
            ensure_session(&app, &harness, &project_hash, &thread_id, "spec", model, bypass)?;
        let prompt = grill_inject::build_prompt("spec", true, "grill-propose");

        *harness.pending_propose.lock().unwrap() = Some(executor::ProposeWatch {
            project_hash: project_hash.clone(),
            thread_id: thread_id.clone(),
            before: executor::openspec_changes(&harness.openspec_cache, &root),
            project_root: root,
        });

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
    .map_err(|e| e.to_string())?
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
fn commit_message_prompt(scope: &str, diff: &str) -> String {
    format!(
        "Write a git commit message for the {scope} diff below.\n\n\
         Rules:\n\
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

/// Draft a commit message from the staged diff via the project's executor.
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
        let server = harness.completion_server.lock().unwrap();
        let Some(server) = server.as_ref().filter(|s| s.is_alive()) else {
            return Ok(String::new());
        };
        Ok(server.commit_subject(&diff).unwrap_or_default())
    })
    .await
    .map_err(|e| e.to_string())?
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
        };
        acp_client::agent_oneshot(
            spawn,
            &commit_message_prompt(scope, &cap_diff(&diff)),
            std::time::Duration::from_secs(90),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Build the grill-apply prompt for a one-shot injection in spec-mode.
/// Per amended D19: grill-apply is UI-triggered, not mode-triggered. The
/// user clicks "Apply" after the proposal is complete; this builds the
/// prompt that goes to the agent.
fn apply_skill_prompt(change: &str) -> String {
    grill_inject::inject_skill(&grill_inject::GrillSkill::Apply, &format!("grill-apply {change}"))
}

/// `apply_skill`: UI-triggered one-shot grill-apply injection in spec-mode.
/// The user clicks "Apply" after the proposal artifacts are complete; this
/// starts (or reuses) a spec-mode session and sends the grill-apply prompt.
#[tauri::command]
async fn apply_skill(
    app: tauri::AppHandle,
    project_hash: String,
    thread_id: String,
    bypass: bool,
) -> Res<()> {
    tokio::task::spawn_blocking(move || {
        let harness: tauri::State<'_, Harness> = app.state();
        let meta = store::list_threads(&palisade_home(), &project_hash)?
            .into_iter()
            .find(|t| t.id == thread_id)
            .ok_or("thread not found")?;
        let change = meta
            .open_spec_change_name
            .ok_or("no open spec change — apply requires a proposal")?;
        let id =
            ensure_session(&app, &harness, &project_hash, &thread_id, "spec", None, bypass)?;
        let prompt = apply_skill_prompt(&change);
        // Persist only the short label — the skill content goes to the agent
        // but is not shown in the chat.
        store::append_message(
            &palisade_home(),
            &project_hash,
            &thread_id,
            "user",
            "spec",
            &format!("grill-apply {change}"),
            Some(&id),
        )?;
        send_to(&harness, &project_hash, &id, &prompt)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// `change_status`: whether a change's planning artifacts are all complete.
/// Returns `true` when `openspec status` reports `isComplete: true`, `false`
/// when it reports `false`, and `null` when `openspec` or the change is missing.
#[tauri::command]
async fn change_status(
    app: tauri::AppHandle,
    project_hash: String,
    change_name: String,
) -> Res<Option<bool>> {
    let cache = app.state::<Harness>().openspec_cache.clone();
    tokio::task::spawn_blocking(move || {
        let root = project_root(&project_hash)?;
        Ok(executor::openspec_change_status(&cache, &root, &change_name))
    })
    .await
    .map_err(|e| e.to_string())?
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
            .acp_sessions
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
            if let Some(watch) = harness.turn_watchers.lock().unwrap().get(&id).cloned() {
                watch.finish(executor::TurnEnd::Crashed("Cancelled by user".into()));
            }
            end_session(&harness, &thread_id, &id, "cancelled");
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
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
        if let Some(session) = harness.acp_sessions.lock().unwrap().get(&session_id) {
            session.answer_permission_prompt(&request_id, answer);
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Kill the hosted terminal behind one running tool call — the per-command
/// stop button (PLAN.md phase 4). Ends that process only; the session and
/// its turn survive. A missing session, or a tool call with no live hosted
/// terminal (an agent that ignores `terminal/*`), is a no-op — a stop
/// button only ever shows for a tool call that actually has one to kill.
#[tauri::command]
async fn kill_tool_terminal(
    app: tauri::AppHandle,
    session_id: String,
    tool_call_id: String,
) -> Res<()> {
    tokio::task::spawn_blocking(move || {
        let harness: tauri::State<'_, Harness> = app.state();
        if let Some(session) = harness.acp_sessions.lock().unwrap().get(&session_id) {
            session.kill_tool_terminal(&tool_call_id);
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
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

#[tauri::command]
async fn executor_status(app: tauri::AppHandle) -> Res<Vec<SessionStatus>> {
    tokio::task::spawn_blocking(move || {
        let harness: tauri::State<'_, Harness> = app.state();
        let mut statuses: Vec<SessionStatus> = harness
            .acp_sessions
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
    .map_err(|e| e.to_string())?
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
            let (added, removed) = git::diff_stat(&bin, &path).unwrap_or((0, 0));
            let base = thread
                .worktree_base_branch
                .clone()
                .or_else(|| git::current_branch_name(&bin, &root).ok())
                .unwrap_or_else(|| "HEAD".into());
            // A readiness probe must never fail the whole list: a repo git
            // can't answer for reports as "nothing to land", not as an error.
            let ready = git::merge_readiness(&bin, &root, &path, &base, &branch)
                .unwrap_or(git::MergeReadiness { ahead: 0, clean: true, mergeable: true });
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
                ahead: ready.ahead,
                clean: ready.clean,
                mergeable: ready.mergeable,
                state: state.into(),
                head: git::rev_parse_head(&bin, &path),
            });
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
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
        if !store::read_thread(&home, &project_hash, &thread_id)?.is_empty() {
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
    .map_err(|e| e.to_string())?
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
        let out = git::merge_into_base(&bin, &root, &base, &branch)?;
        if out.merged {
            let _ = store::set_thread_merged(&palisade_home(), &project_hash, &thread_id);
        }
        Ok(MergeResult {
            merged: out.merged,
            conflict_path: out.conflict_path.map(|p| p.to_string_lossy().into_owned()),
            conflict_branch: out.conflict_branch,
            detail: out.detail,
        })
    })
    .await
    .map_err(|e| e.to_string())?
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
        // A PR is a request to merge commits; a remote can only see pushed ones.
        git::push(&bin, &path)?;
        if let Some(gh) = executor::find_on_path("gh") {
            let out = std::process::Command::new(&gh)
                .args(["pr", "create", "--head", &branch, "--base", &base, "--fill"])
                .current_dir(&path)
                .env("PATH", executor::child_path_env())
                .output()
                .map_err(|err| format!("could not run gh: {err}"))?;
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
    .map_err(|e| e.to_string())?
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
        .ok_or_else(|| "This thread no longer exists.".to_string())?;
    let (Some(path), Some(branch)) = (meta.worktree_path, meta.worktree_branch) else {
        return Err(
            "This thread has no worktree of its own, so there is nothing separate to merge back."
                .into(),
        );
    };
    let base = meta
        .worktree_base_branch
        .or_else(|| git::current_branch_name(bin, root).ok())
        .ok_or_else(|| "Could not tell which branch to merge into.".to_string())?;
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
                ));
            }
        }
        git::remove_worktree(&bin, &root, &path, Some(&branch))?;
        store::clear_thread_worktree(&palisade_home(), &project_hash, &thread_id)?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
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
        let base = thread
            .worktree_base_branch
            .clone()
            .or_else(|| git::current_branch_name(&bin, &root).ok())
            .unwrap_or_else(|| "HEAD".into());
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
        let live: Vec<String> = harness.acp_sessions.lock().unwrap().keys().cloned().collect();
        store::close_stale_sessions(&palisade_home(), &project_hash, &thread_id, &live)
    })
    .await
    .map_err(|e| e.to_string())?
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
            return Err(format!("no verify command named `{name}` in .palisade/project-settings.json"));
        }

        std::thread::spawn(move || {
            let _ = record_verification(&app, &project_hash, &name, thread_id, session_id);
        });
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
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
    let (settings, _) = settings::load(&root);
    // `-dirty` follows git-describe: a run against an uncommitted tree
    // cannot claim the commit it started from, or the evidence is a lie.
    let head = git_bin().ok().and_then(|bin| {
        let head = git::rev_parse_head(&bin, &root)?;
        Some(match git::porcelain_snapshot(&bin, &root).is_empty() {
            true => head,
            false => format!("{head}-dirty"),
        })
    });
    let run = match settings::run_verify(&settings, &root, name) {
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
            output_tail: message,
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
        .map_err(|e| e.to_string())?
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
        .map_err(|e| e.to_string())?
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
                        detail: Some(err),
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
        .map_err(|e| e.to_string())?
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
        .map_err(|e| e.to_string())?
}

/// Kills every server for a project — the frontend calls this on project
/// switch so nothing is left running against a directory nobody has open.
#[tauri::command]
async fn lsp_shutdown(app: tauri::AppHandle, project_hash: String) -> Res<()> {
    let servers = app.state::<lsp::SharedLsp>().inner().clone();
    tokio::task::spawn_blocking(move || servers.shutdown_project(&project_hash))
        .await
        .map_err(|e| e.to_string())
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
    .map_err(|e| e.to_string())?
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
    .map_err(|e| e.to_string())?
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
    .map_err(|e| e.to_string())?
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
    .map_err(|e| e.to_string())?
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
        .map_err(|e| e.to_string())?
}

/// Writes a chain, keyed by its own `name`. Validation lives in
/// `chains::save`, so an ungated loop edge is refused here rather than at run
/// time (D3).
#[tauri::command]
async fn save_chain(project_hash: String, chain: chains::Chain) -> Res<()> {
    tokio::task::spawn_blocking(move || chains::save(&project_root(&project_hash)?, &chain))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn delete_chain(project_hash: String, name: String) -> Res<()> {
    tokio::task::spawn_blocking(move || chains::delete(&project_root(&project_hash)?, &name))
        .await
        .map_err(|e| e.to_string())?
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
    ))
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
    let run_id = ulid::Ulid::new().to_string();
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
        .map_err(|e| e.to_string())??
    };

    let id = run_id.clone();
    let summary_hash = project_hash.clone();
    tokio::task::spawn_blocking(move || {
        let budget = std::time::Duration::from_secs(chain.timeout_seconds);
        let mut runner = chain_exec::AcpNodeRunner::new(
            app.clone(),
            project_hash.clone(),
            thread_id.clone(),
            id.clone(),
            chain.clone(),
        );
        let mut gates = chain_exec::AcpGateEvaluator::new(
            app.clone(),
            project_hash,
            thread_id.clone(),
            id.clone(),
            chain.name.clone(),
            budget,
        );
        let mut run = chain_runner::ChainRun::new(id.clone(), chain.clone(), seed_input);
        let outcome = run.walk(&mut runner, &mut gates);
        runner.release();
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
            },
        );
    });
    Ok(run_id)
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
        other => return Err(format!("unknown gate decision `{other}`")),
    };
    let harness: tauri::State<'_, Harness> = app.state();
    let sender = harness
        .chain_gates
        .lock()
        .unwrap()
        .get(&run_id)
        .cloned()
        .ok_or("that chain run isn't waiting at an approval gate")?;
    sender.send(approval).map_err(|_| "that chain run is no longer listening".to_string())
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
    .map_err(|e| e.to_string())?
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
    .map_err(|e| e.to_string())?
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
    .map_err(|e| e.to_string())?
}

// --------------------------------------------------------------- completion

/// Starts the completion sidecar if it isn't already running.
fn start_completion_server(app: &tauri::AppHandle) -> Res<()> {
    let harness = app.state::<Harness>();
    let mut server_slot = harness.completion_server.lock().unwrap();
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
        ));
    }

    let server = completion::CompletionServer::default();
    if let Err(err) = server.spawn(&binary, &model) {
        return Err(format!("failed to start completion sidecar: {err}"));
    }
    *server_slot = Some(server);
    Ok(())
}

fn stop_completion_server(harness: &Harness) {
    if let Some(server) = harness.completion_server.lock().unwrap().take() {
        drop(server);
    }
    *harness.completion_crashes.lock().unwrap() = 0;
}

/// Ensures the completion sidecar is running before a request, applying the
/// one-restart-then-disable policy from D33.
fn ensure_completion_server(app: &tauri::AppHandle, harness: &Harness) -> Res<()> {
    let mut server_slot = harness.completion_server.lock().unwrap();

    if let Some(server) = server_slot.as_ref() {
        if server.is_alive() {
            return Ok(());
        }
    }

    *server_slot = None;

    let crashes = *harness.completion_crashes.lock().unwrap();
    if crashes >= 2 {
        return Err("AI completion is disabled because the sidecar crashed twice.".into());
    }

    let (binary, model) = completion::resolve_sidecar_paths(app)?;
    if !binary.exists() || !model.exists() {
        *harness.completion_crashes.lock().unwrap() = 2;
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
            *harness.completion_crashes.lock().unwrap() = 0;
            Ok(())
        }
        Err(err) => {
            *harness.completion_crashes.lock().unwrap() += 1;
            if *harness.completion_crashes.lock().unwrap() >= 2 {
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
        if !*harness.completion_enabled.lock().unwrap() {
            return Err("AI completion is disabled.".into());
        }

        ensure_completion_server(&app, &harness)?;

        let guard = harness.completion_server.lock().unwrap();
        let server = guard
            .as_ref()
            .ok_or("completion server is not running")?;
        server.complete(&file_path, &prefix, &suffix)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn set_completion_enabled(
    app: tauri::AppHandle,
    enabled: bool,
) -> Res<bool> {
    tokio::task::spawn_blocking(move || {
        let harness = app.state::<Harness>();
        *harness.completion_enabled.lock().unwrap() = enabled;
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
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn set_completion_keybinding(
    app: tauri::AppHandle,
    keybinding: String,
) -> Res<String> {
    tokio::task::spawn_blocking(move || {
        let harness = app.state::<Harness>();
        *harness.completion_keybinding.lock().unwrap() = keybinding.clone();
        Ok(keybinding)
    })
    .await
    .map_err(|e| e.to_string())?
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
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn save_mcp_server(project_hash: String, server: mcp::McpServer) -> Res<()> {
    tokio::task::spawn_blocking(move || mcp::save(&project_root(&project_hash)?, &server))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn remove_mcp_server(project_hash: String, name: String) -> Res<()> {
    tokio::task::spawn_blocking(move || mcp::remove(&project_root(&project_hash)?, &name))
        .await
        .map_err(|e| e.to_string())?
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
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn search_mcp_registry(
    query: String,
    limit: u32,
    cursor: Option<String>,
) -> Res<mcp::RegistryPage> {
    tokio::task::spawn_blocking(move || mcp::search_registry(&query, limit, cursor.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn flush_completion_telemetry(
    telemetry: completion::CompletionTelemetry,
) -> Res<()> {
    tokio::task::spawn_blocking(move || completion::flush_telemetry(&telemetry))
        .await
        .map_err(|e| e.to_string())?
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
            .preflight
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
    .map_err(|e| e.to_string())?
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
        let enabled = *harness.completion_enabled.lock().unwrap();
        let accept_keybinding = harness.completion_keybinding.lock().unwrap().clone();
        Ok(completion::CompletionSettings {
            enabled,
            accept_keybinding,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------- spec reference/// `None` when `openspec` isn't installed — "we can't tell", which is a/// Set the thread's spec link by hand — how the user resolves the ambiguity// ------------------------------------------------------------- graphify

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build());
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
            if let Err(err) = store::migrate_legacy_home(&palisade_home()) {
                eprintln!("store: {err}");
                let _ = app.emit("harness-warning", err);
            }
            let harness: tauri::State<'_, Harness> = app.state();
            if *harness.completion_enabled.lock().unwrap() {
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
                    *harness.completion_crashes.lock().unwrap() = 0;
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
            complete_code,
            set_completion_enabled,
            set_completion_keybinding,
            get_completion_settings,
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
            append_message,
            read_thread,
            preflight,
            send_message,
            go_mode,
            spec_mode,
            propose,
            draft_commit_message,
            suggest_commit_message,
            apply_skill,
            change_status,
            stop_executor,
            answer_permission_prompt,
            kill_tool_terminal,
            executor_status,
            list_sessions,
            thread_worktrees,
            merge_thread_worktree,
            open_thread_pr,
            prune_thread_worktree,
            set_thread_worktree_enabled,
            leave_thread,
            run_verify,
            list_verifications,
            verify_commands,
            lsp_start,
            lsp_send,
            lsp_status,
            lsp_install,
            lsp_install_command,
            lsp_shutdown,
            run_commands,
            save_run_commands,
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
            commands::graphify_cmds::run_graphify,
            commands::graphify_cmds::load_graphify,
            commands::graphify_cmds::query_graphify,
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
            run_chain,
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
                release_idle_sessions(&app.state::<Harness>(), None);
                let _ = app.state::<Harness>().session_log_writer.lock().unwrap().flush();
                stop_completion_server(&app.state::<Harness>());
                for (_, kernel) in app.state::<Harness>().notebook_kernels.lock().unwrap().drain() {
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
        assert!(commit_message_prompt("working-tree", "+x").contains("working-tree diff"));
        assert!(commit_message_prompt("staged", "+x").contains("staged diff"));
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
            graphify: true,
            ready: true,
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
            merged_at: None,
            worktree_enabled: true,
            title_source: "manual".into(),
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
            .pending_prefix
            .lock()
            .unwrap()
            .insert("s1".into(), "TRANSCRIPT".into());

        // What `send_to` hands the agent.
        assert_eq!(harness.with_pending_prefix("s1", "hello"), "TRANSCRIPT\n\nhello");
        // Still parked until the send succeeds — a failed send must not eat it.
        assert_eq!(harness.with_pending_prefix("s1", "retry"), "TRANSCRIPT\n\nretry");
        harness.clear_pending_prefix("s1");
        // Sent once, not re-sent on every later turn.
        assert_eq!(harness.with_pending_prefix("s1", "next"), "next");
        // A session with nothing parked is untouched.
        assert_eq!(harness.with_pending_prefix("s2", "plain"), "plain");
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
        harness.acp_sessions.lock().unwrap().insert(id.clone(), session);
        // What ensure_session parks when /go hands off to a new agent.
        harness
            .pending_prefix
            .lock()
            .unwrap()
            .insert(id.clone(), "This conversation was handed off. Transcript:\n\nUser: use notes_index.py".into());

        send_to(&harness, "p1", &id, "carry on").unwrap();

        let sent = match rx.try_recv().expect("a prompt reached the transport") {
            acp_client::BridgeCommand::Prompt(text) => text,
            _ => panic!("expected a prompt"),
        };
        assert!(sent.contains("notes_index.py"), "the transcript must ride along: {sent}");
        assert!(sent.ends_with("carry on"), "the user's turn must be last: {sent}");

        // …and only on that turn: once sent, it is no longer parked, so the
        // next turn goes out bare. (A second send here would be rejected as
        // mid-turn — that is `send_acp_prompt`'s busy guard, not this path.)
        assert!(
            harness.pending_prefix.lock().unwrap().is_empty(),
            "a delivered transcript must not be re-sent on the next turn"
        );
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
