//! IPC surface for the debugger.
//!
//! Everything here is thin: the protocol, the ordering and the honesty
//! decisions live in `dap.rs`. What this layer owns is the one live session
//! per app, the persistence of breakpoints, and turning adapter events into
//! `debug-*` events the frontend can key off.

use std::sync::Arc;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{Emitter, Manager};

use crate::dap::{self, Breakpoint, DebugSession, StoppedState, Variable, Watch};
use crate::executor::Harness;
use crate::{palisade_home, project_root, store, Res};
use crate::locks::MutexExt;

/// What the debug panel needs to render itself, in one shape.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugStatus {
    /// `None` when nothing is being debugged.
    pub session_id: Option<String>,
    pub language: Option<String>,
    /// Present only while the program is stopped.
    pub stopped: Option<StoppedState>,
    /// Every breakpoint in the project, keyed by project-relative path.
    pub breakpoints: store::BreakpointsByFile,
}

fn session(harness: &Harness) -> Res<Arc<DebugSession>> {
    harness
        .tooling.debug_session
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| crate::PalisadeError::from("no debug session is running"))
}

fn status_of(harness: &Harness, project_hash: &str) -> Res<DebugStatus> {
    let live = harness.tooling.debug_session.lock_or_recover().clone();
    Ok(DebugStatus {
        session_id: live.as_ref().map(|s| s.id.clone()),
        language: live.as_ref().map(|s| s.language.clone()),
        stopped: live.as_ref().and_then(|s| s.stopped()),
        breakpoints: store::read_breakpoints(&palisade_home(), project_hash)?,
    })
}

// ------------------------------------------------------------- breakpoints

#[tauri::command]
pub async fn debug_breakpoints(project_hash: String) -> Res<store::BreakpointsByFile> {
    tokio::task::spawn_blocking(move || store::read_breakpoints(&palisade_home(), &project_hash))
        .await
        .map_err(crate::PalisadeError::from)?
}

/// Adds or removes a breakpoint at one line, and returns the file's new set.
///
/// Toggling is the whole gesture — a gutter click either places a breakpoint
/// or takes one away — so this is one command rather than an add and a
/// remove the frontend has to choose between.
#[tauri::command]
pub async fn debug_toggle_breakpoint(
    app: tauri::AppHandle,
    project_hash: String,
    path: String,
    line: u32,
) -> Res<Vec<Breakpoint>> {
    tokio::task::spawn_blocking(move || {
        let home = palisade_home();
        let mut all = store::read_breakpoints(&home, &project_hash)?;
        let file = all.entry(path.clone()).or_default();
        match file.iter().position(|b| b.line == line) {
            Some(index) => {
                file.remove(index);
            }
            None => {
                file.push(Breakpoint::new(&path, line));
                // Sorted so the gutter, the panel and the adapter all see the
                // same order regardless of the order they were clicked in.
                file.sort_by_key(|b| b.line);
            }
        }
        store::write_breakpoints(&home, &project_hash, &all)?;

        // A live session hears about it immediately: a breakpoint that only
        // takes effect on the next launch is not a breakpoint you can use.
        let mut file = all.get(&path).cloned().unwrap_or_default();
        let harness: tauri::State<'_, Harness> = app.state();
        if let Ok(session) = session(&harness) {
            let absolute = session.project_root.join(&path);
            if let Ok(bound) = session.set_breakpoints(&absolute.to_string_lossy(), file.clone()) {
                file = bound;
            }
        }
        Ok(file)
    })
    .await
    .map_err(crate::PalisadeError::from)?
}

/// Turns a breakpoint off without forgetting it, or back on.
#[tauri::command]
pub async fn debug_set_breakpoint_enabled(
    project_hash: String,
    path: String,
    line: u32,
    enabled: bool,
) -> Res<Vec<Breakpoint>> {
    tokio::task::spawn_blocking(move || {
        let home = palisade_home();
        let mut all = store::read_breakpoints(&home, &project_hash)?;
        if let Some(file) = all.get_mut(&path) {
            if let Some(breakpoint) = file.iter_mut().find(|b| b.line == line) {
                breakpoint.enabled = enabled;
            }
        }
        store::write_breakpoints(&home, &project_hash, &all)?;
        Ok(all.get(&path).cloned().unwrap_or_default())
    })
    .await
    .map_err(crate::PalisadeError::from)?
}

