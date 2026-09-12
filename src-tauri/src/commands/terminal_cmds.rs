use crate::executor::Harness;
use crate::{project_root, Res};
use serde::Serialize;
use tauri::{Emitter, Manager};

/// One chunk of PTY output, tagged with the tab it came from. Untagged
/// output had nowhere to go once more than one terminal could be open —
/// every tab would have rendered every other tab's bytes.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalOutput {
    terminal_id: String,
    /// Base64: raw PTY bytes, not text. A multi-byte character split across
    /// a read boundary must survive the trip for xterm to reassemble it.
    data: String,
}

/// Ensures the PTY for tab `terminal_id` is running against `project_hash`,
/// spawning one if it isn't. Already running → no-op, so re-opening the panel
/// re-attaches to the same shell instead of spawning a second one.
///
/// Returns whether a new shell was spawned (`false` = re-attached).
#[tauri::command]
pub async fn terminal_spawn(
    app: tauri::AppHandle,
    project_hash: String,
    terminal_id: String,
) -> Res<bool> {
    tokio::task::spawn_blocking(move || {
        let harness: tauri::State<'_, Harness> = app.state();
        let root = project_root(&project_hash)?;
        let app_output = app.clone();
        let id_for_output = terminal_id.clone();
        harness
            .tooling.terminals
            .ensure(&terminal_id, &project_hash, &root, move |bytes| {
                use base64::prelude::*;
                let _ = app_output.emit(
                    "terminal-output",
                    TerminalOutput {
                        terminal_id: id_for_output.clone(),
                        data: BASE64_STANDARD.encode(&bytes),
                    },
                );
            })
            .map_err(|err| crate::PalisadeError::from(format!("start terminal: {err}")))
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

#[tauri::command]
pub async fn terminal_input(
    app: tauri::AppHandle,
    terminal_id: String,
    data: String,
) -> Res<()> {
    tokio::task::spawn_blocking(move || {
        let harness: tauri::State<'_, Harness> = app.state();
        harness.tooling.terminals.write(&terminal_id, data.as_bytes())
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

#[tauri::command]
pub async fn terminal_resize(
    app: tauri::AppHandle,
    terminal_id: String,
    cols: u16,
    rows: u16,
) -> Res<()> {
    tokio::task::spawn_blocking(move || {
        let harness: tauri::State<'_, Harness> = app.state();
        harness.tooling.terminals.resize(&terminal_id, cols, rows)
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

/// Closes one tab's shell. Other tabs, including this project's, keep running.
#[tauri::command]
pub async fn terminal_kill(app: tauri::AppHandle, terminal_id: String) -> Res<()> {
    tokio::task::spawn_blocking(move || {
        let harness: tauri::State<'_, Harness> = app.state();
        harness.tooling.terminals.kill(&terminal_id);
        Ok(())
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

/// Closes every tab belonging to one project — what a project switch does,
/// where the old shells have no surface left to render into.
#[tauri::command]
pub async fn terminal_kill_project(app: tauri::AppHandle, project_hash: String) -> Res<()> {
    tokio::task::spawn_blocking(move || {
        let harness: tauri::State<'_, Harness> = app.state();
        harness.tooling.terminals.kill_project(&project_hash);
        Ok(())
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

/// Which tabs are actually alive for a project. The frontend restores its tab
/// strip from its own persisted list; this says which of those still have a
/// shell behind them.
#[tauri::command]
pub async fn terminal_list(app: tauri::AppHandle, project_hash: String) -> Res<Vec<String>> {
    tokio::task::spawn_blocking(move || {
        let harness: tauri::State<'_, Harness> = app.state();
        Ok(harness.tooling.terminals.list(&project_hash))
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}
