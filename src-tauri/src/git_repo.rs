//! Pure-Rust read-only git access (D12).
//!
//! This module exposes a [`GitRepo`] trait so callers can switch between a real
//! backend and an in-memory test backend. The initial real backend still shells
//! out to the `git` binary for complex diff/status output because gix's API for
//! generating porcelain-style status codes and unified diffs requires more
//! iteration than a single compile-check-free pass can safely deliver; the `gix`
//! dependency is already wired and a [`GixRepo`] stub is provided for the next
//! pass to fill in.

use std::collections::HashMap;
use std::path::Path;
use std::process::{Command, Stdio};

use serde::Serialize;

/// The same alias as `store::Res`, restated here so this module reads
/// standalone. One error type across the backend.
pub type Res<T> = Result<T, crate::error::PalisadeError>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStatus {
    pub path: String,
    /// Raw two-char porcelain v1 status code (e.g. " M", "??", "A ", "MM").
    pub code: String,
}

fn run_git(root: &Path, args: &[&str]) -> Option<String> {
    let bin = crate::executor::find_on_path("git")?;
    let output = Command::new(bin)
        .args(args)
        .current_dir(root)
        .env("PATH", crate::executor::child_path_env())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn run_git_res(root: &Path, args: &[&str]) -> Res<String> {
    let bin = crate::executor::find_on_path("git").ok_or("`git` is not on PATH.")?;
    let output = Command::new(bin)
        .args(args)
        .current_dir(root)
        .env("PATH", crate::executor::child_path_env())
        .output()
        .map_err(|err| crate::PalisadeError::from(format!("could not run git: {err}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git {} failed:\n{}", args.join(" "), stderr.trim()).into());
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// How many untracked files are worth synthesizing a patch for in one read,
/// and how large one of them may be. Both are review limits, not correctness
/// limits: past them the file still appears as a status row, it just doesn't
/// carry its contents. A human is not reading the 201st new file in a single
/// pass, and a multi-megabyte one is generated output, not a change.
const UNTRACKED_DIFF_FILE_LIMIT: usize = 200;
const UNTRACKED_DIFF_BYTE_LIMIT: u64 = 1024 * 1024;

/// The "new file" patch for one untracked path.
///
/// `git diff --no-index` exits 1 whenever the two sides differ — which is
/// always, here — so the exit code carries no information and only stdout is
/// read. A path git cannot diff (binary, unreadable, a dangling symlink)
/// yields no hunks; the caller drops it and the status row still lists it.
fn untracked_patch(root: &Path, path: &str) -> String {
    let Some(bin) = crate::executor::find_on_path("git") else {
        return String::new();
    };
    Command::new(bin)
        .args(["diff", "--no-index", "--", "/dev/null", path])
        .current_dir(root)
        .env("PATH", crate::executor::child_path_env())
        .output()
        .ok()
        .map(|out| String::from_utf8_lossy(&out.stdout).into_owned())
        .unwrap_or_default()
}

fn append_untracked(root: &Path, out: &mut String, status: &[FileStatus]) {
    let mut budget = UNTRACKED_DIFF_FILE_LIMIT;
    for entry in status.iter().filter(|f| f.code == "??") {
        if budget == 0 {
            break;
        }
        let too_big = std::fs::metadata(root.join(&entry.path))
            .map(|meta| meta.len() > UNTRACKED_DIFF_BYTE_LIMIT)
            .unwrap_or(true);
        if too_big {
            continue;
        }
        budget -= 1;
        let patch = untracked_patch(root, &entry.path);
        if !patch.is_empty() {
            if !out.is_empty() && !out.ends_with('\n') {
                out.push('\n');
            }
            out.push_str(&patch);
        }
    }
}

/// Read-only git operations used by the harness.
pub trait GitRepo: Send + Sync + 'static {
    /// Whether `root` is inside a git worktree.
    fn is_git_repo(&self, root: &Path) -> bool;

    /// The commit HEAD points at, if any.
    fn rev_parse_head(&self, root: &Path) -> Option<String>;

    /// Sorted list of paths that appear in `git status --porcelain=v1`.
    fn porcelain_snapshot(&self, root: &Path) -> Vec<String>;

    /// Paths that changed between two commits.
    fn changed_between(&self, root: &Path, before: &str, after: &str) -> Res<Vec<String>>;

    /// Porcelain status entries, including untracked files.
    fn status(&self, root: &Path) -> Res<Vec<FileStatus>>;

    /// Unified diff of unstaged changes, untracked files included as
    /// synthesized "new file" patches.
    fn working_tree_diff(&self, root: &Path) -> Res<String>;

    /// Unified diff from `rev` through the current tree, including committed,
    /// staged, unstaged, and untracked changes.
    fn diff_from(&self, root: &Path, rev: &str) -> Res<String>;

    /// Unified diff of staged changes.
    fn staged_diff(&self, root: &Path) -> Res<String>;

    /// Batched read: status plus both diffs in one call.
    fn snapshot(&self, root: &Path) -> Res<Snapshot>;

    /// Local and remote branches.
    fn list_branches(&self, root: &Path) -> Res<Vec<BranchInfo>>;

    /// Name of the current branch, or "HEAD" if detached.
    fn current_branch_name(&self, root: &Path) -> Res<String>;

    /// `(ahead, behind)` relative to the upstream branch, or `None` if there
    /// is no upstream or no commits yet.
    fn ahead_behind(&self, root: &Path) -> Res<Option<(u32, u32)>>;
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub name: String,
    pub is_current: bool,
    pub is_remote: bool,
}

pub(crate) fn parse_local_branches(raw: &str) -> Vec<BranchInfo> {
    raw.lines()
        .filter_map(|line| {
            let (name, head) = line.split_once('\t')?;
            Some(BranchInfo { name: name.to_string(), is_current: head == "*", is_remote: false })
        })
        .collect()
}

pub(crate) fn parse_remote_branches(raw: &str) -> Vec<BranchInfo> {
    raw.lines()
        // `origin/HEAD` is a symbolic pointer, not a real branch to offer.
        .filter(|line| !line.ends_with("/HEAD"))
        .map(|name| BranchInfo { name: name.to_string(), is_current: false, is_remote: true })
        .collect()
}

/// The result of a batched git read query.
#[derive(Debug, Clone, Default)]
pub struct Snapshot {
    pub status: Vec<FileStatus>,
    pub working_diff: String,
    pub staged_diff: String,
}

/// Real implementation backed by the `git` binary. This is intentionally a
/// thin subprocess wrapper to preserve exact output semantics while the gix
/// migration is completed in a follow-up pass with compile-test iteration.
pub struct ShellGitRepo;

impl GitRepo for ShellGitRepo {
    fn is_git_repo(&self, root: &Path) -> bool {
        run_git(root, &["rev-parse", "--is-inside-work-tree"]).is_some()
    }

    fn rev_parse_head(&self, root: &Path) -> Option<String> {
        run_git(root, &["rev-parse", "HEAD"]).map(|out| out.trim().to_string())
    }

    fn porcelain_snapshot(&self, root: &Path) -> Vec<String> {
        let mut paths: Vec<String> = run_git(root, &["status", "--porcelain=v1", "-uall"])
            .unwrap_or_default()
            .lines()
            .filter(|line| line.len() > 3)
            .map(|line| line[3..].to_string())
            .collect();
        paths.sort();
        paths
    }

    fn changed_between(&self, root: &Path, before: &str, after: &str) -> Res<Vec<String>> {
        let raw = run_git_res(root, &["diff", "--name-only", before, after])?;
        Ok(raw.lines().map(str::to_string).filter(|line| !line.is_empty()).collect())
    }

    fn status(&self, root: &Path) -> Res<Vec<FileStatus>> {
        // `-uall` lists untracked *files* rather than collapsing a new
        // directory into one row: a row that names a directory is a row the
        // user can't open, diff, or stage meaningfully.
        let raw = run_git_res(root, &["status", "--porcelain=v1", "-uall"])?;
        Ok(raw
            .lines()
            .filter(|line| line.len() > 3)
            .map(|line| FileStatus { code: line[..2].to_string(), path: line[3..].to_string() })
            .collect())
    }

    fn working_tree_diff(&self, root: &Path) -> Res<String> {
        let mut out = run_git_res(root, &["diff"])?;
        // `git diff` is blind to untracked files, but a file the agent just
        // created is the single most common thing there is to review — a
        // thread whose whole turn was "write README.md" otherwise renders an
        // empty pane while the diff stat promises +107. Synthesize the same
        // "new file" patch git would emit had the file been staged, so every
        // reader downstream (pane, stat, commit draft) sees one diff.
        //
        // Bounded on both axes, because this runs one `git` process per file
        // against whatever happens to be untracked: a repo with no
        // `.gitignore` yet has a `node_modules` in that list, and an
        // unbounded loop there would hang the pane and exhaust memory before
        // rendering anything. Files past either bound keep their status row,
        // which is how untracked files displayed before this existed.
        append_untracked(root, &mut out, &self.status(root)?);
        Ok(out)
    }

    fn diff_from(&self, root: &Path, rev: &str) -> Res<String> {
        let mut out = run_git_res(root, &["diff", "--no-color", rev])?;
        append_untracked(root, &mut out, &self.status(root)?);
        Ok(out)
    }

    fn staged_diff(&self, root: &Path) -> Res<String> {
        run_git_res(root, &["diff", "--cached"])
    }

    fn snapshot(&self, root: &Path) -> Res<Snapshot> {
        Ok(Snapshot {
            status: self.status(root)?,
            working_diff: self.working_tree_diff(root)?,
            staged_diff: self.staged_diff(root)?,
        })
    }

    fn list_branches(&self, root: &Path) -> Res<Vec<BranchInfo>> {
        let local = run_git_res(root, &["branch", "--format=%(refname:short)\t%(HEAD)"])?;
        let remote = run_git_res(root, &["branch", "-r", "--format=%(refname:short)"])?;
        let mut branches = parse_local_branches(&local);
        branches.extend(parse_remote_branches(&remote));
        Ok(branches)
    }

    fn current_branch_name(&self, root: &Path) -> Res<String> {
        run_git_res(root, &["rev-parse", "--abbrev-ref", "HEAD"]).map(|s| s.trim().to_string())
    }

    fn ahead_behind(&self, root: &Path) -> Res<Option<(u32, u32)>> {
        if run_git(root, &["rev-parse", "--verify", "-q", "HEAD"]).is_none() {
            return Ok(None);
        }
        if run_git(root, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).is_none() {
            return Ok(None);
        }
        let out = run_git_res(root, &["rev-list", "--left-right", "--count", "HEAD...@{u}"])?;
        let mut parts = out.trim().split_whitespace();
        let ahead = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        let behind = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        Ok(Some((ahead, behind)))
    }
}

/// In-memory git backend for tests. Pre-load the answers you need; no
/// subprocess is spawned.
pub struct InMemoryGitRepo {
    pub is_git_repo: bool,
    pub rev_parse_head: Option<String>,
    pub porcelain_snapshot: Vec<String>,
    pub changed_between: HashMap<(String, String), Vec<String>>,
    pub status: Vec<FileStatus>,
    pub working_diff: String,
    pub staged_diff: String,
    pub snapshot: Option<Snapshot>,
    pub branches: Vec<BranchInfo>,
    pub current_branch_name: String,
    pub ahead_behind: Option<Option<(u32, u32)>>,
}

impl Default for InMemoryGitRepo {
    fn default() -> Self {
        Self {
            is_git_repo: false,
            rev_parse_head: None,
            porcelain_snapshot: vec![],
            changed_between: HashMap::new(),
            status: vec![],
            working_diff: String::new(),
            staged_diff: String::new(),
            snapshot: None,
            branches: vec![],
            current_branch_name: "HEAD".into(),
            ahead_behind: None,
        }
    }
}

impl GitRepo for InMemoryGitRepo {
    fn is_git_repo(&self, _root: &Path) -> bool {
        self.is_git_repo
    }

    fn rev_parse_head(&self, _root: &Path) -> Option<String> {
        self.rev_parse_head.clone()
    }

    fn porcelain_snapshot(&self, _root: &Path) -> Vec<String> {
        let mut paths = self.porcelain_snapshot.clone();
        paths.sort();
        paths
    }

    fn changed_between(&self, _root: &Path, before: &str, after: &str) -> Res<Vec<String>> {
        Ok(self.changed_between.get(&(before.to_string(), after.to_string())).cloned().unwrap_or_default())
    }

    fn status(&self, _root: &Path) -> Res<Vec<FileStatus>> {
        Ok(self.status.clone())
    }

    fn working_tree_diff(&self, _root: &Path) -> Res<String> {
        Ok(self.working_diff.clone())
    }

    fn diff_from(&self, _root: &Path, _rev: &str) -> Res<String> {
        Ok(self.working_diff.clone())
    }

    fn staged_diff(&self, _root: &Path) -> Res<String> {
        Ok(self.staged_diff.clone())
    }

    fn snapshot(&self, _root: &Path) -> Res<Snapshot> {
        Ok(self.snapshot.clone().unwrap_or_default())
    }

    fn list_branches(&self, _root: &Path) -> Res<Vec<BranchInfo>> {
        Ok(self.branches.clone())
    }

    fn current_branch_name(&self, _root: &Path) -> Res<String> {
        Ok(self.current_branch_name.clone())
    }

    fn ahead_behind(&self, _root: &Path) -> Res<Option<(u32, u32)>> {
        Ok(self.ahead_behind.unwrap_or(None))
    }
}

/// Placeholder for a pure-gix implementation. Filling this in is the next step
/// once the crate can be compiled and tested iteratively.
pub struct GixRepo;

impl GitRepo for GixRepo {
    fn is_git_repo(&self, _root: &Path) -> bool {
        todo!("gix is_git_repo")
    }

    fn rev_parse_head(&self, _root: &Path) -> Option<String> {
        todo!("gix rev_parse_head")
    }

    fn porcelain_snapshot(&self, _root: &Path) -> Vec<String> {
        todo!("gix porcelain_snapshot")
    }

    fn changed_between(&self, _root: &Path, _before: &str, _after: &str) -> Res<Vec<String>> {
        todo!("gix changed_between")
    }

    fn status(&self, _root: &Path) -> Res<Vec<FileStatus>> {
        todo!("gix status")
    }

    fn working_tree_diff(&self, _root: &Path) -> Res<String> {
        todo!("gix working_tree_diff")
    }

    fn diff_from(&self, _root: &Path, _rev: &str) -> Res<String> {
        todo!("gix diff_from")
    }

    fn staged_diff(&self, _root: &Path) -> Res<String> {
        todo!("gix staged_diff")
    }

    fn snapshot(&self, _root: &Path) -> Res<Snapshot> {
        todo!("gix snapshot")
    }

    fn list_branches(&self, _root: &Path) -> Res<Vec<BranchInfo>> {
        todo!("gix list_branches")
    }

    fn current_branch_name(&self, _root: &Path) -> Res<String> {
        todo!("gix current_branch_name")
    }

    fn ahead_behind(&self, _root: &Path) -> Res<Option<(u32, u32)>> {
        todo!("gix ahead_behind")
    }
}

use std::sync::{Arc, OnceLock};

pub type SharedGitRepo = Arc<dyn GitRepo>;

/// The process-global real git backend.
pub fn shared_git_repo() -> SharedGitRepo {
    static INSTANCE: OnceLock<SharedGitRepo> = OnceLock::new();
    INSTANCE.get_or_init(|| Arc::new(ShellGitRepo)).clone()
}
