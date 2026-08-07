//! Project-level settings (`.project-settings.json`, D14/D15): format-on-save
//! commands and an executor override. `ensure_file` auto-creates it (with
//! self-documenting defaults) the moment a project is opened, so it's always
//! there to edit — but every reader still tolerates it being missing or
//! malformed, since it can be deleted or hand-broken after the fact.

use std::collections::HashMap;
use std::path::Path;
use std::process::Command;

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::executor::Kind;
use crate::store::Res;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ProjectSettings {
    /// Regex pattern (matched against the saved file's project-relative
    /// path) → shell command run after a save matches it (D14). E.g.
    /// `{ "\\.rs$": "cargo fmt", "\\.tsx?$": "prettier --write" }`.
    pub format_on_save: HashMap<String, String>,
    /// Force a specific executor for this project instead of PATH
    /// auto-detection (D15).
    pub executor_override: Option<Kind>,
}

const FILE_NAME: &str = ".project-settings.json";

const DEFAULT_CONTENTS: &str = "{\n  \"formatOnSave\": {},\n  \"executorOverride\": null\n}\n";

/// Loads `.project-settings.json` from `project_root`. A missing file isn't
/// an error — it's the common case (e.g. before `ensure_file` has run, or
/// if it was deleted after the fact), and yields defaults so the IDE works
/// without one. Malformed JSON also falls back to defaults (never blocks
/// project load), paired with a warning for the caller to surface rather
/// than swallow silently.
pub fn load(project_root: &Path) -> (ProjectSettings, Option<String>) {
    let path = project_root.join(FILE_NAME);
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(_) => return (ProjectSettings::default(), None),
    };
    match serde_json::from_str(&raw) {
        Ok(settings) => (settings, None),
        Err(err) => {
            (ProjectSettings::default(), Some(format!("{FILE_NAME} is malformed, using defaults: {err}")))
        }
    }
}

/// Creates `.project-settings.json` with self-documenting defaults if the
/// project doesn't have one yet — called on every project open so it's
/// there to edit without the user having to conjure the filename
/// themselves. A no-op once it exists; never overwrites real content.
pub fn ensure_file(project_root: &Path) -> Res<()> {
    let path = project_root.join(FILE_NAME);
    if path.exists() {
        return Ok(());
    }
    std::fs::write(&path, DEFAULT_CONTENTS).map_err(|err| format!("create {FILE_NAME}: {err}"))
}

/// If `relative_path` matches one of `settings.format_on_save`'s regex keys,
/// runs the paired shell command (cwd = project root, the saved file's
/// relative path appended as the command's final, shell-quoted argument) and
/// returns a ready-to-display summary. `None` when nothing matched — the
/// common case. A malformed regex pattern never matches (rather than
/// erroring the save). Iteration order over a `HashMap` is unspecified, so a
/// path matched by more than one pattern runs exactly one (arbitrary)
/// command, never all of them.
pub fn run_format_on_save(settings: &ProjectSettings, project_root: &Path, relative_path: &str) -> Option<String> {
    let command = settings
        .format_on_save
        .iter()
        .find(|(pattern, _)| Regex::new(pattern).is_ok_and(|re| re.is_match(relative_path)))
        .map(|(_, command)| command)?;

    let full_command = format!("{command} {}", shell_quote(relative_path));
    let output = Command::new("sh").arg("-c").arg(&full_command).current_dir(project_root).output();
    Some(match output {
        Ok(output) => {
            let body = String::from_utf8_lossy(if output.status.success() {
                &output.stdout
            } else {
                &output.stderr
            });
            let body = body.trim();
            if output.status.success() {
                format!("{command}: {}", if body.is_empty() { "ok" } else { body })
            } else {
                format!(
                    "{command} failed ({}): {}",
                    output.status,
                    if body.is_empty() { "(no output)" } else { body }
                )
            }
        }
        Err(err) => format!("{command} failed to start: {err}"),
    })
}

/// POSIX single-quoting — safe against any filename, including ones with
/// spaces or shell metacharacters.
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

