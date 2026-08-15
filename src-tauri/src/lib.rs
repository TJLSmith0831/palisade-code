mod acp_client;
mod acp_events;
mod acp_preflight;
mod acp_registry;
mod completion;
mod executor;
mod grill_inject;
mod handoff;
mod permissions;
mod fswatch;
mod git;
mod git_repo;
mod integrations;
mod lsp;
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
use serde::Serialize;
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

/// Amendment 8's Clone Repository card: clone, then register the result as
/// a project in one step.
#[tauri::command]
async fn clone_repository(url: String, parent: String) -> Res<Project> {
    tokio::task::spawn_blocking(move || {
        let target = git::clone(&git_bin()?, &url, Path::new(&parent))?;
        store::add_project(&floo_home(), &target)
    })
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
async fn set_thread_archived(
    project_hash: String,
    thread_id: String,
    archived: bool,
) -> Res<store::ThreadMeta> {
    tokio::task::spawn_blocking(move || {
        store::set_thread_archived(&floo_home(), &project_hash, &thread_id, archived)
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
            &floo_home(),
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

        match &envelope_ref.event {
            ExecutorEvent::Crashed { .. } => {
                end_session(&self.app.state::<Harness>(), &thread_id, &envelope_ref.session_id, "crashed");
                let _ = executor::on_crash(&floo_home(), &self.project_hash, &thread_id);
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
        let reinjection = thread_meta(project_hash, thread_id)
            .and_then(|m| spec_type_reinjection(&m));
        let prefix = match (reinjection, transcript_prefix) {
            (Some(reinjection), Some(tp)) => Some(format!("{reinjection}\n\n{tp}")),
            (Some(reinjection), None) => Some(reinjection),
            (None, tp) => tp,
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

/// Wrap the spec_type in a sentence so the agent knows it is the starting
/// concept, not just an unexplained topic like "Feature" or "Bugfix".
fn framed_spec_body(spec_type: &str) -> String {
    let trimmed = spec_type.trim();
    if trimmed.is_empty() {
        "Start exploring.".to_string()
    } else {
        format!("Start exploring the following concept: {trimmed}")
    }
}

/// Per D12: on agent handoff (transcript rebuilt with 100k budget), re-inject
/// the stored `spec_type` as the first turn body if the thread has a spec_type
/// and no open change. Returns the grill-explore skill + spec_type prompt to
/// prepend to the handoff prefix. None when conditions aren't met — and
/// `ensure_session` only calls this in the handoff path (same-agent restart
/// returns None prefix, so no reinjection happens there).
fn spec_type_reinjection(meta: &store::ThreadMeta) -> Option<String> {
    match (&meta.spec_type, &meta.open_spec_change_name) {
        (Some(spec_type), None) => Some(grill_inject::build_prompt("spec", false, &framed_spec_body(spec_type))),
        _ => None,
    }
}

/// Decide what initial prompt (if any) to send when entering spec-mode.
/// Per amended D19: spec-mode with no open change auto-fires grill-explore.
/// Per D5: `spec_type` is the user turn body (replacing the bare "grill-explore"
/// literal). Per D10: when an existing change is open, spec_type is silently
/// dropped — no auto-injection, the user is past explore.
fn spec_mode_initial_prompt(meta: &store::ThreadMeta, spec_type: &str) -> Option<String> {
    if meta.open_spec_change_name.is_none() {
        Some(grill_inject::build_prompt("spec", false, &framed_spec_body(spec_type)))
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
    spec_type: String,
    bypass: bool,
) -> Res<ThreadMeta> {
    tokio::task::spawn_blocking(move || {
        let harness: tauri::State<'_, Harness> = app.state();
        let meta = store::set_thread_mode(&floo_home(), &project_hash, &thread_id, "spec")?;
        // Persist the spec_type framing on the thread (D11) — survives restarts
        // and is re-injected on agent handoff (D12). Only stored when the user
        // commits to a spec type (non-empty).
        let meta = if spec_type.trim().is_empty() {
            meta
        } else {
            store::set_spec_type(&floo_home(), &project_hash, &thread_id, &spec_type)?
        };
        if let Some(prompt) = spec_mode_initial_prompt(&meta, &spec_type) {
            if preflight_for_harness(&*harness, true).selected.is_some() {
                let (id, handoff) =
                    ensure_session(&app, &harness, &project_hash, &thread_id, "spec", None, bypass)?;
                let full_prompt = match handoff {
                    Some(prefix) => format!("{prefix}\n\n{prompt}"),
                    None => prompt,
                };
                // Persist only the spec type as the visible user message —
                // the skill instructions are sent to the agent but not shown
                // in the chat. The user sees "Feature" (or "Bugfix", etc.),
                // not the entire grill-explore skill content.
                store::append_message(
                    &floo_home(),
                    &project_hash,
                    &thread_id,
                    "user",
                    "spec",
                    &spec_type,
                    Some(&id),
                )?;
                send_to(&app, &harness, &project_hash, &id, &full_prompt)?;
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
        acp_client::probe_models(PathBuf::from(path), agent.args.clone(), root)
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
        let (id, handoff) =
            ensure_session(&app, &harness, &project_hash, &thread_id, "spec", model, bypass)?;
        let prompt = grill_inject::build_prompt("spec", true, "grill-propose");
        let full_prompt = match handoff {
            Some(prefix) => format!("{prefix}\n\n{prompt}"),
            None => prompt,
        };

        *harness.pending_propose.lock().unwrap() = Some(executor::ProposeWatch {
            project_hash: project_hash.clone(),
            thread_id: thread_id.clone(),
            before: executor::openspec_changes(&harness.openspec_cache, &root),
            project_root: root,
        });

        // Persist only the short label — the skill content goes to the agent
        // but is not shown in the chat.
        store::append_message(
            &floo_home(),
            &project_hash,
            &thread_id,
            "user",
            "spec",
            "grill-propose",
            Some(&id),
        )?;
        send_to(&app, &harness, &project_hash, &id, &full_prompt)
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
#[tauri::command]
async fn draft_commit_message(
    app: tauri::AppHandle,
    project_hash: String,
    thread_id: Option<String>,
) -> Res<String> {
    tokio::task::spawn_blocking(move || {
        let harness: tauri::State<'_, Harness> = app.state();
        let root = project_root(&project_hash)?;
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
            floo_home: floo_home(),
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
        let full_prompt = match handoff {
            Some(prefix) => format!("{prefix}\n\n{prompt}"),
            None => prompt,
        };
        // Persist only the short label — the skill content goes to the agent
        // but is not shown in the chat.
        store::append_message(
            &floo_home(),
            &project_hash,
            &thread_id,
            "user",
            "spec",
            &format!("grill-apply {change}"),
            Some(&id),
        )?;
        send_to(&app, &harness, &project_hash, &id, &full_prompt)
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
            // Emit a Crashed event so the frontend's event listener clears
            // the busy state. Without this, the UI stays stuck on "busy"
            // because end_session terminates the bridge before the prompt
            // response can arrive.
            let envelope = executor::Envelope {
                session_id: id.clone(),
                thread_id: thread_id.clone(),
                event: executor::ExecutorEvent::Crashed {
                    exit_code: None,
                    message: "Cancelled by user".into(),
                },
            };
            let _ = app.emit("executor-event", &envelope);
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

/// The install command Floo would run for `language`, or None when it knows
/// none or the tool that would run it isn't on this machine. The status bar
/// uses this to decide whether to offer the button at all.
#[tauri::command]
async fn lsp_install_command(language: String) -> Res<Option<String>> {
    Ok(lsp::install_command(&language).map(|argv| argv.join(" ")))
}

/// Install the language server for `language` on the user's say-so, using the
/// toolchain already on the machine. Floo still bundles nothing (D6) — this
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

#[tauri::command]
async fn flush_completion_telemetry(
    telemetry: completion::CompletionTelemetry,
) -> Res<()> {
    tokio::task::spawn_blocking(move || completion::flush_telemetry(&telemetry))
        .await
        .map_err(|e| e.to_string())?
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
        .setup(|app| {
            let harness: tauri::State<'_, Harness> = app.state();
            if *harness.completion_enabled.lock().unwrap() {
                let handle = app.handle();
                if let Err(err) = start_completion_server(&handle) {
                    eprintln!("completion: {err}");
                    let _ = app.emit("harness-warning", err);
                }
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
            flush_completion_telemetry,
            list_projects,
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
            apply_skill,
            change_status,
            stop_executor,
            executor_status,
            list_sessions,
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
            detect_run_commands,
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
            commands::git_cmds::git_unstage_file,
            commands::git_cmds::git_commit,
            commands::git_cmds::git_log,
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
                stop_completion_server(&app.state::<Harness>());
            }
        });
}

/// D22: The marker the agent emits when exploration is change-shaped and
/// the agent is ready to move to the proposal phase. Floo strips it from
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
        }
    }

    /// RED→GREEN 6a.1: spec-mode with no change auto-fires grill-explore.
    /// Amended by D5: the spec_type is the user turn body, not "grill-explore".
    #[test]
    fn spec_mode_initial_prompt_with_no_change_uses_spec_type_as_body() {
        let meta = thread_meta(None);
        let prompt = spec_mode_initial_prompt(&meta, "Feature").unwrap();
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

    /// RED→GREEN 6a.1: spec-mode with an existing change does NOT auto-inject.
    /// Amended by D10: spec_type is silently ignored when a change exists.
    #[test]
    fn spec_mode_initial_prompt_with_change_is_none() {
        let meta = thread_meta(Some("my-change"));
        assert!(spec_mode_initial_prompt(&meta, "Feature").is_none());
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
        let reinjection = spec_type_reinjection(&meta).unwrap();
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

    /// RED→GREEN D12: on same-agent restart (no handoff), `ensure_session`
    /// returns None prefix — no reinjection. The pure function also returns
    /// None when a change is open, so even if called it wouldn't inject.
    #[test]
    fn spec_type_reinjection_with_open_change_is_none() {
        let meta = thread_meta_with_spec_type(Some("my-change"), Some("Feature"));
        assert_eq!(spec_type_reinjection(&meta), None);
    }

    /// RED→GREEN D12: no stored spec_type → no reinjection (nothing to re-inject).
    #[test]
    fn spec_type_reinjection_without_stored_type_is_none() {
        let meta = thread_meta_with_spec_type(None, None);
        assert_eq!(spec_type_reinjection(&meta), None);
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
