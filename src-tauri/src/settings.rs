//! Project-level settings (`.palisade/project-settings.json`, D14/D15): format-on-save
//! commands and an executor override. `ensure_file` auto-creates it (with
//! self-documenting defaults) the moment a project is opened, so it's always
//! there to edit — but every reader still tolerates it being missing or
//! malformed, since it can be deleted or hand-broken after the fact.

use std::collections::HashMap;
use std::path::Path;
use std::process::{Command, Stdio};

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::store::Res;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ProjectSettings {
    /// Regex pattern (matched against the saved file's project-relative
    /// path) → shell command run after a save matches it (D14). E.g.
    /// `{ "\\.rs$": "cargo fmt", "\\.tsx?$": "prettier --write" }`.
    pub format_on_save: HashMap<String, String>,
    /// Force a specific agent for this project instead of PATH
    /// auto-detection (D15). Held as a free string and resolved against
    /// the discovered ACP Registry agents by id: an unrecognized name warns
    /// and falls back, where
    /// a typed enum would fail to parse and silently drop *every* setting in
    /// this file back to defaults.
    pub executor_override: Option<String>,
    /// Name → shell command that proves something works, e.g.
    /// `{ "test": "cargo test", "typecheck": "pnpm build" }`. Palisade runs these
    /// itself and persists the exit code: a spec is never "complete" because a
    /// model said so — it is green because a named command exited 0 at a named
    /// commit (D3).
    pub verify: HashMap<String, String>,
    /// Spec change name → list of verify command names pinned to that change's
    /// Tasks tab (D8). The first pinned command becomes the Tasks tab's
    /// primary "Run verify" action (D9). Machine-local UI state, not project
    /// config — same as the rest of this file.
    pub verify_pins: HashMap<String, Vec<String>>,
    /// Name → shell command the user runs by hand, e.g.
    /// `{ "dev": "pnpm start", "build": "cargo build" }` (Amendment 1).
    /// Project-scoped, not file-scoped: the title bar's split button runs
    /// these, the rail's Run panel edits them. Distinct from `verify` —
    /// `verify` is the evidence a spec is green, `run` is only a shortcut.
    pub run: HashMap<String, String>,
}

/// Lives under `.palisade/` alongside `chains/` — one folder for everything
/// Palisade writes into a project. No fallback to the old root-level
/// `.project-settings.json` (D12: clean break).
const FILE_NAME: &str = ".palisade/project-settings.json";

const DEFAULT_CONTENTS: &str =
    "{\n  \"formatOnSave\": {},\n  \"executorOverride\": null,\n  \"verify\": {},\n  \"verifyPins\": {},\n  \"run\": {}\n}\n";

/// Loads `.palisade/project-settings.json` from `project_root`. A missing file isn't
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

/// Creates `.palisade/project-settings.json` with self-documenting defaults if
/// the project doesn't have one yet — called on every project open so it's
/// there to edit without the user having to conjure the filename
/// themselves. A no-op once it exists; never overwrites real content.
/// Lazily creates `.palisade/` on the way, since this is usually the first
/// thing to write into it.
pub fn ensure_file(project_root: &Path) -> Res<()> {
    let path = project_root.join(FILE_NAME);
    if path.exists() {
        return Ok(());
    }
    write_file(project_root, DEFAULT_CONTENTS).map_err(|err| format!("create {FILE_NAME}: {err}"))
}

/// Writes the settings file, lazily creating `.palisade/` first — every
/// writer goes through here so none of them has to remember the directory
/// might not exist yet.
fn write_file(project_root: &Path, body: &str) -> Res<()> {
    let path = project_root.join(FILE_NAME);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| format!("create {}: {err}", parent.display()))?;
    }
    std::fs::write(&path, body).map_err(|err| err.to_string())
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
    // No stdin: a command that reads it (`npx` confirming a fetch, a formatter
    // defaulting to stdin) would otherwise block the save forever.
    let output = Command::new("sh")
        .arg("-c")
        .arg(&full_command)
        .current_dir(project_root)
        .stdin(Stdio::null())
        .output();
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

/// Reads the settings file as raw JSON rather than the typed
/// `ProjectSettings`, so a field one of the `save_*` functions below doesn't
/// know about (e.g. `appearance`, which is frontend-owned and has no Rust
/// model) survives a merge-and-rewrite untouched. Malformed or missing
/// content defaults to `{}` — every `save_*` caller here is a single-field
/// replace, so starting fresh loses only the one field a corrupt file would
/// have lost anyway.
fn read_doc(project_root: &Path) -> serde_json::Value {
    let path = project_root.join(FILE_NAME);
    let doc: serde_json::Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    if doc.is_object() { doc } else { serde_json::json!({}) }
}

