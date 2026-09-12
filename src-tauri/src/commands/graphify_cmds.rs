use crate::{executor, integrations, project_root, Res};

use std::path::PathBuf;
use crate::project_path::ProjectPath;

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
        let target = ProjectPath::existing(&root, subpath.trim())
            .map_err(|err| crate::PalisadeError::from(format!("Graphify target must stay inside the active project. ({err})")))?
            .into_path_buf();

        let out_dir = integrations::default_out_dir(&root);
        integrations::run_graphify(&graphify_bin()?, &target, &out_dir, &options)
    })
    .await
    .map_err(crate::PalisadeError::from)?
}

/// Load a previous run's output without re-running the extract.
#[tauri::command]
pub async fn load_graphify(project_hash: String) -> Res<integrations::GraphifyRun> {
    tokio::task::spawn_blocking(move || {
        integrations::read_run(&integrations::default_out_dir(&project_root(&project_hash)?))
    })
    .await
    .map_err(crate::PalisadeError::from)?
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
    .map_err(crate::PalisadeError::from)?
}