#[tauri::command]
pub async fn debug_clear_breakpoints(project_hash: String) -> Res<()> {
    tokio::task::spawn_blocking(move || {
        store::write_breakpoints(&palisade_home(), &project_hash, &store::BreakpointsByFile::new())
    })
    .await
    .map_err(crate::PalisadeError::from)?
}

// ----------------------------------------------------------------- session

/// Which adapter Palisade would use for a language, and whether it is there.
#[tauri::command]
pub async fn debug_adapter(language: String) -> Res<Option<dap::AdapterInfo>> {
    tokio::task::spawn_blocking(move || Ok(dap::adapter(&language)))
        .await
        .map_err(crate::PalisadeError::from)?
}

/// What Start would actually launch: the `run` command it derives from, and
/// the configuration it builds. `None` when the project has no run command a
/// debugger could attach to — the panel disables Start and says so, rather
/// than sending an empty config the adapter answers by never answering.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugLaunch {
    /// The key from the project's `run` map.
    pub name: String,
    pub command: String,
    pub configuration: Value,
}

#[tauri::command]
pub async fn debug_launch_options(
    project_hash: String,
    language: String,
) -> Res<Vec<DebugLaunch>> {
    tokio::task::spawn_blocking(move || {
        let root = project_root(&project_hash)?;
        let (settings, _) = crate::settings::load(&root);
        let mut options: Vec<DebugLaunch> = settings
            .run
            .iter()
            .filter_map(|(name, command)| {
                Some(DebugLaunch {
                    name: name.clone(),
                    command: command.clone(),
                    configuration: dap::launch_config(command, &language)?,
                })
            })
            .collect();
        options.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(options)
    })
    .await
    .map_err(crate::PalisadeError::from)?
}

#[tauri::command]
pub async fn debug_status(app: tauri::AppHandle, project_hash: String) -> Res<DebugStatus> {
    tokio::task::spawn_blocking(move || {
        let harness: tauri::State<'_, Harness> = app.state();
        status_of(&harness, &project_hash)
    })
    .await
    .map_err(crate::PalisadeError::from)?
}

