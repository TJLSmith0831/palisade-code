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

/// Every file edit an update reports, as `FileEdit` events.
///
/// ACP carries file edits only as `diff` blocks hanging off a tool call, and
/// `from_session_update` collapses a tool call to call/result — so the diffs
/// are pulled out here instead, off both `tool_call` and `tool_call_update`
/// and at any status. Waiting for `completed` would lose the agents that
/// report the diff once, up front, and never repeat it.
///
/// Repeats are the caller's problem: an agent may resend the same diff on
/// every status change, and the notification loop drops ones already emitted.
pub fn file_edits(update: &v1::SessionUpdate) -> Vec<ExecutorEvent> {
    let (id, content) = match update {
        v1::SessionUpdate::ToolCall(call) => {
            (call.tool_call_id.to_string(), call.content.as_slice())
        }
        v1::SessionUpdate::ToolCallUpdate(update) => (
            update.tool_call_id.to_string(),
            update.fields.content.as_deref().unwrap_or(&[]),
        ),
        _ => return vec![],
    };
    content
        .iter()
        .filter_map(|c| match c {
            v1::ToolCallContent::Diff(diff) => Some(ExecutorEvent::FileEdit {
                id: id.clone(),
                path: diff.path.to_string_lossy().into_owned(),
                // A new file has no original text; an empty `before` renders
                // as an all-additions diff, which is what it is.
                before: diff.old_text.clone().unwrap_or_default(),
                after: diff.new_text.clone(),
            }),
            _ => None,
        })
        .collect()
}

/// A terminal a tool call embeds (`ToolCallContent::Terminal`), as
/// `(terminal_id, tool_call_id)` — how a hosted command's live output finds
/// the tool call it belongs to (PLAN.md phase 4). `None` when this update
/// carries no terminal content, same shape as `file_edits`.
pub fn embedded_terminal(update: &v1::SessionUpdate) -> Option<(String, String)> {
    let (id, content) = match update {
        v1::SessionUpdate::ToolCall(call) => {
            (call.tool_call_id.to_string(), call.content.as_slice())
        }
        v1::SessionUpdate::ToolCallUpdate(update) => (
            update.tool_call_id.to_string(),
            update.fields.content.as_deref().unwrap_or(&[]),
        ),
        _ => return None,
    };
    content.iter().find_map(|c| match c {
        v1::ToolCallContent::Terminal(terminal) => {
            Some((terminal.terminal_id.to_string(), id.clone()))
        }
        _ => None,
    })
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
                Some(v1::ToolCallStatus::InProgress) => {
                    let chunk =
                        tool_content_text(update.fields.content.as_deref().unwrap_or(&[]));
                    if chunk.is_empty() {
                        None
                    } else {
                        Some(AcpUpdate::ToolOutputDelta {
                            id: update.tool_call_id.to_string(),
                            chunk,
                        })
                    }
                }
                _ => None,
            }
        }
        v1::SessionUpdate::UsageUpdate(usage) => Some(AcpUpdate::UsageUpdate {
            used: usage.used,
            size: usage.size,
        }),
        v1::SessionUpdate::Plan(_) => Some(AcpUpdate::PlanUpdate),
        v1::SessionUpdate::AvailableCommandsUpdate(update) => Some(AcpUpdate::Commands {
            commands: update
                .available_commands
                .iter()
                .map(|c| AgentCommand {
                    name: c.name.clone(),
                    description: c.description.clone(),
                })
                .collect(),
        }),
        _ => None,
    }
}

/// One slash command the agent says it can run. Skills, user commands, and
/// built-ins all arrive through the same channel and are indistinguishable
/// here by design — Palisade lists what the agent offers rather than
/// deciding what a skill is.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCommand {
    pub name: String,
    pub description: String,
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
    /// A live fragment of a running tool call's output.
    ToolOutputDelta { id: String, chunk: String },
    /// The turn completed normally.
    Done,
    /// The turn crashed.
    Crashed { message: String },
    /// Context usage update (goes to status channel, not ExecutorEvent).
    UsageUpdate { used: u64, size: u64 },
    /// Plan update — ignored in v1.
    PlanUpdate,
    /// The agent's advertised slash commands (goes to the session-status
    /// channel, not ExecutorEvent — these are metadata, not conversation).
    Commands { commands: Vec<AgentCommand> },
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
            // Unreached by `from_session_update` today (ACP only streams
            // reasoning as `ReasoningDelta`; the complete `Reasoning` event
            // is assembled by run_bridge's turn-completion flush, which
            // knows the real elapsed time). Kept for API completeness if an
            // agent ever sends a complete thought in one shot.
            if text.trim().is_empty() {
                vec![]
            } else {
                vec![ExecutorEvent::Reasoning { text, elapsed_secs: 0 }]
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
        AcpUpdate::ToolOutputDelta { id, chunk } => {
            if chunk.is_empty() {
                vec![]
            } else {
                vec![ExecutorEvent::ToolOutputDelta { id, chunk }]
            }
        }
        AcpUpdate::Done => vec![ExecutorEvent::Done],
        // A stop reason, not a dead process: the connection is still up and
        // the next prompt can be retried against it (#18).
        AcpUpdate::Crashed { message } => vec![ExecutorEvent::turn_failed(message)],
        // usage_update, plan_update and available_commands_update produce no
        // ExecutorEvent — nothing here belongs in the persisted transcript.
        AcpUpdate::UsageUpdate { .. } | AcpUpdate::PlanUpdate | AcpUpdate::Commands { .. } => {
            vec![]
        }
    }
}

/// Extract usage data from an update, if present.
pub fn extract_usage(update: &AcpUpdate) -> Option<(u64, u64)> {
    match update {
        AcpUpdate::UsageUpdate { used, size } => Some((*used, *size)),
        _ => None,
    }
}

