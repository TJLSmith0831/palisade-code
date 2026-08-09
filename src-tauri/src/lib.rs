mod executor;
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

use executor::{ExecutorEvent, Harness, Kind, Preflight, Sink, Spawn};
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
fn list_projects() -> Res<Vec<Project>> {
    store::list_projects(&floo_home())
}

#[tauri::command]
fn add_project(path: String) -> Res<Project> {
    store::add_project(&floo_home(), Path::new(&path))
}

#[tauri::command]
fn switch_project(app: tauri::AppHandle, harness: tauri::State<'_, Harness>, hash: String) -> Res<Project> {
    let project = store::touch_project(&floo_home(), &hash)?;
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
    let Ok((kind, _)) = selected_executor(app, harness, &project.hash) else {
        return;
    };

    let root = PathBuf::from(&project.root);
    let graph_path = integrations::default_out_dir(&root).join("graph.json");
    let result = match kind {
        Kind::Claude => integrations::ensure_claude_mcp(&root, &bin, &graph_path),
        Kind::Codex => {
            integrations::ensure_codex_mcp(&root, &bin, &graph_path, &executor::home().join(".codex"))
        }
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
fn rename_project(hash: String, display_name: String) -> Res<Project> {
    store::rename_project(&floo_home(), &hash, &display_name)
}

#[tauri::command]
fn create_thread(project_hash: String, title: String) -> Res<ThreadMeta> {
    store::create_thread(&floo_home(), &project_hash, &title)
}

#[tauri::command]
fn list_threads(project_hash: String) -> Res<Vec<ThreadMeta>> {
    store::list_threads(&floo_home(), &project_hash)
}

#[tauri::command]
fn rename_thread(project_hash: String, thread_id: String, title: String) -> Res<ThreadMeta> {
    store::rename_thread(&floo_home(), &project_hash, &thread_id, &title)
}

#[tauri::command]
fn set_thread_mode(project_hash: String, thread_id: String, mode: String) -> Res<ThreadMeta> {
    store::set_thread_mode(&floo_home(), &project_hash, &thread_id, &mode)
}

/// Refused while this thread has an executor turn in flight — deleting the
/// files a live turn is about to append to would corrupt or orphan state.
#[tauri::command]
fn delete_thread(harness: tauri::State<'_, Harness>, project_hash: String, thread_id: String) -> Res<()> {
    let busy = harness
        .session
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|s| s.thread_id == thread_id && s.is_busy());
    if busy {
        return Err("This thread has a turn in progress — wait for it to finish before deleting.".into());
    }
    store::delete_thread(&floo_home(), &project_hash, &thread_id)
}

#[tauri::command]
fn append_message(
    project_hash: String,
    thread_id: String,
    role: String,
    mode: String,
    content: String,
) -> Res<Message> {
    store::append_message(&floo_home(), &project_hash, &thread_id, &role, &mode, &content)
}

#[tauri::command]
fn read_thread(project_hash: String, thread_id: String) -> Res<Vec<Message>> {
    store::read_thread(&floo_home(), &project_hash, &thread_id)
}

// ------------------------------------------------------- executor handoff

/// Forwards parsed executor events to the webview, and owns the two reactions
/// that must happen no matter which adapter produced them: a crash reverts the
/// thread to spec-mode, and a finished `/propose` turn records its new change.
struct AppSink {
    app: tauri::AppHandle,
    project_hash: String,
    thread_id: String,
}

impl Sink for AppSink {
    fn emit(&self, event: &ExecutorEvent) {
        let _ = self.app.emit("executor-event", event);

        match event {
            ExecutorEvent::Crashed { .. } => {
                let _ = executor::on_crash(&floo_home(), &self.project_hash, &self.thread_id);
                let _ = self.app.emit("thread-updated", &self.thread_id);
            }
            ExecutorEvent::Done => {
                let harness = self.app.state::<Harness>();
                let watch = harness.pending_propose.lock().unwrap().take();
                if let Some(watch) = watch {
                    let after = executor::openspec_changes(&watch.project_root);
                    if let Some(name) = executor::newly_added_change(&watch.before, &after) {
                        let _ = store::set_open_spec_change(
                            &floo_home(),
                            &watch.project_hash,
                            &watch.thread_id,
                            Some(&name),
                        );
                        let _ = self.app.emit("thread-updated", &watch.thread_id);
                    }
                }
            }
            _ => {}
        }
    }
}

fn sink_for(app: &tauri::AppHandle, project_hash: &str, thread_id: &str) -> Arc<dyn Sink> {
    Arc::new(AppSink {
        app: app.clone(),
        project_hash: project_hash.to_string(),
        thread_id: thread_id.to_string(),
    })
}

/// Cached at startup; re-checked when the caller says the cache may be stale
/// (the `/go` path does exactly that before committing to a handoff).
#[tauri::command]
fn preflight(harness: tauri::State<'_, Harness>, refresh: bool) -> Preflight {
    let mut cached = harness.preflight.lock().unwrap();
    if refresh || cached.is_none() {
        *cached = Some(executor::preflight());
    }
    cached.clone().expect("preflight just populated")
}

/// Pure decision: which executor a project should use, given a preflight
/// snapshot and an optional `project-settings.json` override (D15). Only
/// errors when nothing is usable at all — no override, and auto-detection
/// found neither executor. An override naming an executor that isn't
/// installed doesn't error; it falls back to auto-detection and returns a
/// warning for the caller to surface, rather than leaving the project in
/// chat-only mode.
fn resolve_executor(flight: &Preflight, override_kind: Option<Kind>) -> Res<(Kind, Option<String>)> {
    let auto = || flight.selected.ok_or("No executor found on PATH — chat-only mode.".to_string());
    match override_kind {
        Some(wanted) => {
            let installed = match wanted {
                Kind::Claude => flight.claude.is_some(),
                Kind::Codex => flight.codex.is_some(),
            };
            if installed {
                Ok((wanted, None))
            } else {
                let warning = format!(
                    "project-settings.json requests {wanted:?}, but it's not on PATH — falling back to auto-detection."
                );
                Ok((auto()?, Some(warning)))
            }
        }
        None => Ok((auto()?, None)),
    }
}

/// Resolves which executor a project uses and its binary path, applying
/// `resolve_executor`'s decision against the live preflight cache.
fn selected_executor(
    app: &tauri::AppHandle,
    harness: &tauri::State<'_, Harness>,
    project_hash: &str,
) -> Res<(Kind, PathBuf)> {
    let flight = {
        let mut cached = harness.preflight.lock().unwrap();
        if cached.is_none() {
            *cached = Some(executor::preflight());
        }
        cached.clone().expect("preflight just populated")
    };
    let override_kind = project_root(project_hash)
        .ok()
        .and_then(|root| settings::load(&root).0.executor_override);
    let (kind, warning) = resolve_executor(&flight, override_kind)?;
    if let Some(message) = warning {
        let _ = app.emit("harness-warning", message);
    }
    let path = match kind {
        Kind::Claude => flight.claude,
        Kind::Codex => flight.codex,
    };
    Ok((kind, PathBuf::from(path.ok_or("detected executor has no path")?)))
}

/// Start (or restart) the executor for a thread. `carry_forward` resumes the
/// existing conversation instead of beginning a new one.
fn ensure_session(
    app: &tauri::AppHandle,
    harness: &tauri::State<'_, Harness>,
    project_hash: &str,
    thread_id: &str,
    mode: &str,
    carry_forward: bool,
) -> Res<()> {
    let (kind, bin) = selected_executor(app, harness, project_hash)?;
    let mut slot = harness.session.lock().unwrap();

    let matches_thread = slot
        .as_ref()
        .is_some_and(|s| s.thread_id == thread_id && s.mode == mode && s.kind == kind);
    if matches_thread && !carry_forward {
        return Ok(());
    }

    // The live process is the first source of a session id, but it only
    // exists while the app has been running — after a restart the thread's
    // own sidecar is what lets /go still carry the conversation forward.
    let resume = if carry_forward {
        slot.as_ref().map(|s| s.session_id.clone()).or_else(|| {
            store::list_threads(&floo_home(), project_hash)
                .ok()?
                .into_iter()
                .find(|t| t.id == thread_id)?
                .executor_session_id
        })
    } else {
        None
    };
    if let Some(mut previous) = slot.take() {
        previous.terminate();
    }

    let session = executor::start(
        Spawn {
            kind,
            bin,
            project_root: project_root(project_hash)?,
            project_hash,
            thread_id,
            mode,
            resume,
            floo_home: floo_home(),
        },
        sink_for(app, project_hash, thread_id),
    )?;
    let _ = store::set_executor_session(&floo_home(), project_hash, thread_id, Some(&session.session_id));
    *slot = Some(session);
    Ok(())
}

/// Record the user's turn, then forward it to the executor if one is live.
#[tauri::command]
fn send_message(
    app: tauri::AppHandle,
    harness: tauri::State<'_, Harness>,
    project_hash: String,
    thread_id: String,
    content: String,
    mode: String,
) -> Res<Message> {
    let message = store::append_message(&floo_home(), &project_hash, &thread_id, "user", &mode, &content)?;
    if selected_executor(&app, &harness, &project_hash).is_err() {
        // Chat-only mode: the turn is still recorded, nothing answers it.
        return Ok(message);
    }
    ensure_session(&app, &harness, &project_hash, &thread_id, &mode, false)?;

    let sink = sink_for(&app, &project_hash, &thread_id);
    let mut slot = harness.session.lock().unwrap();
    let session = slot.as_mut().ok_or("executor session is not running")?;
    executor::send(session, sink, &content)?;
    Ok(message)
}

/// `/go`: terminate the spec-mode executor and bring the same conversation
/// back up write-enabled. Rejected while a turn is in flight.
#[tauri::command]
fn go_mode(
    app: tauri::AppHandle,
    harness: tauri::State<'_, Harness>,
    project_hash: String,
    thread_id: String,
) -> Res<ThreadMeta> {
    if harness.session.lock().unwrap().as_ref().is_some_and(|s| s.is_busy()) {
        return Err("The executor is mid-turn — wait for it to finish before switching modes.".into());
    }
    // A mid-session uninstall would otherwise only surface as a spawn failure.
    let flight = preflight(harness.clone(), true);
    if flight.selected.is_none() {
        return Err("No executor found on PATH — chat-only mode.".into());
    }

    let meta = store::set_thread_mode(&floo_home(), &project_hash, &thread_id, "go")?;
    ensure_session(&app, &harness, &project_hash, &thread_id, "go", true)?;

    // A thread that already has a proposal starts go-mode by applying it.
    if let Some(change) = meta.open_spec_change_name.clone() {
        let sink = sink_for(&app, &project_hash, &thread_id);
        let mut slot = harness.session.lock().unwrap();
        let session = slot.as_mut().ok_or("executor session is not running")?;
        let prompt = format!("{}grill-apply {}", session.kind.skill_prefix(), change);
        store::append_message(&floo_home(), &project_hash, &thread_id, "user", "go", &prompt)?;
        executor::send(session, sink, &prompt)?;
    }
    Ok(meta)
}

/// Switching back terminates the executor outright — never backgrounds it.
#[tauri::command]
fn spec_mode(
    harness: tauri::State<'_, Harness>,
    project_hash: String,
    thread_id: String,
) -> Res<ThreadMeta> {
    if harness.session.lock().unwrap().as_ref().is_some_and(|s| s.is_busy()) {
        return Err("The executor is mid-turn — wait for it to finish before switching modes.".into());
    }
    if let Some(mut session) = harness.session.lock().unwrap().take() {
        session.terminate();
    }
    store::set_thread_mode(&floo_home(), &project_hash, &thread_id, "spec")
}

/// `/propose`: run `grill-propose` in the live spec-mode executor and watch
/// the project's change directory so the new change name can be linked.
#[tauri::command]
fn propose(
    app: tauri::AppHandle,
    harness: tauri::State<'_, Harness>,
    project_hash: String,
    thread_id: String,
) -> Res<()> {
    let root = project_root(&project_hash)?;
    ensure_session(&app, &harness, &project_hash, &thread_id, "spec", false)?;

    let sink = sink_for(&app, &project_hash, &thread_id);
    let mut slot = harness.session.lock().unwrap();
    let session = slot.as_mut().ok_or("executor session is not running")?;
    let prompt = format!("{}grill-propose", session.kind.skill_prefix());

    *harness.pending_propose.lock().unwrap() = Some(executor::ProposeWatch {
        project_hash: project_hash.clone(),
        thread_id: thread_id.clone(),
        before: executor::openspec_changes(&root),
        project_root: root,
    });

    store::append_message(&floo_home(), &project_hash, &thread_id, "user", "spec", &prompt)?;
    executor::send(session, sink, &prompt)
}

#[tauri::command]
fn stop_executor(harness: tauri::State<'_, Harness>) {
    if let Some(mut session) = harness.session.lock().unwrap().take() {
        session.terminate();
    }
}

#[tauri::command]
fn executor_status(harness: tauri::State<'_, Harness>) -> Option<(String, bool)> {
    harness
        .session
        .lock()
        .unwrap()
        .as_ref()
        .map(|s| (s.thread_id.clone(), s.is_busy()))
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
fn run_graphify(
    project_hash: String,
    subpath: String,
    options: integrations::GraphifyOptions,
) -> Res<integrations::GraphifyRun> {
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
}

/// Load a previous run's output without re-running the extract.
#[tauri::command]
fn load_graphify(project_hash: String) -> Res<integrations::GraphifyRun> {
    integrations::read_run(&integrations::default_out_dir(&project_root(&project_hash)?))
}

#[tauri::command]
fn query_graphify(project_hash: String, subcommand: String, args: Vec<String>) -> Res<String> {
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    integrations::graphify_query(
        &graphify_bin()?,
        &subcommand,
        &refs,
        &integrations::default_out_dir(&project_root(&project_hash)?),
    )
}

// ------------------------------------------------------------- terminal

/// Ensures a PTY terminal is running for `project_hash`, spawning one if
/// none exists yet or the existing one belongs to a different (stale)
/// project. Already running for this project → no-op, so re-opening the
/// panel re-attaches to the same session (spec: "single terminal instance")
/// instead of spawning a second one.
#[tauri::command]
fn terminal_spawn(app: tauri::AppHandle, harness: tauri::State<'_, Harness>, project_hash: String) -> Res<()> {
    {
        let existing = harness.terminal.lock().unwrap();
        if existing.as_ref().is_some_and(|(hash, _)| hash == &project_hash) {
            return Ok(());
        }
    }
    let root = project_root(&project_hash)?;
    let app_output = app.clone();
    let term = terminal::Terminal::spawn(&root, move |bytes| {
        use base64::prelude::*;
        let _ = app_output.emit("terminal-output", BASE64_STANDARD.encode(&bytes));
    })
    .map_err(|err| format!("start terminal: {err}"))?;
    *harness.terminal.lock().unwrap() = Some((project_hash, term));
    Ok(())
}

#[tauri::command]
fn terminal_input(harness: tauri::State<'_, Harness>, data: String) -> Res<()> {
    let guard = harness.terminal.lock().unwrap();
    let (_, term) = guard.as_ref().ok_or("no terminal running")?;
    term.write(data.as_bytes())
}

#[tauri::command]
fn terminal_resize(harness: tauri::State<'_, Harness>, cols: u16, rows: u16) -> Res<()> {
    let guard = harness.terminal.lock().unwrap();
    let (_, term) = guard.as_ref().ok_or("no terminal running")?;
    term.resize(cols, rows)
}

#[tauri::command]
fn terminal_kill(harness: tauri::State<'_, Harness>) {
    *harness.terminal.lock().unwrap() = None;
}

// ------------------------------------------------------------------- git

/// Where the `git` binary lives, or a readable error if it isn't there.
fn git_bin() -> Res<PathBuf> {
    executor::find_on_path("git").ok_or_else(|| "`git` is not on PATH.".into())
}

#[tauri::command]
fn git_status(project_hash: String) -> Res<Vec<git::FileStatus>> {
    git::status(&git_bin()?, &project_root(&project_hash)?)
}

#[tauri::command]
fn git_working_diff(project_hash: String) -> Res<String> {
    git::working_tree_diff(&git_bin()?, &project_root(&project_hash)?)
}

#[tauri::command]
fn git_staged_diff(project_hash: String) -> Res<String> {
    git::staged_diff(&git_bin()?, &project_root(&project_hash)?)
}

#[tauri::command]
fn git_stage_hunk(project_hash: String, patch: String) -> Res<()> {
    git::stage_hunk(&git_bin()?, &project_root(&project_hash)?, &patch)
}

#[tauri::command]
fn git_unstage_hunk(project_hash: String, patch: String) -> Res<()> {
    git::unstage_hunk(&git_bin()?, &project_root(&project_hash)?, &patch)
}

#[tauri::command]
fn git_stage_file(project_hash: String, path: String) -> Res<()> {
    git::stage_file(&git_bin()?, &project_root(&project_hash)?, &path)
}

#[tauri::command]
fn git_commit(project_hash: String, message: String) -> Res<()> {
    git::commit(&git_bin()?, &project_root(&project_hash)?, &message)
}

#[tauri::command]
fn git_branches(project_hash: String) -> Res<Vec<git::BranchInfo>> {
    git::list_branches(&git_bin()?, &project_root(&project_hash)?)
}

#[tauri::command]
fn git_checkout_branch(project_hash: String, name: String) -> Res<()> {
    git::checkout_branch(&git_bin()?, &project_root(&project_hash)?, &name)
}

#[tauri::command]
fn git_create_branch(project_hash: String, name: String) -> Res<()> {
    git::create_branch(&git_bin()?, &project_root(&project_hash)?, &name)
}

#[tauri::command]
fn git_delete_branch(project_hash: String, name: String) -> Res<()> {
    git::delete_branch(&git_bin()?, &project_root(&project_hash)?, &name)
}

#[tauri::command]
fn git_fetch(project_hash: String) -> Res<()> {
    git::fetch(&git_bin()?, &project_root(&project_hash)?)
}

#[tauri::command]
fn git_pull(project_hash: String) -> Res<String> {
    git::pull(&git_bin()?, &project_root(&project_hash)?)
}

#[tauri::command]
fn git_push(project_hash: String) -> Res<String> {
    git::push(&git_bin()?, &project_root(&project_hash)?)
}

#[tauri::command]
fn git_ahead_behind(project_hash: String) -> Res<Option<(u32, u32)>> {
    git::ahead_behind(&git_bin()?, &project_root(&project_hash)?)
}

#[tauri::command]
fn git_discard_file(project_hash: String, path: String, untracked: bool) -> Res<()> {
    git::discard_file(&git_bin()?, &project_root(&project_hash)?, &path, untracked)
}

#[tauri::command]
fn git_is_repo(project_hash: String) -> Res<bool> {
    Ok(git::is_git_repo(&git_bin()?, &project_root(&project_hash)?))
}

#[tauri::command]
fn git_init(project_hash: String) -> Res<()> {
    git::init_repo(&git_bin()?, &project_root(&project_hash)?)
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
fn list_directory(project_hash: String, relative_path: String, include_hidden: bool) -> Res<Vec<DirEntry>> {
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
}

/// Recursive file listing for the fuzzy file-open palette (task 5.2). Applies
/// the same skip rules as `list_directory` (dotfiles, node_modules, target)
/// rather than a full `.gitignore` parser — matches what the tree already hides.
#[tauri::command]
fn list_all_files(project_hash: String) -> Res<Vec<String>> {
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
fn search_text(
    project_hash: String,
    query: String,
    options: Option<SearchOptions>,
) -> Res<TextSearchResult> {
    let root = project_root(&project_hash)?;
    search_text_in(&root, &query, options.unwrap_or_default())
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
fn read_file_content(project_hash: String, relative_path: String) -> Res<String> {
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
}

/// Reads a file as base64 for binary previews (images/video/gif) the editor
/// can't render as text.
#[tauri::command]
fn read_file_base64(project_hash: String, relative_path: String) -> Res<String> {
    use base64::prelude::*;
    let root = project_root(&project_hash)?;
    let resolved = resolve_existing_path(&root, &relative_path)?;
    let bytes = std::fs::read(&resolved).map_err(|err| format!("cannot read file: {err}"))?;
    Ok(BASE64_STANDARD.encode(&bytes))
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
fn write_file_content(
    harness: tauri::State<'_, Harness>,
    project_hash: String,
    relative_path: String,
    content: String,
    expected_previous: Option<String>,
) -> Res<Option<String>> {
    let root = project_root(&project_hash)?;
    let resolved = resolve_creatable_path(&root, &relative_path)?;

    check_not_stale(&resolved, expected_previous.as_deref(), &relative_path)?;

    // Recorded before the write so the event can't beat us to the watcher.
    note_self_write(&harness, &resolved);
    std::fs::write(&resolved, content).map_err(|err| format!("cannot write file: {err}"))?;

    let (settings, _) = settings::load(&root);
    Ok(settings::run_format_on_save(&settings, &root, &relative_path))
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
fn rename_path(
    harness: tauri::State<'_, Harness>,
    project_hash: String,
    from: String,
    to: String,
) -> Res<()> {
    let root = project_root(&project_hash)?;
    let source = resolve_existing_path(&root, &from)?;
    let target = resolve_creatable_path(&root, &to)?;
    if target.exists() {
        return Err(format!("{to} already exists"));
    }
    note_self_write(&harness, &source);
    note_self_write(&harness, &target);
    std::fs::rename(&source, &target).map_err(|err| format!("rename: {err}"))
}

/// Deletes a file or directory (recursively) from the project.
#[tauri::command]
fn delete_path(
    harness: tauri::State<'_, Harness>,
    project_hash: String,
    relative_path: String,
) -> Res<()> {
    let root = project_root(&project_hash)?;
    let target = resolve_existing_path(&root, &relative_path)?;
    check_not_project_root(&root, &target)?;
    note_self_write(&harness, &target);
    if target.is_dir() {
        std::fs::remove_dir_all(&target).map_err(|err| format!("delete directory: {err}"))
    } else {
        std::fs::remove_file(&target).map_err(|err| format!("delete file: {err}"))
    }
}

/// Creates a directory (and any missing parents) — the file tree's "New
/// Folder" action.
#[tauri::command]
fn create_directory(project_hash: String, relative_path: String) -> Res<()> {
    let root = project_root(&project_hash)?;
    let target = resolve_creatable_path(&root, &relative_path)?;
    std::fs::create_dir_all(&target).map_err(|err| format!("create directory: {err}"))
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
            delete_thread,
            append_message,
            read_thread,
            preflight,
            send_message,
            go_mode,
            spec_mode,
            propose,
            stop_executor,
            executor_status,
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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flight(claude: Option<&str>, codex: Option<&str>, selected: Option<Kind>) -> Preflight {
        Preflight {
            claude: claude.map(str::to_string),
            codex: codex.map(str::to_string),
            selected,
            openspec: true,
            grill_apply: true,
            ponytail: true,
            graphify: true,
            ready: true,
            warnings: vec![],
            checked_at: "2026-08-07T00:00:00Z".into(),
        }
    }

    #[test]
    fn no_override_uses_auto_detection() {
        let flight = flight(Some("/usr/bin/claude"), Some("/usr/bin/codex"), Some(Kind::Claude));
        let (kind, warning) = resolve_executor(&flight, None).unwrap();
        assert_eq!(kind, Kind::Claude);
        assert!(warning.is_none());
    }

    #[test]
    fn an_installed_override_wins_over_auto_detection() {
        // Claude wins auto-detection when both are present, but the override
        // must still be able to force Codex.
        let flight = flight(Some("/usr/bin/claude"), Some("/usr/bin/codex"), Some(Kind::Claude));
        let (kind, warning) = resolve_executor(&flight, Some(Kind::Codex)).unwrap();
        assert_eq!(kind, Kind::Codex);
        assert!(warning.is_none());
    }

    #[test]
    fn an_override_naming_an_uninstalled_executor_falls_back_and_warns() {
        let flight = flight(Some("/usr/bin/claude"), None, Some(Kind::Claude));
        let (kind, warning) = resolve_executor(&flight, Some(Kind::Codex)).unwrap();
        assert_eq!(kind, Kind::Claude, "must fall back to auto-detection, not error");
        assert!(warning.unwrap().contains("Codex"));
    }

    #[test]
    fn an_override_with_no_executors_installed_at_all_still_errors() {
        let flight = flight(None, None, None);
        assert!(resolve_executor(&flight, Some(Kind::Claude)).is_err());
    }

    #[test]
    fn no_override_and_nothing_installed_errors() {
        let flight = flight(None, None, None);
        let error = resolve_executor(&flight, None).unwrap_err();
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
}
