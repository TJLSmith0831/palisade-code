//! User-level agent skills, read-only.
//!
//! A skill is a directory with a `SKILL.md` in it. Both CLIs Palisade speaks to
//! keep theirs under the home directory (`~/.claude/skills`, `~/.agents/skills`),
//! so this is a listing of what is installed for the *user*, not what a repo
//! happens to contain. Nothing here writes; the panel is a mirror.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    pub name: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Which home the skill came from: `claude`, `agents`, or `other`.
    pub owner: String,
}

/// The `description:` value from a `SKILL.md`'s YAML frontmatter, if it has one.
///
/// Deliberately a line scanner rather than a YAML parse: the only key anything
/// reads is `description`, and a skill whose frontmatter is malformed should
/// still list by name instead of vanishing.
pub(crate) fn parse_description(text: &str) -> Option<String> {
    let mut lines = text.lines();
    // Frontmatter only — a `description:` in the body is prose, not metadata.
    if lines.next()?.trim() != "---" {
        return None;
    }
    for line in lines {
        let trimmed = line.trim_end();
        if trimmed.trim() == "---" {
            return None;
        }
        if let Some(rest) = trimmed.strip_prefix("description:") {
            let value = rest.trim().trim_matches(|c| c == '"' || c == '\'').trim();
            if value.is_empty() {
                return None;
            }
            return Some(value.to_string());
        }
    }
    None
}

/// Every `<root>/<name>/SKILL.md` under one skills root, unsorted.
pub(crate) fn scan_root(root: &Path, owner: &str) -> Vec<Skill> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let dir = entry.path();
        let manifest = dir.join("SKILL.md");
        if !manifest.is_file() {
            continue;
        }
        let Some(name) = dir.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let description = std::fs::read_to_string(&manifest)
            .ok()
            .and_then(|text| parse_description(&text));
        out.push(Skill {
            name: name.to_string(),
            path: dir.to_string_lossy().into_owned(),
            description,
            owner: owner.to_string(),
        });
    }
    out
}

/// The user's installed skills from both homes, sorted by name.
pub fn list_skills() -> Vec<Skill> {
    let home: PathBuf = crate::executor::home();
    let mut out = scan_root(&home.join(".claude/skills"), "claude");
    out.extend(scan_root(&home.join(".agents/skills"), "agents"));
    out.sort_by(|a, b| a.name.cmp(&b.name).then(a.owner.cmp(&b.owner)));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn description_comes_from_frontmatter() {
        let text = "---\nname: grill-apply\ndescription: Implement an OpenSpec change.\n---\n\n# Body\n";
        assert_eq!(
            parse_description(text).as_deref(),
            Some("Implement an OpenSpec change.")
        );
    }

    #[test]
    fn quoted_description_is_unwrapped() {
        let text = "---\ndescription: \"Runs the thing\"\n---\n";
        assert_eq!(parse_description(text).as_deref(), Some("Runs the thing"));
    }

    #[test]
    fn frontmatter_without_description_is_none() {
        let text = "---\nname: bare\n---\ndescription: this is prose\n";
        assert_eq!(parse_description(text), None);
        assert_eq!(parse_description("# No frontmatter\n"), None);
        assert_eq!(parse_description("---\ndescription:   \n---\n"), None);
    }

    #[test]
    fn scan_skips_dirs_without_a_manifest() {
        let root = std::env::temp_dir().join(format!("palisade-skills-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("has-one")).unwrap();
        std::fs::create_dir_all(root.join("empty")).unwrap();
        std::fs::write(
            root.join("has-one/SKILL.md"),
            "---\ndescription: Does one thing\n---\n",
        )
        .unwrap();

        let found = scan_root(&root, "claude");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].name, "has-one");
        assert_eq!(found[0].owner, "claude");
        assert_eq!(found[0].description.as_deref(), Some("Does one thing"));

        let _ = std::fs::remove_dir_all(&root);
        assert!(scan_root(&root, "claude").is_empty());
    }
}