fn write_doc(project_root: &Path, doc: serde_json::Value) -> Res<()> {
    let body = serde_json::to_string_pretty(&doc).map_err(|err| err.to_string())?;
    write_file(project_root, &(body + "\n")).map_err(|err| format!("write {FILE_NAME}: {err}"))
}

/// Replaces the `run` map, leaving every other setting in the file alone.
/// Re-reads before writing rather than holding state: this file is meant to
/// be hand-edited, so anything changed since load must survive the write.
pub fn save_run(project_root: &Path, commands: HashMap<String, String>) -> Res<()> {
    let mut doc = read_doc(project_root);
    doc["run"] = serde_json::to_value(commands).map_err(|err| err.to_string())?;
    write_doc(project_root, doc)
}

/// Replaces the `verifyPins` map (D8: spec change name → pinned verify
/// command names), leaving every other setting alone. The single writer for
/// this field — the frontend calls this instead of reading, merging, and
/// writing the file itself.
pub fn save_verify_pins(project_root: &Path, pins: HashMap<String, Vec<String>>) -> Res<()> {
    let mut doc = read_doc(project_root);
    doc["verifyPins"] = serde_json::to_value(pins).map_err(|err| err.to_string())?;
    write_doc(project_root, doc)
}

/// Replaces the `appearance` object, leaving every other setting alone.
/// `appearance` has no Rust model — it's a frontend-owned color-override
/// blob (`src/SettingsPanel.tsx`'s `Appearance` type) that Palisade only
/// stores and hands back, so this takes it as opaque JSON rather than a
/// typed struct.
pub fn save_appearance(project_root: &Path, appearance: serde_json::Value) -> Res<()> {
    let mut doc = read_doc(project_root);
    doc["appearance"] = appearance;
    write_doc(project_root, doc)
}

/// Proposes run commands by looking at what's actually in the project root.
/// Proposes only — the caller shows these to the user, and nothing reaches
/// `.palisade/project-settings.json` until they accept (D12: detection proposes, it
/// does not decide).
pub fn detect_run(project_root: &Path) -> Vec<(String, String)> {
    let mut found = Vec::new();

    if let Ok(raw) = std::fs::read_to_string(project_root.join("package.json")) {
        let runner = if project_root.join("pnpm-lock.yaml").exists() {
            "pnpm run"
        } else if project_root.join("yarn.lock").exists() {
            "yarn"
        } else {
            "npm run"
        };
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(scripts) = json.get("scripts").and_then(|s| s.as_object()) {
                for name in scripts.keys() {
                    found.push((name.clone(), format!("{runner} {name}")));
                }
            }
        }
    }
    if project_root.join("Cargo.toml").exists() {
        found.push(("cargo run".to_string(), "cargo run".to_string()));
    }
    if project_root.join("Makefile").exists() {
        found.push(("make".to_string(), "make".to_string()));
    }
    if project_root.join("pyproject.toml").exists() {
        found.push(("python".to_string(), "python -m .".to_string()));
    } else if let Ok(entries) = std::fs::read_dir(project_root) {
        // VER-10: no manifest at all is still "obviously runnable" when the
        // whole project is one script — exactly one top-level .py file, no
        // sibling to disambiguate from.
        let py_files: Vec<String> = entries
            .flatten()
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                (name.ends_with(".py") && e.file_type().map(|t| t.is_file()).unwrap_or(false))
                    .then_some(name)
            })
            .collect();
        if let [only] = py_files.as_slice() {
            found.push((only.clone(), format!("python3 {only}")));
        }
    }
    found.sort();
    found
}

/// One verification command's result, straight from the process.
pub struct VerifyOutcome {
    pub command: String,
    pub exit_code: i32,
    pub output_tail: String,
}

