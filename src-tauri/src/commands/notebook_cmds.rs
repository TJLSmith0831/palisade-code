use std::sync::Arc;

use tauri::{Emitter, Manager};

use crate::executor::Harness;
use crate::notebook::{self, KernelResolution, NotebookKernel};
use crate::Res;

/// Emitted (non-fatally) when the notebook's own recorded kernel isn't
/// installed and Palisade falls back to the default kernel (design.md D4).
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct NotebookWarning {
    notebook_id: String,
    message: String,
}

/// Looks up (or creates, unstarted) this notebook's kernel entry in the
/// registry, returning the shared handle used for both spawn and send.
fn kernel_for(harness: &Harness, notebook_id: &str) -> Arc<NotebookKernel> {
    harness
        .notebook_kernels
        .lock()
        .unwrap()
        .entry(notebook_id.to_string())
        .or_insert_with(|| Arc::new(NotebookKernel::new()))
        .clone()
}

/// Spawns the kernel if it isn't already running (resolving the notebook's
/// own kernelspec per design.md D4, warning-and-falling-back if it's not
/// installed), then sends the execute request. Results arrive as
/// `notebook-event`s, not as this call's return value.
#[tauri::command]
pub async fn run_notebook_cell(
    app: tauri::AppHandle,
    project_hash: String,
    relative_path: String,
    kernelspec_name: Option<String>,
    cell_id: String,
    source: String,
) -> Res<()> {
    tokio::task::spawn_blocking(move || {
        let harness: tauri::State<'_, Harness> = app.state();
        let id = notebook::notebook_id(&project_hash, &relative_path);
        let kernel = kernel_for(&harness, &id);

        if !kernel.is_alive() {
            let resolution = notebook::resolve_kernelspec_name(kernelspec_name.as_deref());
            let resolved_name = match resolution {
                KernelResolution::Found(name) => Some(name),
                KernelResolution::Fallback { warning } => {
                    if let Some(message) = warning {
                        let _ = app.emit("notebook-warning", NotebookWarning { notebook_id: id.clone(), message });
                    }
                    None
                }
            };
            let driver_path = notebook::resolve_driver_path(&app)?;
            kernel.spawn(&app, &driver_path, resolved_name.as_deref(), &id)?;
        }

        kernel.execute(&cell_id, &source)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn interrupt_notebook_kernel(app: tauri::AppHandle, project_hash: String, relative_path: String) -> Res<()> {
    tokio::task::spawn_blocking(move || {
        let harness: tauri::State<'_, Harness> = app.state();
        let id = notebook::notebook_id(&project_hash, &relative_path);
        kernel_for(&harness, &id).interrupt()
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn restart_notebook_kernel(app: tauri::AppHandle, project_hash: String, relative_path: String) -> Res<()> {
    tokio::task::spawn_blocking(move || {
        let harness: tauri::State<'_, Harness> = app.state();
        let id = notebook::notebook_id(&project_hash, &relative_path);
        kernel_for(&harness, &id).restart()
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Stops and drops a notebook's kernel entirely — called on tab close
/// (design.md D6, amended D20). A no-op if no kernel was ever spawned for
/// this notebook (opening a notebook and never running a cell, per D8).
#[tauri::command]
pub async fn close_notebook_kernel(app: tauri::AppHandle, project_hash: String, relative_path: String) -> Res<()> {
    tokio::task::spawn_blocking(move || {
        let harness: tauri::State<'_, Harness> = app.state();
        let id = notebook::notebook_id(&project_hash, &relative_path);
        if let Some(kernel) = harness.notebook_kernels.lock().unwrap().remove(&id) {
            kernel.terminate();
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}
