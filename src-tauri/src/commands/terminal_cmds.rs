use crate::executor::Harness;
use crate::store;
use crate::{project_root, Res};
use tauri::{Emitter, Manager};

/// Ensures a PTY terminal is running for `project_hash`, spawning one if
/// none exists yet or the existing one belongs to a different (stale)
/// project. Already running for this project → no-op, so re-opening the
/// panel re-attaches to the same session (spec: "single terminal instance")
/// instead of spawning a second one.
#[tauri::command]
pub async fn terminal_spawn(
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
                Some((hash, _)) => store::list_projects(&store::floo_home())
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
        let term = crate::terminal::Terminal::spawn(&root, move |bytes| {
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
pub async fn terminal_input(app: tauri::AppHandle, data: String) -> Res<()> {
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
pub async fn terminal_resize(app: tauri::AppHandle, cols: u16, rows: u16) -> Res<()> {
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
pub async fn terminal_kill(app: tauri::AppHandle) -> Res<()> {
    tokio::task::spawn_blocking(move || {
        let harness: tauri::State<'_, Harness> = app.state();
        *harness.terminal.lock().unwrap() = None;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}
