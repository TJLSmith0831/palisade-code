//! Grill skill injection (D19, D20).
//!
//! The four grill skills (explore, propose, apply, archive) are baked into
//! Palisade as bundled resources. Palisade injects the relevant skill's instructions
//! into every `session/prompt` based on the thread's mode. The agent receives
//! skill content as prompt text — no per-agent skill installation required.

use crate::executor::{GRILL_APPLY, GRILL_ARCHIVE, GRILL_EXPLORE, GRILL_PROPOSE};

/// Which grill skill to inject based on mode and context.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GrillSkill {
    /// Spec-mode with no existing change — explore the problem.
    Explore,
    /// Spec-mode with an existing change — propose/refine.
    Propose,
    /// Go-mode — apply/implement.
    Apply,
    /// UI-triggered archive action.
    Archive,
}

impl GrillSkill {
    /// Determine which skill to inject based on mode and whether a change exists.
    ///
    /// Per amended D19: only spec-mode injects grill skills. Go-mode has no
    /// skill injection — it's for direct implementation, not skill-driven
    /// grilling. `grill-apply` is a UI-triggered one-shot, not mode-triggered.
    pub fn for_mode(mode: &str, has_change: bool) -> Option<Self> {
        match mode {
            "spec" if !has_change => Some(GrillSkill::Explore),
            "spec" => Some(GrillSkill::Propose),
            _ => None,
        }
    }

    /// Get the skill content for this skill.
    pub fn content(&self) -> &'static str {
        match self {
            GrillSkill::Explore => GRILL_EXPLORE,
            GrillSkill::Propose => GRILL_PROPOSE,
            GrillSkill::Apply => GRILL_APPLY,
            GrillSkill::Archive => GRILL_ARCHIVE,
        }
    }

    /// Get a human-readable label for this skill.
    pub fn label(&self) -> &'static str {
        match self {
            GrillSkill::Explore => "grill-explore",
            GrillSkill::Propose => "grill-propose",
            GrillSkill::Apply => "grill-apply",
            GrillSkill::Archive => "grill-archive",
        }
    }
}

/// Inject grill skill instructions into a user message.
///
/// The skill content is prepended to the user's message (D19: "injected into
/// every session/prompt"). The agent receives it as prompt text.
pub fn inject_skill(skill: &GrillSkill, user_message: &str) -> String {
    let content = skill.content();
    format!("{content}\n\n---\n\n{user_message}")
}

/// Build a prompt with the appropriate grill skill injected.
///
/// Returns the full prompt text with skill instructions prepended, or just
/// the user message if no skill applies.
pub fn build_prompt(mode: &str, has_change: bool, user_message: &str) -> String {
    match GrillSkill::for_mode(mode, has_change) {
        Some(skill) => inject_skill(&skill, user_message),
        None => user_message.to_string(),
    }
}

// ------------------------------------------------------------------ tests

#[cfg(test)]
mod tests {
    use super::*;

    // --------------------------------------------------------- 6.1: spec-mode → grill-explore

    /// RED→GREEN 6.1: Spec-mode with no change injects grill-explore.
    #[test]
    fn spec_mode_without_change_injects_explore() {
        let skill = GrillSkill::for_mode("spec", false).unwrap();
        assert_eq!(skill, GrillSkill::Explore);
        assert_eq!(skill.label(), "grill-explore");
        // Content should be non-empty (the bundled SKILL.md).
        assert!(!skill.content().is_empty());
        assert!(skill.content().contains("grill-explore"));
    }

    // --------------------------------------------------------- 6.2: spec-mode + change → grill-propose

    /// RED→GREEN 6.2: Spec-mode with an existing change injects grill-propose.
    #[test]
    fn spec_mode_with_change_injects_propose() {
        let skill = GrillSkill::for_mode("spec", true).unwrap();
        assert_eq!(skill, GrillSkill::Propose);
        assert_eq!(skill.label(), "grill-propose");
        assert!(!skill.content().is_empty());
    }

    // --------------------------------------------------------- 6.3: go-mode → NO skill injection

    /// RED→GREEN 6.3: Go-mode injects NO skill (per amended D19 — go-mode is
    /// for direct implementation, not skill-driven grilling).
    #[test]
    fn go_mode_injects_no_skill() {
        assert_eq!(GrillSkill::for_mode("go", false), None);
        assert_eq!(GrillSkill::for_mode("go", true), None);
    }

    /// RED→GREEN 6a.4: Go-mode with an open change does NOT inject grill-apply.
    /// The raw message passes through unchanged — no skill prefix, no separator.
    #[test]
    fn go_mode_with_change_does_not_inject_apply() {
        let prompt = build_prompt("go", true, "grill-apply my-change");
        assert_eq!(prompt, "grill-apply my-change");
        assert!(!prompt.contains("---"));
    }

    // --------------------------------------------------------- 6.4: grill-archive as UI action

    /// RED→GREEN 6.4: Grill-archive has content and is not mode-triggered.
    #[test]
    fn archive_is_available_as_ui_action() {
        let skill = GrillSkill::Archive;
        assert_eq!(skill.label(), "grill-archive");
        assert!(!skill.content().is_empty());
        // Archive is not triggered by mode — it's a UI action.
        assert_ne!(GrillSkill::for_mode("spec", false), Some(GrillSkill::Archive));
        assert_ne!(GrillSkill::for_mode("go", false), Some(GrillSkill::Archive));
    }

    // --------------------------------------------------------- 6.5: skill content prepended

    /// RED→GREEN 6.5: Skill content is prepended to the user's message.
    #[test]
    fn skill_content_is_prepended_not_appended() {
        let prompt = build_prompt("spec", false, "Help me design a feature.");
        // The skill content should come before the user message.
        let explore_pos = prompt.find("grill-explore").unwrap();
        let user_pos = prompt.find("Help me design a feature.").unwrap();
        assert!(explore_pos < user_pos, "skill content must be prepended");
    }

    /// RED→GREEN 6.5: Without a matching skill, the message is unchanged.
    #[test]
    fn no_skill_leaves_message_unchanged() {
        let prompt = build_prompt("chat", false, "Hello");
        assert_eq!(prompt, "Hello");
    }

    /// inject_skill produces a string with both skill and message.
    #[test]
    fn inject_skill_includes_both_parts() {
        let result = inject_skill(&GrillSkill::Apply, "fix the bug");
        assert!(result.contains("grill-apply"));
        assert!(result.contains("fix the bug"));
        assert!(result.contains("---"));
    }
}
