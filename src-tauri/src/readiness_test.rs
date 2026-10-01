//! Opt-in isolation for the real native readiness build. No authentication
//! overrides: the existing provider sign-in is reused with user approval.
use std::path::{Path, PathBuf};

fn checked_root(path: &Path) -> PathBuf {
    assert!(
        path.is_absolute()
            && path.parent().is_some()
            && !path.components().any(|c| c == std::path::Component::ParentDir),
        "readiness profile must be an absolute, non-root directory without parent traversal"
    );
    path.to_owned()
}

pub fn root() -> PathBuf {
    checked_root(Path::new(
        &std::env::var_os("PALISADE_TEST_DIR")
            .expect("readiness-test build requires PALISADE_TEST_DIR"),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_is_explicit_and_cannot_be_filesystem_root() {
        assert_eq!(
            checked_root(Path::new("/tmp/readiness")),
            PathBuf::from("/tmp/readiness")
        );
        for invalid in ["", "relative", "/", "/tmp/.."] {
            assert!(std::panic::catch_unwind(|| checked_root(Path::new(invalid))).is_err());
        }
    }
}
