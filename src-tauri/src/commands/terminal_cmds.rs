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
    /// Where this chunk starts in the tab's lifetime output, so a view that
    /// also fetched a backlog can drop chunks the backlog already holds.
    offset: u64,
}

/// A tab's shell ended without being asked to.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalExit {
    terminal_id: String,
}

/// What `terminal_spawn` hands back: enough for a view to attach mid-stream.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalAttach {
    /// False when the tab was already live and the caller merely re-attached.
    spawned: bool,
    /// Base64 of the tab's recent output.
    backlog: String,
    /// Live chunks with `offset < end` are already in `backlog`.
    end: u64,
}

/// Ensures the PTY for tab `terminal_id` is running against `project_hash`,
/// spawning one if it isn't. Already running → no-op, so re-opening the panel
/// re-attaches to the same shell instead of spawning a second one.
///
/// A tab whose shell has exited is replaced rather than re-attached, which is
/// how a view restarts one. Returns the recent output so a late view can catch
/// up (see `TerminalAttach`).
#[tauri::command]
pub async fn terminal_spawn(
    app: tauri::AppHandle,
    project_hash: String,
    terminal_id: String,
) -> Res<TerminalAttach> {
    tokio::task::spawn_blocking(move || {
        let _admission = crate::account_session::admit_work()?;
        let harness: tauri::State<'_, Harness> = app.state();
        let root = project_root(&project_hash)?;
        let app_output = app.clone();
        let id_for_output = terminal_id.clone();
        let app_exit = app.clone();
        let id_for_exit = terminal_id.clone();
        use base64::prelude::*;
        harness
            .tooling.terminals
            .ensure(
                &terminal_id,
                &project_hash,
                &root,
                move |offset, bytes| {
                    let _ = app_output.emit(
                        "terminal-output",
                        TerminalOutput {
                            terminal_id: id_for_output.clone(),
                            data: BASE64_STANDARD.encode(&bytes),
                            offset,
                        },
                    );
                },
                move || {
                    let _ = app_exit.emit(
                        "terminal-exit",
                        TerminalExit { terminal_id: id_for_exit.clone() },
                    );
                },
            )
            .map(|attach| TerminalAttach {
                spawned: attach.spawned,
                backlog: BASE64_STANDARD.encode(&attach.backlog),
                end: attach.end,
            })
            .map_err(|err| crate::PalisadeError::from(format!("start terminal: {err}")))
    })
    .await
    .map_err(crate::PalisadeError::from)?
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
    .map_err(crate::PalisadeError::from)?
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
    .map_err(crate::PalisadeError::from)?
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
    .map_err(crate::PalisadeError::from)?
}

/// Closes every tab belonging to one project — what a project switch does,
/// where the old shells have no surface left to render into. Skipped while
/// another window still shows the project: its tabs share these shells (#33).
#[tauri::command]
pub async fn terminal_kill_project(
    window: tauri::Window,
    app: tauri::AppHandle,
    project_hash: String,
) -> Res<()> {
    let caller = window.label().to_string();
    tokio::task::spawn_blocking(move || {
        let harness: tauri::State<'_, Harness> = app.state();
        let shown_elsewhere = harness
            .workspace
            .window_projects
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .any(|(label, hash)| *label != caller && *hash == project_hash);
        if !shown_elsewhere {
            harness.tooling.terminals.kill_project(&project_hash);
        }
        Ok(())
    })
    .await
    .map_err(crate::PalisadeError::from)?
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
    .map_err(crate::PalisadeError::from)?
}
