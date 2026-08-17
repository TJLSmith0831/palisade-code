//! ACP event mapping (D13).
//!
//! Maps ACP `session/update` notifications into the existing `ExecutorEvent`
//! enum so the frontend rendering contract is unchanged. Only the backend
//! parser changes — one parser instead of two.

use agent_client_protocol::schema::v1;

use crate::executor::ExecutorEvent;

/// Text inside a content chunk, when it is text.
fn chunk_text(chunk: &v1::ContentChunk) -> Option<&str> {
    match &chunk.content {
        v1::ContentBlock::Text(text) => Some(&text.text),
        _ => None,
    }
}

/// Text flattened out of tool-call content blocks.
fn tool_content_text(content: &[v1::ToolCallContent]) -> String {
    content
        .iter()
        .filter_map(|c| match c {
            v1::ToolCallContent::Content(v1::Content { content, .. }) => match content {
                v1::ContentBlock::Text(text) => Some(text.text.clone()),
                _ => None,
            },
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// A shell command embedded in raw tool input, if there is one.
fn raw_command(raw_input: Option<&serde_json::Value>) -> String {
    raw_input
        .and_then(|v| v.get("command").or_else(|| v.get("cmd")))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

/// Translate a wire-level ACP `session/update` notification into Palisade's
/// `AcpUpdate` vocabulary. Returns `None` for updates Palisade ignores
/// (user echoes, mode/command/info changes).
pub fn from_session_update(update: &v1::SessionUpdate) -> Option<AcpUpdate> {
    match update {
        v1::SessionUpdate::AgentMessageChunk(chunk) => {
            chunk_text(chunk).map(|text| AcpUpdate::TextDelta { text: text.to_string() })
        }
        v1::SessionUpdate::AgentThoughtChunk(chunk) => {
            chunk_text(chunk).map(|text| AcpUpdate::ReasoningDelta { text: text.to_string() })
        }
        v1::SessionUpdate::ToolCall(call) => Some(AcpUpdate::ToolCall {
            id: call.tool_call_id.to_string(),
            name: call.title.clone(),
            command: raw_command(call.raw_input.as_ref()),
        }),
        v1::SessionUpdate::ToolCallUpdate(update) => {
            match update.fields.status {
                Some(v1::ToolCallStatus::Completed) => Some(AcpUpdate::ToolResult {
                    id: update.tool_call_id.to_string(),
                    output: tool_content_text(update.fields.content.as_deref().unwrap_or(&[])),
                    is_error: false,
                }),
                Some(v1::ToolCallStatus::Failed) => Some(AcpUpdate::ToolResult {
                    id: update.tool_call_id.to_string(),
                    output: tool_content_text(update.fields.content.as_deref().unwrap_or(&[])),
                    is_error: true,
                }),
                _ => None,
            }
        }
        v1::SessionUpdate::UsageUpdate(usage) => Some(AcpUpdate::UsageUpdate {
            used: usage.used,
            size: usage.size,
        }),
        v1::SessionUpdate::Plan(_) => Some(AcpUpdate::PlanUpdate),
        _ => None,
    }
}

/// ACP session update kinds that we map to ExecutorEvent variants.
#[derive(Debug, Clone, PartialEq)]
pub enum AcpUpdate {
    /// A text message from the agent.
    Text { text: String },
    /// Reasoning/thinking content from the agent.
    Reasoning { text: String },
    /// A partial text delta (streaming).
    TextDelta { text: String },
    /// A partial reasoning delta (streaming).
    ReasoningDelta { text: String },
    /// A tool call started.
    ToolCall { id: String, name: String, command: String },
    /// A tool result received.
    ToolResult { id: String, output: String, is_error: bool },
    /// The turn completed normally.
    Done,
    /// The turn crashed.
    Crashed { message: String },
    /// Context usage update (goes to status channel, not ExecutorEvent).
    UsageUpdate { used: u64, size: u64 },
    /// Plan update — ignored in v1.
    PlanUpdate,
}

/// Map an ACP update into zero or more `ExecutorEvent` variants.
///
/// D13: Keep the 9 `ExecutorEvent` variants. Map ACP notifications into them.
/// `usage_update` goes to a separate session-status channel, not as an ExecutorEvent.
/// `plan_update` is ignored in v1.
pub fn map_acp_update(update: AcpUpdate) -> Vec<ExecutorEvent> {
    match update {
        AcpUpdate::Text { text } => {
            if text.trim().is_empty() {
                vec![]
            } else {
                vec![ExecutorEvent::Text { text }]
            }
        }
        AcpUpdate::Reasoning { text } => {
            if text.trim().is_empty() {
                vec![]
            } else {
                vec![ExecutorEvent::Reasoning { text }]
            }
        }
        AcpUpdate::TextDelta { text } => {
            if text.is_empty() {
                vec![]
            } else {
                vec![ExecutorEvent::TextDelta { text }]
            }
        }
        AcpUpdate::ReasoningDelta { text } => {
            if text.is_empty() {
                vec![]
            } else {
                vec![ExecutorEvent::ReasoningDelta { text }]
            }
        }
        AcpUpdate::ToolCall { id, name, command } => {
            vec![ExecutorEvent::ToolCall { id, name, command }]
        }
        AcpUpdate::ToolResult { id, output, is_error } => {
            vec![ExecutorEvent::ToolResult { id, output, is_error }]
        }
        AcpUpdate::Done => vec![ExecutorEvent::Done],
        AcpUpdate::Crashed { message } => {
            vec![ExecutorEvent::Crashed { exit_code: None, message }]
        }
        // usage_update and plan_update produce no ExecutorEvent.
        AcpUpdate::UsageUpdate { .. } | AcpUpdate::PlanUpdate => vec![],
    }
}

/// Extract usage data from an update, if present.
pub fn extract_usage(update: &AcpUpdate) -> Option<(u64, u64)> {
    match update {
        AcpUpdate::UsageUpdate { used, size } => Some((*used, *size)),
        _ => None,
    }
}

// ------------------------------------------------------------------ tests

#[cfg(test)]
mod tests {
    use super::*;

    // --------------------------------------------------------- 4.1: message_update → Text/Reasoning

    /// RED→GREEN 4.1: Text update maps to ExecutorEvent::Text.
    #[test]
    fn text_update_maps_to_text_event() {
        let events = map_acp_update(AcpUpdate::Text { text: "Hello, world!".into() });
        assert_eq!(events.len(), 1);
        assert_eq!(events[0], ExecutorEvent::Text { text: "Hello, world!".into() });
    }

    /// RED→GREEN 4.1: Reasoning update maps to ExecutorEvent::Reasoning.
    #[test]
    fn reasoning_update_maps_to_reasoning_event() {
        let events = map_acp_update(AcpUpdate::Reasoning { text: "Let me think...".into() });
        assert_eq!(events.len(), 1);
        assert_eq!(events[0], ExecutorEvent::Reasoning { text: "Let me think...".into() });
    }

    /// RED→GREEN 4.1: Empty text produces no event.
    #[test]
    fn empty_text_produces_no_event() {
        let events = map_acp_update(AcpUpdate::Text { text: "   ".into() });
        assert!(events.is_empty());
    }

    // --------------------------------------------------------- 4.2: partial → TextDelta/ReasoningDelta

    /// RED→GREEN 4.2: TextDelta update maps correctly.
    #[test]
    fn text_delta_maps_correctly() {
        let events = map_acp_update(AcpUpdate::TextDelta { text: "Hel".into() });
        assert_eq!(events.len(), 1);
        assert_eq!(events[0], ExecutorEvent::TextDelta { text: "Hel".into() });
    }

    /// RED→GREEN 4.2: ReasoningDelta update maps correctly.
    #[test]
    fn reasoning_delta_maps_correctly() {
        let events = map_acp_update(AcpUpdate::ReasoningDelta { text: "hmm".into() });
        assert_eq!(events.len(), 1);
        assert_eq!(events[0], ExecutorEvent::ReasoningDelta { text: "hmm".into() });
    }

    /// RED→GREEN 4.2: Empty delta produces no event.
    #[test]
    fn empty_delta_produces_no_event() {
        let events = map_acp_update(AcpUpdate::TextDelta { text: "".into() });
        assert!(events.is_empty());
    }

    // --------------------------------------------------------- 4.3: tool_call_update → ToolCall/ToolResult

    /// RED→GREEN 4.3: ToolCall update maps correctly.
    #[test]
    fn tool_call_maps_correctly() {
        let events = map_acp_update(AcpUpdate::ToolCall {
            id: "tc1".into(),
            name: "bash".into(),
            command: "ls -la".into(),
        });
        assert_eq!(events.len(), 1);
        assert_eq!(events[0], ExecutorEvent::ToolCall {
            id: "tc1".into(),
            name: "bash".into(),
            command: "ls -la".into(),
        });
    }

    /// RED→GREEN 4.3: ToolResult update maps correctly.
    #[test]
    fn tool_result_maps_correctly() {
        let events = map_acp_update(AcpUpdate::ToolResult {
            id: "tc1".into(),
            output: "file1.txt\nfile2.txt".into(),
            is_error: false,
        });
        assert_eq!(events.len(), 1);
        assert_eq!(events[0], ExecutorEvent::ToolResult {
            id: "tc1".into(),
            output: "file1.txt\nfile2.txt".into(),
            is_error: false,
        });
    }

    /// RED→GREEN 4.3: ToolResult with error flag.
    #[test]
    fn tool_result_error_flag_is_preserved() {
        let events = map_acp_update(AcpUpdate::ToolResult {
            id: "tc1".into(),
            output: "command not found".into(),
            is_error: true,
        });
        assert_eq!(events.len(), 1);
        match &events[0] {
            ExecutorEvent::ToolResult { is_error, .. } => assert!(is_error),
            _ => panic!("expected ToolResult"),
        }
    }

    // --------------------------------------------------------- 4.4: stop reason → Done/Crashed

    /// RED→GREEN 4.4: Done maps to Done.
    #[test]
    fn done_maps_to_done() {
        let events = map_acp_update(AcpUpdate::Done);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0], ExecutorEvent::Done);
    }

    /// RED→GREEN 4.4: Crashed maps to Crashed with message.
    #[test]
    fn crashed_maps_to_crashed() {
        let events = map_acp_update(AcpUpdate::Crashed { message: "timeout".into() });
        assert_eq!(events.len(), 1);
        assert_eq!(events[0], ExecutorEvent::Crashed {
            exit_code: None,
            message: "timeout".into(),
        });
    }

    // --------------------------------------------------------- 4.5: usage_update → separate channel

    /// RED→GREEN 4.5: UsageUpdate produces no ExecutorEvent.
    #[test]
    fn usage_update_produces_no_executor_event() {
        let events = map_acp_update(AcpUpdate::UsageUpdate { used: 1000, size: 100000 });
        assert!(events.is_empty());
    }

    /// RED→GREEN 4.5: Usage data can be extracted separately.
    #[test]
    fn usage_data_is_extractable() {
        let update = AcpUpdate::UsageUpdate { used: 5000, size: 200000 };
        let (used, size) = extract_usage(&update).unwrap();
        assert_eq!(used, 5000);
        assert_eq!(size, 200000);
    }

    /// RED→GREEN 4.5: Non-usage updates return None from extract_usage.
    #[test]
    fn non_usage_update_returns_none() {
        assert!(extract_usage(&AcpUpdate::Done).is_none());
        assert!(extract_usage(&AcpUpdate::Text { text: "hi".into() }).is_none());
    }

    // --------------------------------------------------------- 4.6: plan_update → ignored

    /// RED→GREEN 4.6: PlanUpdate produces no events.
    #[test]
    fn plan_update_produces_no_events() {
        let events = map_acp_update(AcpUpdate::PlanUpdate);
        assert!(events.is_empty());
    }

    // --------------------------------------------------------- wire → AcpUpdate

    fn text_chunk(text: &str) -> v1::ContentChunk {
        v1::ContentChunk::new(v1::ContentBlock::Text(v1::TextContent::new(text)))
    }

    /// RED→GREEN: agent message chunks become text deltas.
    #[test]
    fn wire_agent_chunk_maps_to_text_delta() {
        let update = v1::SessionUpdate::AgentMessageChunk(text_chunk("partial"));
        assert_eq!(
            from_session_update(&update),
            Some(AcpUpdate::TextDelta { text: "partial".into() })
        );
    }

    /// RED→GREEN: thought chunks become reasoning deltas.
    #[test]
    fn wire_thought_chunk_maps_to_reasoning_delta() {
        let update = v1::SessionUpdate::AgentThoughtChunk(text_chunk("hmm"));
        assert_eq!(
            from_session_update(&update),
            Some(AcpUpdate::ReasoningDelta { text: "hmm".into() })
        );
    }

    /// RED→GREEN: a tool call carries id, title, and any raw command.
    #[test]
    fn wire_tool_call_maps_command() {
        let update = v1::SessionUpdate::ToolCall(
            v1::ToolCall::new("tc-1", "Run command")
                .raw_input(serde_json::json!({"command": "ls -la"})),
        );
        assert_eq!(
            from_session_update(&update),
            Some(AcpUpdate::ToolCall {
                id: "tc-1".into(),
                name: "Run command".into(),
                command: "ls -la".into(),
            })
        );
    }

    /// RED→GREEN: completed tool-call updates become results; in-progress
    /// ones are ignored.
    #[test]
    fn wire_tool_update_maps_terminal_states_only() {
        let mut fields = v1::ToolCallUpdateFields::new();
        fields.status = Some(v1::ToolCallStatus::Completed);
        fields.content = Some(vec![v1::ToolCallContent::Content(v1::Content::new(
            v1::ContentBlock::Text(v1::TextContent::new("done!")),
        ))]);
        let update = v1::SessionUpdate::ToolCallUpdate(v1::ToolCallUpdate::new("tc-1", fields));
        assert_eq!(
            from_session_update(&update),
            Some(AcpUpdate::ToolResult {
                id: "tc-1".into(),
                output: "done!".into(),
                is_error: false,
            })
        );

        let mut pending = v1::ToolCallUpdateFields::new();
        pending.status = Some(v1::ToolCallStatus::InProgress);
        let update = v1::SessionUpdate::ToolCallUpdate(v1::ToolCallUpdate::new("tc-1", pending));
        assert_eq!(from_session_update(&update), None);
    }

    /// RED→GREEN: usage updates carry through; user echoes are dropped.
    #[test]
    fn wire_usage_and_user_echo() {
        let usage = v1::SessionUpdate::UsageUpdate(v1::UsageUpdate::new(100, 200_000));
        assert_eq!(
            from_session_update(&usage),
            Some(AcpUpdate::UsageUpdate { used: 100, size: 200_000 })
        );
        let echo = v1::SessionUpdate::UserMessageChunk(text_chunk("hi"));
        assert_eq!(from_session_update(&echo), None);
    }
}
