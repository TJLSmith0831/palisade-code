//! Git operations. Write paths still shell out to the `git` binary (the
//! implementation note for Phase 3 keeps stage/commit/branch/fetch/pull as
//! subprocesses). Read paths are delegated to the [`GitRepo`] abstraction in
//! `git_repo.rs` so they can migrate to `gix` without changing callers.

use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

use crate::git_repo;
use crate::integrations::GRAPH_DIR;
use crate::store::Res;

pub use crate::git_repo::{BranchInfo, FileStatus};

fn run(bin: &Path, root: &Path, args: &[&str]) -> Res<String> {
    let output = Command::new(bin)
        .args(args)
        .current_dir(root)
        .env("PATH", crate::executor::child_path_env())
        .output()
        .map_err(|err| format!("could not run git: {err}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git {} failed:\n{}", args.join(" "), stderr.trim()));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// The commit HEAD points at. Recorded at session open and close so "what did
/// this session change?" has an exact answer for anything committed (D13).
/// `None` when there is no HEAD to read — a project need not be a git repo,
/// and a repo with no commits yet has none.
pub fn rev_parse_head(_bin: &Path, root: &Path) -> Option<String> {
    git_repo::shared_git_repo().rev_parse_head(root)
}

/// The set of paths git reports as dirty, as a sorted list. Compared between
/// session open and close, its delta is "what this session left uncommitted" —
/// exact only while no other session shares the root (D13).
pub fn porcelain_snapshot(_bin: &Path, root: &Path) -> Vec<String> {
    git_repo::shared_git_repo().porcelain_snapshot(root)
}

/// Paths that changed between two commits. This is the *exact* half of
/// attribution: whatever a session committed is recoverable from its HEAD
/// pair, with no inference involved.
pub fn changed_between(_bin: &Path, root: &Path, before: &str, after: &str) -> Res<Vec<String>> {
    git_repo::shared_git_repo().changed_between(root, before, after)
}

/// One entry per changed path, tracked or not — `git diff` alone never lists
/// untracked files, so this is the only way the pane learns about new files.
pub fn status(_bin: &Path, root: &Path) -> Res<Vec<FileStatus>> {
    git_repo::shared_git_repo().status(root)
}

pub fn working_tree_diff(_bin: &Path, root: &Path) -> Res<String> {
    git_repo::shared_git_repo().working_tree_diff(root)
}

pub fn staged_diff(_bin: &Path, root: &Path) -> Res<String> {
    git_repo::shared_git_repo().staged_diff(root)
}

/// Batched read query: status + working diff + staged diff together.
pub fn snapshot(_bin: &Path, root: &Path) -> Res<git_repo::Snapshot> {
    git_repo::shared_git_repo().snapshot(root)
}

/// `patch` is a unified diff for one hunk (or a whole single-hunk file diff)
/// — the frontend reconstructs it from a `StructuredPatch` via jsdiff's
/// `formatPatch` before calling this.
pub fn stage_hunk(bin: &Path, root: &Path, patch: &str) -> Res<()> {
    apply(bin, root, patch, &["apply", "--cached"])
}

/// Per-hunk unstage is `git apply --cached --reverse`, not `git restore
/// --staged` — that command only operates on whole files/whole diffs, not a
/// single hunk (D20 listed both; this is the split between them).
pub fn unstage_hunk(bin: &Path, root: &Path, patch: &str) -> Res<()> {
    apply(bin, root, patch, &["apply", "--cached", "--reverse"])
}

fn apply(bin: &Path, root: &Path, patch: &str, args: &[&str]) -> Res<()> {
    let mut child = Command::new(bin)
        .args(args)
        .arg("-")
        .current_dir(root)
        .env("PATH", crate::executor::child_path_env())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| format!("could not run git apply: {err}"))?;
    child
        .stdin
        .take()
        .ok_or("git apply stdin unavailable")?
        .write_all(patch.as_bytes())
        .map_err(|err| format!("write patch to git apply: {err}"))?;
    let output = child.wait_with_output().map_err(|err| format!("git apply: {err}"))?;
    if !output.status.success() {
        return Err(format!("git apply failed:\n{}", String::from_utf8_lossy(&output.stderr).trim()));
    }
    Ok(())
}

/// Whole-file stage ("stage all" for a file) — also how an untracked file
/// gets staged, since it has no hunks to apply a patch against.
pub fn stage_file(bin: &Path, root: &Path, path: &str) -> Res<()> {
    run(bin, root, &["add", "--", path]).map(|_| ())
}

/// Unstage a whole file. `restore --staged` handles a file already in HEAD;
/// a newly-added file needs `rm --cached`, which `restore` cannot express.
pub fn unstage_file(bin: &Path, root: &Path, path: &str) -> Res<()> {
    if run(bin, root, &["restore", "--staged", "--", path]).is_ok() {
        return Ok(());
    }
    run(bin, root, &["rm", "--cached", "--", path]).map(|_| ())
}

pub fn commit(bin: &Path, root: &Path, message: &str) -> Res<()> {
    run(bin, root, &["commit", "-m", message]).map(|_| ())
}

// ---------------------------------------------------------------- branches

pub fn list_branches(_bin: &Path, root: &Path) -> Res<Vec<BranchInfo>> {
    git_repo::shared_git_repo().list_branches(root)
}

pub fn current_branch_name(_bin: &Path, root: &Path) -> Res<String> {
    git_repo::shared_git_repo().current_branch_name(root)
}

