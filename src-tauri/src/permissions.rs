//! ACP permission handling (D12, D15).
//!
//! Floo handles ACP `permission_request` notifications as the permission gate.
//! Spec/go/bypass modes become permission-response policies using ACP's
//! tool-kind taxonomy. The bypass toggle suppresses all prompts.

/// ACP tool kinds that Floo recognizes for permission decisions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolKind {
    Read,
    Search,
    Think,
    Fetch,
    Edit,
    Delete,
    Move,
    Execute,
    /// Any tool kind not in the known taxonomy.
    Other,
}

impl ToolKind {
    /// Parse from an ACP tool kind string.
    pub fn from_str(kind: &str) -> Self {
        match kind {
            "read" => ToolKind::Read,
            "search" => ToolKind::Search,
            "think" => ToolKind::Think,
            "fetch" => ToolKind::Fetch,
            "edit" => ToolKind::Edit,
            "delete" => ToolKind::Delete,
            "move" => ToolKind::Move,
            "execute" => ToolKind::Execute,
            _ => ToolKind::Other,
        }
    }
}

/// The permission decision Floo makes for a tool request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PermissionDecision {
    /// Auto-approve the request.
    Allow,
    /// Auto-deny the request.
    Deny,
    /// Prompt the user to decide.
    Prompt,
}

/// Permission mode (maps to the thread's mode).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionMode {
    Spec,
    Go,
    Bypass,
}

/// Decide whether to allow, deny, or prompt for a tool request.
///
/// D15: Mode as permission-response policy, aligned with industry patterns.
///
/// - **Spec-mode**: auto-approve read/search/think/fetch; auto-deny edit/delete/move/execute.
///   The agent investigates and proposes but cannot modify files.
/// - **Go-mode**: auto-approve read/search/think/fetch/edit/move; prompt for execute/delete.
///   Auto-approves file edits within workspace but gates shell execution and destructive ops.
/// - **Bypass**: auto-approve everything.
/// - **Ambiguous/other**: prompt the user.
///
/// D20: `openspec` commands are whitelisted in all modes — `execute` running
/// `openspec` is auto-approved even in spec-mode.
pub fn decide_permission(
    mode: PermissionMode,
    tool_kind: ToolKind,
    command: Option<&str>,
) -> PermissionDecision {
    // Bypass: everything is auto-approved.
    if mode == PermissionMode::Bypass {
        return PermissionDecision::Allow;
    }

    // D20: openspec CLI commands are whitelisted in all modes.
    if tool_kind == ToolKind::Execute {
        if let Some(cmd) = command {
            if is_openspec_command(cmd) {
                return PermissionDecision::Allow;
            }
        }
    }

    match mode {
        PermissionMode::Spec => match tool_kind {
            ToolKind::Read | ToolKind::Search | ToolKind::Think | ToolKind::Fetch => {
                PermissionDecision::Allow
            }
            ToolKind::Edit | ToolKind::Delete | ToolKind::Move | ToolKind::Execute => {
                PermissionDecision::Deny
            }
            ToolKind::Other => PermissionDecision::Prompt,
        },
        PermissionMode::Go => match tool_kind {
            ToolKind::Read | ToolKind::Search | ToolKind::Think | ToolKind::Fetch
            | ToolKind::Edit | ToolKind::Move => {
                PermissionDecision::Allow
            }
            ToolKind::Execute | ToolKind::Delete => {
                PermissionDecision::Prompt
            }
            ToolKind::Other => PermissionDecision::Prompt,
        },
        PermissionMode::Bypass => PermissionDecision::Allow,
    }
}

/// Check if a command string is an `openspec` invocation.
fn is_openspec_command(command: &str) -> bool {
    let trimmed = command.trim();
    trimmed == "openspec"
        || trimmed.starts_with("openspec ")
        || trimmed.contains(" openspec ")
        || trimmed.starts_with("npx openspec")
}

// ------------------------------------------------------------------ tests

#[cfg(test)]
mod tests {
    use super::*;

    // --------------------------------------------------------- 5.1: spec-mode auto-deny

    /// RED→GREEN 5.1: Spec-mode auto-denies edit/delete/move/execute.
    #[test]
    fn spec_mode_auto_denies_writes() {
        for kind in &[ToolKind::Edit, ToolKind::Delete, ToolKind::Move, ToolKind::Execute] {
            assert_eq!(
                decide_permission(PermissionMode::Spec, *kind, None),
                PermissionDecision::Deny,
                "spec-mode should deny {kind:?}"
            );
        }
    }

    // --------------------------------------------------------- 5.2: spec-mode auto-approve

    /// RED→GREEN 5.2: Spec-mode auto-approves read/search/think/fetch.
    #[test]
    fn spec_mode_auto_approves_reads() {
        for kind in &[ToolKind::Read, ToolKind::Search, ToolKind::Think, ToolKind::Fetch] {
            assert_eq!(
                decide_permission(PermissionMode::Spec, *kind, None),
                PermissionDecision::Allow,
                "spec-mode should allow {kind:?}"
            );
        }
    }

