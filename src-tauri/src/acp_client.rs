//! ACP client wrapper and session lifecycle (D17).
//!
//! Drives a real ACP agent over stdio using the `agent-client-protocol` crate:
//! the async connection runs on a dedicated bridge thread; Palisade's sync side
//! talks to it through channels, and agent notifications arrive at the sync
//! `Sink` as `ExecutorEvent`s. `session/new`'s config options carry the
//! agent's model selector (category `model`), which is how Palisade learns which
//! models the agent actually offers.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use agent_client_protocol::schema::v1;
use agent_client_protocol::{self as acp, ConnectTo};
use agent_client_protocol::schema::ProtocolVersion;
use serde::Serialize;

use crate::executor::{Envelope, ExecutorEvent, Sink};
use crate::permissions::{self, PermissionDecision, PermissionMode};

/// How long session startup (spawn + initialize + session/new) may take
/// before Palisade gives up. Cold npx installs can't happen — availability
/// filtering only lists cached packages — but first-run auth or slow
/// binaries still need headroom.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(90);

// ------------------------------------------------------------- models

/// One selectable model an agent reported via its `model` config option.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
}

/// The agent's model selector as reported by `session/new` (or a later
/// `set_config_option` response).
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelState {
    /// The config option id used to change the model, if the agent has one.
    pub config_id: Option<String>,
    /// The currently selected model value id.
    pub current: Option<String>,
    pub models: Vec<ModelInfo>,
}

/// Pull the model selector out of a session's config options.
pub fn extract_models(options: &[v1::SessionConfigOption]) -> ModelState {
    for option in options {
        if option.category != Some(v1::SessionConfigOptionCategory::Model) {
            continue;
        }
        let v1::SessionConfigKind::Select(select) = &option.kind else {
            continue;
        };
        let entries: Vec<&v1::SessionConfigSelectOption> = match &select.options {
            v1::SessionConfigSelectOptions::Ungrouped(opts) => opts.iter().collect(),
            v1::SessionConfigSelectOptions::Grouped(groups) => {
                groups.iter().flat_map(|g| g.options.iter()).collect()
            }
            _ => continue,
        };
        return ModelState {
            config_id: Some(option.id.to_string()),
            current: Some(select.current_value.to_string()),
            models: entries
                .into_iter()
                .map(|o| ModelInfo {
                    id: o.value.to_string(),
                    name: o.name.clone(),
                })
                .collect(),
        };
    }
    ModelState::default()
}

// ------------------------------------------------------------- credentials

/// Look up stored credentials for an agent's auth method.
///
/// Returns `_meta` fields to attach to the `authenticate` request, or
/// `None` when no stored credentials are found (the agent may still
/// succeed via browser OAuth or an existing session token).
fn lookup_agent_credentials(
    agent_id: &str,
    method_id: &str,
) -> Option<serde_json::Map<String, serde_json::Value>> {
    // Devin / Windsurf API key flow: read the key from Devin's own
    // credentials file so the user doesn't have to re-enter it.
    if agent_id == "devin" && method_id == "windsurf-api-key" {
        if let Some(key) = read_devin_api_key() {
            let mut meta = serde_json::Map::new();
            meta.insert("api_key".into(), serde_json::Value::String(key));
            return Some(meta);
        }
    }
    // OpenCode login: the agent reads its own auth.json; no extra
    // credentials needed — the empty authenticate call suffices.
    None
}

/// Read the Windsurf API key from Devin's credentials file.
fn read_devin_api_key() -> Option<String> {
    let home = crate::executor::home();
    let path = home.join(".local/share/devin/credentials.toml");
    let raw = std::fs::read_to_string(&path).ok()?;
    for line in raw.lines() {
        let stripped = line.trim();
        if let Some(val) = stripped.strip_prefix("windsurf_api_key = ") {
            let val = val.trim().trim_matches('"');
            if !val.is_empty() {
                return Some(val.to_string());
            }
        }
    }
    None
}

// ------------------------------------------------------------- session types

/// A Palisade session backed by a live ACP connection.
///
/// Keeps the public identity fields from the old `Session` struct but
/// replaces process internals (`Child`, `ChildStdin`, `pump`) with a bridge
/// thread running the ACP connection (D17).
pub struct AcpSession {
    /// Palisade's own ULID identity for this session.
    pub id: String,
    /// The ACP registry agent id (e.g. "devin", "claude-acp").
    pub agent_id: String,
    /// The agent's display name from the registry.
    pub agent_name: String,
    /// The resolved binary path used to invoke the agent.
    pub bin: PathBuf,
    /// The command and args to invoke the agent in ACP mode.
    pub cmd: String,
    pub args: Vec<String>,
    pub project_hash: String,
    pub thread_id: String,
    pub project_root: PathBuf,
    pub mode: String,
    pub palisade_home: PathBuf,
    /// The ACP session id, assigned by the agent during session/new.
    pub acp_session_id: Option<String>,
    /// What the agent reported about its model selector at session start.
    pub models: ModelState,
    pub busy: Arc<AtomicBool>,
    stopping: Arc<AtomicBool>,
    /// Commands for the bridge thread; dropping it ends the connection.
    cmd_tx: Option<tokio::sync::mpsc::UnboundedSender<BridgeCommand>>,
}

impl AcpSession {
    pub fn is_busy(&self) -> bool {
        self.busy.load(Ordering::SeqCst)
    }

    /// Terminate this session: tell the bridge to shut down, which closes the
    /// connection and kills the agent process tree.
    pub fn terminate(&mut self) {
        self.stopping.store(true, Ordering::SeqCst);
        if let Some(tx) = &self.cmd_tx {
            let _ = tx.send(BridgeCommand::Shutdown);
        }
        self.cmd_tx = None;
        self.busy.store(false, Ordering::SeqCst);
    }
}

impl Drop for AcpSession {
    fn drop(&mut self) {
        self.terminate();
    }
}

// ------------------------------------------------------------- spawn context

/// Everything needed to start an ACP session.
pub struct AcpSpawn {
    pub agent_id: String,
    pub agent_name: String,
    pub bin: PathBuf,
    pub cmd: String,
    pub args: Vec<String>,
    pub project_root: PathBuf,
    pub project_hash: String,
    pub thread_id: String,
    pub mode: String,
    pub bypass: bool,
    /// Model value id to select right after session/new, if the thread has
    /// chosen one and the agent offers it.
    pub model: Option<String>,
    pub palisade_home: PathBuf,
}

// ------------------------------------------------------------- bridge

/// Commands the sync side sends to the bridge thread.
pub(crate) enum BridgeCommand {
    Prompt(String),
    Shutdown,
}

/// What the bridge reports once the session is live (or why it failed).
struct ReadyReport {
    acp_session_id: String,
    models: ModelState,
}

fn emit(sink: &Arc<dyn Sink>, session_id: &str, thread_id: &str, event: ExecutorEvent) {
    sink.emit(&Envelope {
        session_id: session_id.to_string(),
        thread_id: thread_id.to_string(),
        event,
    });
}

fn permission_mode(mode: &str, bypass: bool) -> PermissionMode {
    if bypass {
        PermissionMode::Bypass
    } else if mode == "go" {
        PermissionMode::Go
    } else {
        PermissionMode::Spec
    }
}