/// Run one named verify command the same way `run_format_on_save` runs a
/// formatter: `sh -c`, cwd = project root, stdout and stderr captured with the
/// exit status. Palisade runs it and reports what happened — it never decides that
/// a non-zero exit "doesn't count".
pub fn run_verify(settings: &ProjectSettings, project_root: &Path, name: &str) -> Res<VerifyOutcome> {
    let command = settings
        .verify
        .get(name)
        .ok_or_else(|| format!("no verify command named `{name}` in {FILE_NAME}"))?
        .clone();
    let output = Command::new("sh")
        .arg("-c")
        .arg(&command)
        .current_dir(project_root)
        .stdin(Stdio::null())
        .output()
        .map_err(|err| format!("{command} failed to start: {err}"))?;

    let mut body = String::from_utf8_lossy(&output.stdout).into_owned();
    body.push_str(&String::from_utf8_lossy(&output.stderr));
    Ok(VerifyOutcome {
        command,
        // A signal-killed process has no code; -1 records "died without one"
        // rather than pretending it passed.
        exit_code: output.status.code().unwrap_or(-1),
        output_tail: tail(&body, 8 * 1024),
    })
}

/// The last `limit` bytes, on a char boundary, marked when anything was cut.
fn tail(body: &str, limit: usize) -> String {
    if body.len() <= limit {
        return body.to_string();
    }
    let mut start = body.len() - limit;
    while start < body.len() && !body.is_char_boundary(start) {
        start += 1;
    }
    format!("… [{start} earlier bytes omitted]\n{}", &body[start..])
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
        write_file(root.path(), "{}").unwrap();
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
        write_file(root.path(), r#"{"executorOverride":"codex"}"#).unwrap();

        ensure_file(root.path()).unwrap();

        let (settings, _) = load(root.path());
        assert_eq!(settings.executor_override, Some("codex".to_string()), "must not clobber real settings");
    }

    #[test]
    fn malformed_json_falls_back_to_defaults_with_a_warning() {
        let root = tempfile::tempdir().unwrap();
        write_file(root.path(), "{ not json").unwrap();
        let (settings, warning) = load(root.path());
        assert_eq!(settings, ProjectSettings::default());
        assert!(warning.unwrap().contains(FILE_NAME));
    }

    #[test]
    fn all_fields_load_correctly() {
        let root = tempfile::tempdir().unwrap();
        write_file(root.path(),
            r#"{"formatOnSave":{"\\.rs$":"cargo fmt"},"executorOverride":"codex"}"#,
        )
        .unwrap();
        let (settings, warning) = load(root.path());
        assert!(warning.is_none());
        assert_eq!(settings.format_on_save.get(r"\.rs$"), Some(&"cargo fmt".to_string()));
        assert_eq!(settings.executor_override, Some("codex".to_string()));
    }

    #[test]
    fn verify_pins_load_and_default_to_empty_when_missing() {
        let root = tempfile::tempdir().unwrap();
        write_file(root.path(),
            r#"{"verifyPins":{"vibe-spec-tabs":["test","typecheck"]}}"#,
        )
        .unwrap();
        let (settings, _) = load(root.path());
        assert_eq!(
            settings.verify_pins.get("vibe-spec-tabs"),
            Some(&vec!["test".to_string(), "typecheck".to_string()])
        );
    }

    #[test]
    fn verify_pins_default_to_empty_for_an_old_settings_file() {
        let root = tempfile::tempdir().unwrap();
        write_file(root.path(),
            r#"{"verify":{}}"#,
        )
        .unwrap();
        let (settings, _) = load(root.path());
        assert!(settings.verify_pins.is_empty());
    }

    #[test]
    fn format_on_save_glob_match_runs_the_matched_command() {
        let root = tempfile::tempdir().unwrap();
        let mut format_on_save = HashMap::new();
        format_on_save.insert(r"\.txt$".to_string(), "echo formatted".to_string());
        let settings = ProjectSettings { format_on_save, executor_override: None, ..Default::default() };

        let result = run_format_on_save(&settings, root.path(), "notes/todo.txt").unwrap();
        assert!(result.contains("formatted"), "got {result}");
    }

    #[test]
    fn a_non_matching_path_runs_nothing() {
        let root = tempfile::tempdir().unwrap();
        let mut format_on_save = HashMap::new();
        format_on_save.insert(r"\.rs$".to_string(), "cargo fmt".to_string());
        let settings = ProjectSettings { format_on_save, executor_override: None, ..Default::default() };

        assert!(run_format_on_save(&settings, root.path(), "notes/todo.txt").is_none());
    }

    #[test]
    fn a_failing_command_is_reported_not_swallowed() {
        let root = tempfile::tempdir().unwrap();
        let mut format_on_save = HashMap::new();
        format_on_save.insert(r"\.rs$".to_string(), "false".to_string());
        let settings = ProjectSettings { format_on_save, executor_override: None, ..Default::default() };

        let result = run_format_on_save(&settings, root.path(), "lib.rs").unwrap();
        assert!(result.contains("failed"), "got {result}");
    }

    #[test]
    fn a_filename_with_shell_metacharacters_does_not_break_out() {
        let root = tempfile::tempdir().unwrap();
        let mut format_on_save = HashMap::new();
        format_on_save.insert(r"\.rs$".to_string(), "echo".to_string());
        let settings = ProjectSettings { format_on_save, executor_override: None, ..Default::default() };

        // A naive unquoted interpolation would let `; rm -rf /` execute as a
        // second command — this only proves it's treated as one literal arg.
        let result = run_format_on_save(&settings, root.path(), "a'; touch pwned.rs").unwrap();
        assert!(!root.path().join("pwned.rs").exists());
        assert!(result.contains("a'; touch pwned.rs"), "got {result}");
    }

    fn with_verify(pairs: &[(&str, &str)]) -> ProjectSettings {
        ProjectSettings {
            verify: pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            ..Default::default()
        }
    }

    /// Task 5.7: the exit code is the whole point — a failure that gets
    /// swallowed or rounded to "ok" would make verification a lie.
    #[test]
    fn verify_records_the_exit_code_and_keeps_the_failing_output() {
        let root = tempfile::tempdir().unwrap();
        let settings = with_verify(&[
            ("green", "echo all good"),
            ("red", "echo to-stdout; echo the-reason >&2; exit 3"),
        ]);

        let pass = run_verify(&settings, root.path(), "green").unwrap();
        assert_eq!(pass.exit_code, 0);
        assert!(pass.output_tail.contains("all good"));

        let fail = run_verify(&settings, root.path(), "red").unwrap();
        assert_eq!(fail.exit_code, 3, "the real code, not a boolean");
        assert!(fail.output_tail.contains("the-reason"), "stderr must survive");
        assert!(fail.output_tail.contains("to-stdout"), "and so must stdout");
        assert_eq!(fail.command, "echo to-stdout; echo the-reason >&2; exit 3");

        // An unconfigured name is an error, not a silent pass.
        assert!(run_verify(&settings, root.path(), "nope").is_err());
    }

    /// Task 5.8: the verify command is the user's own shell line, run whole.
    /// What must not happen is a *filename* smuggling a second command in —
    /// the failure `shell_quote` exists to prevent.
    #[test]
    fn a_verify_command_runs_in_the_project_root_and_cannot_be_extended_by_a_path() {
        let root = tempfile::tempdir().unwrap();
        // cwd is the project root, which is how the command finds the project.
        let settings = with_verify(&[("where", "pwd")]);
        let outcome = run_verify(&settings, root.path(), "where").unwrap();
        assert_eq!(outcome.exit_code, 0);

        // The same quoting guard `run_format_on_save` relies on: a filename
        // carrying `'; touch pwned` is one literal argument, not two commands.
        let mut format_on_save = HashMap::new();
        format_on_save.insert(r"\.rs$".to_string(), "true".to_string());
        let formatting = ProjectSettings { format_on_save, ..Default::default() };
        run_format_on_save(&formatting, root.path(), "x'; touch pwned.rs").unwrap();
        assert!(!root.path().join("pwned.rs").exists());
    }

    #[test]
    fn a_huge_verify_output_is_tailed_with_a_marker() {
        let root = tempfile::tempdir().unwrap();
        // 200k of output — a real test suite's log, not a pathological case.
        let settings = with_verify(&[("noisy", "for i in $(seq 1 20000); do echo 0123456789; done")]);
        let outcome = run_verify(&settings, root.path(), "noisy").unwrap();
        assert_eq!(outcome.exit_code, 0);
        assert!(outcome.output_tail.len() < 20 * 1024);
        assert!(outcome.output_tail.contains("earlier bytes omitted"));
        // The *tail* is what's kept — a failure's last words are its reason.
        assert!(outcome.output_tail.trim_end().ends_with("0123456789"));
    }

    /// `verify` is additive: a settings file written before it existed still
    /// loads, and everything else in the file survives.
    #[test]
    fn a_settings_file_without_verify_still_loads() {
        let root = tempfile::tempdir().unwrap();
        write_file(root.path(),
            r#"{"formatOnSave": {"\\.rs$": "cargo fmt"}, "executorOverride": "codex"}"#,
        )
        .unwrap();
        let (settings, warning) = load(root.path());
        assert!(warning.is_none());
        assert!(settings.verify.is_empty());
        assert_eq!(settings.executor_override.as_deref(), Some("codex"));
        assert_eq!(settings.format_on_save.len(), 1);
    }

    /// `run` is additive the same way `verify` was: an older settings file
    /// still loads, and nothing else in it is lost.
    #[test]
    fn a_settings_file_without_run_still_loads() {
        let root = tempfile::tempdir().unwrap();
        write_file(root.path(),
            r#"{"formatOnSave": {}, "verify": {"test": "cargo test"}}"#,
        )
        .unwrap();
        let (settings, warning) = load(root.path());
        assert!(warning.is_none());
        assert!(settings.run.is_empty());
        assert_eq!(settings.verify.get("test").map(String::as_str), Some("cargo test"));
    }

    #[test]
    fn saving_run_commands_keeps_every_other_setting() {
        let root = tempfile::tempdir().unwrap();
        write_file(root.path(),
            r#"{"formatOnSave": {"\\.rs$": "cargo fmt"}, "executorOverride": "codex", "verify": {"test": "cargo test"}}"#,
        )
        .unwrap();
        let mut commands = HashMap::new();
        commands.insert("dev".to_string(), "pnpm start".to_string());
        save_run(root.path(), commands).unwrap();

        let (settings, warning) = load(root.path());
        assert!(warning.is_none());
        assert_eq!(settings.run.get("dev").map(String::as_str), Some("pnpm start"));
        assert_eq!(settings.executor_override.as_deref(), Some("codex"));
        assert_eq!(settings.verify.len(), 1);
        assert_eq!(settings.format_on_save.len(), 1);
    }

    #[test]
    fn saving_run_commands_works_without_an_existing_file() {
        let root = tempfile::tempdir().unwrap();
        let mut commands = HashMap::new();
        commands.insert("build".to_string(), "cargo build".to_string());
        save_run(root.path(), commands).unwrap();
        assert_eq!(load(root.path()).0.run.get("build").map(String::as_str), Some("cargo build"));
    }

    #[test]
    fn saving_verify_pins_keeps_every_other_setting() {
        let root = tempfile::tempdir().unwrap();
        write_file(root.path(),
            r#"{"executorOverride": "codex", "run": {"dev": "pnpm start"}}"#,
        )
        .unwrap();
        let mut pins = HashMap::new();
        pins.insert("vibe-spec-tabs".to_string(), vec!["test".to_string()]);
        save_verify_pins(root.path(), pins).unwrap();

        let (settings, warning) = load(root.path());
        assert!(warning.is_none());
        assert_eq!(
            settings.verify_pins.get("vibe-spec-tabs"),
            Some(&vec!["test".to_string()])
        );
        assert_eq!(settings.executor_override.as_deref(), Some("codex"));
        assert_eq!(settings.run.get("dev").map(String::as_str), Some("pnpm start"));
    }

    /// `appearance` has no field on `ProjectSettings` — it's frontend-owned
    /// JSON that Palisade only stores. Saving it must not clobber fields the
    /// typed struct doesn't know about, and a round trip through raw JSON
    /// must return exactly what was saved.
    #[test]
    fn saving_appearance_is_opaque_and_keeps_every_other_setting() {
        let root = tempfile::tempdir().unwrap();
        write_file(root.path(), r#"{"executorOverride": "codex"}"#).unwrap();

        save_appearance(root.path(), serde_json::json!({"accentHue": {"light": "210"}})).unwrap();

        let (settings, warning) = load(root.path());
        assert!(warning.is_none());
        assert_eq!(settings.executor_override.as_deref(), Some("codex"));

        let raw = std::fs::read_to_string(root.path().join(FILE_NAME)).unwrap();
        let doc: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(doc["appearance"]["accentHue"]["light"], "210");
    }

    /// A save must never fail just because the file it's about to replace one
    /// field of is unreadable — that would turn a recoverable corruption into
    /// "you can no longer change your appearance." Starting over from `{}`
    /// loses only the fields the malformed file already lost.
    #[test]
    fn saving_appearance_over_a_malformed_file_succeeds_and_starts_fresh() {
        let root = tempfile::tempdir().unwrap();
        write_file(root.path(), r#"{"formatOnSave":"#).unwrap();

        save_appearance(root.path(), serde_json::json!({"accentHue": {"light": "210"}})).unwrap();

        let raw = std::fs::read_to_string(root.path().join(FILE_NAME)).unwrap();
        let doc: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(doc["appearance"]["accentHue"]["light"], "210");
    }

    #[test]
    fn saving_verify_pins_or_appearance_works_without_an_existing_file() {
        let root = tempfile::tempdir().unwrap();
        let mut pins = HashMap::new();
        pins.insert("change".to_string(), vec!["typecheck".to_string()]);
        save_verify_pins(root.path(), pins).unwrap();
        assert_eq!(
            load(root.path()).0.verify_pins.get("change"),
            Some(&vec!["typecheck".to_string()])
        );

        save_appearance(root.path(), serde_json::json!({"shellAccentColor": {"dark": "5"}})).unwrap();
        let raw = std::fs::read_to_string(root.path().join(FILE_NAME)).unwrap();
        let doc: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(doc["appearance"]["shellAccentColor"]["dark"], "5");
        // The earlier save_verify_pins call must still be intact after this
        // second single-field write.
        assert_eq!(doc["verifyPins"]["change"][0], "typecheck");
    }

    #[test]
    fn detection_proposes_package_json_scripts() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(
            root.path().join("package.json"),
            r#"{"scripts": {"dev": "vite", "build": "tsc && vite build"}}"#,
        )
        .unwrap();
        // No lockfile: npm is the safe assumption.
        let found = detect_run(root.path());
        assert!(found.contains(&("dev".to_string(), "npm run dev".to_string())));
        assert!(found.contains(&("build".to_string(), "npm run build".to_string())));

        // The lockfile decides the runner — `npm run dev` in a pnpm project
        // is a proposal the user has to correct by hand every time.
        std::fs::write(root.path().join("pnpm-lock.yaml"), "").unwrap();
        let found = detect_run(root.path());
        assert!(found.contains(&("dev".to_string(), "pnpm run dev".to_string())));
    }

    #[test]
    fn detection_proposes_cargo_make_and_python_entries() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("Cargo.toml"), "[package]\nname = \"x\"\n").unwrap();
        std::fs::write(root.path().join("Makefile"), "build:\n\techo hi\n").unwrap();
        std::fs::write(root.path().join("pyproject.toml"), "[project]\nname = \"x\"\n").unwrap();
        let found = detect_run(root.path());
        let names: Vec<&str> = found.iter().map(|(n, _)| n.as_str()).collect();
        assert!(names.contains(&"cargo run"));
        assert!(names.contains(&"make"));
        assert!(names.contains(&"python"));
    }

    /// Detection proposes; it never writes. A project with candidates but no
    /// settings file must still have an empty `run` until the user accepts.
    #[test]
    fn detection_never_writes_the_settings_file() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("package.json"), r#"{"scripts": {"dev": "vite"}}"#).unwrap();
        let found = detect_run(root.path());
        assert!(!found.is_empty());
        assert!(load(root.path()).0.run.is_empty());
        assert!(!root.path().join(FILE_NAME).exists());
    }

    #[test]
    fn detection_is_empty_for_a_project_with_no_manifest() {
        let root = tempfile::tempdir().unwrap();
        assert!(detect_run(root.path()).is_empty());
    }

    /// VER-10: a bare single-file script (no pyproject.toml, no package
    /// manifest at all) had nothing to suggest — the panel said "nothing
    /// obvious to suggest" for a project that's obviously one runnable file.
    #[test]
    fn detection_proposes_running_a_lone_top_level_python_script() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("greet.py"), "print('hi')\n").unwrap();
        let found = detect_run(root.path());
        assert!(found.contains(&("greet.py".to_string(), "python3 greet.py".to_string())));
    }

    /// Ambiguous with more than one candidate entry point — guessing which
    /// one is "the" script is worse than staying silent and letting the user
    /// add one by hand.
    #[test]
    fn detection_stays_silent_with_more_than_one_top_level_python_script() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("a.py"), "").unwrap();
        std::fs::write(root.path().join("b.py"), "").unwrap();
        assert!(detect_run(root.path()).is_empty());
    }

    /// A real Python project already gets the `pyproject.toml`-driven
    /// suggestion — the lone-script heuristic is a fallback, not a second,
    /// conflicting proposal on top of it.
    #[test]
    fn detection_prefers_pyproject_over_the_lone_script_heuristic() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("pyproject.toml"), "[project]\nname = \"x\"\n").unwrap();
        std::fs::write(root.path().join("main.py"), "").unwrap();
        let found = detect_run(root.path());
        assert_eq!(found, vec![("python".to_string(), "python -m .".to_string())]);
    }
}
