mod executor;
mod store;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::{Emitter, Manager};

use executor::{ExecutorEvent, Harness, Kind, Preflight, Sink, Spawn};
use store::{floo_home, Message, Project, Res, ThreadMeta};

/// Notes live inside the target project, so every note command resolves the
/// project's root from the global index rather than trusting the frontend.
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
fn switch_project(hash: String) -> Res<Project> {
    store::touch_project(&floo_home(), &hash)
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

#[tauri::command]
fn create_note(project_hash: String, name: String) -> Res<String> {
    store::create_note(&project_root(&project_hash)?, &name)
}

#[tauri::command]
fn list_notes(project_hash: String) -> Res<Vec<String>> {
    store::list_notes(&project_root(&project_hash)?)
}

#[tauri::command]
fn read_note(project_hash: String, name: String) -> Res<String> {
    store::read_note(&project_root(&project_hash)?, &name)
}

#[tauri::command]
fn write_note(project_hash: String, name: String, content: String) -> Res<()> {
    store::write_note(&project_root(&project_hash)?, &name, &content)
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
                // History is append-only, so nothing is at risk here. Drop the
                // session id too: a resume against a session the executor no
                // longer has looks exactly like this, and keeping it would
                // make every retry fail the same way.
                let _ = store::set_thread_mode(&floo_home(), &self.project_hash, &self.thread_id, "spec");
                let _ = store::set_executor_session(&floo_home(), &self.project_hash, &self.thread_id, None);
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

fn selected_executor(harness: &tauri::State<'_, Harness>) -> Res<(Kind, PathBuf)> {
    let flight = {
        let mut cached = harness.preflight.lock().unwrap();
        if cached.is_none() {
            *cached = Some(executor::preflight());
        }
        cached.clone().expect("preflight just populated")
    };
    let kind = flight.selected.ok_or("No executor found on PATH — chat-only mode.")?;
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
    let (kind, bin) = selected_executor(harness)?;
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
    if selected_executor(&harness).is_err() {
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
            append_message,
            read_thread,
            create_note,
            list_notes,
            read_note,
            write_note,
            preflight,
            send_message,
            go_mode,
            spec_mode,
            propose,
            stop_executor,
            executor_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