/// A dirty working tree that would be overwritten surfaces git's own error
/// verbatim (D55) — no auto-stash.
pub fn checkout_branch(bin: &Path, root: &Path, name: &str) -> Res<()> {
    run(bin, root, &["checkout", name]).map(|_| ())
}

pub fn create_branch(bin: &Path, root: &Path, name: &str) -> Res<()> {
    run(bin, root, &["checkout", "-b", name]).map(|_| ())
}

/// `-d` (not `-D`): refuses an unmerged branch rather than losing commits —
/// matches "no force-anything" (D55's excluded-risk list).
pub fn delete_branch(bin: &Path, root: &Path, name: &str) -> Res<()> {
    run(bin, root, &["branch", "-d", name]).map(|_| ())
}

// -------------------------------------------------------------- worktrees

/// Where a thread's worktree lives, and what branch it runs on. Both derive
/// from the thread id alone, so a path can be recomputed without reading the
/// thread's metadata back. Worktrees go under `.git/` because that directory
/// is outside the working tree git reports on — a sibling directory inside
/// the project would show up as untracked in every status call.
pub fn worktree_paths(root: &Path, thread_id: &str) -> (std::path::PathBuf, String) {
    let chars: Vec<char> = thread_id.chars().collect();
    let short: String = chars[chars.len().saturating_sub(8)..].iter().collect();
    (
        root.join(".git").join("palisade-worktrees").join(thread_id),
        format!("palisade/{short}"),
    )
}

/// Lines added and removed in this worktree against HEAD — the "+12 −3" the
/// sidebar shows for what a thread has actually done.
///
/// Untracked files count as pure additions. `git diff` never lists them, and
/// a file the agent just created is the most visible change there is, so
/// leaving them out would report "+0 −0" for a thread that wrote a new module.
///
/// ponytail: an untracked *directory* reports as one porcelain entry and is
/// counted as zero. Recurse it if new-directory changes start reading wrong.
pub fn diff_stat(bin: &Path, root: &Path) -> Res<(u32, u32)> {
    let raw = run(bin, root, &["diff", "--numstat", "HEAD"])?;
    let (mut added, mut removed) = (0u32, 0u32);
    for line in raw.lines() {
        let mut cols = line.split('\t');
        // A binary file reports "-\t-": no line counts to add.
        if let (Some(a), Some(r)) = (cols.next(), cols.next()) {
            added += a.parse::<u32>().unwrap_or(0);
            removed += r.parse::<u32>().unwrap_or(0);
        }
    }
    for file in status(bin, root)?.iter().filter(|f| f.code == "??") {
        if let Ok(body) = std::fs::read_to_string(root.join(&file.path)) {
            added += body.lines().count() as u32;
        }
    }
    Ok((added, removed))
}

/// Create the thread's worktree, branching from the project's current HEAD.
/// Returns the path and branch it created. Errors when the project is not a
/// git repo, has no commits yet, or the branch name is already taken — every
/// caller treats that as "fall back to the project root", not as fatal.
pub fn add_worktree(bin: &Path, root: &Path, thread_id: &str) -> Res<(std::path::PathBuf, String)> {
    let (path, branch) = worktree_paths(root, thread_id);
    let path_str = path.to_string_lossy().into_owned();
    run(bin, root, &["worktree", "add", "-b", &branch, &path_str])?;
    Ok((path, branch))
}

/// Remove a thread's worktree and the branch it was on. `--force` because the
/// worktree is Palisade's own and is expected to hold uncommitted agent edits;
/// refusing to clean up after a thread the user deliberately deleted would
/// leak a directory they can't see. The branch delete is best-effort: `-d`
/// leaves an unmerged branch behind rather than force-deleting it, so
/// committed work survives a thread deletion.
pub fn remove_worktree(bin: &Path, root: &Path, path: &Path, branch: Option<&str>) -> Res<()> {
    let path_str = path.to_string_lossy().into_owned();
    run(bin, root, &["worktree", "remove", "--force", &path_str])?;
    if let Some(name) = branch {
        let _ = delete_branch(bin, root, name);
    }
    Ok(())
}

// --------------------------------------------------------- remote sync

pub fn fetch(bin: &Path, root: &Path) -> Res<()> {
    run(bin, root, &["fetch"]).map(|_| ())
}

pub fn pull(bin: &Path, root: &Path) -> Res<String> {
    run(bin, root, &["pull"])
}

/// A new local branch has no upstream yet — the first push sets one
/// (`origin/<branch>`), same as VS Code's own first-push behavior (D55).
/// Every push after that is a plain `git push`.
pub fn push(bin: &Path, root: &Path) -> Res<String> {
    match run(bin, root, &["push"]) {
        Ok(out) => Ok(out),
        Err(err) if err.contains("has no upstream branch") => {
            let branch = current_branch_name(bin, root)?;
            run(bin, root, &["push", "--set-upstream", "origin", &branch])
        }
        Err(err) => Err(err),
    }
}

/// `None` when the current branch has no upstream configured (a brand new
/// local branch) — not an error, just nothing to compare against yet.
pub fn ahead_behind(_bin: &Path, root: &Path) -> Res<Option<(u32, u32)>> {
    git_repo::shared_git_repo().ahead_behind(root)
}

// ------------------------------------------------------- discard + init

