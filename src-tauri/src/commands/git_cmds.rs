use crate::{git, git_bin, project_root, Res};

#[tauri::command]
pub async fn git_status(project_hash: String) -> Res<Vec<git::FileStatus>> {
    tokio::task::spawn_blocking(move || git::status(&git_bin()?, &project_root(&project_hash)?))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_working_diff(project_hash: String) -> Res<String> {
    tokio::task::spawn_blocking(move || {
        git::working_tree_diff(&git_bin()?, &project_root(&project_hash)?)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_staged_diff(project_hash: String) -> Res<String> {
    tokio::task::spawn_blocking(move || {
        git::staged_diff(&git_bin()?, &project_root(&project_hash)?)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_stage_hunk(project_hash: String, patch: String) -> Res<()> {
    tokio::task::spawn_blocking(move || {
        git::stage_hunk(&git_bin()?, &project_root(&project_hash)?, &patch)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_unstage_hunk(project_hash: String, patch: String) -> Res<()> {
    tokio::task::spawn_blocking(move || {
        git::unstage_hunk(&git_bin()?, &project_root(&project_hash)?, &patch)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_stage_file(project_hash: String, path: String) -> Res<()> {
    tokio::task::spawn_blocking(move || {
        git::stage_file(&git_bin()?, &project_root(&project_hash)?, &path)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_unstage_file(project_hash: String, path: String) -> Res<()> {
    tokio::task::spawn_blocking(move || {
        git::unstage_file(&git_bin()?, &project_root(&project_hash)?, &path)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_commit(project_hash: String, message: String) -> Res<()> {
    tokio::task::spawn_blocking(move || {
        git::commit(&git_bin()?, &project_root(&project_hash)?, &message)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Amendment 7's read-only commit graph.
#[tauri::command]
pub async fn git_log(project_hash: String, limit: u32) -> Res<Vec<git::LogEntry>> {
    tokio::task::spawn_blocking(move || {
        git::log(&git_bin()?, &project_root(&project_hash)?, limit)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_branches(project_hash: String) -> Res<Vec<git::BranchInfo>> {
    tokio::task::spawn_blocking(move || {
        git::list_branches(&git_bin()?, &project_root(&project_hash)?)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_checkout_branch(project_hash: String, name: String) -> Res<()> {
    tokio::task::spawn_blocking(move || {
        git::checkout_branch(&git_bin()?, &project_root(&project_hash)?, &name)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_create_branch(project_hash: String, name: String) -> Res<()> {
    tokio::task::spawn_blocking(move || {
        git::create_branch(&git_bin()?, &project_root(&project_hash)?, &name)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_delete_branch(project_hash: String, name: String) -> Res<()> {
    tokio::task::spawn_blocking(move || {
        git::delete_branch(&git_bin()?, &project_root(&project_hash)?, &name)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_fetch(project_hash: String) -> Res<()> {
    tokio::task::spawn_blocking(move || git::fetch(&git_bin()?, &project_root(&project_hash)?))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_pull(project_hash: String) -> Res<String> {
    tokio::task::spawn_blocking(move || git::pull(&git_bin()?, &project_root(&project_hash)?))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_push(project_hash: String) -> Res<String> {
    tokio::task::spawn_blocking(move || git::push(&git_bin()?, &project_root(&project_hash)?))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_ahead_behind(project_hash: String) -> Res<Option<(u32, u32)>> {
    tokio::task::spawn_blocking(move || {
        git::ahead_behind(&git_bin()?, &project_root(&project_hash)?)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_discard_file(project_hash: String, path: String, untracked: bool) -> Res<()> {
    tokio::task::spawn_blocking(move || {
        git::discard_file(&git_bin()?, &project_root(&project_hash)?, &path, untracked)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_is_repo(project_hash: String) -> Res<bool> {
    tokio::task::spawn_blocking(move || {
        Ok(git::is_git_repo(&git_bin()?, &project_root(&project_hash)?))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_init(project_hash: String) -> Res<()> {
    tokio::task::spawn_blocking(move || {
        git::init_repo(&git_bin()?, &project_root(&project_hash)?)
    })
    .await
    .map_err(|e| e.to_string())?
}
