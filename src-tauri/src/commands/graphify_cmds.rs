use crate::{executor, integrations, project_root, Res};

use std::path::PathBuf;

/// Where the `graphify` binary lives, or a readable error if it isn't there.
pub(crate) fn graphify_bin() -> Res<PathBuf> {
    executor::find_on_path("graphify")
        .ok_or_else(|| "`graphify` is not on PATH — install it to build code maps.".into())
}

/// Run Graphify over the active project (or a subdirectory of it). The
/// executor reaches this same graph directly via MCP tools (D9/D21) — this
/// command only serves the human-facing GraphPane, so its output is just
/// written to disk and returned, never injected into a thread.
#[tauri::command]
pub async fn run_graphify(
    project_hash: String,
    subpath: String,
    options: integrations::GraphifyOptions,
) -> Res<integrations::GraphifyRun> {
    tokio::task::spawn_blocking(move || {
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
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Load a previous run's output without re-running the extract.
#[tauri::command]
pub async fn load_graphify(project_hash: String) -> Res<integrations::GraphifyRun> {
    tokio::task::spawn_blocking(move || {
        integrations::read_run(&integrations::default_out_dir(&project_root(&project_hash)?))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn query_graphify(
    project_hash: String,
    subcommand: String,
    args: Vec<String>,
) -> Res<String> {
    tokio::task::spawn_blocking(move || {
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        integrations::graphify_query(
            &graphify_bin()?,
            &subcommand,
            &refs,
            &integrations::default_out_dir(&project_root(&project_hash)?),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