/// The everyday "undo this" next to a changed file (distinct from unstage).
/// `untracked` comes from the caller's already-fetched `status()` — an
/// untracked file has nothing in HEAD to revert to, so discarding it means
/// deleting it instead of `git checkout --`.
pub fn discard_file(bin: &Path, root: &Path, path: &str, untracked: bool) -> Res<()> {
    if untracked {
        // A project that doesn't gitignore `graphify-out/` reports it as one
        // untracked directory entry, so "discard changes" on it means
        // `remove_dir_all` on the whole code graph — minutes of extraction, and
        // every graph tool broken until it's rebuilt. The graph is
        // Palisade-managed state, not the user's uncommitted work, so this
        // button doesn't get to delete it; removing it stays a deliberate act
        // outside the diff pane.
        if path.trim_end_matches('/') == GRAPH_DIR {
            return Err(format!(
                "{GRAPH_DIR}/ holds this project's code graph, which Palisade maintains — \
                 discarding changes won't delete it. Remove the folder yourself if you \
                 really want it gone."
            ));
        }
        let full = root.join(path);
        // An untracked directory (git status reports it as one entry, e.g.
        // "graphify-out/") needs remove_dir_all — remove_file only deletes
        // a single file and errors ("Operation not permitted") on a dir.
        let result = if full.is_dir() { std::fs::remove_dir_all(&full) } else { std::fs::remove_file(&full) };
        result.map_err(|err| format!("could not delete {path}: {err}"))
    } else {
        run(bin, root, &["checkout", "--", path]).map(|_| ())
    }
}

/// The folder name `git clone <url>` would produce, without asking git.
fn clone_dir_name(url: &str) -> String {
    let trimmed = url.trim_end_matches('/');
    let last = trimmed.rsplit(['/', ':']).next().unwrap_or("");
    let name = last.strip_suffix(".git").unwrap_or(last);
    if name.is_empty() {
        "repository".to_string()
    } else {
        name.to_string()
    }
}

/// Clone `url` into `parent`, returning the created directory.
///
/// Amendment 8's Clone Repository card. Refuses rather than overwrites when
/// the target already exists — silently cloning into an occupied directory
/// is how someone loses uncommitted work.
pub fn clone(bin: &Path, url: &str, parent: &Path) -> Res<std::path::PathBuf> {
    let target = parent.join(clone_dir_name(url));
    if target.exists() {
        return Err(format!("{} already exists", target.display()));
    }
    run(bin, parent, &["clone", url, target.to_str().ok_or("bad path")?])?;
    Ok(target)
}

/// One row of Amendment 7's read-only commit graph.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct LogEntry {
    pub hash: String,
    pub subject: String,
    pub author: String,
    /// Author date, ISO-8601. Without it the graph shows a name and nothing
    /// else — a reviewer looking for recency had to go back to `git log`.
    pub date: String,
}

/// The newest `limit` commits on HEAD, newest first.
///
/// Fields are separated by US (0x1f) and records by RS (0x1e) rather than a
/// printable delimiter, so a commit subject containing the separator can't
/// split into phantom fields. A repo with no commits yet yields an empty log
/// rather than an error — `git log` exits non-zero there, and the panel has
/// to render on a freshly-`init`ed project.
pub fn log(bin: &Path, root: &Path, limit: u32) -> Res<Vec<LogEntry>> {
    if rev_parse_head(bin, root).is_none() {
        return Ok(vec![]);
    }
    let count = format!("-{limit}");
    let raw = run(bin, root, &[
        "log",
        &count,
        "--no-color",
        "--pretty=format:%H\x1f%s\x1f%an\x1f%aI\x1e",
    ])?;
    Ok(raw
        .split('\x1e')
        .map(str::trim_start)
        .filter(|record| !record.is_empty())
        .filter_map(|record| {
            // A subject containing US stays whole only because everything
            // after it is taken from the *end*, splitting from the right.
            let (hash, rest) = record.split_once('\x1f')?;
            let (rest, date) = rest.rsplit_once('\x1f')?;
            let (subject, author) = rest.rsplit_once('\x1f')?;
            Some(LogEntry {
                hash: hash.to_string(),
                subject: subject.to_string(),
                author: author.to_string(),
                date: date.to_string(),
            })
        })
        .collect())
}

pub fn is_git_repo(_bin: &Path, root: &Path) -> bool {
    git_repo::shared_git_repo().is_git_repo(root)
}

pub fn init_repo(bin: &Path, root: &Path) -> Res<()> {
    run(bin, root, &["init"]).map(|_| ())
}