/// Map an ACP tool kind onto Palisade's permission taxonomy.
fn tool_kind(kind: Option<&v1::ToolKind>) -> permissions::ToolKind {
    use v1::ToolKind as K;
    match kind {
        Some(K::Read) => permissions::ToolKind::Read,
        Some(K::Edit) => permissions::ToolKind::Edit,
        Some(K::Delete) => permissions::ToolKind::Delete,
        Some(K::Move) => permissions::ToolKind::Move,
        Some(K::Search) => permissions::ToolKind::Search,
        Some(K::Execute) => permissions::ToolKind::Execute,
        Some(K::Fetch) => permissions::ToolKind::Fetch,
        Some(K::Think) => permissions::ToolKind::Think,
        _ => permissions::ToolKind::Other,
    }
}

/// A shell command embedded in a tool call's raw input, if there is one.
fn raw_command(raw_input: Option<&serde_json::Value>) -> Option<String> {
    let input = raw_input?;
    input
        .get("command")
        .or_else(|| input.get("cmd"))
        .and_then(|v| v.as_str())
        .map(str::to_string)
}

/// Extract file paths from a tool call's `locations` array. ACP agents
/// advertise the file paths they touch via `ToolCallLocation.path`.
/// Handles both `Vec<ToolCallLocation>` (notification) and
/// `Option<Vec<ToolCallLocation>>` (permission request update fields).
fn location_paths(locations: &[v1::ToolCallLocation]) -> Vec<String> {
    locations
        .iter()
        .map(|loc| loc.path.to_string_lossy().to_string())
        .collect()
}

/// Extract file paths from an optional `locations` array (permission
/// request path — `ToolCallUpdateFields.locations` is `Option<Vec<...>>`).
fn location_paths_opt(locations: &Option<Vec<v1::ToolCallLocation>>) -> Vec<String> {
    locations.as_deref().map(location_paths).unwrap_or_default()
}

/// Paths from the tool call's diff content. An edit that ships a
/// `ToolCallContent::Diff` names the file it rewrites even when the agent
/// left `locations` empty — OpenCode does exactly that.
fn content_paths(content: &[v1::ToolCallContent]) -> Vec<String> {
    content
        .iter()
        .filter_map(|c| match c {
            v1::ToolCallContent::Diff(diff) => {
                Some(diff.path.to_string_lossy().to_string())
            }
            _ => None,
        })
        .collect()
}

/// Fall back to the path arguments inside a tool call's raw input. Not every
/// agent fills `locations` — OpenCode's write/edit calls arrive with it empty
/// — and Spec mode's `openspec/` exemption needs a path to test, so without
/// this a legitimate spec write reads as "path unknown" and gets denied.
fn raw_paths(raw_input: Option<&serde_json::Value>) -> Vec<String> {
    let Some(input) = raw_input else {
        return Vec::new();
    };
    ["filePath", "file_path", "path", "filepath", "oldPath", "newPath"]
        .iter()
        .filter_map(|key| input.get(key))
        .filter_map(|v| v.as_str())
        .map(str::to_string)
        .collect()
}

/// The paths a tool call touches, in descending order of reliability:
/// `locations` when the agent fills it, then the diff content it streams,
/// then the raw input's path arguments.
fn tool_call_paths(
    locations: Vec<String>,
    content: &[v1::ToolCallContent],
    raw_input: Option<&serde_json::Value>,
) -> Vec<String> {
    if !locations.is_empty() {
        return locations;
    }
    let from_content = content_paths(content);
    if !from_content.is_empty() {
        return from_content;
    }
    raw_paths(raw_input)
}

/// Answer an agent permission request according to the session's mode
/// policy (D12, D15). `Prompt` has no UI surface yet, so it cancels — the
/// safe default until the permission prompt UI lands.
fn answer_permission(
    request: &v1::RequestPermissionRequest,
    mode: PermissionMode,
) -> v1::RequestPermissionResponse {
    let kind = tool_kind(request.tool_call.fields.kind.as_ref());
    let command = raw_command(request.tool_call.fields.raw_input.as_ref());
    let paths = tool_call_paths(
        location_paths_opt(&request.tool_call.fields.locations),
        request.tool_call.fields.content.as_deref().unwrap_or(&[]),
        request.tool_call.fields.raw_input.as_ref(),
    );
    let path_refs: Vec<&str> = paths.iter().map(|s| s.as_str()).collect();
    match permissions::decide_permission(mode, kind, command.as_deref(), &path_refs) {
        PermissionDecision::Allow => {
            let option = request
                .options
                .iter()
                .find(|o| o.kind == v1::PermissionOptionKind::AllowOnce)
                .or_else(|| request.options.first());
            match option {
                Some(o) => v1::RequestPermissionResponse::new(
                    v1::RequestPermissionOutcome::Selected(
                        v1::SelectedPermissionOutcome::new(o.option_id.clone()),
                    ),
                ),
                None => v1::RequestPermissionResponse::new(v1::RequestPermissionOutcome::Cancelled),
            }
        }
        PermissionDecision::Deny | PermissionDecision::Prompt => {
            v1::RequestPermissionResponse::new(v1::RequestPermissionOutcome::Cancelled)
        }
    }
}

/// The write-guard's view of one `session/update`: what kind of tool call it
/// is, the shell command if any, and the paths it touches.
///
/// Both `ToolCall` (the announcement) and `ToolCallUpdate` (the follow-up
/// carrying the diff) are inspected, because agents differ in which one names
/// the file. `kinds` remembers each call's kind from the announcement so an
/// update that omits it is still judged as the write it is.
fn write_guard_input(
    update: &v1::SessionUpdate,
    kinds: &std::sync::Mutex<HashMap<String, permissions::ToolKind>>,
) -> Option<(permissions::ToolKind, Option<String>, Vec<String>)> {
    match update {
        v1::SessionUpdate::ToolCall(call) => {
            let kind = tool_kind(Some(&call.kind));
            kinds
                .lock()
                .unwrap()
                .insert(call.tool_call_id.to_string(), kind);
            Some((
                kind,
                raw_command(call.raw_input.as_ref()),
                tool_call_paths(
                    location_paths(&call.locations),
                    &call.content,
                    call.raw_input.as_ref(),
                ),
            ))
        }
        v1::SessionUpdate::ToolCallUpdate(update) => {
            let kind = match update.fields.kind.as_ref() {
                Some(k) => tool_kind(Some(k)),
                None => *kinds
                    .lock()
                    .unwrap()
                    .get(&update.tool_call_id.to_string())?,
            };
            Some((
                kind,
                raw_command(update.fields.raw_input.as_ref()),
                tool_call_paths(
                    location_paths_opt(&update.fields.locations),
                    update.fields.content.as_deref().unwrap_or(&[]),
                    update.fields.raw_input.as_ref(),
                ),
            ))
        }
        _ => None,
    }
}

