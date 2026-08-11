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
mod integrations;
mod pidguard;
mod settings;
mod store;
mod terminal;
mod plugins;

use plugins::mac_rounded_corners;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::{Emitter, Manager};

use acp_preflight::Preflight;
use executor::{Envelope, ExecutorEvent, Harness, Sink};
use serde::{Deserialize, Serialize};
use store::{floo_home, Message, Project, Res, ThreadMeta};

#[derive(Debug, Clone, Serialize)]
struct DirEntry {
    name: String,
    is_dir: bool,
    path: String,
}

/// Resolves a project's root from the global index rather than trusting the
/// frontend — used by every command that reads/writes inside the project
/// filesystem (file editing, git, Graphify, format-on-save).
fn project_root(hash: &str) -> Res<PathBuf> {
    let home = floo_home();
    store::list_projects(&home)?
        .into_iter()
        .find(|p| p.hash == hash)
        .map(|p| PathBuf::from(p.root))
        .ok_or_else(|| format!("unknown project: {hash}"))
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
                let watch = harness.pending_propose.lock().unwrap().take();
                if let Some(watch) = watch {
                    let after = executor::openspec_changes(&watch.project_root);
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
            before: executor::openspec_changes(&root),
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
    project_hash: String,
    change_name: String,
) -> Res<Option<bool>> {
    tokio::task::spawn_blocking(move || {
        let root = project_root(&project_hash)?;
        Ok(executor::openspec_change_status(&root, &change_name))
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

// ---------------------------------------------------------- spec reference

/// Read-only. Every one of these asks the `openspec` CLI and renders what it
/// says; nothing here writes a spec file, and nothing here writes to
/// `~/.floo-network` (task 4.5). Floo's only durable spec state stays the one
/// reference string on `ThreadMeta`.
#[tauri::command]
async fn list_spec_changes(project_hash: String) -> Res<Vec<executor::SpecChange>> {
    tokio::task::spawn_blocking(move || Ok(executor::openspec_list(&project_root(&project_hash)?)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn show_spec_change(
    project_hash: String,
    name: String,
) -> Res<Option<serde_json::Value>> {
    tokio::task::spawn_blocking(move || {
        Ok(executor::openspec_show(&project_root(&project_hash)?, &name))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// `None` when `openspec` isn't installed — "we can't tell", which is a
/// different answer from "invalid" and must not be rendered as one.
#[tauri::command]
async fn validate_spec_changes(project_hash: String) -> Res<Option<bool>> {
    tokio::task::spawn_blocking(move || {
        Ok(executor::openspec_validate(&project_root(&project_hash)?))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn archive_spec_change(project_hash: String, name: String) -> Res<String> {
    tokio::task::spawn_blocking(move || {
        executor::openspec_archive(&project_root(&project_hash)?, &name)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Set the thread's spec link by hand — how the user resolves the ambiguity
/// `spec-link-ambiguous` reports.
#[tauri::command]
async fn set_spec_change(
    project_hash: String,
    thread_id: String,
    name: Option<String>,
) -> Res<ThreadMeta> {
    tokio::task::spawn_blocking(move || {
        store::set_open_spec_change(&floo_home(), &project_hash, &thread_id, name.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ------------------------------------------------------------- graphify

/// Where the `graphify` binary lives, or a readable error if it isn't there.
fn graphify_bin() -> Res<PathBuf> {
    executor::find_on_path("graphify")
        .ok_or_else(|| "`graphify` is not on PATH — install it to build code maps.".into())
}

/// Run Graphify over the active project (or a subdirectory of it). The
/// executor reaches this same graph directly via MCP tools (D9/D21) — this
/// command only serves the human-facing GraphPane, so its output is just
/// written to disk and returned, never injected into a thread.
#[tauri::command]
async fn run_graphify(
    project_hash: String,
    subpath: String,
    options: integrations::GraphifyOptions,
) -> Res<integrations::GraphifyRun> {
    tokio::task::spawn_blocking(move || {
        let root = project_root(&project_hash)?;
        // Graphify maps the active project, never the harness — and never
        // anywhere outside the project the user selected.
        let target = if subpath.trim().is_empty() {
            root.clone()
        } else {
            let joined = root.join(subpath.trim());
            let resolved = std::fs::canonicalize(&joined)
                .map_err(|err| format!("no such directory in this project: {} ({err})", joined.display()))?;
            if !resolved.starts_with(std::fs::canonicalize(&root).unwrap_or(root.clone())) {
                return Err("Graphify target must stay inside the active project.".into());
            }
            resolved
        };

        let out_dir = integrations::default_out_dir(&root);
        integrations::run_graphify(&graphify_bin()?, &target, &out_dir, &options)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Load a previous run's output without re-running the extract.
#[tauri::command]
async fn load_graphify(project_hash: String) -> Res<integrations::GraphifyRun> {
    tokio::task::spawn_blocking(move || {
        integrations::read_run(&integrations::default_out_dir(&project_root(&project_hash)?))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn query_graphify(
    project_hash: String,
    subcommand: String,
    args: Vec<String>,
) -> Res<String> {
    tokio::task::spawn_blocking(move || {
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        integrations::graphify_query(
            &graphify_bin()?,
            &subcommand,
            &refs,
            &integrations::default_out_dir(&project_root(&project_hash)?),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

// ------------------------------------------------------------- terminal

/// Ensures a PTY terminal is running for `project_hash`, spawning one if
/// none exists yet or the existing one belongs to a different (stale)
/// project. Already running for this project → no-op, so re-opening the
/// panel re-attaches to the same session (spec: "single terminal instance")
/// instead of spawning a second one.
#[tauri::command]
async fn terminal_spawn(
    app: tauri::AppHandle,
    project_hash: String,
) -> Res<Option<String>> {
    tokio::task::spawn_blocking(move || {
        let harness: tauri::State<'_, Harness> = app.state();
        // The display name of a project whose shell this call is about to kill.
        // Single terminal instance is deliberate (D-spec), but it used to happen
        // silently: a build or dev server running in another project's shell
        // died on project switch with nothing said about it.
        let replaced = {
            let existing = harness.terminal.lock().unwrap();
            match existing.as_ref() {
                Some((hash, _)) if hash == &project_hash => return Ok(None),
                Some((hash, _)) => store::list_projects(&floo_home())
                    .ok()
                    .and_then(|projects| {
                        projects
                            .into_iter()
                            .find(|p| &p.hash == hash)
                            .map(|p| p.display_name)
                    }),
                None => None,
            }
        };

        let root = project_root(&project_hash)?;
        let app_output = app.clone();
        let term = terminal::Terminal::spawn(&root, move |bytes| {
            use base64::prelude::*;
            let _ = app_output.emit("terminal-output", BASE64_STANDARD.encode(&bytes));
        })
        .map_err(|err| format!("start terminal: {err}"))?;
        // Assigning here drops the previous Terminal, whose Drop kills its shell.
        *harness.terminal.lock().unwrap() = Some((project_hash, term));
        Ok(replaced)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn terminal_input(app: tauri::AppHandle, data: String) -> Res<()> {
    tokio::task::spawn_blocking(move || {
        let harness: tauri::State<'_, Harness> = app.state();
        let guard = harness.terminal.lock().unwrap();
        let (_, term) = guard.as_ref().ok_or("no terminal running")?;
        term.write(data.as_bytes())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn terminal_resize(app: tauri::AppHandle, cols: u16, rows: u16) -> Res<()> {
    tokio::task::spawn_blocking(move || {
        let harness: tauri::State<'_, Harness> = app.state();
        let guard = harness.terminal.lock().unwrap();
        let (_, term) = guard.as_ref().ok_or("no terminal running")?;
        term.resize(cols, rows)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn terminal_kill(app: tauri::AppHandle) -> Res<()> {
    tokio::task::spawn_blocking(move || {
        let harness: tauri::State<'_, Harness> = app.state();
        *harness.terminal.lock().unwrap() = None;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ------------------------------------------------------------------- git

/// Where the `git` binary lives, or a readable error if it isn't there.
fn git_bin() -> Res<PathBuf> {
    executor::find_on_path("git").ok_or_else(|| "`git` is not on PATH.".into())
}

#[tauri::command]
async fn git_status(project_hash: String) -> Res<Vec<git::FileStatus>> {
    tokio::task::spawn_blocking(move || git::status(&git_bin()?, &project_root(&project_hash)?))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn git_working_diff(project_hash: String) -> Res<String> {
    tokio::task::spawn_blocking(move || {
        git::working_tree_diff(&git_bin()?, &project_root(&project_hash)?)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn git_staged_diff(project_hash: String) -> Res<String> {
    tokio::task::spawn_blocking(move || {
        git::staged_diff(&git_bin()?, &project_root(&project_hash)?)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn git_stage_hunk(project_hash: String, patch: String) -> Res<()> {
    tokio::task::spawn_blocking(move || {
        git::stage_hunk(&git_bin()?, &project_root(&project_hash)?, &patch)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn git_unstage_hunk(project_hash: String, patch: String) -> Res<()> {
    tokio::task::spawn_blocking(move || {
        git::unstage_hunk(&git_bin()?, &project_root(&project_hash)?, &patch)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn git_stage_file(project_hash: String, path: String) -> Res<()> {
    tokio::task::spawn_blocking(move || {
        git::stage_file(&git_bin()?, &project_root(&project_hash)?, &path)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn git_commit(project_hash: String, message: String) -> Res<()> {
    tokio::task::spawn_blocking(move || {
        git::commit(&git_bin()?, &project_root(&project_hash)?, &message)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn git_branches(project_hash: String) -> Res<Vec<git::BranchInfo>> {
    tokio::task::spawn_blocking(move || {
        git::list_branches(&git_bin()?, &project_root(&project_hash)?)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn git_checkout_branch(project_hash: String, name: String) -> Res<()> {
    tokio::task::spawn_blocking(move || {
        git::checkout_branch(&git_bin()?, &project_root(&project_hash)?, &name)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn git_create_branch(project_hash: String, name: String) -> Res<()> {
    tokio::task::spawn_blocking(move || {
        git::create_branch(&git_bin()?, &project_root(&project_hash)?, &name)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn git_delete_branch(project_hash: String, name: String) -> Res<()> {
    tokio::task::spawn_blocking(move || {
        git::delete_branch(&git_bin()?, &project_root(&project_hash)?, &name)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn git_fetch(project_hash: String) -> Res<()> {
    tokio::task::spawn_blocking(move || git::fetch(&git_bin()?, &project_root(&project_hash)?))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn git_pull(project_hash: String) -> Res<String> {
    tokio::task::spawn_blocking(move || git::pull(&git_bin()?, &project_root(&project_hash)?))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn git_push(project_hash: String) -> Res<String> {
    tokio::task::spawn_blocking(move || git::push(&git_bin()?, &project_root(&project_hash)?))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn git_ahead_behind(project_hash: String) -> Res<Option<(u32, u32)>> {
    tokio::task::spawn_blocking(move || {
        git::ahead_behind(&git_bin()?, &project_root(&project_hash)?)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn git_discard_file(project_hash: String, path: String, untracked: bool) -> Res<()> {
    tokio::task::spawn_blocking(move || {
        git::discard_file(&git_bin()?, &project_root(&project_hash)?, &path, untracked)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn git_is_repo(project_hash: String) -> Res<bool> {
    tokio::task::spawn_blocking(move || {
        Ok(git::is_git_repo(&git_bin()?, &project_root(&project_hash)?))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn git_init(project_hash: String) -> Res<()> {
    tokio::task::spawn_blocking(move || {
        git::init_repo(&git_bin()?, &project_root(&project_hash)?)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ------------------------------------------------------------- file tree

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
    name.starts_with('.') || name == "node_modules" || name == "target"
}

#[tauri::command]
async fn list_directory(
    project_hash: String,
    relative_path: String,
    include_hidden: bool,
) -> Res<Vec<DirEntry>> {
    tokio::task::spawn_blocking(move || {
        let root = project_root(&project_hash)?;
        let target = if relative_path.is_empty() {
            root.clone()
        } else {
            let joined = root.join(&relative_path);
            std::fs::canonicalize(&joined)
                .map_err(|err| format!("no such directory: {} ({err})", joined.display()))?
        };
        if !target.starts_with(&root) {
            return Err("path must stay inside the project".into());
        }
        let mut entries: Vec<DirEntry> = Vec::new();
        for entry in std::fs::read_dir(&target).map_err(|e| format!("cannot read directory: {e}"))? {
            let entry = entry.map_err(|e| format!("cannot read entry: {e}"))?;
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
    .map_err(|e| e.to_string())?
}

/// Recursive file listing for the fuzzy file-open palette (task 5.2). Applies
/// the same skip rules as `list_directory` (dotfiles, node_modules, target)
/// rather than a full `.gitignore` parser — matches what the tree already hides.
#[tauri::command]
async fn list_all_files(project_hash: String) -> Res<Vec<String>> {
    tokio::task::spawn_blocking(move || {
        let root = project_root(&project_hash)?;
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
                if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    stack.push(full);
                } else {
                    let rel = full
                        .strip_prefix(&root)
                        .unwrap_or(&full)
                        .to_string_lossy()
                        .to_string();
                    files.push(rel);
                }
            }
        }
        files.sort();
        Ok(files)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Debug, Clone, Serialize)]
struct TextMatch {
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
pub struct SearchOptions {
    pub regex: bool,
    pub case_sensitive: bool,
    pub whole_word: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TextSearchResult {
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
            .map_err(|err| format!("invalid search pattern: {err}"))
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
fn search_text_in(root: &Path, query: &str, options: SearchOptions) -> Res<TextSearchResult> {
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
async fn search_text(
    project_hash: String,
    query: String,
    options: Option<SearchOptions>,
) -> Res<TextSearchResult> {
    tokio::task::spawn_blocking(move || {
        let root = project_root(&project_hash)?;
        search_text_in(&root, &query, options.unwrap_or_default())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Resolves `relative_path` against `root`, requiring it to already exist
/// and stay inside the project.
fn resolve_existing_path(root: &Path, relative_path: &str) -> Res<PathBuf> {
    let target = root.join(relative_path);
    let resolved = std::fs::canonicalize(&target)
        .map_err(|err| format!("no such file: {} ({err})", target.display()))?;
    if !resolved.starts_with(root) {
        return Err("path must stay inside the project".into());
    }
    Ok(resolved)
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
fn looks_binary(path: &Path) -> bool {
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
async fn read_file_content(project_hash: String, relative_path: String) -> Res<String> {
    tokio::task::spawn_blocking(move || {
        let root = project_root(&project_hash)?;
        let resolved = resolve_existing_path(&root, &relative_path)?;

        let size = std::fs::metadata(&resolved)
            .map_err(|err| format!("cannot read file: {err}"))?
            .len();
        if size > MAX_EDITABLE_BYTES {
            return Err(format!("{TOO_LARGE_PREFIX} {size}"));
        }
        if looks_binary(&resolved) {
            return Err(BINARY_PREFIX.to_string());
        }

        std::fs::read_to_string(&resolved)
            .map_err(|err| format!("cannot read file: {err}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Reads a file as base64 for binary previews (images/video/gif) the editor
/// can't render as text.
#[tauri::command]
async fn read_file_base64(project_hash: String, relative_path: String) -> Res<String> {
    tokio::task::spawn_blocking(move || {
        use base64::prelude::*;
        let root = project_root(&project_hash)?;
        let resolved = resolve_existing_path(&root, &relative_path)?;
        let bytes = std::fs::read(&resolved).map_err(|err| format!("cannot read file: {err}"))?;
        Ok(BASE64_STANDARD.encode(&bytes))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Resolves `relative_path` against `root` for creating a file or directory
/// there — unlike `resolve_existing_path`, nothing (or only part of the
/// path) needs to exist yet. Rejects any `..` component outright (a
/// relative path with none can only ever join to somewhere under `root`),
/// then walks up to the nearest ancestor that *does* exist and canonicalizes
/// just that — catching a symlink escape planted partway down an existing
/// subtree — before creating whatever's missing beneath it.
fn resolve_creatable_path(root: &Path, relative_path: &str) -> Res<PathBuf> {
    let rel = Path::new(relative_path);
    if rel.is_absolute() || rel.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err("path must stay inside the project".into());
    }
    let target = root.join(rel);

    let mut existing = target.clone();
    while !existing.exists() {
        match existing.parent() {
            Some(parent) => existing = parent.to_path_buf(),
            None => break,
        }
    }
    let resolved_existing = std::fs::canonicalize(&existing)
        .map_err(|err| format!("cannot resolve {}: {err}", existing.display()))?;
    if !resolved_existing.starts_with(root) {
        return Err("path must stay inside the project".into());
    }

    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|err| format!("create directory: {err}"))?;
    }
    Ok(target)
}

/// Prefix on the error a stale save returns, so the frontend can tell "your
/// buffer is out of date" apart from a real write failure and offer to
/// reload instead of just reporting it.
pub(crate) const CONFLICT_PREFIX: &str = "CONFLICT:";

/// Saves the file (creating it, and any missing parent directories, if it
/// doesn't exist yet), then runs any matching `formatOnSave` command (D14)
/// and returns a summary of what it did — `None` when no pattern matched.
///
/// `expected_previous` is the content the caller believes is currently on
/// disk. When supplied and the file says otherwise, the write is refused —
/// the editor's backstop for a change that landed inside the filesystem
/// watcher's debounce window, where the reload banner wouldn't have appeared
/// yet. Callers that legitimately write blind (creating a file, seeding
/// `.project-settings.json`) pass `None` and are unaffected.
#[tauri::command]
async fn write_file_content(
    app: tauri::AppHandle,
    project_hash: String,
    relative_path: String,
    content: String,
    expected_previous: Option<String>,
) -> Res<Option<String>> {
    tokio::task::spawn_blocking(move || {
        let harness: tauri::State<'_, Harness> = app.state();
        let root = project_root(&project_hash)?;
        let resolved = resolve_creatable_path(&root, &relative_path)?;

        check_not_stale(&resolved, expected_previous.as_deref(), &relative_path)?;

        // Recorded before the write so the event can't beat us to the watcher.
        note_self_write(&harness, &resolved);
        std::fs::write(&resolved, content).map_err(|err| format!("cannot write file: {err}"))?;

        let (settings, _) = settings::load(&root);
        Ok(settings::run_format_on_save(&settings, &root, &relative_path))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Refuses a delete that would take the whole project with it. An empty
/// relative path resolves straight to the project root, and `delete_path`
/// recurses — nothing in the UI can ask for that, but this is a reachable
/// IPC command. Both sides are canonicalized so a symlinked project root
/// can't sneak past the comparison.
fn check_not_project_root(root: &Path, target: &Path) -> Res<()> {
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
fn check_not_stale(resolved: &Path, expected_previous: Option<&str>, relative_path: &str) -> Res<()> {
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
    ))
}

/// Tells the filesystem watcher that the change it's about to see is ours,
/// so a save doesn't come straight back as a "changed on disk" banner. A
/// no-op when no project is active or the watcher failed to start.
fn note_self_write(harness: &tauri::State<'_, Harness>, resolved: &Path) {
    if let Some(watcher) = harness.fswatch.lock().unwrap().as_ref() {
        watcher.note_self_write(resolved);
    }
}

/// Renames or moves a file or directory within the project (the file
/// palette's rename action — a full relative-path edit doubles as a move,
/// so this is also how "reorganize" works). Refuses to clobber an existing
/// file at the destination.
#[tauri::command]
async fn rename_path(
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
            return Err(format!("{to} already exists"));
        }
        note_self_write(&harness, &source);
        note_self_write(&harness, &target);
        std::fs::rename(&source, &target).map_err(|err| format!("rename: {err}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Deletes a file or directory (recursively) from the project.
#[tauri::command]
async fn delete_path(
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
            std::fs::remove_dir_all(&target).map_err(|err| format!("delete directory: {err}"))
        } else {
            std::fs::remove_file(&target).map_err(|err| format!("delete file: {err}"))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Creates a directory (and any missing parents) — the file tree's "New
/// Folder" action.
#[tauri::command]
async fn create_directory(project_hash: String, relative_path: String) -> Res<()> {
    tokio::task::spawn_blocking(move || {
        let root = project_root(&project_hash)?;
        let target = resolve_creatable_path(&root, &relative_path)?;
        std::fs::create_dir_all(&target).map_err(|err| format!("create directory: {err}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

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
            list_spec_changes,
            show_spec_change,
            validate_spec_changes,
            archive_spec_change,
            set_spec_change,
            run_graphify,
            load_graphify,
            query_graphify,
            terminal_spawn,
            terminal_input,
            terminal_resize,
            terminal_kill,
            git_status,
            git_working_diff,
            git_staged_diff,
            git_stage_hunk,
            git_unstage_hunk,
            git_stage_file,
            git_commit,
            git_branches,
            git_checkout_branch,
            git_create_branch,
            git_delete_branch,
            git_fetch,
            git_pull,
            git_push,
            git_ahead_behind,
            git_discard_file,
            git_is_repo,
            git_init,
            list_directory,
            list_all_files,
            search_text,
            read_file_content,
            read_file_base64,
            write_file_content,
            rename_path,
            delete_path,
            create_directory,
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
        // What the agent (or a git checkout) left behind, which is not what
        // the editor loaded.
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

        // Creating a file and seeding .project-settings.json both go this
        // way — they must not start failing now that the check exists.
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
        // What `delete_path(hash, "")` resolves to.
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

    /// Search with the defaults — case-insensitive substring, what the UI
    /// sends unless the user turns a toggle on.
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

        // Whole-word escapes the query, so "." stays a full stop rather
        // than becoming "any character".
        let found = with(&canonical_root, "a.b", SearchOptions { whole_word: true, ..Default::default() });
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].text, "a.b");
    }

    #[test]
    fn a_malformed_regex_reports_an_error_instead_of_panicking() {
        let root = tempfile::tempdir().unwrap();
        let canonical_root = std::fs::canonicalize(root.path()).unwrap();
        std::fs::write(canonical_root.join("a.txt"), "anything\n").unwrap();

        // What the user has on screen halfway through typing "(foo)".
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

        // Exercises the same resolution rename_path/delete_path use, without
        // going through project_root()'s real ~/.floo-network index lookup.
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

    #[tokio::test]
    async fn list_projects_command_returns_ok_when_index_missing() {
        let result = list_projects().await;
        assert!(result.is_ok());
    }
}