/// Paths `git` itself would ignore, one entry per top-level ignored file or
/// directory (`--directory` collapses a whole ignored tree like
/// `graphify-out/` into a single entry instead of walking every file inside
/// it). Empty rather than erroring outside a git repo — callers like the
/// file palette work on any project; ignore-awareness is a nicety on top.
pub fn ignored_paths(bin: &Path, root: &Path) -> std::collections::HashSet<String> {
    run(
        bin,
        root,
        &["ls-files", "--others", "--ignored", "--exclude-standard", "--directory"],
    )
    .map(|out| out.lines().map(str::to_string).filter(|s| !s.is_empty()).collect())
    .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn git() -> &'static Path {
        Path::new("git")
    }

    /// A throwaway repo with one committed file, ready for working-tree edits.
    fn init_test_repo() -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        run(git(), root, &["init", "-q", "-b", "main"]).unwrap();
        run(git(), root, &["config", "user.email", "test@example.com"]).unwrap();
        run(git(), root, &["config", "user.name", "Test"]).unwrap();
        fs::write(root.join("tracked.txt"), "line one\nline two\nline three\n").unwrap();
        run(git(), root, &["add", "-A"]).unwrap();
        run(git(), root, &["commit", "-q", "-m", "initial"]).unwrap();
        (dir, "tracked.txt".to_string())
    }

    /// Task 5.9: a session that commits has a distinct HEAD pair, and what it
    /// committed is recoverable exactly — no inference, no heuristic.
    #[test]
    fn a_session_that_commits_moves_head_and_one_that_does_not_leaves_it_alone() {
        let (dir, tracked) = init_test_repo();
        let root = dir.path();

        // A session that commits nothing: identical before/after.
        let before = rev_parse_head(git(), root).unwrap();
        fs::write(root.join(&tracked), "line one\nedited but not committed\n").unwrap();
        assert_eq!(rev_parse_head(git(), root).as_deref(), Some(before.as_str()));

        // A session that commits: distinct heads, and the exact file list.
        run(git(), root, &["add", "-A"]).unwrap();
        run(git(), root, &["commit", "-q", "-m", "session work"]).unwrap();
        let after = rev_parse_head(git(), root).unwrap();
        assert_ne!(before, after);
        assert_eq!(changed_between(git(), root, &before, &after).unwrap(), vec![tracked.clone()]);

        // And with no commits between them, the diff is empty rather than a guess.
        assert!(changed_between(git(), root, &after, &after).unwrap().is_empty());
    }

    /// The uncommitted half: the delta between two porcelain snapshots is what
    /// appeared while the session ran.
    #[test]
    fn the_porcelain_delta_is_what_appeared_since_the_snapshot() {
        let (dir, tracked) = init_test_repo();
        let root = dir.path();
        fs::write(root.join(&tracked), "already dirty before the session\n").unwrap();

        let opened = porcelain_snapshot(git(), root);
        assert_eq!(opened, vec![tracked.clone()]);

        fs::write(root.join("session-made-this.txt"), "new\n").unwrap();
        let closed = porcelain_snapshot(git(), root);
        let delta: Vec<&String> = closed.iter().filter(|p| !opened.contains(p)).collect();
        assert_eq!(delta, vec!["session-made-this.txt"], "the pre-existing edit is not attributed");
    }

    /// A project need not be a git repo — that's a normal state, and the
    /// attribution layer has to degrade rather than error.
    #[test]
    fn a_non_repo_has_no_head_and_an_empty_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(rev_parse_head(git(), dir.path()), None);
        assert!(porcelain_snapshot(git(), dir.path()).is_empty());
    }

    #[test]
    fn status_lists_a_modified_tracked_file_and_an_untracked_file() {
        let (dir, tracked) = init_test_repo();
        let root = dir.path();
        fs::write(root.join(&tracked), "line one\nCHANGED\nline three\n").unwrap();
        fs::write(root.join("new.txt"), "brand new\n").unwrap();

        let found = status(git(), root).unwrap();
        assert!(found.iter().any(|f| f.path == tracked && f.code.trim() == "M"));
        assert!(found.iter().any(|f| f.path == "new.txt" && f.code == "??"));
    }

    #[test]
    fn working_tree_diff_shows_unstaged_changes_staged_diff_does_not() {
        let (dir, tracked) = init_test_repo();
        let root = dir.path();
        fs::write(root.join(&tracked), "line one\nCHANGED\nline three\n").unwrap();

        assert!(working_tree_diff(git(), root).unwrap().contains("CHANGED"));
        assert_eq!(staged_diff(git(), root).unwrap(), "");
    }

    #[test]
    fn stage_hunk_then_unstage_hunk_round_trips() {
        let (dir, tracked) = init_test_repo();
        let root = dir.path();
        fs::write(root.join(&tracked), "line one\nCHANGED\nline three\n").unwrap();

        let patch = working_tree_diff(git(), root).unwrap();
        stage_hunk(git(), root, &patch).unwrap();

        assert!(staged_diff(git(), root).unwrap().contains("CHANGED"));
        assert_eq!(working_tree_diff(git(), root).unwrap(), "", "fully staged — nothing left unstaged");

        unstage_hunk(git(), root, &patch).unwrap();

        assert_eq!(staged_diff(git(), root).unwrap(), "");
        assert!(working_tree_diff(git(), root).unwrap().contains("CHANGED"));
    }

    #[test]
    fn commit_records_staged_changes() {
        let (dir, tracked) = init_test_repo();
        let root = dir.path();
        fs::write(root.join(&tracked), "line one\nCHANGED\nline three\n").unwrap();
        stage_file(git(), root, &tracked).unwrap();

        commit(git(), root, "a real commit message").unwrap();

        assert_eq!(staged_diff(git(), root).unwrap(), "");
        let log = run(git(), root, &["log", "--oneline", "-1"]).unwrap();
        assert!(log.contains("a real commit message"));
    }

    #[test]
    fn stage_file_stages_an_untracked_file() {
        let (dir, _tracked) = init_test_repo();
        let root = dir.path();
        fs::write(root.join("new.txt"), "brand new\n").unwrap();

        stage_file(git(), root, "new.txt").unwrap();

        assert!(staged_diff(git(), root).unwrap().contains("brand new"));
    }

    // ------------------------------------------------------------ branches

    #[test]
    fn parse_local_branches_marks_the_current_branch() {
        let branches = crate::git_repo::parse_local_branches("feature\t\nmain\t*\n");
        assert_eq!(
            branches,
            vec![
                BranchInfo { name: "feature".into(), is_current: false, is_remote: false },
                BranchInfo { name: "main".into(), is_current: true, is_remote: false },
            ]
        );
    }

    #[test]
    fn parse_remote_branches_skips_the_symbolic_head_pointer() {
        let branches = crate::git_repo::parse_remote_branches("origin/HEAD\norigin/main\n");
        assert_eq!(branches, vec![BranchInfo { name: "origin/main".into(), is_current: false, is_remote: true }]);
    }

    #[test]
    fn checkout_branch_blocked_by_dirty_tree_surfaces_gits_own_error() {
        let (dir, tracked) = init_test_repo();
        let root = dir.path();
        // `other` commits a different value for the same line `main` has.
        create_branch(git(), root, "other").unwrap();
        fs::write(root.join(&tracked), "line one\nFROM-OTHER\nline three\n").unwrap();
        run(git(), root, &["commit", "-q", "-am", "change on other"]).unwrap();
        checkout_branch(git(), root, "main").unwrap();
        // An uncommitted, different-again change to that same line — neither
        // matches main's committed version nor other's, so switching would
        // discard it. Git must refuse rather than silently overwrite it.
        fs::write(root.join(&tracked), "line one\nUNCOMMITTED\nline three\n").unwrap();

        let err = checkout_branch(git(), root, "other").unwrap_err();

        assert!(err.contains("would be overwritten") || err.contains("Please commit"), "unexpected error: {err}");
        // No auto-stash: still on main, uncommitted change untouched.
        assert_eq!(current_branch_name(git(), root).unwrap(), "main");
        assert_eq!(fs::read_to_string(root.join(&tracked)).unwrap(), "line one\nUNCOMMITTED\nline three\n");
    }

    #[test]
    fn create_branch_switches_to_a_new_branch() {
        let (dir, _tracked) = init_test_repo();
        let root = dir.path();

        create_branch(git(), root, "feature").unwrap();

        assert_eq!(current_branch_name(git(), root).unwrap(), "feature");
        let branches = list_branches(git(), root).unwrap();
        assert!(branches.iter().any(|b| b.name == "feature" && b.is_current));
    }

    #[test]
    fn delete_branch_removes_a_merged_local_branch() {
        let (dir, _tracked) = init_test_repo();
        let root = dir.path();
        run(git(), root, &["branch", "throwaway"]).unwrap();

        delete_branch(git(), root, "throwaway").unwrap();

        assert!(!list_branches(git(), root).unwrap().iter().any(|b| b.name == "throwaway"));
    }

    // --------------------------------------------------------- remote sync

    fn init_bare_remote() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        run(git(), dir.path(), &["init", "--bare", "-q"]).unwrap();
        dir
    }

    /// A repo with `origin` pointing at a local bare repo — push/pull/fetch
    /// exercise the real commands with zero network involvement.
    fn init_repo_with_remote() -> (tempfile::TempDir, tempfile::TempDir, String) {
        let remote = init_bare_remote();
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        run(git(), root, &["init", "-q", "-b", "main"]).unwrap();
        run(git(), root, &["config", "user.email", "test@example.com"]).unwrap();
        run(git(), root, &["config", "user.name", "Test"]).unwrap();
        run(git(), root, &["remote", "add", "origin", remote.path().to_str().unwrap()]).unwrap();
        fs::write(root.join("tracked.txt"), "line one\n").unwrap();
        run(git(), root, &["add", "-A"]).unwrap();
        run(git(), root, &["commit", "-q", "-m", "initial"]).unwrap();
        (dir, remote, "tracked.txt".to_string())
    }

    #[test]
    fn ahead_behind_is_none_on_a_freshly_initialized_repo_with_no_commits_yet() {
        // Distinct from "no upstream configured" — HEAD itself doesn't
        // exist yet on a brand new `git init`. Both must return None, not
        // propagate git's (very different) error text for each case.
        let dir = tempfile::tempdir().unwrap();
        init_repo(git(), dir.path()).unwrap();

        assert_eq!(ahead_behind(git(), dir.path()).unwrap(), None);
    }

    #[test]
    fn unstaging_puts_a_modified_file_back_in_the_working_tree() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(git(), dir.path()).unwrap();
        std::fs::write(dir.path().join("a.txt"), "one").unwrap();
        stage_file(git(), dir.path(), "a.txt").unwrap();
        commit(git(), dir.path(), "add a").unwrap();

        std::fs::write(dir.path().join("a.txt"), "two").unwrap();
        stage_file(git(), dir.path(), "a.txt").unwrap();
        assert!(staged_diff(git(), dir.path()).unwrap().contains("two"));

        unstage_file(git(), dir.path(), "a.txt").unwrap();
        assert!(staged_diff(git(), dir.path()).unwrap().trim().is_empty());
        assert!(working_tree_diff(git(), dir.path()).unwrap().contains("two"));
    }

    #[test]
    fn unstaging_a_newly_added_file_makes_it_untracked_again() {
        // `git restore --staged` cannot express this case for a file that
        // has never been committed — it needs `rm --cached`.
        let dir = tempfile::tempdir().unwrap();
        init_repo(git(), dir.path()).unwrap();
        std::fs::write(dir.path().join("a.txt"), "one").unwrap();
        stage_file(git(), dir.path(), "a.txt").unwrap();
        commit(git(), dir.path(), "first").unwrap();

        std::fs::write(dir.path().join("new.txt"), "hello").unwrap();
        stage_file(git(), dir.path(), "new.txt").unwrap();
        unstage_file(git(), dir.path(), "new.txt").unwrap();

        let codes: Vec<String> = status(git(), dir.path())
            .unwrap()
            .into_iter()
            .filter(|f| f.path == "new.txt")
            .map(|f| f.code)
            .collect();
        assert_eq!(codes, vec!["??".to_string()]);
        // Unstaging must never delete the file itself.
        assert!(dir.path().join("new.txt").exists());
    }

    #[test]
    fn an_untracked_directory_is_listed_as_its_files_not_as_the_directory() {
        // A row naming a directory can't be opened, diffed or staged — the
        // UI showed "cannot read file: Is a directory" when one was clicked.
        let dir = tempfile::tempdir().unwrap();
        init_repo(git(), dir.path()).unwrap();
        std::fs::create_dir_all(dir.path().join("newdir/nested")).unwrap();
        std::fs::write(dir.path().join("newdir/a.txt"), "a").unwrap();
        std::fs::write(dir.path().join("newdir/nested/b.txt"), "b").unwrap();

        let paths: Vec<String> =
            status(git(), dir.path()).unwrap().into_iter().map(|f| f.path).collect();
        assert!(paths.contains(&"newdir/a.txt".to_string()), "{paths:?}");
        assert!(paths.contains(&"newdir/nested/b.txt".to_string()), "{paths:?}");
        assert!(!paths.iter().any(|p| p.ends_with('/')), "{paths:?}");
    }

    #[test]
    fn push_auto_sets_upstream_on_first_push_to_a_new_branch() {
        let (dir, _remote, _tracked) = init_repo_with_remote();
        let root = dir.path();
        assert_eq!(ahead_behind(git(), root).unwrap(), None, "no upstream yet");

        push(git(), root).unwrap();

        let branch = current_branch_name(git(), root).unwrap();
        let upstream = run(git(), root, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).unwrap();
        assert_eq!(upstream.trim(), format!("origin/{branch}"));
    }

    #[test]
    fn fetch_then_pull_bring_in_a_remote_commit() {
        let (dir_a, remote, tracked) = init_repo_with_remote();
        push(git(), dir_a.path()).unwrap();

        // A second clone of the same remote makes an upstream commit.
        let dir_b = tempfile::tempdir().unwrap();
        run(git(), dir_b.path(), &["clone", "-q", remote.path().to_str().unwrap(), "."]).unwrap();
        run(git(), dir_b.path(), &["config", "user.email", "b@example.com"]).unwrap();
        run(git(), dir_b.path(), &["config", "user.name", "B"]).unwrap();
        fs::write(dir_b.path().join(&tracked), "line one\nfrom b\n").unwrap();
        run(git(), dir_b.path(), &["commit", "-q", "-am", "from b"]).unwrap();
        push(git(), dir_b.path()).unwrap();

        fetch(git(), dir_a.path()).unwrap();
        assert_eq!(ahead_behind(git(), dir_a.path()).unwrap(), Some((0, 1)));

        pull(git(), dir_a.path()).unwrap();
        assert_eq!(ahead_behind(git(), dir_a.path()).unwrap(), Some((0, 0)));
        assert_eq!(fs::read_to_string(dir_a.path().join(&tracked)).unwrap(), "line one\nfrom b\n");
    }

    // ------------------------------------------------------------- discard

    #[test]
    fn discard_file_deletes_an_untracked_file() {
        let (dir, _tracked) = init_test_repo();
        let root = dir.path();
        fs::write(root.join("scratch.txt"), "temp\n").unwrap();

        discard_file(git(), root, "scratch.txt", true).unwrap();

        assert!(!root.join("scratch.txt").exists());
    }

    #[test]
    fn discard_file_deletes_an_untracked_directory() {
        // status() reports a wholly-untracked directory as one entry
        // ("scratch-dir/") — remove_file alone can't delete it.
        let (dir, _tracked) = init_test_repo();
        let root = dir.path();
        fs::create_dir(root.join("scratch-dir")).unwrap();
        fs::write(root.join("scratch-dir/inner.txt"), "temp\n").unwrap();

        discard_file(git(), root, "scratch-dir/", true).unwrap();

        assert!(!root.join("scratch-dir").exists());
    }

    /// RED→GREEN: in a project that doesn't gitignore it, `graphify-out/` shows
    /// up in `git status` as one untracked directory entry, and "discard" then
    /// means `remove_dir_all` on the whole code graph — minutes of extraction
    /// gone, from a button whose confirm dialog says "discard changes". The
    /// graph is Palisade-managed state, not the user's uncommitted work.
    #[test]
    fn discard_file_refuses_to_delete_the_code_graph() {
        let (dir, _tracked) = init_test_repo();
        let root = dir.path();
        let out = root.join("graphify-out");
        fs::create_dir(&out).unwrap();
        fs::write(out.join("graph.json"), "{}").unwrap();

        let error = discard_file(git(), root, "graphify-out/", true).unwrap_err();

        assert!(out.join("graph.json").exists(), "the graph must survive a discard");
        assert!(error.contains("graphify-out"), "the error should name what it refused: {error}");
    }

    /// The guard keys on the graph directory itself, not on anything that
    /// merely lives beneath it — a stray file inside stays discardable.
    // -------------------------------------------------------- ignored_paths

    /// FIL-02: the file palette walked the whole tree with only a hardcoded
    /// name-skip (`.git`, `node_modules`, `target`, `__pycache__`) — a
    /// project-specific `.gitignore` entry like `graphify-out/` was invisible
    /// to it and leaked hundreds of generated-cache files into the palette.
    #[test]
    fn ignored_paths_reports_a_gitignored_directory_as_one_entry() {
        let (dir, _tracked) = init_test_repo();
        let root = dir.path();
        fs::write(root.join(".gitignore"), "graphify-out/\n").unwrap();
        fs::create_dir(root.join("graphify-out")).unwrap();
        fs::write(root.join("graphify-out/graph.json"), "{}").unwrap();
        fs::write(root.join("graphify-out/cache.bin"), "x").unwrap();

        let ignored = ignored_paths(git(), root);

        assert!(
            ignored.contains("graphify-out/"),
            "expected the whole ignored dir as one entry, got {ignored:?}"
        );
    }

    /// Outside a git repo the palette must keep working — ignore-awareness is
    /// a nicety on top of listing files, not a precondition for it.
    #[test]
    fn ignored_paths_is_empty_outside_a_git_repo() {
        let dir = tempfile::tempdir().unwrap();
        assert!(ignored_paths(git(), dir.path()).is_empty());
    }

    #[test]
    fn discard_file_still_deletes_a_sibling_of_the_code_graph() {
        let (dir, _tracked) = init_test_repo();
        let root = dir.path();
        fs::create_dir(root.join("graphify-outtakes")).unwrap();
        fs::write(root.join("graphify-outtakes/x.txt"), "temp\n").unwrap();

        discard_file(git(), root, "graphify-outtakes/", true).unwrap();

        assert!(!root.join("graphify-outtakes").exists());
    }

    #[test]
    fn discard_file_reverts_a_tracked_files_changes() {
        let (dir, tracked) = init_test_repo();
        let root = dir.path();
        fs::write(root.join(&tracked), "line one\nCHANGED\nline three\n").unwrap();

        discard_file(git(), root, &tracked, false).unwrap();

        assert_eq!(fs::read_to_string(root.join(&tracked)).unwrap(), "line one\nline two\nline three\n");
        assert_eq!(working_tree_diff(git(), root).unwrap(), "");
    }

    // --------------------------------------------------------------- clone

    #[test]
    fn clone_creates_a_directory_named_after_the_repo() {
        let (source, _) = init_test_repo();
        let parent = tempfile::tempdir().unwrap();

        let cloned = clone(git(), source.path().to_str().unwrap(), parent.path()).unwrap();

        assert!(cloned.join(".git").exists());
        assert!(cloned.join("tracked.txt").exists());
        assert_eq!(cloned.parent().unwrap(), parent.path());
    }

    /// A trailing `.git` and trailing slashes must not leak into the folder
    /// name — `…/repo.git/` should clone to `repo`, not `repo.git`.
    #[test]
    fn clone_target_name_strips_dot_git_and_trailing_slashes() {
        assert_eq!(clone_dir_name("https://example.com/x/repo.git"), "repo");
        assert_eq!(clone_dir_name("https://example.com/x/repo.git/"), "repo");
        assert_eq!(clone_dir_name("git@example.com:x/repo.git"), "repo");
        assert_eq!(clone_dir_name("https://example.com/x/repo"), "repo");
    }

    #[test]
    fn clone_target_name_falls_back_rather_than_returning_empty() {
        assert_eq!(clone_dir_name("///"), "repository");
        assert_eq!(clone_dir_name(""), "repository");
    }

    // ----------------------------------------------------------------- log

    /// Amendment 7's commit graph reads newest-first and carries the subject
    /// and author it renders — a parser, so it gets a test.
    #[test]
    fn log_returns_newest_first_with_subject_and_author() {
        let (dir, tracked) = init_test_repo();
        let root = dir.path();
        fs::write(root.join(&tracked), "second revision\n").unwrap();
        run(git(), root, &["add", "-A"]).unwrap();
        run(git(), root, &["commit", "-q", "-m", "second commit"]).unwrap();

        let entries = log(git(), root, 10).unwrap();

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].subject, "second commit");
        assert_eq!(entries[1].subject, "initial");
        assert_eq!(entries[0].author, "Test");
        assert_eq!(entries[0].hash.len(), 40);
        // The graph shows recency; a name on its own sent a reviewer back
        // to `git log` to find out when anything happened.
        assert!(
            entries[0].date.starts_with("20") && entries[0].date.contains('T'),
            "{}",
            entries[0].date
        );
    }

    /// A subject containing the field separator must not split into extra
    /// fields — the classic naive-split bug.
    #[test]
    fn log_keeps_a_subject_that_contains_the_field_separator_intact() {
        let (dir, tracked) = init_test_repo();
        let root = dir.path();
        fs::write(root.join(&tracked), "third\n").unwrap();
        run(git(), root, &["add", "-A"]).unwrap();
        run(git(), root, &["commit", "-q", "-m", "fix: a\x1fb separator"]).unwrap();

        let entries = log(git(), root, 1).unwrap();

        assert_eq!(entries[0].subject, "fix: a\x1fb separator");
    }

    /// A repo with no commits yet has an empty log, not an error — the panel
    /// renders on a fresh `git init` project.
    #[test]
    fn log_is_empty_in_a_repo_with_no_commits() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(git(), dir.path()).unwrap();

        assert_eq!(log(git(), dir.path(), 10).unwrap(), vec![]);
    }

    // --------------------------------------------------------- init / repo

    #[test]
    fn is_git_repo_is_false_outside_a_repo_and_true_after_init() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!is_git_repo(git(), dir.path()));

        init_repo(git(), dir.path()).unwrap();

        assert!(is_git_repo(git(), dir.path()));
    }

    // ----------------------------------------------------------- worktrees

    /// The isolation the whole feature rests on: an edit in one thread's
    /// worktree is invisible to another thread's, and to the project root.
    #[test]
    fn two_threads_get_separate_worktrees_that_do_not_see_each_others_edits() {
        let (dir, tracked) = init_test_repo();
        let root = dir.path();

        let (path_a, branch_a) = add_worktree(git(), root, "01THREADAAAA").unwrap();
        let (path_b, branch_b) = add_worktree(git(), root, "01THREADBBBB").unwrap();
        assert_ne!(path_a, path_b);
        assert_ne!(branch_a, branch_b);

        fs::write(path_a.join(&tracked), "edited by thread A\n").unwrap();

        assert_eq!(porcelain_snapshot(git(), &path_a), vec![tracked.clone()]);
        assert!(porcelain_snapshot(git(), &path_b).is_empty(), "B must not see A's edit");
        assert!(porcelain_snapshot(git(), root).is_empty(), "root must not see A's edit");
    }

    /// A thread's second session must reuse the first one's worktree — asking
    /// git for the same one twice is an error, which is what makes the
    /// recorded path (not a fresh `add`) the reuse path in `thread_worktree`.
    #[test]
    fn adding_the_same_threads_worktree_twice_fails() {
        let (dir, _) = init_test_repo();
        let root = dir.path();

        add_worktree(git(), root, "01THREADAAAA").unwrap();

        assert!(add_worktree(git(), root, "01THREADAAAA").is_err());
    }

    /// Deleting a thread takes its worktree with it, uncommitted edits and
    /// all — otherwise the directory leaks where the user cannot see it.
    #[test]
    fn removing_a_worktree_deletes_it_even_with_uncommitted_edits() {
        let (dir, tracked) = init_test_repo();
        let root = dir.path();
        let (path, branch) = add_worktree(git(), root, "01THREADAAAA").unwrap();
        fs::write(path.join(&tracked), "uncommitted\n").unwrap();

        remove_worktree(git(), root, &path, Some(&branch)).unwrap();

        assert!(!path.exists());
        let branches = list_branches(git(), root).unwrap();
        assert!(!branches.iter().any(|b| b.name == branch), "branch should be gone too");
    }

    /// Committed work outlives the thread that made it: `remove_worktree`
    /// deletes the branch with `-d`, so an unmerged branch is left behind.
    #[test]
    fn removing_a_worktree_keeps_a_branch_that_has_unmerged_commits() {
        let (dir, tracked) = init_test_repo();
        let root = dir.path();
        let (path, branch) = add_worktree(git(), root, "01THREADAAAA").unwrap();
        fs::write(path.join(&tracked), "committed in the worktree\n").unwrap();
        run(git(), &path, &["add", "-A"]).unwrap();
        run(git(), &path, &["commit", "-q", "-m", "work"]).unwrap();

        remove_worktree(git(), root, &path, Some(&branch)).unwrap();

        assert!(!path.exists());
        let branches = list_branches(git(), root).unwrap();
        assert!(branches.iter().any(|b| b.name == branch), "unmerged commits must survive");
    }

    /// The worktree lives under `.git/`, which git does not report on — a
    /// sibling inside the project would show as untracked in every status.
    #[test]
    fn worktrees_do_not_show_up_as_untracked_files_in_the_project() {
        let (dir, _) = init_test_repo();
        let root = dir.path();

        add_worktree(git(), root, "01THREADAAAA").unwrap();

        assert!(porcelain_snapshot(git(), root).is_empty());
    }

    /// A non-repo project has no worktree to make — the caller falls back to
    /// the project root, silently, because it never had isolation to lose.
    #[test]
    fn adding_a_worktree_outside_a_repo_fails() {
        let dir = tempfile::tempdir().unwrap();

        assert!(add_worktree(git(), dir.path(), "01THREADAAAA").is_err());
    }

    /// A new file is the most visible thing an agent does, and `git diff`
    /// never lists untracked paths — so an unmodified counter would report
    /// "+0 −0" for a thread that just wrote a module.
    #[test]
    fn diff_stat_counts_edits_and_untracked_new_files() {
        let (dir, tracked) = init_test_repo();
        let root = dir.path();
        assert_eq!(diff_stat(git(), root).unwrap(), (0, 0));

        // Was 3 lines; now 2 lines with one of them new.
        fs::write(root.join(&tracked), "line one\nchanged\n").unwrap();
        assert_eq!(diff_stat(git(), root).unwrap(), (1, 2));

        fs::write(root.join("brand_new.txt"), "a\nb\nc\n").unwrap();
        assert_eq!(diff_stat(git(), root).unwrap(), (4, 2));
    }

    /// Each thread's stat reflects only its own worktree.
    #[test]
    fn diff_stat_is_per_worktree() {
        let (dir, tracked) = init_test_repo();
        let root = dir.path();
        let (path_a, _) = add_worktree(git(), root, "01THREADAAAA").unwrap();
        let (path_b, _) = add_worktree(git(), root, "01THREADBBBB").unwrap();

        fs::write(path_a.join(&tracked), "only A edited this\n").unwrap();

        assert_eq!(diff_stat(git(), &path_a).unwrap(), (1, 3));
        assert_eq!(diff_stat(git(), &path_b).unwrap(), (0, 0));
    }

    #[test]
    fn worktree_branch_is_namespaced_and_path_is_keyed_by_thread_id() {
        let (path, branch) = worktree_paths(Path::new("/proj"), "01ABCDEFGHIJKLMNOP");

        assert_eq!(branch, "palisade/IJKLMNOP");
        assert_eq!(path, Path::new("/proj/.git/palisade-worktrees/01ABCDEFGHIJKLMNOP"));
    }
}