/// Check whether a tool call notification violates the session's permission
/// mode. Some agents (OpenCode) auto-approve workspace writes internally and
/// never send `session/request_permission` for in-project edits — so Palisade must
/// also enforce Spec mode at the `session/update` layer, by cancelling the
/// turn when a write-kind tool call appears in Spec mode.
///
/// Returns `Some(reason)` when the tool call should be cancelled, describing
/// the violation for the `Crashed` event. Returns `None` when the tool call
/// is permitted under the current mode.
///
/// Mirrors `permissions::decide_permission` but operates on the *notification*
/// stream rather than the *request* stream: the agent already started the
/// tool call, so the only action is to cancel the whole turn.
fn spec_mode_violation(
    kind: permissions::ToolKind,
    mode: PermissionMode,
    command: Option<&str>,
    file_paths: &[&str],
) -> Option<String> {
    // An edit whose path is still unknown is undecidable, not a violation.
    // OpenCode announces a write with empty `locations`, no `rawInput` and no
    // content, and only names the file on the follow-up update carrying the
    // diff — so judging the announcement would cancel every spec write,
    // including the agent's own `openspec/` output. The follow-up update
    // carries the path and gets judged there.
    if file_paths.is_empty()
        && matches!(
            kind,
            permissions::ToolKind::Edit | permissions::ToolKind::Move
        )
    {
        return None;
    }
    match permissions::decide_permission(mode, kind, command, file_paths) {
        PermissionDecision::Deny => {
            let kind_label = match kind {
                permissions::ToolKind::Edit => "edit",
                permissions::ToolKind::Delete => "delete",
                permissions::ToolKind::Move => "move",
                permissions::ToolKind::Execute => "execute",
                _ => "write",
            };
            Some(format!(
                "Spec mode denies {kind_label} tool calls — switch to Go mode to allow writes."
            ))
        }
        _ => None,
    }
}

/// Run the ACP connection until shutdown. Errors before the session is ready
/// are reported through `ready_tx`; errors afterwards surface as `Crashed`
/// events on the sink.
async fn run_bridge(
    transport: impl ConnectTo<acp::Client>,
    spawn: AcpSpawn,
    palisade_session_id: String,
    sink: Arc<dyn Sink>,
    busy: Arc<AtomicBool>,
    ready_tx: mpsc::Sender<Result<ReadyReport, String>>,
    mut cmd_rx: tokio::sync::mpsc::UnboundedReceiver<BridgeCommand>,
    probe_only: bool,
) -> Result<(), String> {
    let notif_sink = sink.clone();
    let notif_session = palisade_session_id.clone();
    let notif_thread = spawn.thread_id.clone();
    let perm_mode = permission_mode(&spawn.mode, spawn.bypass);
    // ACP streams chunks; there is no complete-text event at turn end.
    // Accumulate text/thought chunks per turn so the prompt response can
    // emit the assembled `Text`/`Reasoning` events that persist() writes
    // to the thread log.
    let text_buf = Arc::new(std::sync::Mutex::new(String::new()));
    let think_buf = Arc::new(std::sync::Mutex::new(String::new()));
    let notif_text = text_buf.clone();
    let notif_think = think_buf.clone();
    // Whether the current turn has already been cancelled for a Spec-mode
    // violation. Prevents double-cancellation when multiple write tool calls
    // arrive in the same turn.
    let cancelled = Arc::new(AtomicBool::new(false));
    let notif_cancelled = cancelled.clone();
    // Tool kinds by call id, so a `ToolCallUpdate` that omits `kind` is still
    // judged by the write guard (see `write_guard_input`).
    let notif_kinds =
        Arc::new(std::sync::Mutex::new(HashMap::<String, permissions::ToolKind>::new()));
    let notif_busy = busy.clone();
    // Clones for the error tail after connect_with — the closure moves the
    // originals.
    let tail_ready_tx = ready_tx.clone();
    let tail_sink = sink.clone();
    let tail_session = palisade_session_id.clone();
    let tail_thread = spawn.thread_id.clone();

    let result = acp::Client.builder()
        .name("palisade-code")
        .on_receive_notification(
            async move |notification: v1::SessionNotification, cx| {
                // Spec-mode enforcement at the notification layer: some agents
                // (OpenCode) auto-approve workspace writes and never send
                // `session/request_permission` for in-project edits. When a
                // write-kind tool call appears in Spec mode, cancel the turn
                // and emit a Crashed event so the user sees the denial.
                if let Some((kind, command, paths)) =
                    write_guard_input(&notification.update, &notif_kinds)
                {
                    if !notif_cancelled.load(Ordering::SeqCst) {
                        let path_refs: Vec<&str> =
                            paths.iter().map(|s| s.as_str()).collect();
                        if let Some(reason) =
                            spec_mode_violation(kind, perm_mode, command.as_deref(), &path_refs)
                        {
                            notif_cancelled.store(true, Ordering::SeqCst);
                            notif_busy.store(false, Ordering::SeqCst);
                            // Ask the agent to stop the current turn.
                            let _ = cx.send_notification(v1::CancelNotification::new(
                                notification.session_id.clone(),
                            ));
                            // Clear the turn's buffers so the prompt response
                            // doesn't flush partial text as a "completed" turn.
                            notif_text.lock().unwrap().clear();
                            notif_think.lock().unwrap().clear();
                            emit(
                                &notif_sink,
                                &notif_session,
                                &notif_thread,
                                ExecutorEvent::Crashed {
                                    exit_code: None,
                                    message: reason,
                                },
                            );
                            return Ok(());
                        }
                    }
                }
                if let Some(update) = crate::acp_events::from_session_update(&notification.update)
                {
                    match &update {
                        crate::acp_events::AcpUpdate::TextDelta { text } => {
                            notif_text.lock().unwrap().push_str(text)
                        }
                        crate::acp_events::AcpUpdate::ReasoningDelta { text } => {
                            notif_think.lock().unwrap().push_str(text)
                        }
                        _ => {}
                    }
                    for event in crate::acp_events::map_acp_update(update) {
                        emit(&notif_sink, &notif_session, &notif_thread, event);
                    }
                }
                Ok(())
            },
            acp::on_receive_notification!(),
        )
        .on_receive_request(
            async move |request: v1::RequestPermissionRequest, responder, _cx| {
                responder.respond(answer_permission(&request, perm_mode))
            },
            acp::on_receive_request!(),
        )
        .connect_with(transport, async move |cx| {
            let init_response = cx
                .send_request(v1::InitializeRequest::new(ProtocolVersion::V1))
                .block_task()
                .await
                .map_err(|e| acp::Error::internal_error().data(format!("initialize failed: {e}")))?;

            // Authenticate if the agent requires it (D15).  Agents that
            // advertise auth methods (e.g. Devin's API-key flow) will
            // reject session/new until the client calls authenticate first.
            // AuthMethod::Agent means the agent handles auth itself — Palisade
            // looks up stored credentials and passes them via _meta.
            if !init_response.auth_methods.is_empty() {
                let method_id = init_response.auth_methods[0].id().clone();
                let method_id_str = method_id.to_string();
                let creds = lookup_agent_credentials(&spawn.agent_id, &method_id_str);
                let mut req = v1::AuthenticateRequest::new(method_id);
                if let Some(meta) = creds {
                    req = req.meta(meta);
                }
                cx.send_request(req)
                    .block_task()
                    .await
                    .map_err(|e| {
                        acp::Error::internal_error()
                            .data(format!("authenticate failed: {e}"))
                    })?;
            }

            let new_session = cx
                .send_request(v1::NewSessionRequest::new(spawn.project_root.clone()))
                .block_task()
                .await
                .map_err(|e| acp::Error::internal_error().data(format!("session/new failed: {e}")))?;

            let session_id = new_session.session_id;
            let mut models = extract_models(new_session.config_options.as_deref().unwrap_or(&[]));

            // Apply the thread's model choice when the agent offers it.
            if let Some(want) = spawn.model.as_deref() {
                let offered = models.models.iter().any(|m| m.id == want);
                if offered && models.current.as_deref() != Some(want) {
                    if let Some(config_id) = models.config_id.clone() {
                        if let Ok(response) = cx
                            .send_request(v1::SetSessionConfigOptionRequest::new(
                                session_id.clone(),
                                config_id,
                                want,
                            ))
                            .block_task()
                            .await
                        {
                            models =
                                extract_models(&response.config_options);
                        }
                    }
                }
            }

            let ready = ready_tx.send(Ok(ReadyReport {
                acp_session_id: session_id.to_string(),
                models,
            }));
            if ready.is_err() || probe_only {
                // Caller gave up waiting, or this was just a model probe.
                return Ok(());
            }

            loop {
                tokio::select! {
                    cmd = cmd_rx.recv() => {
                        match cmd {
                            Some(BridgeCommand::Prompt(text)) => {
                                let done_sink = sink.clone();
                                let done_session = palisade_session_id.clone();
                                let done_thread = spawn.thread_id.clone();
                                let done_busy = busy.clone();
                                let done_text = text_buf.clone();
                                let done_think = think_buf.clone();
                                let done_cancelled = cancelled.clone();
                                // Reset the per-turn cancellation flag.
                                cancelled.store(false, Ordering::SeqCst);
                                let send = cx.send_request(v1::PromptRequest::new(
                                    session_id.clone(),
                                    vec![v1::ContentBlock::Text(v1::TextContent::new(text))],
                                ));
                                if let Err(e) = send.on_receiving_result(async move |result| {
                                    done_busy.store(false, Ordering::SeqCst);
                                    // If the notification handler already cancelled
                                    // the turn for a Spec-mode violation, it emitted
                                    // Crashed and cleared the buffers — don't emit a
                                    // duplicate Done/Crashed here.
                                    if done_cancelled.load(Ordering::SeqCst) {
                                        return Ok(());
                                    }
                                    // Flush the turn's accumulated chunks as the
                                    // complete events persist() records.
                                    let full = std::mem::take(&mut *done_text.lock().unwrap());
                                    if !full.trim().is_empty() {
                                        emit(&done_sink, &done_session, &done_thread, ExecutorEvent::Text { text: full });
                                    }
                                    let thought = std::mem::take(&mut *done_think.lock().unwrap());
                                    if !thought.trim().is_empty() {
                                        emit(&done_sink, &done_session, &done_thread, ExecutorEvent::Reasoning { text: thought });
                                    }
                                    match result {
                                        Ok(_) => emit(&done_sink, &done_session, &done_thread, ExecutorEvent::Done),
                                        Err(e) => emit(&done_sink, &done_session, &done_thread, ExecutorEvent::Crashed {
                                            exit_code: None,
                                            message: format!("prompt failed: {e}"),
                                        }),
                                    }
                                    Ok(())
                                }) {
                                    busy.store(false, Ordering::SeqCst);
                                    emit(&sink, &palisade_session_id, &spawn.thread_id, ExecutorEvent::Crashed {
                                        exit_code: None,
                                        message: format!("prompt send failed: {e}"),
                                    });
                                }
                            }
                            Some(BridgeCommand::Shutdown) | None => return Ok(()),
                        }
                    }
                    _ = cx.incoming_closed() => return Ok(()),
                }
            }
        })
        .await;

    match result {
        Ok(()) => Ok(()),
        Err(e) => {
            let message = e.to_string();
            // If startup never completed, the caller is still waiting on the
            // ready channel; otherwise the receiver is dropped and the
            // session died mid-flight — surface it as a Crashed event.
            if tail_ready_tx.send(Err(message.clone())).is_err() {
                emit(
                    &tail_sink,
                    &tail_session,
                    &tail_thread,
                    ExecutorEvent::Crashed {
                        exit_code: None,
                        message: message.clone(),
                    },
                );
            }
            Err(message)
        }
    }
}