    // --------------------------------------------------------- 5.3: go-mode auto-approve

    /// RED→GREEN 5.3: Go-mode auto-approves read/search/think/fetch/edit/move.
    #[test]
    fn go_mode_auto_approves_reads_and_edits() {
        for kind in &[ToolKind::Read, ToolKind::Search, ToolKind::Think, ToolKind::Fetch, ToolKind::Edit, ToolKind::Move] {
            assert_eq!(
                decide_permission(PermissionMode::Go, *kind, None),
                PermissionDecision::Allow,
                "go-mode should allow {kind:?}"
            );
        }
    }

    // --------------------------------------------------------- 5.4: go-mode prompt

    /// RED→GREEN 5.4: Go-mode prompts for execute/delete.
    #[test]
    fn go_mode_prompts_for_execute_and_delete() {
        for kind in &[ToolKind::Execute, ToolKind::Delete] {
            assert_eq!(
                decide_permission(PermissionMode::Go, *kind, None),
                PermissionDecision::Prompt,
                "go-mode should prompt for {kind:?}"
            );
        }
    }

    // --------------------------------------------------------- 5.5: bypass

    /// RED→GREEN 5.5: Bypass auto-approves everything.
    #[test]
    fn bypass_auto_approves_everything() {
        let all_kinds = [
            ToolKind::Read, ToolKind::Search, ToolKind::Think, ToolKind::Fetch,
            ToolKind::Edit, ToolKind::Delete, ToolKind::Move, ToolKind::Execute,
            ToolKind::Other,
        ];
        for kind in &all_kinds {
            assert_eq!(
                decide_permission(PermissionMode::Bypass, *kind, None),
                PermissionDecision::Allow,
                "bypass should allow {kind:?}"
            );
        }
    }

    // --------------------------------------------------------- 5.6: openspec whitelist

    /// RED→GREEN 5.6: openspec execute is auto-approved in spec-mode.
    #[test]
    fn openspec_is_whitelisted_in_spec_mode() {
        assert_eq!(
            decide_permission(PermissionMode::Spec, ToolKind::Execute, Some("openspec list --json")),
            PermissionDecision::Allow,
        );
        assert_eq!(
            decide_permission(PermissionMode::Spec, ToolKind::Execute, Some("openspec show my-change --json")),
            PermissionDecision::Allow,
        );
        assert_eq!(
            decide_permission(PermissionMode::Spec, ToolKind::Execute, Some("openspec validate --changes")),
            PermissionDecision::Allow,
        );
    }

    // --------------------------------------------------------- 5.7: non-openspec execute denied

    /// RED→GREEN 5.7: Non-openspec execute is still denied in spec-mode.
    #[test]
    fn non_openspec_execute_is_denied_in_spec_mode() {
        assert_eq!(
            decide_permission(PermissionMode::Spec, ToolKind::Execute, Some("rm -rf /")),
            PermissionDecision::Deny,
        );
        assert_eq!(
            decide_permission(PermissionMode::Spec, ToolKind::Execute, Some("cargo build")),
            PermissionDecision::Deny,
        );
        assert_eq!(
            decide_permission(PermissionMode::Spec, ToolKind::Execute, None),
            PermissionDecision::Deny,
        );
    }

    // --------------------------------------------------------- 5.8: ambiguous/other

    /// RED→GREEN 5.8: Ambiguous/other tool kind prompts the user.
    #[test]
    fn other_tool_kind_prompts_user() {
        assert_eq!(
            decide_permission(PermissionMode::Spec, ToolKind::Other, None),
            PermissionDecision::Prompt,
        );
        assert_eq!(
            decide_permission(PermissionMode::Go, ToolKind::Other, None),
            PermissionDecision::Prompt,
        );
    }

    // --------------------------------------------------------- ToolKind parsing

    /// ToolKind::from_str parses known kinds correctly.
    #[test]
    fn tool_kind_from_str_parses_known_kinds() {
        assert_eq!(ToolKind::from_str("read"), ToolKind::Read);
        assert_eq!(ToolKind::from_str("search"), ToolKind::Search);
        assert_eq!(ToolKind::from_str("think"), ToolKind::Think);
        assert_eq!(ToolKind::from_str("fetch"), ToolKind::Fetch);
        assert_eq!(ToolKind::from_str("edit"), ToolKind::Edit);
        assert_eq!(ToolKind::from_str("delete"), ToolKind::Delete);
        assert_eq!(ToolKind::from_str("move"), ToolKind::Move);
        assert_eq!(ToolKind::from_str("execute"), ToolKind::Execute);
    }

    /// Unknown tool kinds map to Other.
    #[test]
    fn unknown_tool_kind_maps_to_other() {
        assert_eq!(ToolKind::from_str("unknown_thing"), ToolKind::Other);
        assert_eq!(ToolKind::from_str(""), ToolKind::Other);
    }
}
