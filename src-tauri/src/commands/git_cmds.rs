use std::path::PathBuf;

use crate::{git, git_bin, project_root, thread_meta, Res};

/// Which working tree an operation is about: a thread's own worktree when one
/// is named and exists, the project root otherwise.
///
/// Reads and writes both. An earlier revision pinned every write to the
/// project root on the theory that a write could otherwise land in a tree the
/// user was merely *watching* — but that left a thread's worktree with no way
/// to stage, discard, or commit anything from the UI at all, which is most of
/// what the multi-worktree feature is for. The guarantee that actually
/// matters is narrower and is the caller's to keep: **pass the same
/// `thread_id` you rendered from**, so the tree written to is the tree on
/// screen. Panes that show the project root pass `None` and are unaffected.
///
/// Repository-wide operations (branch list, checkout, init) are deliberately
/// not routed here: they are properties of the repo, not of one working tree.
pub(crate) fn tree_root(project_hash: &str, thread_id: Option<&str>) -> Res<PathBuf> {
    let root = project_root(project_hash)?;
    let Some(recorded) = thread_id
        .and_then(|id| thread_meta(project_hash, id))
        .and_then(|t| t.worktree_path)
        .map(PathBuf::from)
    else {
        // No worktree recorded for this thread — a thread that has never run,
        // or a non-git project. The project root is the right answer.
        return Ok(root);
    };
    // A recorded worktree whose directory is gone is not a reason to quietly
    // use the project root: the caller is showing that worktree's branch on a
    // commit button, and falling back would stage and commit a different tree
    // than the one on screen under the wrong branch's name. Refuse instead.
    if !recorded.is_dir() {
        return Err(format!(
            "This thread's worktree is missing ({}). It may have been removed outside Palisade. Its changes cannot be read or committed from here.",
            recorded.display()
        ).into());
    }
    Ok(recorded)
}

