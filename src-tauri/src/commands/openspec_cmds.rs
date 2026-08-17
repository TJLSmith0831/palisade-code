use crate::executor;
use crate::executor::Harness;
use crate::store;
use crate::{project_root, Res, ThreadMeta};
use tauri::Manager;

/// Read-only. Every one of these asks the `openspec` CLI and renders what it
/// says; nothing here writes a spec file, and nothing here writes to
/// `~/.palisade-code` (task 4.5). Palisade's only durable spec state stays the one
/// reference string on `ThreadMeta`.
#[tauri::command]
pub async fn list_spec_changes(app: tauri::AppHandle, project_hash: String) -> Res<Vec<executor::SpecChange>> {
    let cache = app.state::<Harness>().openspec_cache.clone();
    tokio::task::spawn_blocking(move || Ok(executor::openspec_list(&cache, &project_root(&project_hash)?)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn show_spec_change(
    app: tauri::AppHandle,
    project_hash: String,
    name: String,
) -> Res<Option<serde_json::Value>> {
    let cache = app.state::<Harness>().openspec_cache.clone();
    tokio::task::spawn_blocking(move || {
        Ok(executor::openspec_show(&cache, &project_root(&project_hash)?, &name))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// `None` when `openspec` isn't installed — "we can't tell", which is a
/// different answer from "invalid" and must not be rendered as one.
#[tauri::command]
pub async fn validate_spec_changes(app: tauri::AppHandle, project_hash: String) -> Res<Option<bool>> {
    let cache = app.state::<Harness>().openspec_cache.clone();
    tokio::task::spawn_blocking(move || {
        Ok(executor::openspec_validate(&cache, &project_root(&project_hash)?))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn archive_spec_change(app: tauri::AppHandle, project_hash: String, name: String) -> Res<String> {
    let cache = app.state::<Harness>().openspec_cache.clone();
    tokio::task::spawn_blocking(move || {
        executor::openspec_archive(&cache, &project_root(&project_hash)?, &name)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Set the thread's spec link by hand — how the user resolves the ambiguity
/// `spec-link-ambiguous` reports.
#[tauri::command]
pub async fn set_spec_change(
    project_hash: String,
    thread_id: String,
    name: Option<String>,
) -> Res<ThreadMeta> {
    tokio::task::spawn_blocking(move || {
        store::set_open_spec_change(&store::palisade_home(), &project_hash, &thread_id, name.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}