// ------------------------------------------------------------------ tests

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_settings_file_yields_defaults_and_no_warning() {
        let root = tempfile::tempdir().unwrap();
        let (settings, warning) = load(root.path());
        assert_eq!(settings, ProjectSettings::default());
        assert!(warning.is_none());
    }

    #[test]
    fn an_empty_settings_file_yields_defaults() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join(FILE_NAME), "{}").unwrap();
        let (settings, warning) = load(root.path());
        assert_eq!(settings, ProjectSettings::default());
        assert!(warning.is_none());
    }

    #[test]
    fn ensure_file_creates_valid_defaults_when_missing() {
        let root = tempfile::tempdir().unwrap();
        ensure_file(root.path()).unwrap();

        let path = root.path().join(FILE_NAME);
        assert!(path.exists());
        // The written defaults must themselves parse cleanly through `load`.
        let (settings, warning) = load(root.path());
        assert_eq!(settings, ProjectSettings::default());
        assert!(warning.is_none());
    }

    #[test]
    fn ensure_file_never_overwrites_existing_content() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join(FILE_NAME), r#"{"executorOverride":"codex"}"#).unwrap();

        ensure_file(root.path()).unwrap();

        let (settings, _) = load(root.path());
        assert_eq!(settings.executor_override, Some(Kind::Codex), "must not clobber real settings");
    }

    #[test]
    fn malformed_json_falls_back_to_defaults_with_a_warning() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join(FILE_NAME), "{ not json").unwrap();
        let (settings, warning) = load(root.path());
        assert_eq!(settings, ProjectSettings::default());
        assert!(warning.unwrap().contains(FILE_NAME));
    }

    #[test]
    fn all_fields_load_correctly() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(
            root.path().join(FILE_NAME),
            r#"{"formatOnSave":{"\\.rs$":"cargo fmt"},"executorOverride":"codex"}"#,
        )
        .unwrap();
        let (settings, warning) = load(root.path());
        assert!(warning.is_none());
        assert_eq!(settings.format_on_save.get(r"\.rs$"), Some(&"cargo fmt".to_string()));
        assert_eq!(settings.executor_override, Some(Kind::Codex));
    }

    #[test]
    fn format_on_save_glob_match_runs_the_matched_command() {
        let root = tempfile::tempdir().unwrap();
        let mut format_on_save = HashMap::new();
        format_on_save.insert(r"\.txt$".to_string(), "echo formatted".to_string());
        let settings = ProjectSettings { format_on_save, executor_override: None };

        let result = run_format_on_save(&settings, root.path(), "notes/todo.txt").unwrap();
        assert!(result.contains("formatted"), "got {result}");
    }

    #[test]
    fn a_non_matching_path_runs_nothing() {
        let root = tempfile::tempdir().unwrap();
        let mut format_on_save = HashMap::new();
        format_on_save.insert(r"\.rs$".to_string(), "cargo fmt".to_string());
        let settings = ProjectSettings { format_on_save, executor_override: None };

        assert!(run_format_on_save(&settings, root.path(), "notes/todo.txt").is_none());
    }

    #[test]
    fn a_failing_command_is_reported_not_swallowed() {
        let root = tempfile::tempdir().unwrap();
        let mut format_on_save = HashMap::new();
        format_on_save.insert(r"\.rs$".to_string(), "false".to_string());
        let settings = ProjectSettings { format_on_save, executor_override: None };

        let result = run_format_on_save(&settings, root.path(), "lib.rs").unwrap();
        assert!(result.contains("failed"), "got {result}");
    }

    #[test]
    fn a_filename_with_shell_metacharacters_does_not_break_out() {
        let root = tempfile::tempdir().unwrap();
        let mut format_on_save = HashMap::new();
        format_on_save.insert(r"\.rs$".to_string(), "echo".to_string());
        let settings = ProjectSettings { format_on_save, executor_override: None };

        // A naive unquoted interpolation would let `; rm -rf /` execute as a
        // second command — this only proves it's treated as one literal arg.
        let result = run_format_on_save(&settings, root.path(), "a'; touch pwned.rs").unwrap();
        assert!(!root.path().join("pwned.rs").exists());
        assert!(result.contains("a'; touch pwned.rs"), "got {result}");
    }
}
