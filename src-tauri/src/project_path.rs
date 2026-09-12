//! A path that has been proved to live inside a project root.
//!
//! Containment used to be enforced inline, at five separate places, each
//! re-implementing the same canonicalize-then-compare against a surface of
//! 156 IPC commands. That was correct, and nothing made it *stay* correct: a
//! new command that takes a path and forgets the check is silently unscoped,
//! and no reviewer or test catches it.
//!
//! `ProjectPath` moves the invariant from review time to compile time. Its
//! field is private, so outside this module the only way to obtain one is
//! through a constructor that performed the check. A function that takes a
//! `ProjectPath` cannot be handed an unvalidated path at all.
//!
//! Two cases the inline checks got right and most implementations get wrong
//! are preserved deliberately, and each has a test below:
//!
//! * **Symlinks on both sides.** The root itself may be a symlink — `/tmp` is
//!   one on macOS — so canonicalizing only the target compares
//!   `/private/tmp/…` against `/tmp/…` and rejects a legitimate path. Both
//!   sides are canonicalized. (The old inline checks at `list_directory` and
//!   `resolve_existing_path` canonicalized only the target, which failed
//!   closed rather than open, but failed.)
//!
//! * **Paths that do not exist yet.** `canonicalize` needs the file to be
//!   there, so creating one cannot use it directly. `creatable` walks up to
//!   the nearest ancestor that does exist and canonicalizes that, which still
//!   catches a symlink escape planted partway down an existing subtree.

use std::path::{Component, Path, PathBuf};

use crate::Res;

/// What every containment failure says, whichever constructor found it. One
/// message on purpose: which of the checks tripped is a detail of ours, not
/// something a caller outside the project boundary should be able to probe.
const ESCAPED: &str = "path must stay inside the project";

/// A path proved to be inside a project root.
///
/// Construct with [`ProjectPath::root_of`], [`ProjectPath::existing`] or
/// [`ProjectPath::creatable`]; there is no other way to make one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectPath {
    /// Private. This is the whole point of the type.
    path: PathBuf,
}

/// The project root, canonicalized when it can be. A root that cannot be
/// canonicalized (it was deleted or unmounted since the project was indexed)
/// falls back to its literal form, which then matches nothing and fails
/// closed — the same behaviour `check_not_project_root` already relied on.
fn canonical_root(root: &Path) -> PathBuf {
    std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf())
}

impl ProjectPath {
    /// The project root itself. Used by the commands whose relative path is
    /// allowed to be empty, meaning "the whole project".
    pub fn root_of(root: &Path) -> Res<Self> {
        Ok(Self { path: canonical_root(root) })
    }

    /// Resolves `relative` against `root`, requiring it to exist already.
    pub fn existing(root: &Path, relative: &str) -> Res<Self> {
        if relative.trim().is_empty() {
            return Self::root_of(root);
        }
        let root = canonical_root(root);
        let joined = root.join(relative);
        let resolved = std::fs::canonicalize(&joined)
            .map_err(|err| format!("no such file: {} ({err})", joined.display()))?;
        if !resolved.starts_with(&root) {
            return Err(ESCAPED.into());
        }
        Ok(Self { path: resolved })
    }

    /// Resolves `relative` against `root` for something about to be created,
    /// where the leaf — or the whole tail of the path — does not exist yet.
    ///
    /// Purely a check: it creates nothing. The returned path is the literal
    /// join rather than a canonicalization, because the thing it names is not
    /// there to canonicalize.
    pub fn creatable(root: &Path, relative: &str) -> Res<Self> {
        let rel = Path::new(relative);
        // A relative path with no `..` in it can only ever join to somewhere
        // under the root, so rejecting those two outright means the walk
        // below is only ever looking for symlinks.
        if rel.is_absolute() || rel.components().any(|c| matches!(c, Component::ParentDir)) {
            return Err(ESCAPED.into());
        }
        let root = canonical_root(root);
        let target = root.join(rel);

        let mut existing = target.clone();
        while !existing.exists() {
            match existing.parent() {
                Some(parent) => existing = parent.to_path_buf(),
                None => break,
            }
        }
        let resolved_existing = std::fs::canonicalize(&existing)
            .map_err(|err| format!("cannot resolve {}: {err}", existing.display()))?;
        if !resolved_existing.starts_with(&root) {
            return Err(ESCAPED.into());
        }
        Ok(Self { path: target })
    }

