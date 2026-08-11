mod acp_client;
mod acp_events;
mod acp_preflight;
mod acp_registry;
mod executor;
mod grill_inject;
mod handoff;
mod permissions;
mod fswatch;
mod git;
mod git_repo;
mod integrations;
mod pidguard;
mod session_log_writer;
mod openspec_cache;
mod settings;
mod store;
mod terminal;
mod plugins;
mod commands;

use plugins::mac_rounded_corners;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::{Emitter, Manager};

use acp_preflight::Preflight;
use executor::{Envelope, ExecutorEvent, Harness, Sink};
use serde::{Deserialize, Serialize};
use store::{floo_home, Message, Project};
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
    let home = floo_home();
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
    tokio::task::spawn_blocking(|| store::list_projects(&floo_home()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn add_project(path: String) -> Res<Project> {
    tokio::task::spawn_blocking(move || store::add_project(&floo_home(), Path::new(&path)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn switch_project(app: tauri::AppHandle, hash: String) -> Res<Project> {
    tokio::task::spawn_blocking(move || {
        let project = store::touch_project(&floo_home(), &hash)?;
        let harness: tauri::State<'_, Harness> = app.state();
        start_watcher(&app, &harness, &project);
        start_fs_watcher(&app, &harness, &project);
        ensure_graphify_mcp(&app, &harness, &project);

        let root = Path::new(&project.root);
        // Auto-create .project-settings.json (D14/D15) so there's always a real
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
    let mut slot = harness.watch.lock().unwrap();
    *slot = None;

    let Some(bin) = executor::find_on_path("graphify") else {
        return;
    };

    let app_update = app.clone();
    let hash_update = project.hash.clone();
    let app_crash = app.clone();
    *slot = Some(integrations::Watcher::spawn(
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

/// Replaces whatever filesystem watcher was running with one scoped to the
/// newly active project (`FsWatcher`'s `Drop` stops the old one), so the
/// editor and file tree find out when the agent, a `git checkout`, or
/// another editor changes something underneath them. A watcher that can't
/// start surfaces once through `harness-warning` and leaves the app working
/// without reconciliation — the same degradation as a missing `graphify`.
fn start_fs_watcher(app: &tauri::AppHandle, harness: &tauri::State<'_, Harness>, project: &Project) {
    let mut slot = harness.fswatch.lock().unwrap();
    *slot = None;

    let app_change = app.clone();
    let hash_change = project.hash.clone();
    let app_crash = app.clone();
    *slot = Some(fswatch::FsWatcher::spawn(
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
async fn rename_project(hash: String, display_name: String) -> Res<Project> {
    tokio::task::spawn_blocking(move || store::rename_project(&floo_home(), &hash, &display_name))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn create_thread(project_hash: String, title: String) -> Res<ThreadMeta> {
    tokio::task::spawn_blocking(move || store::create_thread(&floo_home(), &project_hash, &title))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn list_threads(project_hash: String) -> Res<Vec<ThreadMeta>> {
    tokio::task::spawn_blocking(move || store::list_threads(&floo_home(), &project_hash))
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
        store::rename_thread(&floo_home(), &project_hash, &thread_id, &title)
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
        store::set_thread_mode(&floo_home(), &project_hash, &thread_id, &mode)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Refused while this thread has an executor turn in flight — deleting the
/// files a live turn is about to append to would corrupt or orphan state.
#[tauri::command]
async fn delete_thread(app: tauri::AppHandle, project_hash: String, thread_id: String) -> Res<()> {
    tokio::task::spawn_blocking(move || {
        let harness: tauri::State<'_, Harness> = app.state();
        if harness.thread_is_busy(&thread_id) {
            return Err(
                "This thread has a turn in progress — wait for it to finish before deleting.".into(),
            );
        }
        store::delete_thread(&floo_home(), &project_hash, &thread_id)
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
            &floo_home(),
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
    tokio::task::spawn_blocking(move || store::read_thread(&floo_home(), &project_hash, &thread_id))
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

/// Forwards parsed executor events to the webview, and owns the two reactions
/// that must happen no matter which adapter produced them: a crash reverts the
/// thread to spec-mode, and a finished `/propose` turn records its new change.
struct AppSink {
    app: tauri::AppHandle,
    project_hash: String,
}

impl Sink for AppSink {
    fn emit(&self, envelope: &Envelope) {
        let _ = self.app.emit("executor-event", envelope);

        // The thread these side effects belong to is the one the event came
        // from, not whichever thread the sink happened to be built for — with
        // concurrent sessions those stop being the same thing.
        let thread_id = &envelope.thread_id;

        // Durable copy: the thread's JSONL log is the source of truth once a
        // turn ends. persist() decides what lands (text, tool rows, crash
        // markers) and what stays live-only (deltas, Done).
        let mode = self
            .app
            .state::<Harness>()
            .acp_sessions
            .lock()
            .unwrap()
            .get(&envelope.session_id)
            .map(|s| s.mode.clone())
            .unwrap_or_else(|| "spec".to_string());
        executor::persist(
            &floo_home(),
            &self.project_hash,
            thread_id,
            &envelope.session_id,
            &mode,
            &envelope.event,
        );

        match &envelope.event {
            ExecutorEvent::Crashed { .. } => {
                end_session(&self.app.state::<Harness>(), thread_id, &envelope.session_id, "crashed");
                let _ = executor::on_crash(&floo_home(), &self.project_hash, thread_id);
                let _ = self.app.emit("thread-updated", thread_id);
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
                                &floo_home(),
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
            &store::floo_home(),
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
fn thread_meta(project_hash: &str, thread_id: &str) -> Option<store::ThreadMeta> {
    store::list_threads(&floo_home(), project_hash)
        .ok()?
        .into_iter()
        .find(|t| t.id == thread_id)
}

/// Resolves which agent a thread uses and its binary path. Selection order
/// (D9/D18): the thread's own picker choice, then the project's
/// `executorOverride`, then auto-detection (first installed agent).
fn selected_executor(
    app: &tauri::AppHandle,
    harness: &tauri::State<'_, Harness>,
    project_hash: &str,
    thread_id: Option<&str>,
) -> Res<(acp_preflight::AgentStatus, PathBuf)> {
    let flight = {
        let mut cached = harness.preflight.lock().unwrap();
        if cached.is_none() {
            *cached = Some(acp_preflight::preflight(
                &store::floo_home(),
                &|bin| executor::find_on_path(bin),
            ));
        }
        cached.clone().expect("preflight just populated")
    };
    let thread_override = thread_id.and_then(|id| thread_meta(project_hash, id)?.executor);
    let override_id = thread_override.or_else(|| {
        project_root(project_hash)
            .ok()
            .and_then(|root| settings::load(&root).0.executor_override)
    });
    let (agent, warning) = resolve_executor(&flight, override_id)?;
    if let Some(message) = warning {
        let _ = app.emit("harness-warning", message);
    }
    let path = agent.path.clone().ok_or("detected executor has no path")?;
    Ok((agent.clone(), PathBuf::from(path)))
}

/// The id of a live session on this thread running under `mode`, if any.
fn find_live_session(harness: &tauri::State<'_, Harness>, thread_id: &str, mode: &str) -> Option<String> {
    harness
        .acp_sessions
        .lock()
        .unwrap()
        .values()
        .find(|s| s.thread_id == thread_id && s.mode == mode)
        .map(|s| s.id.clone())
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
    let (agent, bin) = selected_executor(app, harness, project_hash, Some(thread_id))?;
    let agent_id = agent.id.clone();
    let home = floo_home();
    // The thread meta is the source of truth for the model choice; the IPC
    // `model` parameter is legacy and ignored (the frontend passes null).
    let model = thread_meta(project_hash, thread_id).and_then(|t| t.model);

    // ACP sessions don't use provider handles — each session is fresh.
    // Collision warning: Floo cannot stop two agents writing the same file.
    let collision = {
        let sessions = harness.acp_sessions.lock().unwrap();
        sessions
            .values()
            .find(|s| s.project_hash == project_hash)
            .map(|s| format!("{} session {} is already live in this project — concurrent edits are not coordinated; git is the arbiter.", s.agent_name, s.id))
    };
    if let Some(message) = collision {
        let _ = app.emit("harness-warning", message);
    }

    let root = project_root(project_hash)?;
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
        floo_home: home.clone(),
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
/// to the first prompt (D6/D7). The returned `Option` is that transcript
/// prefix, when a handoff happened.
fn ensure_session(
    app: &tauri::AppHandle,
    harness: &tauri::State<'_, Harness>,
    project_hash: &str,
    thread_id: &str,
    mode: &str,
    model: Option<String>,
    bypass: bool,
) -> Res<(String, Option<String>)> {
    let (agent, _) = selected_executor(app, harness, project_hash, Some(thread_id))?;
    if let Some(id) = find_live_session(harness, thread_id, mode) {
        let matches = harness
            .acp_sessions
            .lock()
            .unwrap()
            .get(&id)
            .is_some_and(|s| s.agent_id == agent.id);
        if matches {
            return Ok((id, None));
        }
        // Agent changed under a live session: hand off (D6). The transcript
        // budget is a fixed default until the new agent reports its context
        // window via usage_update (D8) — 100k tokens covers every current
        // agent's window conservatively enough for a text prefix.
        let turns: Vec<handoff::TranscriptTurn> = store::read_thread(
            &floo_home(),
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
        let prefix = if transcript.is_empty() {
            None
        } else {
            Some(format!(
                "This conversation was handed off from another agent. Transcript so far:\n\n{transcript}"
            ))
        };
        return Ok((new_id, prefix));
    }
    Ok((start_session(app, harness, project_hash, thread_id, mode, true, model, bypass)?, None))
}

/// Drop a session from the live map and close its record. Idempotent.
fn end_session(harness: &Harness, thread_id: &str, session_id: &str, outcome: &str) {
    if let Some(mut session) = harness.acp_sessions.lock().unwrap().remove(session_id) {
        session.terminate();
        let head_after = git_bin()
            .ok()
            .and_then(|bin| git::rev_parse_head(&bin, &session.project_root));
        let _ = store::close_session(
            &floo_home(),
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
            store::append_message(&floo_home(), &project_hash, &thread_id, "user", &mode, &content, None)?;
        if selected_executor(&app, &harness, &project_hash, Some(&thread_id)).is_err() {
            // Chat-only mode: the turn is still recorded, nothing answers it.
            return Ok(message);
        }
        let (id, handoff) =
            ensure_session(&app, &harness, &project_hash, &thread_id, &mode, model, bypass)?;
        let content = match handoff {
            Some(prefix) => format!("{prefix}\n\n{content}"),
            None => content,
        };
        send_to(&app, &harness, &project_hash, &id, &content)?;
        Ok(message)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Send one turn to a named live session.
fn send_to(
    _app: &tauri::AppHandle,
    harness: &tauri::State<'_, Harness>,
    _project_hash: &str,
    session_id: &str,
    content: &str,
) -> Res<()> {
    let sessions = harness.acp_sessions.lock().unwrap();
    let session = sessions.get(session_id).ok_or("executor session is not running")?;
    acp_client::send_acp_prompt(session, content)
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

        let meta = store::set_thread_mode(&floo_home(), &project_hash, &thread_id, "go")?;
        let _ = ensure_session(&app, &harness, &project_hash, &thread_id, "go", model, bypass)?;
        // Per amended D19: go-mode has no skill injection. The user toggles
        // go-mode to let the agent write code; grill-apply is a separate
        // UI-triggered one-shot in spec-mode.
        Ok(meta)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Decide what initial prompt (if any) to send when entering spec-mode.
/// Per amended D19: spec-mode with no open change auto-fires grill-explore.
/// With an existing change, the user is past explore — no auto-injection.
fn spec_mode_initial_prompt(meta: &store::ThreadMeta) -> Option<String> {
    if meta.open_spec_change_name.is_none() {
        Some(grill_inject::build_prompt("spec", false, "grill-explore"))
    } else {
        None
    }
}

/// Sets the thread's default mode back to spec. Under amended D19, entering
/// spec-mode with no open change auto-fires grill-explore — the first stage
/// of the explore → propose → apply progression. With an existing change,
/// it just sets the mode (the user is past explore).
#[tauri::command]
async fn spec_mode(
    app: tauri::AppHandle,
    project_hash: String,
    thread_id: String,
    bypass: bool,
) -> Res<ThreadMeta> {
    tokio::task::spawn_blocking(move || {
        let harness: tauri::State<'_, Harness> = app.state();
        let meta = store::set_thread_mode(&floo_home(), &project_hash, &thread_id, "spec")?;
        if let Some(prompt) = spec_mode_initial_prompt(&meta) {
            if preflight_for_harness(&*harness, true).selected.is_some() {
                let (id, handoff) =
                    ensure_session(&app, &harness, &project_hash, &thread_id, "spec", None, bypass)?;
                let prompt = match handoff {
                    Some(prefix) => format!("{prefix}\n\n{prompt}"),
                    None => prompt,
                };
                store::append_message(
                    &floo_home(),
                    &project_hash,
                    &thread_id,
                    "user",
                    "spec",
                    &prompt,
                    Some(&id),
                )?;
                send_to(&app, &harness, &project_hash, &id, &prompt)?;
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
            &floo_home(),
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
    project_hash: String,
    agent_id: String,
) -> Res<acp_client::ModelState> {
    tokio::task::spawn_blocking(move || {
        let harness: tauri::State<'_, Harness> = app.state();
        let flight = preflight_for_harness(&*harness, false);
        let agent = flight
            .agent(&agent_id)
            .ok_or_else(|| format!("unknown or unavailable agent `{agent_id}`"))?;
        let path = agent.path.clone().ok_or("agent has no path")?;
        let root = project_root(&project_hash)?;
        acp_client::probe_models(PathBuf::from(path), agent.args.clone(), root)
    })
    .await
    .map_err(|e| e.to_string())?
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
        let (id, handoff) =
            ensure_session(&app, &harness, &project_hash, &thread_id, "spec", model, bypass)?;
        let prompt = grill_inject::build_prompt("spec", true, "grill-propose");
        let prompt = match handoff {
            Some(prefix) => format!("{prefix}\n\n{prompt}"),
            None => prompt,
        };

        *harness.pending_propose.lock().unwrap() = Some(executor::ProposeWatch {
            project_hash: project_hash.clone(),
            thread_id: thread_id.clone(),
            before: executor::openspec_changes(&harness.openspec_cache, &root),
            project_root: root,
        });

        store::append_message(
            &floo_home(),
            &project_hash,
            &thread_id,
            "user",
            "spec",
            &prompt,
            Some(&id),
        )?;
        send_to(&app, &harness, &project_hash, &id, &prompt)
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
        let meta = store::list_threads(&floo_home(), &project_hash)?
            .into_iter()
            .find(|t| t.id == thread_id)
            .ok_or("thread not found")?;
        let change = meta
            .open_spec_change_name
            .ok_or("no open spec change — apply requires a proposal")?;
        let (id, handoff) =
            ensure_session(&app, &harness, &project_hash, &thread_id, "spec", None, bypass)?;
        let prompt = apply_skill_prompt(&change);
        let prompt = match handoff {
            Some(prefix) => format!("{prefix}\n\n{prompt}"),
            None => prompt,
        };
        store::append_message(
            &floo_home(),
            &project_hash,
            &thread_id,
            "user",
            "spec",
            &prompt,
            Some(&id),
        )?;
        send_to(&app, &harness, &project_hash, &id, &prompt)
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

/// Stop one session by id, or every live session when none is named.
#[tauri::command]
async fn stop_executor(app: tauri::AppHandle, session_id: Option<String>) -> Res<()> {
    tokio::task::spawn_blocking(move || {
        let harness: tauri::State<'_, Harness> = app.state();
        let targets: Vec<(String, String)> = harness
            .acp_sessions
            .lock()
            .unwrap()
            .values()
            .filter(|s| session_id.as_ref().is_none_or(|wanted| *wanted == s.id))
            .map(|s| (s.id.clone(), s.thread_id.clone()))
            .collect();
        for (id, thread_id) in targets {
            end_session(&harness, &thread_id, &id, "cancelled");
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
            })
            .collect();
        statuses.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(statuses)
    })
    .await
    .map_err(|e| e.to_string())?
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
        store::close_stale_sessions(&floo_home(), &project_hash, &thread_id, &live)
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
            return Err(format!("no verify command named `{name}` in .project-settings.json"));
        }

        std::thread::spawn(move || {
            let head = git_bin().ok().and_then(|bin| git::rev_parse_head(&bin, &root));
            let outcome = settings::run_verify(&settings, &root, &name);
            let run = match outcome {
                Ok(outcome) => store::VerificationRun {
                    id: ulid::Ulid::new().to_string(),
                    project_hash: project_hash.clone(),
                    thread_id,
                    session_id,
                    name,
                    command: outcome.command,
                    exit_code: outcome.exit_code,
                    output_tail: outcome.output_tail,
                    git_head: head,
                    at: chrono::Utc::now().to_rfc3339(),
                },
                // A command that couldn't start is a failed verification, not a
                // missing one — recording nothing would leave it looking untested.
                Err(message) => store::VerificationRun {
                    id: ulid::Ulid::new().to_string(),
                    project_hash: project_hash.clone(),
                    thread_id,
                    session_id,
                    name,
                    command: String::new(),
                    exit_code: -1,
                    output_tail: message,
                    git_head: head,
                    at: chrono::Utc::now().to_rfc3339(),
                },
            };
            let _ = store::append_verification(&floo_home(), &run);
            let _ = app.emit("verification-finished", &run);
        });
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn list_verifications(project_hash: String) -> Res<Vec<store::VerificationRun>> {
    tokio::task::spawn_blocking(move || store::read_verifications(&floo_home(), &project_hash))
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
        let home = floo_home();
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

// ---------------------------------------------------------- spec reference/// `None` when `openspec` isn't installed — "we can't tell", which is a/// Set the thread's spec link by hand — how the user resolves the ambiguity// ------------------------------------------------------------- graphify

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init());
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
        .manage(Harness::default())
        .invoke_handler(tauri::generate_handler![
            list_projects,
            add_project,
            switch_project,
            rename_project,
            create_thread,
            list_threads,
            rename_thread,
            set_thread_mode,
            set_thread_executor,
            list_models,
            delete_thread,
            append_message,
            read_thread,
            preflight,
            send_message,
            go_mode,
            spec_mode,
            propose,
            apply_skill,
            change_status,
            stop_executor,
            executor_status,
            list_sessions,
            leave_thread,
            run_verify,
            list_verifications,
            verify_commands,
            session_attribution,
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
            commands::git_cmds::git_status,
            commands::git_cmds::git_working_diff,
            commands::git_cmds::git_staged_diff,
            commands::git_cmds::git_stage_hunk,
            commands::git_cmds::git_unstage_hunk,
            commands::git_cmds::git_stage_file,
            commands::git_cmds::git_commit,
            commands::git_cmds::git_branches,
            commands::git_cmds::git_checkout_branch,
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
            mac_rounded_corners::enable_rounded_corners,
            mac_rounded_corners::enable_modern_window_style,
            mac_rounded_corners::reposition_traffic_lights,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            // No process survives the app, so leaving records open would make
            // every clean quit look like an interrupt on next launch (D20).
            if matches!(event, tauri::RunEvent::Exit) {
                release_idle_sessions(&app.state::<Harness>(), None);
                let _ = app.state::<Harness>().session_log_writer.lock().unwrap().flush();
            }
        });
}

#[cfg(test)]
mod tests {
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
        }
    }

    /// RED→GREEN 6a.1: spec-mode with no change auto-fires grill-explore.
    #[test]
    fn spec_mode_initial_prompt_with_no_change_injects_explore() {
        let meta = thread_meta(None);
        let prompt = spec_mode_initial_prompt(&meta).unwrap();
        assert!(prompt.contains("grill-explore"));
        assert!(prompt.contains("---"));
    }

    /// RED→GREEN 6a.1: spec-mode with an existing change does NOT auto-inject.
    #[test]
    fn spec_mode_initial_prompt_with_change_is_none() {
        let meta = thread_meta(Some("my-change"));
        assert!(spec_mode_initial_prompt(&meta).is_none());
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
}