#[tauri::command]
pub async fn git_status(project_hash: String, thread_id: Option<String>) -> Res<Vec<git::FileStatus>> {
    tokio::task::spawn_blocking(move || {
        git::status(&git_bin()?, &tree_root(&project_hash, thread_id.as_deref())?)
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

#[tauri::command]
pub async fn git_working_diff(project_hash: String, thread_id: Option<String>) -> Res<String> {
    tokio::task::spawn_blocking(move || {
        git::working_tree_diff(&git_bin()?, &tree_root(&project_hash, thread_id.as_deref())?)
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

#[tauri::command]
pub async fn git_staged_diff(project_hash: String, thread_id: Option<String>) -> Res<String> {
    tokio::task::spawn_blocking(move || {
        git::staged_diff(&git_bin()?, &tree_root(&project_hash, thread_id.as_deref())?)
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

#[tauri::command]
pub async fn git_stage_hunk(project_hash: String, patch: String, thread_id: Option<String>) -> Res<()> {
    tokio::task::spawn_blocking(move || {
        git::stage_hunk(&git_bin()?, &tree_root(&project_hash, thread_id.as_deref())?, &patch)
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

#[tauri::command]
pub async fn git_unstage_hunk(project_hash: String, patch: String, thread_id: Option<String>) -> Res<()> {
    tokio::task::spawn_blocking(move || {
        git::unstage_hunk(&git_bin()?, &tree_root(&project_hash, thread_id.as_deref())?, &patch)
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

#[tauri::command]
pub async fn git_stage_file(project_hash: String, path: String, thread_id: Option<String>) -> Res<()> {
    tokio::task::spawn_blocking(move || {
        git::stage_file(&git_bin()?, &tree_root(&project_hash, thread_id.as_deref())?, &path)
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

#[tauri::command]
pub async fn git_unstage_file(project_hash: String, path: String, thread_id: Option<String>) -> Res<()> {
    tokio::task::spawn_blocking(move || {
        git::unstage_file(&git_bin()?, &tree_root(&project_hash, thread_id.as_deref())?, &path)
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

#[tauri::command]
pub async fn git_commit(project_hash: String, message: String, thread_id: Option<String>) -> Res<()> {
    tokio::task::spawn_blocking(move || {
        git::commit(&git_bin()?, &tree_root(&project_hash, thread_id.as_deref())?, &message)
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

/// Amendment 7's read-only commit graph.
#[tauri::command]
pub async fn git_log(project_hash: String, limit: u32, thread_id: Option<String>) -> Res<Vec<git::LogEntry>> {
    tokio::task::spawn_blocking(move || {
        git::log(&git_bin()?, &tree_root(&project_hash, thread_id.as_deref())?, limit)
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

#[tauri::command]
pub async fn git_graph(project_hash: String, limit: u32) -> Res<Vec<git::GraphCommit>> {
    tokio::task::spawn_blocking(move || git::graph(&git_bin()?, &project_root(&project_hash)?, limit))
        .await
        .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

#[tauri::command]
pub async fn git_commit_diff(project_hash: String, hash: String) -> Res<String> {
    tokio::task::spawn_blocking(move || git::commit_diff(&git_bin()?, &project_root(&project_hash)?, &hash))
        .await
        .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

#[tauri::command]
pub async fn git_branches(project_hash: String) -> Res<Vec<git::BranchInfo>> {
    tokio::task::spawn_blocking(move || {
        git::list_branches(&git_bin()?, &project_root(&project_hash)?)
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

#[tauri::command]
pub async fn git_checkout_branch(project_hash: String, name: String) -> Res<()> {
    tokio::task::spawn_blocking(move || {
        git::checkout_branch(&git_bin()?, &project_root(&project_hash)?, &name)
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

/// Every branch this repo has checked out in a worktree other than the
/// project root, as `(branch, worktree path)`.
///
/// A branch lives in exactly one worktree, so this is what turns "switch to
/// that branch" into "open the tree it is already in" — the branch picker
/// marks these entries and opens the worktree instead of attempting a
/// checkout git would refuse.
#[tauri::command]
pub async fn git_worktrees(project_hash: String) -> Res<Vec<(String, String)>> {
    tokio::task::spawn_blocking(move || {
        let root = project_root(&project_hash)?;
        let here = root.canonicalize().ok();
        Ok(git::worktree_branches(&git_bin()?, &root)?
            .into_iter()
            // `git worktree list` still reports an entry whose directory has
            // been deleted until someone prunes it. Offering one as a place
            // to open would register a project pointing at nothing.
            .filter(|(_, path)| path.is_dir() && path.canonicalize().ok() != here)
            .map(|(branch, path)| (branch, path.to_string_lossy().into_owned()))
            .collect())
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

#[tauri::command]
pub async fn git_create_branch(project_hash: String, name: String) -> Res<()> {
    tokio::task::spawn_blocking(move || {
        git::create_branch(&git_bin()?, &project_root(&project_hash)?, &name)
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

#[tauri::command]
pub async fn git_delete_branch(project_hash: String, name: String) -> Res<()> {
    tokio::task::spawn_blocking(move || {
        git::delete_branch(&git_bin()?, &project_root(&project_hash)?, &name)
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

#[tauri::command]
pub async fn git_fetch(project_hash: String, thread_id: Option<String>) -> Res<()> {
    tokio::task::spawn_blocking(move || {
        git::fetch(&git_bin()?, &tree_root(&project_hash, thread_id.as_deref())?)
    })
        .await
        .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

#[tauri::command]
pub async fn git_pull(project_hash: String, thread_id: Option<String>) -> Res<String> {
    tokio::task::spawn_blocking(move || {
        git::pull(&git_bin()?, &tree_root(&project_hash, thread_id.as_deref())?)
    })
        .await
        .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

#[tauri::command]
pub async fn git_push(project_hash: String, thread_id: Option<String>) -> Res<String> {
    tokio::task::spawn_blocking(move || {
        git::push(&git_bin()?, &tree_root(&project_hash, thread_id.as_deref())?)
    })
        .await
        .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

#[tauri::command]
pub async fn git_ahead_behind(project_hash: String, thread_id: Option<String>) -> Res<Option<(u32, u32)>> {
    tokio::task::spawn_blocking(move || {
        git::ahead_behind(&git_bin()?, &tree_root(&project_hash, thread_id.as_deref())?)
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

#[tauri::command]
pub async fn git_discard_file(
    project_hash: String,
    path: String,
    untracked: bool,
    thread_id: Option<String>,
) -> Res<()> {
    tokio::task::spawn_blocking(move || {
        git::discard_file(&git_bin()?, &tree_root(&project_hash, thread_id.as_deref())?, &path, untracked)
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

#[tauri::command]
pub async fn git_is_repo(project_hash: String) -> Res<bool> {
    tokio::task::spawn_blocking(move || {
        Ok(git::is_git_repo(&git_bin()?, &project_root(&project_hash)?))
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}

#[tauri::command]
pub async fn git_init(project_hash: String) -> Res<()> {
    tokio::task::spawn_blocking(move || {
        git::init_repo(&git_bin()?, &project_root(&project_hash)?)
    })
    .await
    .map_err(|e| crate::PalisadeError::from(e.to_string()))?
}