/// Spawn the bridge thread and wait for the session to become ready.
///
/// Returns the Palisade session id, the reported model state, the command
/// channel, and the busy flag — the *same* `Arc` the bridge clears when a
/// turn ends, so the session handle must share it rather than make its own.
#[allow(clippy::type_complexity)]
fn start_with_transport(
    transport: impl ConnectTo<acp::Client> + Send + 'static,
    spawn: AcpSpawn,
    sink: Arc<dyn Sink>,
    probe_only: bool,
) -> Result<
    (
        String,
        ModelState,
        tokio::sync::mpsc::UnboundedSender<BridgeCommand>,
        Arc<AtomicBool>,
        String,
    ),
    String,
> {
    let palisade_session_id = ulid::Ulid::new().to_string();
    let busy = Arc::new(AtomicBool::new(false));
    let bridge_busy = busy.clone();
    let (ready_tx, ready_rx) = mpsc::channel::<Result<ReadyReport, String>>();
    let (cmd_tx, cmd_rx) = tokio::sync::mpsc::unbounded_channel::<BridgeCommand>();

    let thread_session = palisade_session_id.clone();
    std::thread::spawn(move || {
        let runtime = match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(rt) => rt,
            Err(e) => {
                let _ = ready_tx.send(Err(format!("tokio runtime: {e}")));
                return;
            }
        };
        let _ = runtime.block_on(run_bridge(
            transport,
            spawn,
            thread_session,
            sink,
            bridge_busy,
            ready_tx,
            cmd_rx,
            probe_only,
        ));
    });

    match ready_rx.recv_timeout(STARTUP_TIMEOUT) {
        Ok(Ok(report)) => Ok((
            palisade_session_id,
            report.models,
            cmd_tx,
            busy,
            report.acp_session_id,
        )),
        Ok(Err(e)) => Err(e),
        Err(_) => Err(format!("agent did not answer within {STARTUP_TIMEOUT:?}")),
    }
}

/// Start an ACP session on a background bridge thread.
///
/// Spawns the agent process, connects over stdio, completes the initialize
/// handshake, creates a session (applying the thread's model choice), and
/// bridges notifications to the sync `Sink`. Blocks until the session is
/// ready or startup fails.
pub fn start_acp_session(spawn: AcpSpawn, sink: Arc<dyn Sink>) -> Result<AcpSession, String> {
    let agent = agent_config(&spawn);
    let identity = SessionIdentity::from(&spawn);
    let (id, models, cmd_tx, busy, acp_session_id) =
        start_with_transport(agent, spawn, sink, false)?;
    let mut session = identity.into_session(id, models, cmd_tx, busy);
    session.acp_session_id = Some(acp_session_id);
    Ok(session)
}

/// Spawn an agent just long enough to learn its model selector, then drop
/// the connection (which kills the process). Used to populate the model
/// menu for a provider without opening a thread session.
pub fn probe_models(
    bin: PathBuf,
    args: Vec<String>,
    project_root: PathBuf,
) -> Result<ModelState, String> {
    let spawn = AcpSpawn {
        agent_id: String::new(),
        agent_name: String::new(),
        bin,
        cmd: String::new(),
        args,
        project_root,
        project_hash: String::new(),
        thread_id: String::new(),
        mode: "spec".into(),
        bypass: false,
        model: None,
        palisade_home: PathBuf::new(),
    };
    let agent = agent_config(&spawn);
    let (_id, models, _cmd_tx, _busy, _acp_id) =
        start_with_transport(agent, spawn, Arc::new(NullSink), true)?;
    Ok(models)
}

/// A sink for probes — no UI is listening.
struct NullSink;
impl Sink for NullSink {
    fn emit(&self, _envelope: &Envelope) {}
}