/// Starts a debug session: spawn the adapter, hand it the launch config,
/// wait for `initialized`, send the project's breakpoints, let it run.
///
/// `configuration` is the adapter-specific `launch` (or `attach`) arguments —
/// a program path, an args list, a port. Passed through untouched: what a
/// launch config means is the adapter's business, not Palisade's.
#[tauri::command]
pub async fn debug_start(
    app: tauri::AppHandle,
    project_hash: String,
    language: String,
    configuration: Value,
) -> Res<DebugStatus> {
    tokio::task::spawn_blocking(move || {
        let harness: tauri::State<'_, Harness> = app.state();
        // One session at a time. Replacing silently would leave an orphaned
        // adapter holding the debuggee, so the old one is stopped first.
        if let Some(previous) = harness.tooling.debug_session.lock_or_recover().take() {
            previous.stop();
        }

        // An empty configuration is not something to send and hope: an
        // adapter's answer to a launch with no program is to never answer at
        // all, which showed up as a Start button spinning for thirty seconds
        // and then failing with nothing useful to say.
        if configuration.as_object().is_none_or(|c| c.is_empty()) {
            return Err(crate::PalisadeError::from(
                "nothing to launch: add a `run` command to \
                 .palisade/project-settings.json that starts this project",
            ));
        }

        let root = project_root(&project_hash)?;
        let adapter = dap::adapter(&language).ok_or_else(|| {
            crate::PalisadeError::not_found(format!("Palisade knows no debug adapter for {language}"))
        })?;

        let id = ulid::Ulid::new().to_string();
        // The adapter signals `initialized` on its own schedule; configuration
        // has to wait for it, so the event thread parks it here.
        let (initialized_tx, initialized_rx) = std::sync::mpsc::channel::<()>();
        let initialized_tx = std::sync::Mutex::new(Some(initialized_tx));
        let app_events = app.clone();
        let session_id = id.clone();
        let session = DebugSession::start(
            id.clone(),
            project_hash.clone(),
            root.clone(),
            language.clone(),
            &adapter,
            move |event, body| {
                if event == "initialized" {
                    if let Some(tx) = initialized_tx.lock_or_recover().take() {
                        let _ = tx.send(());
                    }
                }
                forward_event(&app_events, &session_id, event, body);
            },
        )?;

        // `launch` may not answer until after `initialized` on some adapters,
        // so it runs on its own thread rather than deadlocking against the
        // wait below.
        let launching = Arc::clone(&session);
        let launch = std::thread::spawn(move || launching.request("launch", configuration));

        // A missing `initialized` is not fatal: some adapters emit it before
        // `launch` is even sent, and some never do. Configure anyway rather
        // than refusing to debug.
        let _ = initialized_rx.recv_timeout(dap::REQUEST_TIMEOUT);

        let stored = store::read_breakpoints(&palisade_home(), &project_hash)?;
        let files: Vec<dap::BoundFile> = stored
            .iter()
            .map(|(path, breakpoints)| {
                (root.join(path).to_string_lossy().into_owned(), breakpoints.clone())
            })
            .collect();
        let bound = session.configure(files)?;

        // Fold the adapter's verdicts back onto the stored set so the gutter
        // can show which breakpoints actually bound. Persisted without them:
        // `write_breakpoints` keeps the user's lines, `read_breakpoints`
        // drops the per-session verdicts.
        let mut with_verdicts = stored;
        for (absolute, breakpoints) in bound {
            let relative = std::path::Path::new(&absolute)
                .strip_prefix(&root)
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or(absolute);
            with_verdicts.insert(relative, breakpoints);
        }

        if let Err(message) = launch.join().unwrap_or_else(|_| Err("launch panicked".into())) {
            session.stop();
            return Err(format!("launch failed: {message}").into());
        }

        *harness.tooling.debug_session.lock_or_recover() = Some(Arc::clone(&session));
        // The only "a session exists now" signal. `debug-stopped` means the
        // debuggee *paused*, so anything outside this panel that watched for
        // that missed every program that runs straight through.
        let _ = app.emit("debug-started", json!({ "sessionId": id }));
        Ok(DebugStatus {
            session_id: Some(id),
            language: Some(language),
            stopped: session.stopped(),
            breakpoints: with_verdicts,
        })
    })
    .await
    .map_err(crate::PalisadeError::from)?
}

#[tauri::command]
pub async fn debug_stop(app: tauri::AppHandle) -> Res<()> {
    tokio::task::spawn_blocking(move || {
        let harness: tauri::State<'_, Harness> = app.state();
        let live = harness.tooling.debug_session.lock_or_recover().take();
        if let Some(session) = live {
            session.stop();
        }
        let _ = app.emit("debug-ended", json!({}));
        Ok(())
    })
    .await
    .map_err(crate::PalisadeError::from)?
}

// ---------------------------------------------------------------- stepping

/// One of DAP's execution commands. Named rather than free-form so an
/// unknown string can't be forwarded to the adapter as a request.
fn step_command(action: &str) -> Res<&'static str> {
    Ok(match action {
        "continue" => "continue",
        "next" | "stepOver" => "next",
        "stepIn" => "stepIn",
        "stepOut" => "stepOut",
        "pause" => "pause",
        "restart" => "restart",
        other => return Err(format!("unknown debug action `{other}`").into()),
    })
}

#[tauri::command]
pub async fn debug_step(app: tauri::AppHandle, action: String, thread_id: Option<i64>) -> Res<()> {
    tokio::task::spawn_blocking(move || {
        let harness: tauri::State<'_, Harness> = app.state();
        let session = session(&harness)?;
        let command = step_command(&action)?;
        let thread = thread_id
            .or_else(|| session.stopped().map(|s| s.thread_id))
            .ok_or("nothing is stopped, so there is no thread to step")?;
        // Optimistically clear the stop: the program is running again the
        // moment this is accepted, and holding the old stack would let a
        // watch evaluate against a frame that no longer exists.
        session.on_continued();
        let _ = app.emit("debug-continued", json!({}));
        session.request(command, json!({"threadId": thread, "granularity": "statement"}))?;
        Ok(())
    })
    .await
    .map_err(crate::PalisadeError::from)?
}

// --------------------------------------------------------------- inspection

