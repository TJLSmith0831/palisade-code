use crate::{executor, integrations, project_root, Res};

use std::path::PathBuf;
use crate::project_path::ProjectPath;

/// Where the `graphify` binary lives, or a readable error if it isn't there.
pub(crate) fn graphify_bin() -> Res<PathBuf> {
    executor::find_on_path("graphify")
        .ok_or_else(|| "`graphify` is not on PATH — install it to build code maps.".into())
}

/// Resolve Graphify's target within `root`, without losing the reason a bad
/// `subpath` was rejected.
///
/// Graphify maps the active project, never the harness — and never anywhere
/// outside the project the user selected. Only a genuine containment escape
/// gets relabelled with that context; a target that simply doesn't exist
/// must stay `NotFound`. Folding both into one "must stay inside the active
/// project" message told the user their path was a security violation when
/// it was just a typo.
pub(crate) fn resolve_graphify_target(root: &std::path::Path, subpath: &str) -> Res<PathBuf> {
    ProjectPath::existing(root, subpath.trim())
        .map_err(|err| match err.kind {
            crate::error::ErrorKind::OutsideProject => crate::PalisadeError::outside_project(
                format!("Graphify target must stay inside the active project. ({err})"),
            ),
            _ => err,
        })
        .map(ProjectPath::into_path_buf)
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
        let target = resolve_graphify_target(&root, &subpath)?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorKind;

    /// A project root with one real file in it, for target resolution.
    fn project() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        std::fs::write(root.join("inside.txt"), "hello").unwrap();
        (dir, root)
    }

    /// Regression for PR #47 review finding: a `subpath` that simply doesn't
    /// exist must stay `NotFound`, not get relabelled as a containment
    /// violation — those are different problems with different fixes.
    #[test]
    fn a_missing_subpath_reports_not_found_not_a_containment_violation() {
        let (_dir, root) = project();
        let err = resolve_graphify_target(&root, "does-not-exist.txt").unwrap_err();
        assert_eq!(err.kind, ErrorKind::NotFound, "{err}");
        assert!(
            !err.message.contains("must stay inside the active project"),
            "a not-found error must not read like a security violation: {err}"
        );
    }

    /// The one case the old blanket rewrap got right: an actual escape is
    /// still reported as `OutsideProject`, with Graphify's own context.
    #[test]
    fn a_traversal_out_of_the_project_is_still_reported_as_outside_project() {
        let (_dir, root) = project();
        let err = resolve_graphify_target(&root, "../../../../../../etc/passwd").unwrap_err();
        assert_eq!(err.kind, ErrorKind::OutsideProject, "{err}");
        assert!(err.message.contains("must stay inside the active project"), "{err}");
    }

    /// A subpath that resolves cleanly still works.
    #[test]
    fn an_existing_subpath_resolves() {
        let (_dir, root) = project();
        let resolved = resolve_graphify_target(&root, "inside.txt").unwrap();
        assert!(resolved.ends_with("inside.txt"));
    }
}