// ------------------------------------------------------------- one-shot
//
// Amendment 7's Source Control panel needs the agent's answer as a *value*
// (a drafted commit message goes into the message box), not as chat turns.
// Every other agent path streams into a thread, so this is the one place
// that runs a prompt on an ephemeral session and collects the reply.

/// Accumulates assistant text until the turn ends. Split out from the
/// spawn plumbing so its "which events count" branching is unit-testable
/// without a live agent.
#[derive(Default)]
pub(crate) struct Collected {
    pub text: String,
    pub finished: bool,
    pub error: Option<String>,
}

impl Collected {
    /// Deltas are deliberately ignored: each one is followed by the complete
    /// `Text` event, so counting both would duplicate every fragment.
    pub(crate) fn accept(&mut self, event: &ExecutorEvent) {
        match event {
            ExecutorEvent::Text { text } => self.text.push_str(text),
            ExecutorEvent::Done => self.finished = true,
            ExecutorEvent::Crashed { message, .. } => {
                self.error = Some(message.clone());
                self.finished = true;
            }
            _ => {}
        }
    }
}

struct CollectingSink(Arc<Mutex<Collected>>);

impl Sink for CollectingSink {
    fn emit(&self, envelope: &Envelope) {
        if let Ok(mut collected) = self.0.lock() {
            collected.accept(&envelope.event);
        }
    }
}