#[tauri::command]
pub async fn debug_scopes(app: tauri::AppHandle, frame_id: i64) -> Res<Vec<(String, i64)>> {
    tokio::task::spawn_blocking(move || {
        let harness: tauri::State<'_, Harness> = app.state();
        let body = session(&harness)?.request("scopes", json!({"frameId": frame_id}))?;
        Ok(body
            .get("scopes")
            .and_then(Value::as_array)
            .map(|scopes| {
                scopes
                    .iter()
                    .filter_map(|scope| {
                        Some((
                            scope.get("name")?.as_str()?.to_string(),
                            scope.get("variablesReference")?.as_i64()?,
                        ))
                    })
                    .collect()
            })
            .unwrap_or_default())
    })
    .await
    .map_err(crate::PalisadeError::from)?
}

#[tauri::command]
pub async fn debug_variables(app: tauri::AppHandle, variables_reference: i64) -> Res<Vec<Variable>> {
    tokio::task::spawn_blocking(move || {
        let harness: tauri::State<'_, Harness> = app.state();
        let body = session(&harness)?
            .request("variables", json!({"variablesReference": variables_reference}))?;
        Ok(dap::parse_variables(&body))
    })
    .await
    .map_err(crate::PalisadeError::from)?
}

/// Evaluates watch expressions in one frame.
///
/// Batched because they are re-evaluated together on every stop, and a
/// failure in one must not take the others with it — each carries its own
/// error instead.
#[tauri::command]
pub async fn debug_evaluate(
    app: tauri::AppHandle,
    expressions: Vec<String>,
    frame_id: Option<i64>,
) -> Res<Vec<Watch>> {
    tokio::task::spawn_blocking(move || {
        let harness: tauri::State<'_, Harness> = app.state();
        let session = session(&harness)?;
        Ok(expressions.iter().map(|e| session.evaluate(e, frame_id)).collect())
    })
    .await
    .map_err(crate::PalisadeError::from)?
}

// ------------------------------------------------------------------ events

/// Turns one adapter event into the `debug-*` event the frontend listens for.
///
/// `stopped` is the one that does work: it pulls the call stack before
/// emitting, so the UI gets a stop and its stack together rather than
/// rendering a stopped program with an empty stack for a round-trip.
fn forward_event(app: &tauri::AppHandle, session_id: &str, event: &str, body: Value) {
    let harness: tauri::State<'_, Harness> = app.state();
    match event {
        "stopped" => {
            let live = harness.tooling.debug_session.lock_or_recover().clone();
            let state = match live {
                Some(session) => session.on_stopped(&body),
                // The stop arrived before `debug_start` finished storing the
                // session (a breakpoint on the first line does this). Report
                // it with no stack rather than dropping it entirely.
                None => StoppedState {
                    thread_id: body.get("threadId").and_then(Value::as_i64).unwrap_or(0),
                    reason: body
                        .get("reason")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown")
                        .to_string(),
                    description: None,
                    frames: vec![],
                },
            };
            let _ = app.emit("debug-stopped", state);
        }
        "continued" => {
            if let Some(session) = harness.tooling.debug_session.lock_or_recover().clone() {
                session.on_continued();
            }
            let _ = app.emit("debug-continued", body);
        }
        "output" => {
            let _ = app.emit("debug-output", body);
        }
        "terminated" | "exited" | "__closed" => {
            let _ = app.emit("debug-ended", json!({ "reason": event, "sessionId": session_id }));
        }
        _ => {
            let _ = app.emit("debug-event", json!({ "event": event, "body": body }));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_known_step_actions_reach_the_adapter() {
        assert_eq!(step_command("stepOver").unwrap(), "next");
        assert_eq!(step_command("next").unwrap(), "next");
        assert_eq!(step_command("stepIn").unwrap(), "stepIn");
        assert_eq!(step_command("stepOut").unwrap(), "stepOut");
        assert_eq!(step_command("continue").unwrap(), "continue");
        // A typo, or anything from the frontend that isn't an execution
        // command, must not be forwarded as an arbitrary DAP request.
        let err = step_command("evaluate").unwrap_err();
        assert!(err.contains("evaluate"), "the error should name the action: {err}");
        assert!(step_command("").is_err());
    }
}
