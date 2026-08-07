mod executor;
mod git;
mod integrations;
mod pidguard;
mod settings;
mod store;
mod terminal;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::{Emitter, Manager};

use executor::{ExecutorEvent, Harness, Kind, Preflight, Sink, Spawn};
use serde::Serialize;
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
/// can't drift on which dirs/files they hide.
fn should_skip_entry(name: &str) -> bool {
    name.starts_with('.') || name == "node_modules" || name == "target"
}

#[tauri::command]
fn list_directory(project_hash: String, relative_path: String) -> Res<Vec<DirEntry>> {
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
        if should_skip_entry(&name) {
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
            if should_skip_entry(&name) {
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

#[tauri::command]
fn read_file_content(project_hash: String, relative_path: String) -> Res<String> {
    let root = project_root(&project_hash)?;
    let target = root.join(&relative_path);
    let resolved = std::fs::canonicalize(&target)
        .map_err(|err| format!("no such file: {} ({err})", target.display()))?;
    if !resolved.starts_with(&root) {
        return Err("path must stay inside the project".into());
    }
    std::fs::read_to_string(&resolved)
        .map_err(|err| format!("cannot read file: {err}"))
}

/// Resolves `relative_path` against `root` for writing. Unlike reading, the
/// file itself may not exist yet (creating a new file is valid), so only
/// its *parent* directory — which must already exist — is canonicalized and
/// boundary-checked, not the file.
fn resolve_writable_path(root: &Path, relative_path: &str) -> Res<PathBuf> {
    let target = root.join(relative_path);
    let parent = target.parent().ok_or("invalid file path")?;
    let resolved_parent = std::fs::canonicalize(parent)
        .map_err(|err| format!("no such directory: {} ({err})", parent.display()))?;
    if !resolved_parent.starts_with(root) {
        return Err("path must stay inside the project".into());
    }
    let file_name = target.file_name().ok_or("invalid file path")?;
    Ok(resolved_parent.join(file_name))
}

/// Saves the file (creating it if it doesn't exist yet), then runs any
/// matching `formatOnSave` command (D14) and returns a summary of what it
/// did — `None` when no pattern matched.
#[tauri::command]
fn write_file_content(
    project_hash: String,
    relative_path: String,
    content: String,
) -> Res<Option<String>> {
    let root = project_root(&project_hash)?;
    let resolved = resolve_writable_path(&root, &relative_path)?;
    std::fs::write(&resolved, content).map_err(|err| format!("cannot write file: {err}"))?;

    let (settings, _) = settings::load(&root);
    Ok(settings::run_format_on_save(&settings, &root, &relative_path))
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
            read_file_content,
            write_file_content,
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
    fn resolve_writable_path_allows_creating_a_brand_new_file() {
        let root = tempfile::tempdir().unwrap();
        let canonical_root = std::fs::canonicalize(root.path()).unwrap();
        let resolved = resolve_writable_path(&canonical_root, "new-file.json").unwrap();
        assert_eq!(resolved, canonical_root.join("new-file.json"));
        assert!(!resolved.exists(), "must not require the file to already exist");
    }

    #[test]
    fn resolve_writable_path_rejects_a_parent_directory_that_does_not_exist() {
        let root = tempfile::tempdir().unwrap();
        let canonical_root = std::fs::canonicalize(root.path()).unwrap();
        assert!(resolve_writable_path(&canonical_root, "missing-dir/file.json").is_err());
    }

    #[test]
    fn resolve_writable_path_rejects_a_parent_outside_the_project() {
        let root = tempfile::tempdir().unwrap();
        let canonical_root = std::fs::canonicalize(root.path()).unwrap();
        let error = resolve_writable_path(&canonical_root, "../escape.json").unwrap_err();
        assert!(error.contains("stay inside"), "got {error}");
    }
}