/// Run one prompt on a throwaway session and return the assistant's reply.
///
/// The session is terminated either way — this is not a thread the user can
/// see or resume, so leaving it live would leak a child process per click.
pub fn agent_oneshot(spawn: AcpSpawn, prompt: &str, timeout: Duration) -> Result<String, String> {
    let collected = Arc::new(Mutex::new(Collected::default()));
    let sink = Arc::new(CollectingSink(collected.clone()));
    let agent = agent_config(&spawn);
    let (_id, models, cmd_tx, busy, _acp_id) =
        start_with_transport(agent, spawn, sink, false)?;
    let _ = models;

    busy.store(true, Ordering::SeqCst);
    cmd_tx
        .send(BridgeCommand::Prompt(prompt.to_string()))
        .map_err(|_| "agent connection is closed".to_string())?;

    let deadline = std::time::Instant::now() + timeout;
    loop {
        if collected.lock().map(|c| c.finished).unwrap_or(true) {
            break;
        }
        if std::time::Instant::now() >= deadline {
            let _ = cmd_tx.send(BridgeCommand::Shutdown);
            return Err("agent did not answer in time".into());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let _ = cmd_tx.send(BridgeCommand::Shutdown);

    let collected = collected.lock().map_err(|_| "collector poisoned")?;
    if let Some(error) = &collected.error {
        return Err(error.clone());
    }
    Ok(collected.text.trim().to_string())
}

/// The identity fields `AcpSession` mirrors from the spawn, captured before
/// the spawn is moved onto the bridge thread.
struct SessionIdentity {
    agent_id: String,
    agent_name: String,
    bin: PathBuf,
    cmd: String,
    args: Vec<String>,
    project_hash: String,
    thread_id: String,
    project_root: PathBuf,
    mode: String,
    palisade_home: PathBuf,
}

impl SessionIdentity {
    fn from(spawn: &AcpSpawn) -> Self {
        Self {
            agent_id: spawn.agent_id.clone(),
            agent_name: spawn.agent_name.clone(),
            bin: spawn.bin.clone(),
            cmd: spawn.cmd.clone(),
            args: spawn.args.clone(),
            project_hash: spawn.project_hash.clone(),
            thread_id: spawn.thread_id.clone(),
            project_root: spawn.project_root.clone(),
            mode: spawn.mode.clone(),
            palisade_home: spawn.palisade_home.clone(),
        }
    }

    fn into_session(
        self,
        id: String,
        models: ModelState,
        cmd_tx: tokio::sync::mpsc::UnboundedSender<BridgeCommand>,
        busy: Arc<AtomicBool>,
    ) -> AcpSession {
        AcpSession {
            id,
            agent_id: self.agent_id,
            agent_name: self.agent_name,
            bin: self.bin,
            cmd: self.cmd,
            args: self.args,
            project_hash: self.project_hash,
            thread_id: self.thread_id,
            project_root: self.project_root,
            mode: self.mode,
            palisade_home: self.palisade_home,
            acp_session_id: None,
            models,
            busy,
            stopping: Arc::new(AtomicBool::new(false)),
            cmd_tx: Some(cmd_tx),
        }
    }
}

/// Send a user message to a live ACP session. The prompt response arrives
/// on the bridge thread, which emits `Done` (or `Crashed`) and clears busy.
pub fn send_acp_prompt(session: &AcpSession, message: &str) -> Result<(), String> {
    if session.is_busy() {
        return Err("executor is mid-turn".into());
    }
    let tx = session.cmd_tx.as_ref().ok_or("session is shut down")?;
    session.busy.store(true, Ordering::SeqCst);
    tx.send(BridgeCommand::Prompt(message.to_string()))
        .map_err(|_| "agent connection is closed".to_string())
}

fn agent_config(spawn: &AcpSpawn) -> acp::AcpAgent {
    let mut config = acp::AcpAgentConfig::new(spawn.bin.clone());
    config = config.args(spawn.args.iter().cloned());
    // A GUI-launched Palisade inherits launchd's minimal PATH; the agent (and
    // anything it shells out to) needs the user's real one.
    if let Some(path) = crate::executor::login_shell_path() {
        config = config.env("PATH", path.to_string_lossy().into_owned());
    }
    acp::AcpAgent::new(config)
}

/// A session handle for tests that never touch a transport.
#[cfg(test)]
pub(crate) fn stub_session(busy: bool) -> (AcpSession, tokio::sync::mpsc::UnboundedReceiver<BridgeCommand>) {
    let (cmd_tx, cmd_rx) = tokio::sync::mpsc::unbounded_channel();
    (
        AcpSession {
            id: "test-id".into(),
            agent_id: "devin".into(),
            agent_name: "Devin".into(),
            bin: PathBuf::from("/usr/bin/devin"),
            cmd: "devin".into(),
            args: vec!["acp".into()],
            project_hash: "abc123".into(),
            thread_id: "thread-1".into(),
            project_root: PathBuf::from("/tmp/proj"),
            mode: "spec".into(),
            palisade_home: PathBuf::from("/tmp/palisade"),
            acp_session_id: None,
            models: ModelState::default(),
            busy: Arc::new(AtomicBool::new(busy)),
            stopping: Arc::new(AtomicBool::new(false)),
            cmd_tx: Some(cmd_tx),
        },
        cmd_rx,
    )
}

// ------------------------------------------------------------------ tests

#[cfg(test)]
mod tests {
    use super::*;

    // ------------------------------------------------------- one-shot

    #[test]
    fn collector_joins_text_events_and_finishes_on_done() {
        let mut collected = Collected::default();
        collected.accept(&ExecutorEvent::Text { text: "fix: ".into() });
        collected.accept(&ExecutorEvent::Text { text: "drop the guard".into() });
        assert!(!collected.finished);

        collected.accept(&ExecutorEvent::Done);

        assert_eq!(collected.text, "fix: drop the guard");
        assert!(collected.finished);
        assert!(collected.error.is_none());
    }

    /// Deltas are followed by the complete `Text` event, so counting both
    /// would duplicate every fragment into the drafted message.
    #[test]
    fn collector_ignores_deltas_and_other_events() {
        let mut collected = Collected::default();
        collected.accept(&ExecutorEvent::TextDelta { text: "fix".into() });
        collected.accept(&ExecutorEvent::Reasoning { text: "thinking".into() });
        collected.accept(&ExecutorEvent::ToolCall {
            id: "1".into(),
            name: "bash".into(),
            command: "git diff".into(),
        });
        collected.accept(&ExecutorEvent::Text { text: "fix: real".into() });

        assert_eq!(collected.text, "fix: real");
    }

    #[test]
    fn collector_records_a_crash_as_an_error_and_finishes() {
        let mut collected = Collected::default();
        collected.accept(&ExecutorEvent::Crashed {
            exit_code: Some(1),
            message: "agent exited".into(),
        });

        assert!(collected.finished);
        assert_eq!(collected.error.as_deref(), Some("agent exited"));
    }

    // --------------------------------------------------------- models

    fn model_option() -> v1::SessionConfigOption {
        v1::SessionConfigOption::select(
            "model",
            "Model",
            "model-a",
            vec![
                v1::SessionConfigSelectOption::new("model-a", "Model A"),
                v1::SessionConfigSelectOption::new("model-b", "Model B"),
            ],
        )
        .category(v1::SessionConfigOptionCategory::Model)
    }

    /// RED→GREEN: the model selector is extracted from config options.
    #[test]
    fn extract_models_finds_model_category() {
        let state = extract_models(&[model_option()]);
        assert_eq!(state.config_id.as_deref(), Some("model"));
        assert_eq!(state.current.as_deref(), Some("model-a"));
        assert_eq!(
            state.models,
            vec![
                ModelInfo { id: "model-a".into(), name: "Model A".into() },
                ModelInfo { id: "model-b".into(), name: "Model B".into() },
            ]
        );
    }

    /// RED→GREEN: no model option means an empty state, not an error.
    #[test]
    fn extract_models_empty_when_absent() {
        let other = v1::SessionConfigOption::boolean("fast", "Fast mode", false);
        let state = extract_models(&[other]);
        assert_eq!(state, ModelState::default());
    }

    // --------------------------------------------------------- permissions

    fn permission_request(
        kind: v1::ToolKind,
        command: Option<serde_json::Value>,
    ) -> v1::RequestPermissionRequest {
        let mut fields = v1::ToolCallUpdateFields::new();
        fields.kind = Some(kind);
        fields.raw_input = command;
        v1::RequestPermissionRequest::new(
            "sess-1",
            v1::ToolCallUpdate::new("tc-1", fields),
            vec![
                v1::PermissionOption::new("allow", "Allow once", v1::PermissionOptionKind::AllowOnce),
                v1::PermissionOption::new("deny", "Deny", v1::PermissionOptionKind::RejectOnce),
            ],
        )
    }

    fn selected_option(response: v1::RequestPermissionResponse) -> Option<String> {
        match response.outcome {
            v1::RequestPermissionOutcome::Selected(selected) => {
                Some(selected.option_id.to_string())
            }
            _ => None,
        }
    }

    /// RED→GREEN: spec mode auto-approves reads.
    #[test]
    fn spec_mode_allows_read() {
        let req = permission_request(v1::ToolKind::Read, None);
        let res = answer_permission(&req, PermissionMode::Spec);
        assert_eq!(selected_option(res).as_deref(), Some("allow"));
    }

    /// RED→GREEN: spec mode denies edits by cancelling.
    #[test]
    fn spec_mode_denies_edit() {
        let req = permission_request(v1::ToolKind::Edit, None);
        let res = answer_permission(&req, PermissionMode::Spec);
        assert!(matches!(
            res.outcome,
            v1::RequestPermissionOutcome::Cancelled
        ));
    }

    /// RED→GREEN: bypass mode allows everything.
    #[test]
    fn bypass_allows_execute() {
        let req = permission_request(v1::ToolKind::Execute, Some(serde_json::json!({"command": "rm -rf /tmp/x"})));
        let res = answer_permission(&req, PermissionMode::Bypass);
        assert_eq!(selected_option(res).as_deref(), Some("allow"));
    }

    /// RED→GREEN: openspec commands are whitelisted even in spec mode (D20).
    #[test]
    fn spec_mode_allows_openspec_execute() {
        let req = permission_request(v1::ToolKind::Execute, Some(serde_json::json!({"command": "openspec list"})));
        let res = answer_permission(&req, PermissionMode::Spec);
        assert_eq!(selected_option(res).as_deref(), Some("allow"));
    }

    /// RED→GREEN: go-mode prompts on execute → cancelled until the prompt UI exists.
    #[test]
    fn go_mode_prompt_cancels_for_now() {
        let req = permission_request(v1::ToolKind::Execute, Some(serde_json::json!({"command": "cargo build"})));
        let res = answer_permission(&req, PermissionMode::Go);
        assert!(matches!(
            res.outcome,
            v1::RequestPermissionOutcome::Cancelled
        ));
    }

    // --------------------------------------------------------- spec-mode notification enforcement

    /// RED→GREEN: spec_mode_violation flags an edit tool call in Spec mode.
    /// OpenCode auto-approves workspace writes and never sends
    /// `session/request_permission` for in-project edits, so Palisade must enforce
    /// Spec mode at the `session/update` notification layer.
    #[test]
    fn spec_mode_violation_flags_edit_in_spec_mode() {
        let reason = spec_mode_violation(
            permissions::ToolKind::Edit,
            PermissionMode::Spec,
            None,
            &["src/todo.js"],
        );
        assert!(reason.is_some(), "spec mode should flag an edit");
        let reason = reason.unwrap();
        assert!(
            reason.to_lowercase().contains("spec mode"),
            "reason should mention spec mode: {reason}"
        );
        assert!(
            reason.to_lowercase().contains("edit"),
            "reason should mention edit: {reason}"
        );
    }

    /// RED→GREEN: spec_mode_violation flags delete and move in Spec mode.
    /// A delete is denied whatever the path; a move needs a path to judge.
    #[test]
    fn spec_mode_violation_flags_delete_and_move() {
        assert!(
            spec_mode_violation(
                permissions::ToolKind::Delete,
                PermissionMode::Spec,
                None,
                &[]
            )
            .is_some(),
            "spec mode should flag a delete"
        );
        assert!(
            spec_mode_violation(
                permissions::ToolKind::Move,
                PermissionMode::Spec,
                None,
                &["src/todo.js"]
            )
            .is_some(),
            "spec mode should flag a move outside openspec/"
        );
    }

    /// A write whose path has not arrived yet is undecidable, not a
    /// violation — judging it would cancel every OpenCode spec write, whose
    /// announcement carries no path at all.
    #[test]
    fn spec_mode_violation_defers_a_pathless_write() {
        for kind in &[permissions::ToolKind::Edit, permissions::ToolKind::Move] {
            assert!(
                spec_mode_violation(*kind, PermissionMode::Spec, None, &[]).is_none(),
                "a pathless {kind:?} should be deferred, not cancelled"
            );
        }
    }

    /// RED→GREEN: spec_mode_violation does NOT flag reads in Spec mode.
    #[test]
    fn spec_mode_violation_allows_reads_in_spec_mode() {
        for kind in &[
            permissions::ToolKind::Read,
            permissions::ToolKind::Search,
            permissions::ToolKind::Think,
            permissions::ToolKind::Fetch,
        ] {
            assert!(
                spec_mode_violation(*kind, PermissionMode::Spec, None, &[]).is_none(),
                "spec mode should NOT flag {kind:?}"
            );
        }
    }

    /// RED→GREEN: OpenCode sends write tool calls with an empty `locations`,
    /// so the openspec/ path must come off the raw input — otherwise spec
    /// mode cancels the turn on the agent's own spec file.
    #[test]
    fn tool_call_paths_falls_back_to_raw_input() {
        let raw = serde_json::json!({"filePath": "openspec/changes/x/proposal.md"});
        let paths = tool_call_paths(Vec::new(), &[], Some(&raw));
        assert_eq!(paths, vec!["openspec/changes/x/proposal.md".to_string()]);
        let refs: Vec<&str> = paths.iter().map(|s| s.as_str()).collect();
        assert!(
            spec_mode_violation(
                permissions::ToolKind::Edit,
                PermissionMode::Spec,
                None,
                &refs
            )
            .is_none(),
            "spec mode should allow a write to openspec/"
        );
    }

    /// `locations` wins when the agent fills it.
    #[test]
    fn tool_call_paths_prefers_locations() {
        let raw = serde_json::json!({"path": "openspec/notes.md"});
        let paths = tool_call_paths(vec!["src/todo.js".to_string()], &[], Some(&raw));
        assert_eq!(paths, vec!["src/todo.js".to_string()]);
    }

    /// RED→GREEN: OpenCode's write calls carry neither `locations` nor a
    /// usable `rawInput` — the only path is on the streamed diff, so spec
    /// mode has to read it there or it cancels the agent's own spec write.
    #[test]
    fn tool_call_paths_reads_the_diff_path() {
        let diff = v1::Diff::new(
            std::path::PathBuf::from(
                "/Users/x/proj/openspec/changes/clear-completed/proposal.md",
            ),
            "## Why".to_string(),
        );
        let content = vec![v1::ToolCallContent::Diff(diff)];
        let paths = tool_call_paths(Vec::new(), &content, None);
        let refs: Vec<&str> = paths.iter().map(|s| s.as_str()).collect();
        assert!(
            spec_mode_violation(
                permissions::ToolKind::Edit,
                PermissionMode::Spec,
                None,
                &refs
            )
            .is_none(),
            "spec mode should allow the diff's openspec/ write"
        );
    }

    /// RED→GREEN: spec_mode_violation does NOT flag edits in Go mode.
    #[test]
    fn spec_mode_violation_allows_edits_in_go_mode() {
        assert!(
            spec_mode_violation(permissions::ToolKind::Edit, PermissionMode::Go, None, &[]).is_none(),
            "go mode should allow edits"
        );
        assert!(
            spec_mode_violation(permissions::ToolKind::Move, PermissionMode::Go, None, &[]).is_none(),
            "go mode should allow moves"
        );
    }

    /// RED→GREEN: spec_mode_violation does NOT flag anything in Bypass mode.
    #[test]
    fn spec_mode_violation_allows_everything_in_bypass() {
        for kind in &[
            permissions::ToolKind::Edit,
            permissions::ToolKind::Delete,
            permissions::ToolKind::Move,
            permissions::ToolKind::Execute,
        ] {
            assert!(
                spec_mode_violation(*kind, PermissionMode::Bypass, None, &[]).is_none(),
                "bypass should allow {kind:?}"
            );
        }
    }

    /// RED→GREEN: execute commands are allowed even in Spec mode.
    #[test]
    fn spec_mode_violation_allows_execute() {
        for cmd in &[Some("openspec list --json"), Some("cargo build"), None] {
            assert!(
                spec_mode_violation(
                    permissions::ToolKind::Execute,
                    PermissionMode::Spec,
                    *cmd,
                    &[],
                )
                .is_none(),
                "execute should not be flagged in spec mode"
            );
        }
    }

    // --------------------------------------------------------- send / terminate

    /// RED→GREEN: send rejects while busy and never reaches the bridge.
    #[test]
    fn send_rejects_when_busy() {
        let (session, mut cmd_rx) = stub_session(true);
        let result = send_acp_prompt(&session, "hello");
        assert!(result.unwrap_err().contains("mid-turn"));
        assert!(cmd_rx.try_recv().is_err());
    }

    /// RED→GREEN: send marks busy and queues the prompt for the bridge.
    #[test]
    fn send_queues_prompt_when_idle() {
        let (session, mut cmd_rx) = stub_session(false);
        send_acp_prompt(&session, "hello").unwrap();
        assert!(session.is_busy());
        match cmd_rx.try_recv() {
            Ok(BridgeCommand::Prompt(text)) => assert_eq!(text, "hello"),
            _ => panic!("expected a Prompt command"),
        }
    }

    /// RED→GREEN: terminate tells the bridge to shut down.
    #[test]
    fn terminate_sends_shutdown() {
        let (mut session, mut cmd_rx) = stub_session(true);
        session.terminate();
        assert!(matches!(cmd_rx.try_recv(), Ok(BridgeCommand::Shutdown)));
        assert!(!session.is_busy());
    }

    // --------------------------------------------------------- live bridge

    /// A fake ACP agent on the other end of an in-memory duplex: answers
    /// initialize, reports a two-model selector on session/new, echoes one
    /// text chunk per prompt, and records set_config_option requests.
    struct FakeAgent {
        set_config_requests: Arc<std::sync::Mutex<Vec<(String, String)>>>,
    }

    impl FakeAgent {
        fn spawn(
            &self,
            transport: acp::ByteStreams<
                impl futures::AsyncWrite + Send + 'static,
                impl futures::AsyncRead + Send + 'static,
            >,
        ) -> tokio::task::JoinHandle<()> {
            let set_requests = self.set_config_requests.clone();
            tokio::spawn(async move {
                let _ = acp::Agent
                    .builder()
                    .name("fake-agent")
                    .on_receive_request(
                        async |req: v1::InitializeRequest, responder, _cx| {
                            responder.respond(
                                v1::InitializeResponse::new(req.protocol_version)
                                    .agent_capabilities(v1::AgentCapabilities::new()),
                            )
                        },
                        acp::on_receive_request!(),
                    )
                    .on_receive_request(
                        async |_req: v1::NewSessionRequest, responder, _cx| {
                            responder.respond(
                                v1::NewSessionResponse::new("acp-sess-1")
                                    .config_options(vec![model_option()]),
                            )
                        },
                        acp::on_receive_request!(),
                    )
                    .on_receive_request(
                        async move |req: v1::SetSessionConfigOptionRequest, responder, _cx| {
                            let value = match &req.value {
                                v1::SessionConfigOptionValue::ValueId { value } => {
                                    value.to_string()
                                }
                                _ => String::new(),
                            };
                            set_requests
                                .lock()
                                .unwrap()
                                .push((req.config_id.to_string(), value.clone()));
                            responder.respond(v1::SetSessionConfigOptionResponse::new(vec![
                                v1::SessionConfigOption::select(
                                    "model",
                                    "Model",
                                    value,
                                    vec![
                                        v1::SessionConfigSelectOption::new("model-a", "Model A"),
                                        v1::SessionConfigSelectOption::new("model-b", "Model B"),
                                    ],
                                )
                                .category(v1::SessionConfigOptionCategory::Model),
                            ]))
                        },
                        acp::on_receive_request!(),
                    )
                    .on_receive_request(
                        async |req: v1::PromptRequest, responder, cx| {
                            for piece in ["agent ", "reply"] {
                                let _ = cx.send_notification(v1::SessionNotification::new(
                                    req.session_id.clone(),
                                    v1::SessionUpdate::AgentMessageChunk(v1::ContentChunk::new(
                                        v1::ContentBlock::Text(v1::TextContent::new(piece)),
                                    )),
                                ));
                            }
                            responder
                                .respond(v1::PromptResponse::new(v1::StopReason::EndTurn))
                        },
                        acp::on_receive_request!(),
                    )
                    .connect_to(transport)
                    .await;
            })
        }
    }

    /// Wire a fake agent to a bridge transport over an in-memory duplex.
    fn fake_agent_pair() -> (
        acp::ByteStreams<
            impl futures::AsyncWrite + Send + 'static,
            impl futures::AsyncRead + Send + 'static,
        >,
        FakeAgent,
        tokio::task::JoinHandle<()>,
    ) {
        use tokio_util::compat::TokioAsyncReadCompatExt;
        use tokio_util::compat::TokioAsyncWriteCompatExt;

        let (client_end, agent_end) = tokio::io::duplex(64 * 1024);
        let (client_r, client_w) = tokio::io::split(client_end);
        let (agent_r, agent_w) = tokio::io::split(agent_end);

        let fake = FakeAgent {
            set_config_requests: Arc::new(std::sync::Mutex::new(vec![])),
        };
        let handle = fake.spawn(acp::ByteStreams::new(
            agent_w.compat_write(),
            agent_r.compat(),
        ));
        let transport = acp::ByteStreams::new(client_w.compat_write(), client_r.compat());
        (transport, fake, handle)
    }

    fn test_spawn(model: Option<String>) -> AcpSpawn {
        AcpSpawn {
            agent_id: "fake".into(),
            agent_name: "Fake".into(),
            bin: PathBuf::from("/bin/fake"),
            cmd: "fake".into(),
            args: vec![],
            project_root: PathBuf::from("/tmp/proj"),
            project_hash: "abc123".into(),
            thread_id: "thread-1".into(),
            mode: "spec".into(),
            bypass: false,
            model,
            palisade_home: PathBuf::from("/tmp/palisade"),
        }
    }

    struct ChannelSink(std::sync::mpsc::Sender<Envelope>);
    impl Sink for ChannelSink {
        fn emit(&self, envelope: &Envelope) {
            let _ = self.0.send(envelope.clone());
        }
    }

    fn recv_event(rx: &std::sync::mpsc::Receiver<Envelope>) -> Envelope {
        rx.recv_timeout(Duration::from_secs(10))
            .expect("timed out waiting for an executor event")
    }

    /// RED→GREEN: a session starts against a live ACP connection and reports
    /// the agent's model selector.
    #[tokio::test(flavor = "multi_thread")]
    async fn bridge_session_reports_models() {
        let (transport, _fake, _agent) = fake_agent_pair();
        let (tx, _rx) = std::sync::mpsc::channel();
        let session = start_with_transport(transport, test_spawn(None), Arc::new(ChannelSink(tx)), false);
        let (_id, models, _cmds, _busy, acp_id) = session.expect("session should start");
        assert_eq!(models.current.as_deref(), Some("model-a"));
        assert_eq!(models.models.len(), 2);
        assert_eq!(acp_id, "acp-sess-1");
    }

    /// RED→GREEN: a prompt round-trips — the agent's chunk arrives at the
    /// sink, and the prompt response closes the turn with Done. The busy
    /// flag the session handle holds is the one the bridge clears.
    #[tokio::test(flavor = "multi_thread")]
    async fn bridge_prompt_round_trips() {
        let (transport, _fake, _agent) = fake_agent_pair();
        let (tx, rx) = std::sync::mpsc::channel();
        let (id, _models, cmds, busy, _acp_id) =
            start_with_transport(transport, test_spawn(None), Arc::new(ChannelSink(tx)), false)
                .unwrap();

        let session = SessionIdentity::from(&test_spawn(None))
            .into_session(id, ModelState::default(), cmds, busy);
        send_acp_prompt(&session, "hello").unwrap();

        // Live deltas stream first…
        let first = recv_event(&rx);
        assert!(matches!(first.event, ExecutorEvent::TextDelta { ref text } if text == "agent "));
        assert_eq!(first.thread_id, "thread-1");
        let second = recv_event(&rx);
        assert!(matches!(second.event, ExecutorEvent::TextDelta { ref text } if text == "reply"));
        // …then the assembled complete text (what persist() records)…
        let third = recv_event(&rx);
        assert!(matches!(third.event, ExecutorEvent::Text { ref text } if text == "agent reply"));
        // …then the turn closes.
        let fourth = recv_event(&rx);
        assert!(matches!(fourth.event, ExecutorEvent::Done));
        // The turn closed: busy cleared on the session's own flag.
        assert!(!session.is_busy());
    }

    /// RED→GREEN: a thread-chosen model is applied via set_config_option
    /// right after session/new.
    #[tokio::test(flavor = "multi_thread")]
    async fn bridge_applies_model_choice() {
        let (transport, fake, _agent) = fake_agent_pair();
        let (tx, _rx) = std::sync::mpsc::channel();
        let (_id, models, _cmds, _busy, _acp_id) = start_with_transport(
            transport,
            test_spawn(Some("model-b".into())),
            Arc::new(ChannelSink(tx)),
            false,
        )
        .unwrap();

        assert_eq!(models.current.as_deref(), Some("model-b"));
        assert_eq!(
            *fake.set_config_requests.lock().unwrap(),
            vec![("model".to_string(), "model-b".to_string())]
        );
    }

    /// RED→GREEN: a probe reports models and then lets the connection die.
    #[tokio::test(flavor = "multi_thread")]
    async fn probe_returns_models_without_a_session() {
        let (transport, _fake, agent) = fake_agent_pair();
        let (tx, _rx) = std::sync::mpsc::channel();
        let (_id, models, _cmds, _busy, _acp_id) =
            start_with_transport(transport, test_spawn(None), Arc::new(ChannelSink(tx)), true)
                .unwrap();
        assert_eq!(models.models.len(), 2);
        // The bridge returned, so the agent sees EOF and exits too.
        agent.await.unwrap();
    }

    /// RED→GREEN: extract_models handles a large ungrouped model list
    /// (matching real OpenCode responses with 59 models).
    #[test]
    fn extract_models_handles_large_ungrouped_list() {
        let models: Vec<v1::SessionConfigSelectOption> = (0..60)
            .map(|i| {
                v1::SessionConfigSelectOption::new(
                    format!("model-{i}"),
                    format!("Display Name {i}"),
                )
            })
            .collect();
        let option = v1::SessionConfigOption::new(
            "model",
            "Model",
            v1::SessionConfigKind::Select(
                v1::SessionConfigSelect::new("model-0", models),
            ),
        )
        .category(v1::SessionConfigOptionCategory::Model);
        let result = extract_models(&[option]);
        assert_eq!(result.config_id.as_deref(), Some("model"));
        assert_eq!(result.current.as_deref(), Some("model-0"));
        assert_eq!(result.models.len(), 60);
        assert_eq!(result.models[0].id, "model-0");
        assert_eq!(result.models[59].id, "model-59");
    }

    /// RED→GREEN: extract_models returns default when options is empty.
    #[test]
    fn extract_models_returns_default_on_empty() {
        let result = extract_models(&[]);
        assert_eq!(result.models.len(), 0);
        assert!(result.config_id.is_none());
        assert!(result.current.is_none());
    }
}
