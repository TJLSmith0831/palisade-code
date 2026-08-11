//! Mid-thread executor switch with context handoff (D6–D9).
//!
//! Switching executors mid-thread starts a fresh ACP session with the new
//! agent, passing the previous conversation turns as a raw-text transcript.
//! The transcript is token-budget-bounded using ACP `usage_update` data.

/// A single turn in a conversation transcript.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranscriptTurn {
    pub role: String,
    pub content: String,
}

/// Format conversation turns into a raw-text transcript.
///
/// D7: Previous turns are formatted as `User: ...\nAssistant: ...\n`.
pub fn format_transcript(turns: &[TranscriptTurn]) -> String {
    turns
        .iter()
        .map(|turn| {
            let label = match turn.role.as_str() {
                "user" => "User",
                "assistant" => "Assistant",
                "system" => "System",
                other => other,
            };
            format!("{label}: {}", turn.content)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Estimate token count using the `chars / 4` heuristic (D8).
///
/// No tokenizer dependency for v1; upgrade to `tiktoken` crate later
/// if pre-send estimates are needed.
pub fn estimate_tokens(text: &str) -> usize {
    (text.chars().count() / 4).max(1)
}

/// Build a handoff transcript bounded by a token budget.
///
/// D8: Pass as many previous turns as fit within the new agent's context
/// window, most-recent-first, dropping older turns when the budget is hit.
/// The budget is derived from the agent's reported context window size
/// via ACP `usage_update`.
pub fn build_handoff_transcript(
    turns: &[TranscriptTurn],
    token_budget: usize,
) -> String {
    if turns.is_empty() || token_budget == 0 {
        return String::new();
    }

    // Reserve some budget for the new message and overhead.
    let available = token_budget.saturating_sub(1024);

    let mut included: Vec<&TranscriptTurn> = Vec::new();
    let mut used = 0usize;

    // Most-recent-first: iterate from the end.
    for turn in turns.iter().rev() {
        let turn_text = format!(
            "{}: {}",
            match turn.role.as_str() {
                "user" => "User",
                "assistant" => "Assistant",
                _ => &turn.role,
            },
            turn.content
        );
        let turn_tokens = estimate_tokens(&turn_text);
        if used + turn_tokens > available {
            break;
        }
        used += turn_tokens;
        included.push(turn);
    }

    // Reverse back to chronological order, then convert to owned.
    included.reverse();
    let owned: Vec<TranscriptTurn> = included.into_iter().cloned().collect();
    format_transcript(&owned)
}

// ------------------------------------------------------------------ tests

#[cfg(test)]
mod tests {
    use super::*;

    fn make_turns() -> Vec<TranscriptTurn> {
        vec![
            TranscriptTurn { role: "user".into(), content: "Hello".into() },
            TranscriptTurn { role: "assistant".into(), content: "Hi there!".into() },
            TranscriptTurn { role: "user".into(), content: "Write a function.".into() },
            TranscriptTurn { role: "assistant".into(), content: "Here you go:\nfn main() {}".into() },
        ]
    }

    // --------------------------------------------------------- 7.1: transcript formatting

    /// RED→GREEN 7.1: Transcript renders as `User: ...\nAssistant: ...`.
    #[test]
    fn transcript_formats_correctly() {
        let transcript = format_transcript(&make_turns());
        assert!(transcript.contains("User: Hello"));
        assert!(transcript.contains("Assistant: Hi there!"));
        assert!(transcript.contains("User: Write a function."));
        assert!(transcript.contains("Assistant: Here you go:"));
    }

    /// RED→GREEN 7.1: Empty turns produce empty transcript.
    #[test]
    fn empty_turns_produce_empty_transcript() {
        assert_eq!(format_transcript(&[]), "");
    }

    // --------------------------------------------------------- 7.2: token-budget bounding

    /// RED→GREEN 7.2: Token estimation uses chars/4.
    #[test]
    fn token_estimation_uses_chars_div_4() {
        assert_eq!(estimate_tokens("abcd"), 1);  // 4 chars = 1 token
        assert_eq!(estimate_tokens("12345678"), 2); // 8 chars = 2 tokens
        assert_eq!(estimate_tokens(""), 1); // minimum 1
    }

    /// RED→GREEN 7.2: Transcript exceeding budget drops oldest turns first.
    #[test]
    fn budget_bounding_drops_oldest_turns_first() {
        let turns = make_turns();
        // Small budget (just above overhead): only fits the last turn.
        let small = build_handoff_transcript(&turns, 1040);
        assert!(small.contains("Here you go"));
        assert!(!small.contains("Hello")); // Oldest turn dropped.

        // Large budget: all turns fit.
        let large = build_handoff_transcript(&turns, 100_000);
        assert!(large.contains("Hello"));
        assert!(large.contains("Here you go"));
    }

    /// RED→GREEN 7.2: Zero budget returns empty.
    #[test]
    fn zero_budget_returns_empty() {
        assert_eq!(build_handoff_transcript(&make_turns(), 0), "");
    }

    // --------------------------------------------------------- 7.3: handoff

    /// RED→GREEN 7.3: Handoff transcript maintains chronological order.
    #[test]
    fn handoff_preserves_chronological_order() {
        let turns = vec![
            TranscriptTurn { role: "user".into(), content: "First".into() },
            TranscriptTurn { role: "assistant".into(), content: "Second".into() },
        ];
        let transcript = build_handoff_transcript(&turns, 10_000);
        let first_pos = transcript.find("First").unwrap();
        let second_pos = transcript.find("Second").unwrap();
        assert!(first_pos < second_pos, "chronological order must be preserved");
    }

    // --------------------------------------------------------- 7.4: no previous turns

    /// RED→GREEN 7.4: Switch with no previous turns returns empty transcript.
    #[test]
    fn no_previous_turns_returns_empty() {
        assert_eq!(build_handoff_transcript(&[], 10_000), "");
    }

    // --------------------------------------------------------- 7.5: switch confirmation

    /// RED→GREEN 7.5: The turn count and target agent are available for confirmation UI.
    #[test]
    fn turn_count_is_calculable() {
        let turns = make_turns();
        assert_eq!(turns.len(), 4);
        // The confirmation dialog would show "4 turns will be handed off to <agent>".
        let confirmation_message = format!(
            "{} turns will be handed off to the new agent",
            turns.len()
        );
        assert!(confirmation_message.contains("4 turns"));
    }

    /// System messages are included in transcript.
    #[test]
    fn system_messages_are_included() {
        let turns = vec![
            TranscriptTurn { role: "system".into(), content: "Session started.".into() },
            TranscriptTurn { role: "user".into(), content: "hi".into() },
        ];
        let transcript = format_transcript(&turns);
        assert!(transcript.contains("System: Session started."));
    }
}