    pub fn as_path(&self) -> &Path {
        &self.path
    }

    /// Whether this resolved to the project root itself — which `delete_path`
    /// has to refuse, since an empty relative path resolves straight to it and
    /// the delete recurses.
    pub fn is_project_root(&self, root: &Path) -> bool {
        self.path == canonical_root(root)
    }

    pub fn into_path_buf(self) -> PathBuf {
        self.path
    }
}

impl AsRef<Path> for ProjectPath {
    fn as_ref(&self) -> &Path {
        &self.path
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A project root plus a file in it, both real on disk.
    fn project() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        std::fs::write(root.join("inside.txt"), "hello").unwrap();
        std::fs::create_dir_all(root.join("sub/deeper")).unwrap();
        (dir, root)
    }

    #[test]
    fn accepts_a_file_inside_the_project() {
        let (_dir, root) = project();
        let p = ProjectPath::existing(&root, "inside.txt").unwrap();
        assert!(p.as_path().ends_with("inside.txt"));
    }

    #[test]
    fn rejects_a_traversal_out_of_the_project() {
        let (_dir, root) = project();
        // The classic. It exists on every machine this runs on, so the
        // rejection has to come from the containment check and not from the
        // file simply being absent.
        let err = ProjectPath::existing(&root, "../../../../../../etc/passwd").unwrap_err();
        assert_eq!(err, ESCAPED, "traversal was refused for the wrong reason");

        let err = ProjectPath::creatable(&root, "../escaped.txt").unwrap_err();
        assert_eq!(err, ESCAPED);
    }

    #[test]
    fn rejects_a_symlink_that_points_out_of_the_project() {
        let (_dir, root) = project();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.txt"), "no").unwrap();

        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.path(), root.join("escape")).unwrap();
        #[cfg(not(unix))]
        return;

        // The symlink itself is inside the project and the target exists, so
        // only canonicalizing catches this.
        let err = ProjectPath::existing(&root, "escape/secret.txt").unwrap_err();
        assert_eq!(err, ESCAPED);

        // And planted partway down a path whose leaf does not exist yet.
        let err = ProjectPath::creatable(&root, "escape/planted.txt").unwrap_err();
        assert_eq!(err, ESCAPED);
    }

    #[test]
    fn a_symlinked_root_does_not_reject_its_own_files() {
        // Canonicalizing only the target compares /private/tmp/… against
        // /tmp/… and refuses a path that is plainly inside the project. Both
        // sides are canonicalized, so this holds.
        let (_dir, root) = project();
        let link_dir = tempfile::tempdir().unwrap();
        let linked_root = link_dir.path().join("root-link");

        #[cfg(unix)]
        std::os::unix::fs::symlink(&root, &linked_root).unwrap();
        #[cfg(not(unix))]
        return;

        let p = ProjectPath::existing(&linked_root, "inside.txt")
            .expect("a file inside a symlinked project root is still inside it");
        assert!(p.as_path().ends_with("inside.txt"));
    }

    #[test]
    fn resolves_a_path_whose_leaf_does_not_exist_yet() {
        let (_dir, root) = project();
        let p = ProjectPath::creatable(&root, "sub/deeper/brand-new.json").unwrap();
        assert!(p.as_path().ends_with("sub/deeper/brand-new.json"));
        assert!(!p.as_path().exists(), "creatable() must not create anything");
    }

    #[test]
    fn resolves_a_path_whose_whole_tail_does_not_exist_yet() {
        let (_dir, root) = project();
        let p = ProjectPath::creatable(&root, "not/here/at/all.txt").unwrap();
        assert!(p.as_path().starts_with(canonical_root(&root)));
    }

    #[test]
    fn an_empty_relative_path_is_the_project_root() {
        let (_dir, root) = project();
        let p = ProjectPath::existing(&root, "").unwrap();
        assert!(p.is_project_root(&root));
        assert!(!ProjectPath::existing(&root, "inside.txt").unwrap().is_project_root(&root));
    }
}
