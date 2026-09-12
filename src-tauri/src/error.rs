//! The error every IPC command returns.
//!
//! Palisade's backend spoke only `Result<T, String>` — 421 aliases of it and
//! not one typed error — so a missing file and a crashed agent arrived at the
//! UI indistinguishable. The cost was visible in `src/errors.ts`, which
//! classified failures with a regex over free text and said so in its own
//! comment.
//!
//! ## The split that matters
//!
//! Not all of that regex is avoidable, and pretending otherwise would make
//! this worse. The frontend branches on exactly two things:
//!
//! * **`isAuthError`**, over text an *ACP agent* produced. Those are
//!   third-party CLIs whose wording nobody here controls, and no amount of
//!   typing on our side gives them a status code. That regex survives, scoped
//!   to genuinely foreign text.
//! * **`/not a git repository/i`**, over text *Palisade itself* produced.
//!   That one was avoidable, and it is what this module removes.
//!
//! ## Why a struct and not an enum of variants
//!
//! The brief suggested `thiserror`. It is not pulled in, and that is a
//! deliberate call rather than an oversight: the shape that actually fits is
//! one struct carrying a `kind` plus the human message, whose `Display` is a
//! single line. `thiserror` earns its place when you are hand-writing
//! `Display` and `From` across many data-carrying variants — and an enum like
//! that would force all 421 existing construction sites to choose a variant
//! up front, which is the opposite of "keep variants to what call sites
//! actually branch on".
//!
//! Instead `From<String>` carries the long tail as [`ErrorKind::Unknown`], so
//! every existing `format!` error keeps working and reaches the UI with a
//! message exactly as before. A site becomes typed the moment someone has a
//! reason to branch on it, and no sooner.

use serde::{Deserialize, Serialize};
use std::fmt;

/// What went wrong, in the few terms the UI actually changes its behaviour
/// for. Serialized in camelCase as the `kind` discriminant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorKind {
    /// The project has no git repository. A normal state for a new folder,
    /// not a failure — Source Control used to detect this by regex and had to
    /// suppress a duplicate toast because two commands reported it at once.
    NotAGitRepo,
    /// A file, directory or project that was asked for is not there.
    NotFound,
    /// A path resolved outside the project root. See `project_path.rs`.
    OutsideProject,
    /// Everything not yet worth distinguishing. The message is still carried
    /// verbatim; only the branching is unavailable.
    Unknown,
}

/// An error on its way to the frontend, as `{ kind, message }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PalisadeError {
    pub kind: ErrorKind,
    pub message: String,
}

impl PalisadeError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self { kind, message: message.into() }
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::NotFound, message)
    }

    pub fn outside_project(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::OutsideProject, message)
    }

    pub fn not_a_git_repo(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::NotAGitRepo, message)
    }
}

impl fmt::Display for PalisadeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for PalisadeError {}

/// Derefs to the message.
///
/// Ordinarily reserved for smart pointers, and taken here deliberately: the
/// message *is* what this type is, plus a label. It lets the several hundred
/// existing `err.contains("…")` assertions keep reading the way they always
/// did, and lets an error still be passed anywhere a `&str` is wanted — which
/// is the whole reason the switch away from `String` could be mechanical
/// instead of a rewrite of every call site that only ever wanted the text.
impl std::ops::Deref for PalisadeError {
    type Target = str;
    fn deref(&self) -> &str {
        &self.message
    }
}

/// The long tail. Every `format!`-built error in the backend arrives here and
/// keeps its message; it simply carries no discriminant yet.
///
/// The one exception is recognising git's own "not a repository" wording,
/// which is the single classification the frontend was doing by regex. It is
/// done here, once, against the text git itself emits, rather than in the UI
/// against whatever reached it.
impl From<String> for PalisadeError {
    fn from(message: String) -> Self {
        let kind = if message.to_ascii_lowercase().contains("not a git repository") {
            ErrorKind::NotAGitRepo
        } else {
            ErrorKind::Unknown
        };
        Self { kind, message }
    }
}

impl From<&str> for PalisadeError {
    fn from(message: &str) -> Self {
        Self::from(message.to_string())
    }
}

/// So a `PalisadeError` can still be fed to anything wanting a plain message.
impl From<PalisadeError> for String {
    fn from(err: PalisadeError) -> Self {
        err.message
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_untyped_error_keeps_its_message_and_says_it_is_untyped() {
        let err = PalisadeError::from(format!("cannot read directory: {}", "boom"));
        assert_eq!(err.kind, ErrorKind::Unknown);
        assert_eq!(err.message, "cannot read directory: boom");
        // Display is the message, so anything already printing these is
        // unchanged.
        assert_eq!(err.to_string(), "cannot read directory: boom");
    }

    #[test]
    fn git_s_own_wording_is_classified_once_here_instead_of_by_the_ui() {
        for message in [
            "fatal: not a git repository (or any of the parent directories): .git",
            "Not a git repository",
        ] {
            assert_eq!(
                PalisadeError::from(message.to_string()).kind,
                ErrorKind::NotAGitRepo,
                "{message}"
            );
        }
        assert_eq!(PalisadeError::from("unrelated".to_string()).kind, ErrorKind::Unknown);
    }

    #[test]
    fn every_variant_survives_a_round_trip_across_ipc() {
        // The frontend branches on `kind`, so the discriminant has to arrive
        // intact and spelled the way the TypeScript expects.
        for (kind, wire) in [
            (ErrorKind::NotAGitRepo, "notAGitRepo"),
            (ErrorKind::NotFound, "notFound"),
            (ErrorKind::OutsideProject, "outsideProject"),
            (ErrorKind::Unknown, "unknown"),
        ] {
            let original = PalisadeError::new(kind, "something happened");
            let json = serde_json::to_string(&original).unwrap();
            assert!(json.contains(&format!("\"kind\":\"{wire}\"")), "{json}");
            assert!(json.contains("\"message\":\"something happened\""), "{json}");

            let back: PalisadeError = serde_json::from_str(&json).unwrap();
            assert_eq!(back, original, "{wire} did not survive the round trip");
        }
    }

    #[test]
    fn the_constructors_set_the_kind_they_name() {
        assert_eq!(PalisadeError::not_found("x").kind, ErrorKind::NotFound);
        assert_eq!(PalisadeError::outside_project("x").kind, ErrorKind::OutsideProject);
        assert_eq!(PalisadeError::not_a_git_repo("x").kind, ErrorKind::NotAGitRepo);
    }
}