/// Extract advertised commands from an update, if present.
pub fn extract_commands(update: &AcpUpdate) -> Option<&[AgentCommand]> {
    match update {
        AcpUpdate::Commands { commands } => Some(commands),
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
        assert_eq!(
            events[0],
            ExecutorEvent::Reasoning { text: "Let me think...".into(), elapsed_secs: 0 }
        );
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
        assert_eq!(events[0], ExecutorEvent::turn_failed("timeout".into()));
        assert!(!crate::executor::crash_resets_mode(&events[0]), "a stop reason is retryable");
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
    fn a_completed_update_still_becomes_a_tool_result() {
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
    }

    /// RED→GREEN: an `InProgress` update carrying content is a live-only
    /// rendering signal — a `ToolOutputDelta`, never persisted (that's what
    /// the terminal `ToolResult` is for). Without this, a long-running
    /// command shows nothing until it exits (PLAN.md phase 3).
    #[test]
    fn in_progress_content_becomes_a_tool_output_delta() {
        let mut fields = v1::ToolCallUpdateFields::new();
        fields.status = Some(v1::ToolCallStatus::InProgress);
        fields.content = Some(vec![v1::ToolCallContent::Content(v1::Content::new(
            v1::ContentBlock::Text(v1::TextContent::new("Compiling...\n")),
        ))]);
        let update = v1::SessionUpdate::ToolCallUpdate(v1::ToolCallUpdate::new("tc-1", fields));
        assert_eq!(
            from_session_update(&update),
            Some(AcpUpdate::ToolOutputDelta {
                id: "tc-1".into(),
                chunk: "Compiling...\n".into(),
            })
        );
    }

    /// RED→GREEN: a status-only `InProgress` update (no content) stays
    /// ignored — an empty delta would be noise, not a rendering signal.
    #[test]
    fn an_in_progress_update_with_no_content_is_still_ignored() {
        let mut pending = v1::ToolCallUpdateFields::new();
        pending.status = Some(v1::ToolCallStatus::InProgress);
        let update = v1::SessionUpdate::ToolCallUpdate(v1::ToolCallUpdate::new("tc-1", pending));
        assert_eq!(from_session_update(&update), None);
    }

    /// A tool call's diff blocks become FileEdit events — the only path by
    /// which ACP reports a file edit, and what the chat's diff row reads.
    #[test]
    fn wire_tool_diffs_become_file_edits() {
        let diff = v1::ToolCallContent::Diff(v1::Diff::new("/repo/a.ts", "after\n"));
        let mut fields = v1::ToolCallUpdateFields::new();
        fields.status = Some(v1::ToolCallStatus::InProgress);
        fields.content = Some(vec![diff.clone()]);
        let update = v1::SessionUpdate::ToolCallUpdate(v1::ToolCallUpdate::new("tc-1", fields));
        // In-progress still yields the edit, even though it yields no result.
        assert_eq!(from_session_update(&update), None);
        assert_eq!(
            file_edits(&update),
            vec![ExecutorEvent::FileEdit {
                id: "tc-1".into(),
                path: "/repo/a.ts".into(),
                // A new file: no old text, so the diff is all additions.
                before: String::new(),
                after: "after\n".into(),
            }]
        );

        // A plain text tool call has no edits to report.
        let mut plain = v1::ToolCallUpdateFields::new();
        plain.status = Some(v1::ToolCallStatus::Completed);
        plain.content = Some(vec![v1::ToolCallContent::Content(v1::Content::new(
            v1::ContentBlock::Text(v1::TextContent::new("done!")),
        ))]);
        let update = v1::SessionUpdate::ToolCallUpdate(v1::ToolCallUpdate::new("tc-2", plain));
        assert!(file_edits(&update).is_empty());
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

    // ------------------------------------------------- available commands

    /// The agent's advertised commands are how skills reach the `/` menu.
    /// Verified against `@agentclientprotocol/claude-agent-acp` 0.69.0: a
    /// project's own `.claude/skills/*/SKILL.md` and `.claude/commands/*.md`
    /// both arrive here, so Palisade needs no filesystem knowledge of any
    /// agent's skill directory layout.
    #[test]
    fn wire_available_commands() {
        let update = v1::SessionUpdate::AvailableCommandsUpdate(
            v1::AvailableCommandsUpdate::new(vec![
                v1::AvailableCommand::new("review", "Review code changes"),
                v1::AvailableCommand::new("ponytail:ponytail-audit", "Audit for bloat"),
            ]),
        );
        assert_eq!(
            from_session_update(&update),
            Some(AcpUpdate::Commands {
                commands: vec![
                    AgentCommand {
                        name: "review".into(),
                        description: "Review code changes".into(),
                    },
                    AgentCommand {
                        name: "ponytail:ponytail-audit".into(),
                        description: "Audit for bloat".into(),
                    },
                ]
            })
        );
    }

    /// Commands are session metadata, not conversation: they must not enter
    /// the ExecutorEvent stream, which is what gets persisted to the thread's
    /// JSONL and re-rendered on reload.
    #[test]
    fn commands_produce_no_executor_event() {
        let events = map_acp_update(AcpUpdate::Commands { commands: vec![] });
        assert!(events.is_empty());
    }

    #[test]
    fn commands_are_extracted_for_the_side_channel() {
        let update = AcpUpdate::Commands {
            commands: vec![AgentCommand { name: "go".into(), description: "d".into() }],
        };
        assert_eq!(extract_commands(&update).map(<[_]>::len), Some(1));
        assert_eq!(extract_commands(&AcpUpdate::PlanUpdate), None);
    }
}
