//! Git operations. Write paths still shell out to the `git` binary (the
//! implementation note for Phase 3 keeps stage/commit/branch/fetch/pull as
//! subprocesses). Read paths are delegated to the [`GitRepo`] abstraction in
//! `git_repo.rs` so they can migrate to `gix` without changing callers.

use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

use crate::git_repo;
use crate::store::Res;

pub use crate::git_repo::{BranchInfo, FileStatus};

fn run(bin: &Path, root: &Path, args: &[&str]) -> Res<String> {
    let output = Command::new(bin)
        .args(args)
        .current_dir(root)
        .env("PATH", crate::executor::child_path_env())
        .output()
        .map_err(|err| crate::PalisadeError::from(format!("could not run git: {err}")))?;
    if !output.status.success() {
        // git reports some failures entirely on stdout ("nothing to commit"),
        // so stderr alone can leave the error blank and undiagnosable.
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let detail = [stderr.trim(), stdout.trim()].iter().filter(|s| !s.is_empty()).cloned().collect::<Vec<_>>().join("\n");
        return Err(format!("git {} failed:\n{}", args.join(" "), detail).into());
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

pub fn diff_from(_bin: &Path, root: &Path, rev: &str) -> Res<String> {
    git_repo::shared_git_repo().diff_from(root, rev)
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
        .map_err(|err| crate::PalisadeError::from(format!("could not run git apply: {err}")))?;
    child
        .stdin
        .take()
        .ok_or("git apply stdin unavailable")?
        .write_all(patch.as_bytes())
        .map_err(|err| crate::PalisadeError::from(format!("write patch to git apply: {err}")))?;
    let output = child.wait_with_output().map_err(|err| crate::PalisadeError::from(format!("git apply: {err}")))?;
    if !output.status.success() {
        return Err(format!("git apply failed:\n{}", String::from_utf8_lossy(&output.stderr).trim()).into());
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
/// Every worktree of this repo that currently has a branch checked out, as
/// `(branch, path)`. A detached worktree contributes no entry.
///
/// `git worktree list --porcelain` emits one blank-line-separated record per
/// worktree, with `worktree <path>` first and an optional `branch
/// refs/heads/<name>` line.
pub fn worktree_branches(bin: &Path, root: &Path) -> Res<Vec<(String, std::path::PathBuf)>> {
    let raw = run(bin, root, &["worktree", "list", "--porcelain"])?;
    let mut out = vec![];
    let mut path: Option<std::path::PathBuf> = None;
    for line in raw.lines() {
        if let Some(rest) = line.strip_prefix("worktree ") {
            path = Some(std::path::PathBuf::from(rest));
        } else if let Some(rest) = line.strip_prefix("branch refs/heads/") {
            if let Some(p) = path.clone() {
                out.push((rest.to_string(), p));
            }
        }
    }
    Ok(out)
}

/// Which worktree holds `name` checked out, if any other than `root` itself.
pub fn worktree_holding(bin: &Path, root: &Path, name: &str) -> Option<std::path::PathBuf> {
    let here = root.canonicalize().ok();
    worktree_branches(bin, root)
        .ok()?
        .into_iter()
        .find(|(branch, path)| branch == name && path.canonicalize().ok() != here)
        .map(|(_, path)| path)
}

/// Git refuses to check out a branch another worktree already holds, and says
/// so with a `fatal:` line naming a path the user never chose.
///
/// The UI does not normally reach this: picking a held branch opens that
/// worktree as a workspace instead — the branch picker asks
/// [`worktree_holding`] first. This stays as the backstop, for the race where
/// a worktree appears between that check and this call and for any caller
/// that skips the check, so the failure explains itself rather than leaking
/// git's message about a directory the user has no context for.
pub fn checkout_branch(bin: &Path, root: &Path, name: &str) -> Res<()> {
    if let Some(path) = worktree_holding(bin, root, name) {
        return Err(format!(
            "`{name}` is already checked out in another worktree ({}). A branch can only live in one worktree at a time \u{2014} open that worktree to work on it, or pick a different branch here.",
            path.display()
        ).into());
    }
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

/// Raw `git diff --numstat <rev>`: one `added\tremoved\tpath` line per tracked
/// file in the working tree that differs from `rev`. Callers that need the
/// paths (the Fleet board, the Review lane) parse this. `rev` is `HEAD` for
/// "what is uncommitted right here" and a merge base for "what this thread
/// has done since it branched".
pub fn diff_numstat(bin: &Path, root: &Path, rev: &str) -> Res<String> {
    run(bin, root, &["diff", "--numstat", rev])
}

/// The commit `base` and this tree's HEAD last shared — where the thread's
/// branch diverged. Diffing from here rather than from HEAD is what keeps
/// work the thread already committed counted as work it did.
///
/// `None` when there is no shared history to find (an unborn HEAD, an
/// unrelated ref, no git). Callers then fall back to `HEAD`, which is the
/// old uncommitted-only measurement.
pub fn merge_base(bin: &Path, root: &Path, base: &str) -> Option<String> {
    let rev = run(bin, root, &["merge-base", base, "HEAD"]).ok()?.trim().to_string();
    (!rev.is_empty()).then_some(rev)
}

/// The branch a thread's work would merge into: the one recorded when its
/// worktree was cut, else the branch checked out in `root` now, else `HEAD`.
/// Every surface that measures or merges a thread reads this one rule, so a
/// thread cannot show one diff on the board and another in the Review lane.
pub fn base_or_current(bin: &Path, root: &Path, recorded: Option<&str>) -> String {
    recorded
        .map(str::to_string)
        .or_else(|| current_branch_name(bin, root).ok())
        .unwrap_or_else(|| "HEAD".into())
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

// ------------------------------------------------------------ merge-back

/// How a thread's branch stands against the branch it was cut from. Every
/// field is measured, never inferred: `ahead` is a rev-list count, `clean`
/// is `git status`, and `mergeable` is a real trial merge (`merge-tree`),
/// not a guess from whether the diffs overlap.
#[derive(Debug, Clone, PartialEq)]
pub struct MergeReadiness {
    pub ahead: u32,
    pub clean: bool,
    pub mergeable: bool,
}

/// Whether the worktree that currently has the base branch checked out can
/// accept a fast-forward. A branch checked out nowhere is safe to update by
/// moving its ref directly.
#[derive(Debug, Clone, PartialEq)]
pub enum BaseWorktreeState {
    Clean,
    Dirty(u32),
}

fn base_worktree_path(bin: &Path, root: &Path, base: &str) -> Res<Option<std::path::PathBuf>> {
    if current_branch_name(bin, root).ok().as_deref() == Some(base) {
        Ok(Some(root.to_path_buf()))
    } else {
        Ok(worktree_holding(bin, root, base))
    }
}

/// The same target-worktree check used by a real merge, exposed for the merge
/// gate so it does not promise a merge that Git will immediately refuse.
pub fn base_worktree_state(bin: &Path, root: &Path, base: &str) -> Res<BaseWorktreeState> {
    match base_worktree_path(bin, root, base)? {
        Some(path) => match status(bin, &path)?.len() as u32 {
            0 => Ok(BaseWorktreeState::Clean),
            count => Ok(BaseWorktreeState::Dirty(count)),
        },
        None => Ok(BaseWorktreeState::Clean),
    }
}

/// Commits on `branch` that `base` does not have yet.
pub fn ahead_of(bin: &Path, root: &Path, base: &str, branch: &str) -> Res<u32> {
    let raw = run(bin, root, &["rev-list", "--count", &format!("{base}..{branch}")])?;
    Ok(raw.trim().parse::<u32>().unwrap_or(0))
}

/// Does `branch` merge into `base` without conflicts? A trial merge done
/// entirely in the object database — no worktree, no index, nothing to clean
/// up — so this is safe to call on every status poll. Exit 0 is a clean
/// merge, 1 is conflicts; anything else is a real failure.
///
/// ponytail: `merge-tree --write-tree` needs git 2.38 (Oct 2022). An older
/// git reports the unknown flag as a hard error, which surfaces as "could not
/// check" rather than a wrong answer — swap in a scratch-worktree probe if
/// that ever matters.
pub fn merges_cleanly(bin: &Path, root: &Path, base: &str, branch: &str) -> Res<bool> {
    let output = Command::new(bin)
        .args(["merge-tree", "--write-tree", base, branch])
        .current_dir(root)
        .env("PATH", crate::executor::child_path_env())
        .output()
        .map_err(|err| crate::PalisadeError::from(format!("could not run git: {err}")))?;
    match output.status.code() {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => Err(format!(
            "git merge-tree failed:\n{}",
            String::from_utf8_lossy(&output.stderr).trim()
        ).into()),
    }
}

/// Everything the merge gate needs about one thread's worktree, measured in
/// one pass. `root` is the project root; `worktree` is the thread's.
pub fn merge_readiness(
    bin: &Path,
    root: &Path,
    worktree: &Path,
    base: &str,
    branch: &str,
) -> Res<MergeReadiness> {
    let ahead = ahead_of(bin, root, base, branch)?;
    let clean = status(bin, worktree)?.is_empty();
    // Nothing to merge is trivially mergeable; skip the trial merge.
    let mergeable = ahead == 0 || merges_cleanly(bin, root, base, branch)?;
    Ok(MergeReadiness { ahead, clean, mergeable })
}

/// What a merge attempt did. A conflict is not an error: it leaves the
/// half-merged scratch worktree on disk at `conflict_path` so a session can
/// be pointed at it and resolve the merge the same way it does any other
/// work — that is the whole conflict story, no bespoke merge editor.
#[derive(Debug, Clone, PartialEq)]
pub struct MergeOutcome {
    pub merged: bool,
    pub conflict_path: Option<std::path::PathBuf>,
    pub conflict_branch: Option<String>,
    pub detail: String,
}

/// Where a merge attempt for `branch` gets staged. Alongside the thread
/// worktrees, under `.git/`, for the same reason they live there.
fn merge_scratch(root: &Path, branch: &str) -> (std::path::PathBuf, String) {
    let slug = branch.rsplit('/').next().unwrap_or(branch);
    (
        root.join(".git").join("palisade-worktrees").join(format!("merge-{slug}")),
        format!("palisade/merge-{slug}"),
    )
}

/// Merge a thread's branch into its base branch.
///
/// The merge is attempted in a scratch worktree cut from `base`, never in the
/// project root: a conflicted merge left in the user's own working tree would
/// block every other thread, and a merge that touches the root while an agent
/// is mid-turn there is exactly the race worktrees exist to avoid.
///
/// On success the base branch is advanced to the merge commit — by
/// fast-forwarding the worktree that has `base` checked out when there is one
/// (so git's own index and working tree stay in sync), and by moving the ref
/// directly when `base` is checked out nowhere. A fast-forward into a dirty
/// root is refused rather than forced; the caller reports it and the user
/// commits or stashes.
pub fn merge_into_base(bin: &Path, root: &Path, base: &str, branch: &str) -> Res<MergeOutcome> {
    if ahead_of(bin, root, base, branch)? == 0 {
        return Ok(MergeOutcome {
            merged: false,
            conflict_path: None,
            conflict_branch: None,
            detail: format!("`{branch}` has no commits that `{base}` does not already have."),
        });
    }
    // A base checked out in a dirty worktree can't take the fast-forward, and
    // finding that out *after* the merge means cleaning up a scratch worktree
    // for nothing. Check first.
    // `worktree_holding` only knows about *linked* worktrees; the project
    // root is the common case and it has to be checked separately.
    let host = base_worktree_path(bin, root, base)?;
    if let Some(path) = &host {
        let changes = status(bin, path)?;
        if !changes.is_empty() {
            return Err(format!(
                "Cannot merge into `{base}` because it has {} uncommitted {}. Commit or stash them before merging.",
                changes.len(),
                if changes.len() == 1 { "change" } else { "changes" },
            ).into());
        }
    }

    let (scratch, tmp_branch) = merge_scratch(root, branch);
    // A scratch worktree left behind by an earlier conflict is stale the
    // moment a new attempt starts: the branch has moved on since.
    if scratch.exists() {
        let _ = run(bin, root, &["worktree", "remove", "--force", &scratch.to_string_lossy()]);
    }
    let _ = run(bin, root, &["branch", "-D", &tmp_branch]);
    run(bin, root, &["worktree", "add", "-b", &tmp_branch, &scratch.to_string_lossy(), base])?;

    let message = format!("Merge {branch} into {base}");
    match run(bin, &scratch, &["merge", "--no-ff", "-m", &message, branch]) {
        Ok(_) => {}
        Err(detail) => {
            // Conflicts stay on disk to be resolved; anything else (a merge
            // that could not even start) cleans up after itself.
            let conflicted = status(bin, &scratch)
                .map(|files| files.iter().any(|f| f.code.contains('U')))
                .unwrap_or(false);
            if !conflicted {
                let _ = run(bin, root, &["worktree", "remove", "--force", &scratch.to_string_lossy()]);
                let _ = run(bin, root, &["branch", "-D", &tmp_branch]);
                return Err(detail);
            }
            return Ok(MergeOutcome {
                merged: false,
                conflict_path: Some(scratch),
                conflict_branch: Some(tmp_branch),
                detail: detail.message,
            });
        }
    }

    // The merge commit exists on the scratch branch; move `base` onto it.
    let advanced = match &host {
        Some(path) => run(bin, path, &["merge", "--ff-only", &tmp_branch]).map(|_| ()),
        None => {
            let tip = run(bin, root, &["rev-parse", &tmp_branch])?;
            run(bin, root, &["update-ref", &format!("refs/heads/{base}"), tip.trim()]).map(|_| ())
        }
    };
    // Clean up regardless: the merge commit is safe on `base` (or the error
    // below explains why it isn't), so the scratch worktree has no more to say.
    let _ = run(bin, root, &["worktree", "remove", "--force", &scratch.to_string_lossy()]);
    let _ = run(bin, root, &["branch", "-D", &tmp_branch]);
    advanced?;

    Ok(MergeOutcome {
        merged: true,
        conflict_path: None,
        conflict_branch: None,
        detail: message,
    })
}

// --------------------------------------------------------- remote sync

/// `origin`'s URL, for turning a branch into a web link when `gh` can't.
pub fn remote_url(bin: &Path, root: &Path) -> Res<String> {
    run(bin, root, &["remote", "get-url", "origin"])
}

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
        Err(err) if err.message.contains("has no upstream branch") => {
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
        let full = root.join(path);
        // An untracked directory (git status reports it as one entry, e.g.
        // "build-out/") needs remove_dir_all — remove_file only deletes
        // a single file and errors ("Operation not permitted") on a dir.
        let result = if full.is_dir() { std::fs::remove_dir_all(&full) } else { std::fs::remove_file(&full) };
        result.map_err(|err| crate::PalisadeError::from(format!("could not delete {path}: {err}")))
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
        return Err(format!("{} already exists", target.display()).into());
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

/// Repository-wide topology. Keeping parents and decorations makes branch
/// relationships available without coupling the view to any one worktree.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphCommit {
    pub hash: String,
    pub parents: Vec<String>,
    pub subject: String,
    pub author: String,
    pub date: String,
    pub refs: Vec<String>,
}

pub fn graph(bin: &Path, root: &Path, limit: u32) -> Res<Vec<GraphCommit>> {
    if rev_parse_head(bin, root).is_none() { return Ok(vec![]); }
    let count = format!("-{limit}");
    // `--exclude` must precede the ref-selecting flag it filters — here
    // `--all`. A stash entry is a real commit with 2-3 parents (the base
    // commit, plus a hidden index-tree commit and sometimes an
    // untracked-tree commit): internal plumbing, not branch topology. Left
    // in, every stash renders as a 3-way tangle at the top of the graph
    // that has nothing to do with the repo's actual branches.
    let raw = run(bin, root, &["log", "--exclude=refs/stash", "--all", "--topo-order", &count, "--no-color", "--decorate=short", "--pretty=format:%H\x1f%P\x1f%s\x1f%an\x1f%aI\x1f%D\x1e"])?;
    Ok(raw.split('\x1e').map(str::trim_start).filter(|row| !row.is_empty()).filter_map(|row| {
        let mut fields = row.split('\x1f');
        let hash = fields.next()?;
        let parents = fields.next()?.split_whitespace().map(str::to_owned).collect();
        let subject = fields.next()?;
        let author = fields.next()?;
        let date = fields.next()?;
        let refs = fields.next().unwrap_or_default().split(", ").filter(|reference| !reference.is_empty()).map(str::to_owned).collect();
        Some(GraphCommit { hash: hash.into(), parents, subject: subject.into(), author: author.into(), date: date.into(), refs })
    }).collect())
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

/// The diff introduced by one commit — `git show` handles a root commit
/// (diff against the empty tree) the same as any other, so unlike `diff
/// <hash>^ <hash>` this never fails on the first commit in a repo. Runs
/// against the project root like `graph` above: the diff is a property of
/// the commit object, not of any one worktree, so there is nothing to scope
/// per-thread here.
/// `--format=` drops the commit-message header; the frontend already has
/// that from the `GraphCommit` it clicked.
pub fn commit_diff(bin: &Path, root: &Path, hash: &str) -> Res<String> {
    run(bin, root, &["show", "--format=", "--no-color", hash])
}

pub fn is_git_repo(_bin: &Path, root: &Path) -> bool {
    git_repo::shared_git_repo().is_git_repo(root)
}

pub fn init_repo(bin: &Path, root: &Path) -> Res<()> {
    run(bin, root, &["init"]).map(|_| ())
}

/// Paths `git` itself would ignore, one entry per top-level ignored file or
/// directory (`--directory` collapses a whole ignored tree like
/// `build-out/` into a single entry instead of walking every file inside
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

    /// The regression behind "View diff renders nothing": a turn that only
    /// creates files left `git diff` empty while the stat promised +N.
    #[test]
    fn working_tree_diff_includes_untracked_files_as_new_file_patches() {
        let (dir, tracked) = init_test_repo();
        let root = dir.path();
        fs::write(root.join("brand_new.md"), "hello
world
").unwrap();

        let diff = working_tree_diff(git(), root).unwrap();
        assert!(diff.contains("brand_new.md"), "untracked file is named");
        assert!(diff.contains("new file mode"), "emitted as a new-file patch");
        assert!(diff.contains("+hello"), "its content is reviewable");

        // Tracked edits and untracked files coexist in one diff.
        fs::write(root.join(&tracked), "line one\nCHANGED\nline three\n").unwrap();
        let both = working_tree_diff(git(), root).unwrap();
        assert!(both.contains("CHANGED") && both.contains("+hello"));

        // Staging moves it out of the working diff, same as any edit.
        stage_file(git(), root, "brand_new.md").unwrap();
        assert!(!working_tree_diff(git(), root).unwrap().contains("+hello"));
        assert!(staged_diff(git(), root).unwrap().contains("+hello"));
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
        run(git(), dir.path(), &["init", "--bare", "-q", "-b", "main"]).unwrap();
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

    // -------------------------------------------------------- ignored_paths

    /// FIL-02: the file palette walked the whole tree with only a hardcoded
    /// name-skip (`.git`, `node_modules`, `target`, `__pycache__`) — a
    /// project-specific `.gitignore` entry like `build-out/` was invisible
    /// to it and leaked hundreds of generated-cache files into the palette.
    #[test]
    fn ignored_paths_reports_a_gitignored_directory_as_one_entry() {
        let (dir, _tracked) = init_test_repo();
        let root = dir.path();
        fs::write(root.join(".gitignore"), "build-out/\n").unwrap();
        fs::create_dir(root.join("build-out")).unwrap();
        fs::write(root.join("build-out/bundle.js"), "{}").unwrap();
        fs::write(root.join("build-out/cache.bin"), "x").unwrap();

        let ignored = ignored_paths(git(), root);

        assert!(
            ignored.contains("build-out/"),
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

    #[test]
    fn repository_graph_includes_a_non_head_branch_and_its_ref() {
        let (dir, tracked) = init_test_repo();
        let root = dir.path();
        run(git(), root, &["checkout", "-q", "-b", "feature/docs"]).unwrap();
        fs::write(root.join(tracked), "feature work\n").unwrap();
        run(git(), root, &["commit", "-qam", "feature commit"]).unwrap();
        run(git(), root, &["checkout", "-q", "main"]).unwrap();

        let commits = graph(git(), root, 20).unwrap();

        assert!(commits.iter().any(|commit| {
            commit.subject == "feature commit"
                && commit.refs.iter().any(|reference| reference == "feature/docs")
        }));
    }

    /// A stash entry is a real commit — with 2-3 parents (base commit, a
    /// hidden index-tree commit, sometimes an untracked-tree commit) that
    /// have nothing to do with branch topology. `--all` picks up
    /// `refs/stash` unless excluded, and rendering that plumbing produces a
    /// tangled cluster with no relation to the repo's real history.
    #[test]
    fn repository_graph_excludes_stash_entries() {
        let (dir, tracked) = init_test_repo();
        let root = dir.path();
        fs::write(root.join(&tracked), "uncommitted edit\n").unwrap();
        run(git(), root, &["stash", "push", "-q", "-m", "wip work"]).unwrap();

        let commits = graph(git(), root, 20).unwrap();

        assert!(!commits.iter().any(|commit| commit.subject.contains("wip work")));
    }

    #[test]
    fn commit_diff_shows_what_the_commit_changed() {
        let (dir, tracked) = init_test_repo();
        let root = dir.path();
        fs::write(root.join(&tracked), "line one\nline two\nline three\nline four\n").unwrap();
        run(git(), root, &["commit", "-qam", "add line four"]).unwrap();
        let hash = rev_parse_head(git(), root).unwrap();

        let diff = commit_diff(git(), root, &hash).unwrap();

        assert!(diff.contains("+line four"), "diff did not show the added line:\n{diff}");
    }

    /// `diff <hash>^ <hash>` fails on the first commit (no parent); `git show`
    /// diffs against the empty tree instead and must not error here.
    #[test]
    fn commit_diff_handles_the_root_commit() {
        let (dir, tracked) = init_test_repo();
        let root = dir.path();
        let hash = rev_parse_head(git(), root).unwrap();

        let diff = commit_diff(git(), root, &hash).unwrap();

        assert!(diff.contains(&tracked), "diff did not name the root commit's file:\n{diff}");
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

    /// A repo with no commits is the trap `thread_worktree` guards against:
    /// `git worktree add -b` does not fail on an unborn branch, it infers
    /// `--orphan` and returns a worktree sharing neither history nor files
    /// with the project. `rev_parse_head` is the predicate that catches it.
    #[test]
    fn a_worktree_off_an_unborn_branch_is_empty_and_head_says_so() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        run(git(), root, &["init"]).unwrap();
        fs::write(root.join("already_here.txt"), "work done before any commit\n").unwrap();

        assert!(rev_parse_head(git(), root).is_none(), "no commits yet");

        // The add itself succeeds — which is exactly why the guard cannot
        // rely on its error.
        let (path, _) = add_worktree(git(), root, "01THREADAAAA").unwrap();
        assert!(!path.join("already_here.txt").exists(), "orphan worktree carries nothing over");
    }

    #[test]
    fn base_or_current_prefers_the_recorded_base() {
        let (dir, _) = init_test_repo();
        let root = dir.path();
        assert_eq!(base_or_current(git(), root, Some("release")), "release");
        let current = current_branch_name(git(), root).unwrap();
        assert_eq!(base_or_current(git(), root, None), current);
    }

    /// The multi-worktree promise: a thread can stage and commit its own work
    /// without the project root seeing any of it.
    #[test]
    fn a_worktree_stages_and_commits_independently_of_the_project_root() {
        let (dir, tracked) = init_test_repo();
        let root = dir.path();
        let (wt, _branch) = add_worktree(git(), root, "01THREADAAAA").unwrap();

        fs::write(wt.join("only_here.md"), "worktree work\n").unwrap();
        stage_file(git(), &wt, "only_here.md").unwrap();
        commit(git(), &wt, "worktree commit").unwrap();

        // The worktree advanced; the project root did not.
        assert_eq!(log(git(), &wt, 1).unwrap()[0].subject, "worktree commit");
        assert_ne!(log(git(), root, 1).unwrap()[0].subject, "worktree commit");
        assert!(!root.join("only_here.md").exists());

        // And an edit in the root stays in the root.
        fs::write(root.join(&tracked), "root only\n").unwrap();
        assert!(working_tree_diff(git(), root).unwrap().contains("root only"));
        assert_eq!(working_tree_diff(git(), &wt).unwrap(), "");
    }

    /// The red banner in the bug report: git's own message names a path the
    /// user never picked. Palisade explains the situation instead.
    /// One `git` process per untracked file is fine for a handful and a hang
    /// for a repo with no `.gitignore` yet, so both axes are bounded.
    #[test]
    fn untracked_diffing_is_bounded_by_file_count_and_size() {
        let (dir, _tracked) = init_test_repo();
        let root = dir.path();

        // Past the size bound: still a status row, no contents.
        let big = "x".repeat(1024 * 1024 + 1);
        fs::write(root.join("generated.bin"), &big).unwrap();
        let diff = working_tree_diff(git(), root).unwrap();
        assert!(!diff.contains("generated.bin"), "oversized file is not diffed");
        assert!(
            status(git(), root).unwrap().iter().any(|f| f.path == "generated.bin"),
            "but it is still reported as untracked"
        );

        // Past the count bound: the first 200 carry contents, the rest do not.
        for i in 0..250 {
            fs::write(root.join(format!("f{i:03}.txt")), format!("line {i}\n")).unwrap();
        }
        let diff = working_tree_diff(git(), root).unwrap();
        let diffed = diff.matches("new file mode").count();
        assert_eq!(diffed, 200, "capped at the file limit, not unbounded");
    }

    #[test]
    fn checking_out_a_branch_another_worktree_holds_explains_rather_than_fataling() {
        let (dir, _tracked) = init_test_repo();
        let root = dir.path();
        let (wt_path, branch) = add_worktree(git(), root, "01THREADAAAA").unwrap();

        assert_eq!(
            worktree_holding(git(), root, &branch).map(|p| p.canonicalize().unwrap()),
            Some(wt_path.canonicalize().unwrap())
        );

        let err = checkout_branch(git(), root, &branch).unwrap_err();
        assert!(err.contains("already checked out in another worktree"), "{err}");
        assert!(!err.contains("fatal:"), "git's raw message must not leak: {err}");

        // A branch no worktree holds still checks out normally.
        create_branch(git(), root, "free").unwrap();
        checkout_branch(git(), root, "main").unwrap();
        checkout_branch(git(), root, "free").unwrap();
        assert_eq!(current_branch_name(git(), root).unwrap(), "free");
        // And the root's own branch is never reported as "held elsewhere".
        assert!(worktree_holding(git(), root, "free").is_none());
    }

    #[test]
    fn base_worktree_state_counts_tracked_and_untracked_changes() {
        let (dir, tracked) = init_test_repo();
        let root = dir.path();
        let base = current_branch_name(git(), root).unwrap();

        assert_eq!(base_worktree_state(git(), root, &base).unwrap(), BaseWorktreeState::Clean);

        fs::write(root.join(&tracked), "changed\n").unwrap();
        fs::write(root.join("artifact.txt"), "untracked\n").unwrap();
        assert_eq!(base_worktree_state(git(), root, &base).unwrap(), BaseWorktreeState::Dirty(2));

        run(git(), root, &["checkout", "-b", "other"]).unwrap();
        assert_eq!(base_worktree_state(git(), root, &base).unwrap(), BaseWorktreeState::Clean);
    }

    #[test]
    fn worktree_branch_is_namespaced_and_path_is_keyed_by_thread_id() {
        let (path, branch) = worktree_paths(Path::new("/proj"), "01ABCDEFGHIJKLMNOP");

        assert_eq!(branch, "palisade/IJKLMNOP");
        assert_eq!(path, Path::new("/proj/.git/palisade-worktrees/01ABCDEFGHIJKLMNOP"));
    }
    /// The merge-back happy path and its one interesting failure, end to end
    /// on a real repo: a clean merge advances the base branch and leaves no
    /// scratch worktree behind, and a conflicting one leaves the half-merged
    /// worktree on disk for a session to resolve instead of erroring out.
    #[test]
    fn merge_back_advances_the_base_and_parks_conflicts_in_a_worktree() {
        let (dir, tracked) = init_test_repo();
        let root = dir.path();
        let base = current_branch_name(git(), root).unwrap();

        // A thread worktree with one commit that does not touch `tracked`.
        let (wt, branch) = add_worktree(git(), root, "01thread-clean").unwrap();
        fs::write(wt.join("new.txt"), "from the thread\n").unwrap();
        run(git(), &wt, &["add", "-A"]).unwrap();
        run(git(), &wt, &["commit", "-q", "-m", "thread work"]).unwrap();

        let ready = merge_readiness(git(), root, &wt, &base, &branch).unwrap();
        assert_eq!(ready, MergeReadiness { ahead: 1, clean: true, mergeable: true });

        let out = merge_into_base(git(), root, &base, &branch).unwrap();
        assert!(out.merged, "clean merge should land: {}", out.detail);
        assert_eq!(ahead_of(git(), root, &base, &branch).unwrap(), 0);
        assert!(root.join("new.txt").is_file(), "base worktree should have the merged file");
        assert!(!merge_scratch(root, &branch).0.exists(), "scratch worktree should be gone");

        // A second thread that rewrites the same line the base is about to.
        let (wt2, branch2) = add_worktree(git(), root, "02thread-conflict").unwrap();
        fs::write(wt2.join(&tracked), "thread version\n").unwrap();
        run(git(), &wt2, &["commit", "-qam", "thread edit"]).unwrap();
        fs::write(root.join(&tracked), "base version\n").unwrap();
        run(git(), root, &["commit", "-qam", "base edit"]).unwrap();

        assert!(!merges_cleanly(git(), root, &base, &branch2).unwrap());
        let out = merge_into_base(git(), root, &base, &branch2).unwrap();
        assert!(!out.merged);
        let parked = out.conflict_path.expect("conflict leaves a worktree to resolve in");
        assert!(parked.is_dir(), "conflicted merge stays on disk");
        assert_eq!(fs::read_to_string(root.join(&tracked)).unwrap(), "base version\n");
    }
}
