//! ACP client wrapper and session lifecycle (D17).
//!
//! Drives a real ACP agent over stdio using the `agent-client-protocol` crate:
//! the async connection runs on a dedicated bridge thread; Palisade's sync side
//! talks to it through channels, and agent notifications arrive at the sync
//! `Sink` as `ExecutorEvent`s. `session/new`'s config options carry the
//! agent's model selector (category `model`), which is how Palisade learns which
//! models the agent actually offers.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use tokio::sync::oneshot;

use agent_client_protocol::schema::v1;
use agent_client_protocol::{self as acp, ConnectTo};
use agent_client_protocol::schema::ProtocolVersion;
use serde::{Deserialize, Serialize};

use crate::executor::{Envelope, ExecutorEvent, Sink};
use crate::permissions::{self, PermissionDecision, PermissionMode};
use crate::locks::MutexExt;
use crate::Res;

/// How long session startup (spawn + initialize + session/new) may take
/// before Palisade gives up. Cold npx installs can't happen — availability
/// filtering only lists cached packages — but first-run auth or slow
/// binaries still need headroom.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(90);

/// How long an interactive sign-in may take. Longer than startup on purpose:
/// the agent's own flow can send the user to a browser and wait for them.
const AUTH_TIMEOUT: Duration = Duration::from_secs(300);

/// Backoff before each retry of a `session/new` that failed with Claude
/// Code's transient OAuth-refresh-race `server_error` (see
/// `is_transient_server_error`). The per-agent spawn lock already prevents
/// This is intentionally not paired with a process-local mutex: other
/// Palisade instances and terminal agents share the provider credentials.
const SESSION_NEW_RETRY_DELAYS: [Duration; 3] = [Duration::from_secs(1), Duration::from_secs(3), Duration::from_secs(7)];

// ------------------------------------------------------------- models

/// The model id ACP agents use for their own recommended pick (Claude's
/// "Default (recommended)").
const AGENT_DEFAULT_MODEL_ID: &str = "default";

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
    /// The model value id a session runs on: the live selection, or — from a
    /// probe, which never switches — the one a new session would select.
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

// ------------------------------------------------------------ ACP auth

/// How a login is driven. ACP has two shapes, and an agent may advertise
/// either — offering only one is what made three of four installed agents look
/// like they had no login at all (#19).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentLoginKind {
    /// `type: "terminal"` — the client runs the agent's own login command.
    /// Deliberately not passed to the auth endpoints.
    Terminal,
    /// `type: "agent"` (the protocol's default) — the client calls
    /// `authenticate` with the method id and the agent runs its own flow.
    Protocol,
}

/// A login an agent says the *client* should run for it.
///
/// ACP's `terminal` auth methods work this way: the agent can't log itself in
/// over the protocol (its `authenticate` rejects them), it tells the client
/// what to run so the user can complete an interactive login. Palisade has a
/// terminal, so it runs this in one — no agent-specific knowledge, just the
/// method the agent advertised (#19).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentLogin {
    pub method_id: String,
    pub label: String,
    pub kind: AgentLoginKind,
    /// Empty for a `Protocol` login: there is nothing to run, the client
    /// calls `authenticate` with `method_id` instead.
    pub command: String,
    pub args: Vec<String>,
    /// Environment the agent asked for on this login. ACP: the client launches
    /// the agent program with the arguments *and environment variables* the
    /// method supplies — an agent whose login is gated behind one of these
    /// gets a broken login if they are dropped.
    pub env: Vec<(String, String)>,
}

impl AgentLogin {
    /// The command as one shell line, for writing into a PTY — environment
    /// assignments first, the way a shell applies them to one command.
    pub fn shell_line(&self) -> String {
        self.env
            .iter()
            .map(|(name, value)| format!("{name}={}", shell_quote(value)))
            .chain(std::iter::once(&self.command).chain(self.args.iter()).map(|w| shell_quote(w)))
            .collect::<Vec<_>>()
            .join(" ")
    }
}

/// Single-quote a word unless it is plainly safe bare. The words come from an
/// agent's own manifest, so they are not hostile input, but a path with a
/// space still has to survive reaching a shell intact.
fn shell_quote(word: &str) -> String {
    let safe = !word.is_empty()
        && word
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_./:@+=,".contains(c));
    if safe {
        word.to_string()
    } else {
        format!("'{}'", word.replace('\'', r"'\''"))
    }
}

/// What Palisade tells agents it can do.
///
/// `auth.terminal` is the reason any of this works: agents only advertise
/// their interactive logins when the client says it can run one. Sending no
/// capabilities at all — what Palisade did — means `initialize` comes back
/// with an empty `auth_methods` and there is no way to sign in from inside
/// the app, whatever the agent supports (#19). The `_meta` variant is the same
/// statement for agents that key off the extension rather than the (still
/// unstable) spec field, and buys a fully resolved command in return.
pub(crate) fn client_capabilities() -> v1::ClientCapabilities {
    let mut meta = serde_json::Map::new();
    meta.insert("terminal-auth".into(), serde_json::Value::Bool(true));
    v1::ClientCapabilities::new()
        .auth(v1::AuthCapabilities::new().terminal(true).meta(meta))
}

/// The advertised method `authenticate` may actually be called with.
///
/// ACP is explicit that a `terminal` method is out-of-band: the client runs it
/// and it "is not passed to the standard v1 or v2 authentication endpoints".
/// Calling `authenticate` with one is a protocol error the agent answers with
/// "method not implemented" — so the client must pick a protocol-driven method
/// or make no call at all (#19).
#[cfg(test)]
pub(crate) fn protocol_login_method(methods: &[v1::AuthMethod]) -> Option<v1::AuthMethodId> {
    methods
        .iter()
        .find(|method| !matches!(method, v1::AuthMethod::Terminal(_)))
        .map(|method| method.id().clone())
}

/// Every agent's advertised logins, keyed by agent id, as last seen at
/// `initialize`.
///
/// Process-global on purpose: the sign-in the user needs has to outlive the
/// session whose failure asked for it, and a session that hit an auth error is
/// torn down before the user can act on it.
static AGENT_LOGINS: std::sync::OnceLock<Mutex<HashMap<String, Vec<AgentLogin>>>> =
    std::sync::OnceLock::new();

fn agent_logins() -> &'static Mutex<HashMap<String, Vec<AgentLogin>>> {
    AGENT_LOGINS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) fn record_logins(agent_id: &str, logins: Vec<AgentLogin>) {
    agent_logins().lock_or_recover().insert(agent_id.to_string(), logins);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FailureClass { AuthRequired, TransientProvider, Other }

impl FailureClass {
    pub fn error_kind(self) -> crate::error::ErrorKind {
        match self {
            Self::AuthRequired => crate::error::ErrorKind::AuthRequired,
            Self::TransientProvider => crate::error::ErrorKind::TransientProvider,
            Self::Other => crate::error::ErrorKind::Unknown,
        }
    }
}

/// What the user can be offered to sign this agent in, or empty when the agent
/// advertised no client-runnable login (or has not been reached yet).
pub fn logins_for(agent_id: &str) -> Vec<AgentLogin> {
    agent_logins().lock_or_recover().get(agent_id).cloned().unwrap_or_default()
}

/// An advertised method's display name, falling back to its id.
fn login_label(method: &v1::AuthMethod) -> String {
    match method {
        v1::AuthMethod::Agent(agent) => agent.name.clone(),
        v1::AuthMethod::EnvVar(env) => env.name.clone(),
        v1::AuthMethod::Terminal(terminal) => terminal.name.clone(),
        _ => method.id().to_string(),
    }
}

/// The interactive logins an agent advertised, as commands Palisade can run.
///
/// `cmd`/`args` are how Palisade launched this agent; per ACP a terminal auth
/// method is the same binary with extra arguments, so the login command is the
/// launch plus the method's own args. An agent that resolved the command for
/// itself (the `terminal-auth` `_meta` extension) is taken at its word.
pub(crate) fn logins_from(
    methods: &[v1::AuthMethod],
    cmd: &str,
    args: &[String],
) -> Vec<AgentLogin> {
    methods
        .iter()
        .filter_map(|method| {
            // The protocol's default: the agent owns the flow and the client
            // starts it with `authenticate`.
            let terminal = match method {
                v1::AuthMethod::Terminal(terminal) => terminal,
                other => {
                    return Some(AgentLogin {
                        method_id: other.id().to_string(),
                        label: login_label(other),
                        kind: AgentLoginKind::Protocol,
                        command: String::new(),
                        args: Vec::new(),
                        env: Vec::new(),
                    })
                }
            };
            let resolved = terminal
                .meta
                .as_ref()
                .and_then(|m| m.get("terminal-auth"))
                .and_then(|m| m.as_object());
            let (command, login_args, label) = match resolved {
                Some(meta) => {
                    let command = meta.get("command").and_then(|c| c.as_str())?.to_string();
                    let login_args = meta
                        .get("args")
                        .and_then(|a| a.as_array())
                        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                        .unwrap_or_default();
                    let label = meta
                        .get("label")
                        .and_then(|l| l.as_str())
                        .unwrap_or(&terminal.name)
                        .to_string();
                    (command, login_args, label)
                }
                None => (
                    cmd.to_string(),
                    args.iter().cloned().chain(terminal.args.iter().cloned()).collect(),
                    terminal.name.clone(),
                ),
            };
            // Sorted so the command line a user sees is stable between runs;
            // the agent hands these over as an unordered map.
            let mut env: Vec<(String, String)> =
                terminal.env.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
            env.sort();
            Some(AgentLogin {
                method_id: terminal.id.to_string(),
                label,
                kind: AgentLoginKind::Terminal,
                command,
                args: login_args,
                env,
            })
        })
        .collect()
}


/// Whether an agent's error is ACP's "the client must authenticate" signal.
///
/// The protocol defines this as JSON-RPC code -32000 (`ErrorCode::AuthRequired`),
/// and the spec's examples also carry `data.reason == "auth_required"`. Both are
/// checked so this works for any compliant agent rather than one adapter's
/// wording; the prose check is a fallback for agents that only say it in text
/// (#19), not the contract.
pub(crate) fn is_auth_required(err: &acp::Error) -> bool {
    classify_acp_error(err) == FailureClass::AuthRequired
}

/// Structured ACP fields take precedence over error prose. In particular, a
/// provider's `server_error` is never upgraded to a login requirement merely
/// because its troubleshooting text says “sign in again”.
pub(crate) fn classify_acp_error(err: &acp::Error) -> FailureClass {
    if matches!(err.code, acp::ErrorCode::AuthRequired) { return FailureClass::AuthRequired; }
    if let Some(data) = err.data.as_ref().and_then(|value| value.as_object()) {
        if data.get("reason").and_then(|value| value.as_str()) == Some("auth_required") {
            return FailureClass::AuthRequired;
        }
        if let Some(kind) = data.get("errorKind").and_then(|value| value.as_str()) {
            return match kind {
                "authentication_failed" => FailureClass::AuthRequired,
                "server_error" => FailureClass::TransientProvider,
                _ => FailureClass::Other,
            };
        }
    }
    if reads_as_auth_failure(&err.to_string()) { FailureClass::AuthRequired } else { FailureClass::Other }
}

/// Whether `err` is Claude Code's known-transient OAuth-refresh race
/// (anthropics/claude-code#27933, #25609, #24317): the refresh token is
/// single-use, so a process that loses the race to another one gets this
/// `errorKind` rather than `authentication_failed`. Retryable, not a real
/// logout.
fn is_transient_server_error(err: &acp::Error) -> bool {
    classify_acp_error(err) == FailureClass::TransientProvider
}

/// Mirror of the frontend's `isAuthError` (src/errors.ts): agents report an
/// expired or missing login in prose, with no shared error code between them.
pub(crate) fn reads_as_auth_failure(text: &str) -> bool {
    let text = text.to_ascii_lowercase();
    // Claude Code's OAuth refresh token is single-use (anthropics/claude-code
    // #27933, #25609, #24317): two processes racing to refresh it produce
    // "errorKind: server_error" and a message that suggests "sign in again"
    // as a last resort, even though the agent itself calls this transient.
    // Without this guard the keyword scan below treats every such race as a
    // real logout.
    if text.contains("errorkind") && text.contains("server_error") {
        return false;
    }
    [
        "auth_required",
        "authenticate",
        "authentication",
        "unauthoriz",
        "not logged in",
        "log in",
        "login required",
        "sign in",
        "signed in",
        "session expired",
        "token expired",
        "credentials",
        "401",
    ]
    .iter()
    .any(|needle| text.contains(needle))
}

/// How Palisade actually launched this agent, e.g. `npx @scope/pkg` — the
/// thing the user has to sign in, which is not always the CLI of the same name.
pub(crate) fn launch_label(cmd: &str, args: &[String]) -> String {
    std::iter::once(cmd.to_string())
        .chain(args.iter().cloned())
        .collect::<Vec<_>>()
        .join(" ")
}

/// What to tell the user when an agent says it needs authentication.
///
/// Naming the launch command is the point (#19): an ACP adapter distributed as
/// an npm package holds its own login, so re-authenticating a CLI that happens
/// to share its name changes nothing the adapter reads.
pub(crate) fn auth_help(agent_name: &str, launch: &str, detail: &str) -> String {
    let mut help = format!(
        "{agent_name} needs to be signed in — {detail}. Palisade runs it as `{launch}`;          sign in for that agent, then retry"
    );
    if launch.starts_with("npx ") {
        help.push_str(
            ". This agent is an npm-distributed ACP adapter: it keeps its own login,              which is not necessarily the one a CLI of the same name wrote",
        );
    }
    help.push('.');
    help
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
    /// Tool calls awaiting the user's Allow/Deny/AllowSession decision.
    pending_permissions: PendingPermissions,
}

impl AcpSession {
    pub fn is_busy(&self) -> bool {
        self.busy.load(Ordering::SeqCst)
    }

    /// True while this session is blocked on an unanswered Allow/Deny
    /// prompt — reuses `pending_permissions` rather than tracking a
    /// separate flag (attention-routing D1).
    pub fn needs_attention(&self) -> bool {
        !self.pending_permissions.lock_or_recover().is_empty()
    }

    /// Resolve a pending permission request from outside the bridge thread
    /// (the `answer_permission_prompt` Tauri command). A missing id is a
    /// no-op success — already resolved, or the session is gone.
    pub fn answer_permission_prompt(&self, request_id: &str, answer: PermissionAnswer) {
        if let Some(tx) = self.pending_permissions.lock_or_recover().remove(request_id) {
            let _ = tx.send(answer);
        }
    }

    /// Terminate this session: tell the bridge to shut down, which closes the
    /// connection and kills the agent process tree. Fail-safe-to-deny (D-design-4):
    /// any tool call still awaiting the user's decision resolves as denied
    /// rather than left hanging or defaulting to allow.
    pub fn terminate(&mut self) {
        self.stopping.store(true, Ordering::SeqCst);
        if let Some(tx) = &self.cmd_tx {
            let _ = tx.send(BridgeCommand::Shutdown);
        }
        self.cmd_tx = None;
        self.busy.store(false, Ordering::SeqCst);
        for (_, tx) in self.pending_permissions.lock_or_recover().drain() {
            let _ = tx.send(PermissionAnswer::Deny);
        }
        active_commands_registry().lock_or_recover().remove(&self.id);
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
    pub extra_env: Vec<(String, String)>,
}

// ------------------------------------------------------------- bridge

/// Commands the sync side sends to the bridge thread.
pub(crate) enum BridgeCommand {
    Prompt(Prompt),
    Shutdown,
}

/// One turn as the agent receives it. The user's own words go out as the
/// *last* text block, after Palisade's context and any images: Claude Code
/// only expands a `/skill` natively when it leads the final text block
/// (probed on claude-agent-acp 0.79 — with the context prepended into the
/// same block, the model had to decide to load the skill itself).
#[derive(Debug, Clone, Default)]
pub(crate) struct Prompt {
    /// Palisade-authored instructions and handoff transcripts, in order.
    pub context: Vec<String>,
    pub images: Vec<PromptImage>,
    /// Skills picked in the composer tray (`tdd`, or `$tdd` for an agent
    /// with its own sigil). The first leads the user's text; see
    /// [`Prompt::user_text`].
    pub skills: Vec<String>,
    /// Threads the user's text mentions: title and transcript path. The
    /// agent is pointed at each transcript to read with its own tools;
    /// nothing is copied into the prompt.
    pub chats: Vec<(String, String)>,
    pub text: String,
}

/// The one place the tray's skills become prompt text. Stored turns keep
/// `skills` and `text` apart, so nothing ever has to parse this back.
const ALSO_USE: &str = "Also use these skills: ";

fn skill_trigger(name: &str) -> String {
    if name.starts_with(['/', '$']) { name.to_string() } else { format!("/{name}") }
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct PromptImage {
    /// The stored copy under the attachments dir — also the text fallback.
    pub path: String,
    pub mime_type: String,
    /// Base64.
    pub data: String,
}

impl Prompt {
    pub fn text(text: impl Into<String>) -> Self {
        Self { text: text.into(), ..Self::default() }
    }

    /// Everything joined as one string — what a text-only reader (tests,
    /// logs) sees. Not what goes on the wire; see [`Prompt::blocks`].
    #[cfg(test)]
    pub fn joined(&self) -> String {
        let mut parts = self.context.clone();
        parts.push(self.user_text());
        parts.join("\n\n")
    }

    /// The user's words with the tray's skills applied: the first skill
    /// leads, since an agent only runs a command that opens the turn, and
    /// the rest follow as a plain instruction — no agent runs two commands
    /// in one turn.
    fn user_text(&self) -> String {
        let mut text = match self.skills.split_first() {
            None => self.text.clone(),
            Some((first, rest)) => {
                let trigger = skill_trigger(first);
                let mut lead = if self.text.is_empty() { trigger } else { format!("{trigger} {}", self.text) };
                if !rest.is_empty() {
                    let names: Vec<&str> = rest.iter().map(|n| n.trim_start_matches(['/', '$'])).collect();
                    lead.push_str(&format!("\n\n{ALSO_USE}{}", names.join(", ")));
                }
                lead
            }
        };
        if !self.chats.is_empty() {
            text.push_str("\n\nReferenced chats (JSONL transcripts, one message per line):");
            for (title, path) in &self.chats {
                text.push_str(&format!("\n- {title} → {path}"));
            }
        }
        text
    }

    /// The wire form. An agent that never said it takes images gets their
    /// paths appended to the user's text instead, so the turn still carries
    /// them and the agent can open the files with its own tools.
    pub fn blocks(&self, images_supported: bool) -> Vec<v1::ContentBlock> {
        let mut blocks: Vec<v1::ContentBlock> = self
            .context
            .iter()
            .map(|c| v1::ContentBlock::Text(v1::TextContent::new(c.clone())))
            .collect();
        let mut text = self.user_text();
        if images_supported {
            blocks.extend(self.images.iter().map(|image| {
                v1::ContentBlock::Image(v1::ImageContent::new(
                    image.data.clone(),
                    image.mime_type.clone(),
                ))
            }));
        } else if !self.images.is_empty() {
            text.push_str("\n\nAttached images:");
            for image in &self.images {
                text.push_str(&format!("\n- {}", image.path));
            }
        }
        blocks.push(v1::ContentBlock::Text(v1::TextContent::new(text)));
        blocks
    }
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

/// The user's answer to a pending `Prompt`-tier permission request (D7b,
/// D-design-1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionAnswer {
    Allow,
    Deny,
    AllowSession,
}

impl PermissionAnswer {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "allow" => Some(Self::Allow),
            "deny" => Some(Self::Deny),
            "allow_session" => Some(Self::AllowSession),
            _ => None,
        }
    }
}

/// Requests awaiting the user's decision, keyed by a fresh id distinct from
/// `tool_call_id` (D-design-2). Lives on the session handle, shared with the
/// bridge task the same way `busy` already is, so `answer_permission_prompt`
/// (lib.rs) can resolve one from outside the bridge thread.
pub(crate) type PendingPermissions = Arc<Mutex<HashMap<String, oneshot::Sender<PermissionAnswer>>>>;

/// The last Execute-kind command each live session ran, keyed by session id
/// — shared across every bridge task the same way `pending_permissions`
/// already is (D-attention-routing-2), so a second session's permission
/// check can see what the first is doing in the same project.
#[derive(Debug, Clone)]
pub(crate) struct ActiveCommand {
    pub project_hash: String,
    pub command: String,
}
pub(crate) type ActiveCommands = Arc<Mutex<HashMap<String, ActiveCommand>>>;

/// One process-wide registry, shared by every session's bridge thread — all
/// sessions run in this same OS process, so a `OnceLock` static is simpler
/// than threading a new field through `AcpSpawn`/`Harness`/every call site
/// that already exists for `pending_permissions`.
static ACTIVE_COMMANDS: std::sync::OnceLock<ActiveCommands> = std::sync::OnceLock::new();
fn active_commands_registry() -> ActiveCommands {
    ACTIVE_COMMANDS
        .get_or_init(|| Arc::new(Mutex::new(HashMap::new())))
        .clone()
}

/// ponytail: literal-string/port match only — no shell parsing. Extracts
/// bare port-range numbers (1024-65535) appearing in the command text.
/// Upgrade to a real shell/arg parser if this produces repeated false
/// negatives users report (e.g. a port hidden behind a shell variable).
fn command_ports(command: &str) -> HashSet<u32> {
    let mut ports = HashSet::new();
    let mut digits = String::new();
    for ch in command.chars().chain(std::iter::once(' ')) {
        if ch.is_ascii_digit() {
            digits.push(ch);
            continue;
        }
        if let Ok(n) = digits.parse::<u32>() {
            if (1024..=65535).contains(&n) {
                ports.insert(n);
            }
        }
        digits.clear();
    }
    ports
}

/// ponytail: literal match on `DATABASE_URL=<value>` only — not a general
/// .env parser. Upgrade if users hit real collisions this misses.
fn command_database_url(command: &str) -> Option<&str> {
    let rest = command.split("DATABASE_URL=").nth(1)?;
    Some(rest.split_whitespace().next().unwrap_or(""))
        .filter(|v| !v.is_empty())
}

/// Compares one about-to-run command against every other session's last
/// command in the same project, and returns a warning to attach to the
/// permission prompt when they look like they'll collide. `None` when
/// nothing obviously conflicts — false negatives are fine here (see the
/// `ponytail:` notes on the two checks above), false positives that block
/// normal work are not.
fn conflict_warning(
    project_hash: &str,
    command: &str,
    self_session_id: &str,
    active: &HashMap<String, ActiveCommand>,
) -> Option<String> {
    let ports = command_ports(command);
    let db_url = command_database_url(command);
    for (other_id, other) in active {
        if other_id == self_session_id || other.project_hash != project_hash {
            continue;
        }
        let shared_ports: Vec<u32> = command_ports(&other.command)
            .into_iter()
            .filter(|p| ports.contains(p))
            .collect();
        if !shared_ports.is_empty() {
            return Some(format!(
                "Another session in this project is already running a command on port {} (`{}`).",
                shared_ports[0], other.command
            ));
        }
        if let (Some(a), Some(b)) = (db_url, command_database_url(&other.command)) {
            if a == b {
                return Some(format!(
                    "Another session in this project is already using DATABASE_URL={a} (`{}`).",
                    other.command
                ));
            }
        }
    }
    None
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ToolOutputShape {
    Unknown,
    Cumulative,
    Tail,
}

#[derive(Debug)]
struct ToolOutputStream {
    previous: String,
    complete: String,
    shape: ToolOutputShape,
}

/// Merge a tool-content update without dropping valid tail chunks. A strict
/// extension proves the cumulative shape; a non-prefix or exact repeat is
/// treated as tail output because both can contain real repeated bytes.
fn dedup_tool_output(
    seen: &mut HashMap<String, ToolOutputStream>,
    id: &str,
    chunk: &str,
) -> String {
    let Some(stream) = seen.get_mut(id) else {
        seen.insert(
            id.to_string(),
            ToolOutputStream {
                previous: chunk.to_string(),
                complete: chunk.to_string(),
                shape: ToolOutputShape::Unknown,
            },
        );
        return chunk.to_string();
    };

    let emitted = match stream.shape {
        ToolOutputShape::Tail => chunk.to_string(),
        ToolOutputShape::Cumulative if chunk.starts_with(&stream.previous) => {
            chunk[stream.previous.len()..].to_string()
        }
        ToolOutputShape::Cumulative => {
            stream.shape = ToolOutputShape::Tail;
            chunk.to_string()
        }
        ToolOutputShape::Unknown
            if chunk.len() > stream.previous.len() && chunk.starts_with(&stream.previous) =>
        {
            stream.shape = ToolOutputShape::Cumulative;
            chunk[stream.previous.len()..].to_string()
        }
        ToolOutputShape::Unknown => {
            stream.shape = ToolOutputShape::Tail;
            chunk.to_string()
        }
    };
    if stream.shape == ToolOutputShape::Cumulative {
        stream.complete = chunk.to_string();
    } else {
        stream.complete.push_str(chunk);
    }
    stream.previous = chunk.to_string();
    emitted
}

/// Resolve a terminal update against the most recent content snapshot. ACP
/// update fields are partial, so a status-only `Completed`/`Failed` update
/// leaves the prior content unchanged rather than clearing it.
fn complete_tool_output(
    seen: &mut HashMap<String, ToolOutputStream>,
    id: &str,
    final_output: &str,
) -> String {
    let streamed = seen
        .remove(id)
        .map(|stream| stream.complete)
        .unwrap_or_default();
    if final_output.is_empty() {
        streamed
    } else {
        final_output.to_string()
    }
}

/// Answer an agent permission request according to the session's mode
/// policy (D12, D15). `Prompt` pauses the turn on a oneshot channel until
/// the user answers via `answer_permission_prompt` (D7, D-design-1); a kind
/// already in `session_allowed` (an earlier "allow for rest of session")
/// auto-allows without registering a new pending entry (D-design-3).
#[allow(clippy::too_many_arguments)]
async fn answer_permission(
    request: &v1::RequestPermissionRequest,
    mode: PermissionMode,
    session_allowed: &Mutex<HashSet<permissions::ToolKind>>,
    pending: &PendingPermissions,
    sink: &Arc<dyn Sink>,
    session_id: &str,
    thread_id: &str,
    project_hash: &str,
    active_commands: &ActiveCommands,
) -> v1::RequestPermissionResponse {
    let kind = tool_kind(request.tool_call.fields.kind.as_ref());
    let command = raw_command(request.tool_call.fields.raw_input.as_ref());
    let paths = tool_call_paths(
        location_paths_opt(&request.tool_call.fields.locations),
        request.tool_call.fields.content.as_deref().unwrap_or(&[]),
        request.tool_call.fields.raw_input.as_ref(),
    );

    // Port/DB-env collision check (attention-routing D2): only meaningful
    // for shell commands, and only ever escalates to a warning — it never
    // denies on its own, the mode policy below still decides that.
    let conflict = if kind == permissions::ToolKind::Execute {
        command.as_deref().and_then(|cmd| {
            let warning = {
                let mut active = active_commands.lock_or_recover();
                active.insert(
                    session_id.to_string(),
                    ActiveCommand { project_hash: project_hash.to_string(), command: cmd.to_string() },
                );
                conflict_warning(project_hash, cmd, session_id, &active)
            };
            warning
        })
    } else {
        None
    };

    let decision = if session_allowed.lock_or_recover().contains(&kind) {
        PermissionDecision::Allow
    } else {
        let path_refs: Vec<&str> = paths.iter().map(|s| s.as_str()).collect();
        permissions::decide_permission(mode, kind, command.as_deref(), &path_refs)
    };
    // A detected conflict always surfaces the prompt, even under a policy
    // that would otherwise auto-allow — the whole point is the user sees it
    // before two sessions collide.
    let decision = if conflict.is_some() && decision == PermissionDecision::Allow {
        PermissionDecision::Prompt
    } else {
        decision
    };

    let answer = match decision {
        PermissionDecision::Allow => PermissionAnswer::Allow,
        PermissionDecision::Deny => PermissionAnswer::Deny,
        PermissionDecision::Prompt => {
            let request_id = ulid::Ulid::new().to_string();
            let (tx, rx) = oneshot::channel();
            pending.lock_or_recover().insert(request_id.clone(), tx);
            emit(
                sink,
                session_id,
                thread_id,
                ExecutorEvent::PermissionRequest {
                    id: request_id,
                    tool_call_id: request.tool_call.tool_call_id.to_string(),
                    tool_kind: kind.as_str().to_string(),
                    command: command.clone(),
                    paths: paths.clone(),
                    warning: conflict.clone(),
                },
            );
            // A dropped sender (session torn down while awaiting) resolves
            // to Deny rather than leaving this hanging.
            rx.await.unwrap_or(PermissionAnswer::Deny)
        }
    };

    if answer == PermissionAnswer::AllowSession {
        session_allowed.lock_or_recover().insert(kind);
    }

    match answer {
        PermissionAnswer::Allow | PermissionAnswer::AllowSession => {
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
        PermissionAnswer::Deny => {
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
                .lock_or_recover()
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
                    .lock_or_recover()
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
#[allow(clippy::too_many_arguments)]
async fn run_bridge(
    transport: impl ConnectTo<acp::Client>,
    spawn: AcpSpawn,
    palisade_session_id: String,
    sink: Arc<dyn Sink>,
    busy: Arc<AtomicBool>,
    pending_permissions: PendingPermissions,
    active_commands: ActiveCommands,
    ready_tx: mpsc::Sender<Result<ReadyReport, crate::PalisadeError>>,
    mut cmd_rx: tokio::sync::mpsc::UnboundedReceiver<BridgeCommand>,
    probe_only: bool,
    // Set to run one `authenticate` for this method and stop — the sign-in
    // path for an agent whose login the protocol drives (#19).
    auth_only: Option<String>,
) -> Res<()> {
    let notif_sink = sink.clone();
    let notif_session = palisade_session_id.clone();
    let notif_thread = spawn.thread_id.clone();
    let perm_mode = permission_mode(&spawn.mode, spawn.bypass);
    // "Allow for rest of session" (D7b) — scoped to this bridge task's
    // lifetime, so it needs no explicit cleanup on teardown (D-design-3).
    let session_allowed: Arc<Mutex<HashSet<permissions::ToolKind>>> =
        Arc::new(Mutex::new(HashSet::new()));
    let perm_sink = sink.clone();
    let perm_session = palisade_session_id.clone();
    let perm_thread = spawn.thread_id.clone();
    let perm_pending = pending_permissions.clone();
    let perm_project = spawn.project_hash.clone();
    let perm_active_commands = active_commands.clone();
    // ACP streams chunks; there is no complete-text event at turn end.
    // Accumulate text/thought chunks per turn so the prompt response can
    // emit the assembled `Text`/`Reasoning` events that persist() writes
    // to the thread log.
    let text_buf = Arc::new(std::sync::Mutex::new(String::new()));
    let think_buf = Arc::new(std::sync::Mutex::new(String::new()));
    // When `think_buf` first goes non-empty for a turn — the "Thought for
    // Ns" start instant (reasoning-collapse-ux D-design-2). `None` between
    // turns and while a turn has produced no reasoning yet.
    let think_started: Arc<std::sync::Mutex<Option<std::time::Instant>>> =
        Arc::new(std::sync::Mutex::new(None));
    let notif_text = text_buf.clone();
    let notif_think = think_buf.clone();
    let notif_think_started = think_started.clone();
    // Whether the current turn has already been cancelled for a Spec-mode
    // violation. Prevents double-cancellation when multiple write tool calls
    // arrive in the same turn.
    let cancelled = Arc::new(AtomicBool::new(false));
    let notif_cancelled = cancelled.clone();
    // Tool kinds by call id, so a `ToolCallUpdate` that omits `kind` is still
    // judged by the write guard (see `write_guard_input`).
    let notif_kinds =
        Arc::new(std::sync::Mutex::new(HashMap::<String, permissions::ToolKind>::new()));
    // File edits already emitted this session, keyed by call + path + body.
    // An agent that repeats a diff on every status change would otherwise
    // stack a duplicate diff block in the transcript for each repeat.
    let notif_edits = Arc::new(std::sync::Mutex::new(std::collections::HashSet::<String>::new()));
    // Live tool-output text already streamed per tool call id, so a
    // cumulative-output agent doesn't double-print its own history on every
    // `InProgress` update (`dedup_tool_output`). Cleared
    // when the tool call completes — nothing more to de-dup against.
    let notif_tool_output =
        Arc::new(std::sync::Mutex::new(HashMap::<String, ToolOutputStream>::new()));
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
                            notif_text.lock_or_recover().clear();
                            notif_think.lock_or_recover().clear();
                            *notif_think_started.lock_or_recover() = None;
                            emit(
                                &notif_sink,
                                &notif_session,
                                &notif_thread,
                                // A policy cancellation, not a death: the
                                // agent is still connected (#18).
                                ExecutorEvent::turn_failed(reason),
                            );
                            return Ok(());
                        }
                    }
                }
                // File edits ride on tool calls as `diff` blocks, which
                // `from_session_update` does not carry — they are pulled off
                // the raw update so chat shows the code as it changes.
                for event in crate::acp_events::file_edits(&notification.update) {
                    if let ExecutorEvent::FileEdit { id, path, after, .. } = &event {
                        let key = format!("{id}\0{path}\0{after}");
                        if !notif_edits.lock_or_recover().insert(key) {
                            continue;
                        }
                    }
                    emit(&notif_sink, &notif_session, &notif_thread, event);
                }
                if let Some(mut update) =
                    crate::acp_events::from_session_update(&notification.update)
                {
                    match &mut update {
                        crate::acp_events::AcpUpdate::TextDelta { text } => {
                            notif_text.lock_or_recover().push_str(text)
                        }
                        crate::acp_events::AcpUpdate::ReasoningDelta { text } => {
                            let mut buf = notif_think.lock_or_recover();
                            if buf.is_empty() {
                                *notif_think_started.lock_or_recover() = Some(std::time::Instant::now());
                            }
                            buf.push_str(text);
                        }
                        // Cumulative-output agents resend everything so far
                        // on every `InProgress` update; strip what was
                        // already streamed so the live view doesn't
                        // double-print (`dedup_tool_output`).
                        crate::acp_events::AcpUpdate::ToolOutputDelta { id, chunk } => {
                            *chunk = dedup_tool_output(
                                &mut notif_tool_output.lock_or_recover(),
                                id,
                                chunk,
                            );
                        }
                        // A terminal status can omit unchanged content. Keep
                        // the last streamed snapshot in that case, then clear
                        // the call's tracking state.
                        crate::acp_events::AcpUpdate::ToolResult {
                            id, output, ..
                        } => {
                            *output = complete_tool_output(
                                &mut notif_tool_output.lock_or_recover(),
                                id,
                                output,
                            );
                        }
                        _ => {}
                    }
                    if let Some(commands) = crate::acp_events::extract_commands(&update) {
                        notif_sink.emit_commands(&notif_session, &notif_thread, commands);
                    }
                    // Usage is not an ExecutorEvent — the transcript event
                    // enum is intentionally capped — but an active chain
                    // turn needs ACP's optional billed cost. The app sink
                    // finds the watcher for this session and keeps the most
                    // recent cumulative amount (D-d).
                    if let Some((_used, _size, cost)) = crate::acp_events::extract_usage(&update) {
                        notif_sink.emit_usage(&notif_session, &notif_thread, cost);
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
            async move |request: v1::RequestPermissionRequest, responder, cx| {
                // Awaiting the user here would hold the dispatch loop open
                // for the entire time the Allow/Deny prompt is on screen —
                // the crate is explicit that "no other messages are
                // processed while your callback runs", which froze every
                // session behind one open prompt. `cx.spawn` moves the wait
                // outside the loop; each capture is cloned rather than moved
                // because this handler runs again for the next prompt.
                let session_allowed = session_allowed.clone();
                let perm_pending = perm_pending.clone();
                let perm_sink = perm_sink.clone();
                let perm_session = perm_session.clone();
                let perm_thread = perm_thread.clone();
                let perm_project = perm_project.clone();
                let perm_active_commands = perm_active_commands.clone();
                cx.spawn(async move {
                    let response = answer_permission(
                        &request,
                        perm_mode,
                        &session_allowed,
                        &perm_pending,
                        &perm_sink,
                        &perm_session,
                        &perm_thread,
                        &perm_project,
                        &perm_active_commands,
                    )
                    .await;
                    responder.respond(response)
                })
            },
            acp::on_receive_request!(),
        )
        .connect_with(transport, async move |cx| {
            let init_response = cx
                .send_request(
                    v1::InitializeRequest::new(ProtocolVersion::V1)
                        .client_capabilities(client_capabilities()),
                )
                .block_task()
                .await
                .map_err(|e| acp::Error::internal_error().data(format!("initialize failed: {e}")))?;

            // Remember any interactive login this agent offers, so a later auth
            // failure can hand the user a sign-in they can actually click (#19).
            record_logins(
                &spawn.agent_id,
                logins_from(&init_response.auth_methods, &spawn.cmd, &spawn.args),
            );

            // Authentication is intentionally not attempted during startup.
            // `session/new` is the ACP authority for whether this connection
            // needs a credential; only an explicit user choice may select an
            // advertised protocol method. Terminal methods remain out of band.
            // An explicit sign-in: run exactly the method the user chose and
            // report how it went. No session follows — the agent keeps its own
            // credentials, and the next turn starts a fresh handshake.
            if let Some(method_id) = &auth_only {
                let creds = lookup_agent_credentials(&spawn.agent_id, method_id);
                let mut req =
                    v1::AuthenticateRequest::new(v1::AuthMethodId::new(method_id.as_str()));
                if let Some(meta) = creds {
                    req = req.meta(meta);
                }
                let outcome = cx.send_request(req).block_task().await;
                let _ = ready_tx.send(match outcome {
                    Ok(_) => Ok(ReadyReport {
                        acp_session_id: String::new(),
                        models: ModelState::default(),
                    }),
                    Err(e) => Err(crate::PalisadeError::new(classify_acp_error(&e).error_kind(), e.to_string())),
                });
                return Ok(());
            }
            // The project's MCP servers, handed over the protocol rather than
            // left for the agent to find. `.mcp.json` is a Claude-shaped file;
            // passing the same list here is what makes those servers reach
            // Codex and every other agent without Palisade learning a second
            // config format per agent. Remote transports are filtered by what
            // this agent actually said it supports.
            let images_supported = init_response.agent_capabilities.prompt_capabilities.image;
            let mcp = &init_response.agent_capabilities.mcp_capabilities;
            let mcp_servers =
                crate::mcp::for_session(&spawn.project_root, mcp.http, mcp.sse);

            let launch = launch_label(&spawn.cmd, &spawn.args);
            let new_request = || {
                v1::NewSessionRequest::new(spawn.project_root.clone())
                    .mcp_servers(mcp_servers.clone())
            };
            let mut started = cx.send_request(new_request()).block_task().await;
            for delay in SESSION_NEW_RETRY_DELAYS {
                match &started {
                    Err(e) if is_transient_server_error(e) => {
                        tokio::time::sleep(delay).await;
                        started = cx.send_request(new_request()).block_task().await;
                    }
                    _ => break,
                }
            }
            // Authentication is demand-driven. Picking the first advertised
            // method here was both surprising (Codex advertises API-key before
            // ChatGPT) and could launch a sign-in while merely opening a
            // thread. Surface `auth_required` to the UI instead; the user
            // chooses a method and a later retry creates the session.
            let new_session = match started {
                Ok(session) => session,
                Err(e) => {
                    let failure_class = classify_acp_error(&e);
                    let detail = if failure_class == FailureClass::AuthRequired {
                        auth_help(&spawn.agent_name, &launch, &e.to_string())
                    } else {
                        format!("session/new failed: {e}")
                    };
                    let _ = ready_tx.send(Err(crate::PalisadeError::new(failure_class.error_kind(), detail)));
                    return Ok(());
                }
            };

            let session_id = new_session.session_id;
            let mut models = extract_models(new_session.config_options.as_deref().unwrap_or(&[]));

            // Apply the thread's model choice when the agent offers it. No
            // choice means the agent's recommended model, not whatever it
            // boots on: claude-acp boots on the user's ~/.claude settings
            // pin, which can be a credits-only model nobody picked for this
            // thread. A probe never switches, but it reports what a session
            // would run, so a picker defaults to the same model.
            let want = spawn.model.as_deref().unwrap_or(AGENT_DEFAULT_MODEL_ID);
            let offered = models.models.iter().any(|m| m.id == want);
            if offered && probe_only {
                models.current = Some(want.to_string());
            } else if offered && models.current.as_deref() != Some(want) {
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

            let ready = ready_tx.send(Ok(ReadyReport {
                acp_session_id: session_id.to_string(),
                models,
            }));
            if !probe_only {
                sink.emit_image_support(&palisade_session_id, &spawn.thread_id, images_supported);
            }
            if ready.is_err() || probe_only {
                // Caller gave up waiting, or this was just a model probe.
                return Ok(());
            }

            loop {
                tokio::select! {
                    cmd = cmd_rx.recv() => {
                        match cmd {
                            Some(BridgeCommand::Prompt(prompt)) => {
                                let done_sink = sink.clone();
                                let done_session = palisade_session_id.clone();
                                let done_thread = spawn.thread_id.clone();
                                let done_busy = busy.clone();
                                let done_text = text_buf.clone();
                                let done_think = think_buf.clone();
                                let done_think_started = think_started.clone();
                                let done_cancelled = cancelled.clone();
                                let done_agent = spawn.agent_name.clone();
                                let done_launch = launch.clone();
                                // Reset the per-turn cancellation flag.
                                cancelled.store(false, Ordering::SeqCst);
                                let send = cx.send_request(v1::PromptRequest::new(
                                    session_id.clone(),
                                    prompt.blocks(images_supported),
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
                                    let full = std::mem::take(&mut *done_text.lock_or_recover());
                                    if !full.trim().is_empty() {
                                        emit(&done_sink, &done_session, &done_thread, ExecutorEvent::Text { text: full });
                                    }
                                    let thought = std::mem::take(&mut *done_think.lock_or_recover());
                                    let started = done_think_started.lock_or_recover().take();
                                    if !thought.trim().is_empty() {
                                        let elapsed_secs = started
                                            .map(|s| s.elapsed().as_secs())
                                            .unwrap_or(0);
                                        emit(&done_sink, &done_session, &done_thread, ExecutorEvent::Reasoning { text: thought, elapsed_secs });
                                    }
                                    match result {
                                        Ok(_) => emit(&done_sink, &done_session, &done_thread, ExecutorEvent::Done),
                                        // The turn failed, the agent did not
                                        // die: an expired login or a rejected
                                        // prompt is retryable, and must not
                                        // reset the thread's mode (#18). An
                                        // auth failure gets the message that
                                        // names what to sign in (#19) — the
                                        // retry then re-runs the handshake,
                                        // which is where `authenticate` is
                                        // called.
                                        Err(e) => {
                                            let failure_class = classify_acp_error(&e);
                                            let message = if failure_class == FailureClass::AuthRequired {
                                                auth_help(&done_agent, &done_launch, &e.to_string())
                                            } else {
                                                format!("prompt failed: {e}")
                                            };
                                            emit(&done_sink, &done_session, &done_thread,
                                                ExecutorEvent::turn_failed_classified(message, Some(failure_class)))
                                        }
                                    }
                                    Ok(())
                                }) {
                                    busy.store(false, Ordering::SeqCst);
                                    // Couldn't even dispatch the request —
                                    // the connection is gone.
                                    emit(&sink, &palisade_session_id, &spawn.thread_id,
                                        ExecutorEvent::agent_died(None, format!("prompt send failed: {e}")));
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
            if tail_ready_tx.send(Err(crate::PalisadeError::from(message.clone()))).is_err() {
                emit(
                    &tail_sink,
                    &tail_session,
                    &tail_thread,
                    ExecutorEvent::agent_died(None, message.clone()),
                );
            }
            Err(message.into())
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
    auth_only: Option<String>,
) -> Result<
    (
        String,
        ModelState,
        tokio::sync::mpsc::UnboundedSender<BridgeCommand>,
        Arc<AtomicBool>,
        String,
        PendingPermissions,
    ),
    crate::PalisadeError,
> {
    // Held for this whole function: blocks a second spawn of the same agent
    // from starting its handshake until this one is ready or has failed, so
    // the two never race to refresh the same OAuth token.
    let palisade_session_id = ulid::Ulid::new().to_string();
    let busy = Arc::new(AtomicBool::new(false));
    let bridge_busy = busy.clone();
    let pending_permissions: PendingPermissions = Arc::new(Mutex::new(HashMap::new()));
    let bridge_pending = pending_permissions.clone();
    let (ready_tx, ready_rx) = mpsc::channel::<Result<ReadyReport, crate::PalisadeError>>();
    let (cmd_tx, cmd_rx) = tokio::sync::mpsc::unbounded_channel::<BridgeCommand>();

    let thread_session = palisade_session_id.clone();
    let auth_only_for_bridge = auth_only.clone();
    std::thread::spawn(move || {
        let runtime = match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(rt) => rt,
            Err(e) => {
                let _ = ready_tx.send(Err(crate::PalisadeError::from(format!("tokio runtime: {e}"))));
                return;
            }
        };
        let _ = runtime.block_on(run_bridge(
            transport,
            spawn,
            thread_session,
            sink,
            bridge_busy,
            bridge_pending,
            active_commands_registry(),
            ready_tx,
            cmd_rx,
            probe_only,
            auth_only_for_bridge,
        ));
    });

    // A sign-in waits on a person — a browser round trip, a pasted code — so
    // it gets its own deadline rather than the handshake's.
    let deadline = if auth_only.is_some() { AUTH_TIMEOUT } else { STARTUP_TIMEOUT };
    match ready_rx.recv_timeout(deadline) {
        Ok(Ok(report)) => Ok((
            palisade_session_id,
            report.models,
            cmd_tx,
            busy,
            report.acp_session_id,
            pending_permissions,
        )),
        Ok(Err(e)) => Err(e),
        Err(_) => Err(format!("agent did not answer within {deadline:?}").into()),
    }
}

/// Start an ACP session on a background bridge thread.
///
/// Spawns the agent process, connects over stdio, completes the initialize
/// handshake, creates a session (applying the thread's model choice), and
/// bridges notifications to the sync `Sink`. Blocks until the session is
/// ready or startup fails.
pub fn start_acp_session(spawn: AcpSpawn, sink: Arc<dyn Sink>) -> Res<AcpSession> {
    let agent = agent_config(&spawn);
    let identity = SessionIdentity::from(&spawn);
    let (id, models, cmd_tx, busy, acp_session_id, pending_permissions) =
        start_with_transport(agent, spawn, sink, false, None)?;
    let mut session = identity.into_session(id, models, cmd_tx, busy, pending_permissions);
    session.acp_session_id = Some(acp_session_id);
    Ok(session)
}

/// Spawn an agent just long enough to learn its model selector, then drop
/// the connection (which kills the process). Used to populate the model
/// menu for a provider without opening a thread session.
pub fn probe_models(
    agent_id: String,
    cmd: String,
    bin: PathBuf,
    args: Vec<String>,
    project_root: PathBuf,
) -> Res<ModelState> {
    let spawn = AcpSpawn {
        // Named, not blank: the probe completes a real `initialize`, which is
        // where an agent's advertised logins are learned — recording them
        // under an empty id would throw that away (#19).
        agent_id,
        agent_name: String::new(),
        bin,
        cmd,
        args,
        project_root,
        project_hash: String::new(),
        thread_id: String::new(),
        mode: "spec".into(),
        bypass: false,
        model: None,
        palisade_home: PathBuf::new(),
        extra_env: vec![],
    };
    let agent = agent_config(&spawn);
    let (_id, models, _cmd_tx, _busy, _acp_id, _pending) =
        start_with_transport(agent, spawn, Arc::new(NullSink), true, None)?;
    Ok(models)
}

/// Run one advertised login against an agent and report how it went.
///
/// This is the protocol half of signing in: for a `type: "agent"` method the
/// client calls `authenticate` and the agent runs its own flow (an OAuth
/// round trip, a key exchange). No session is created — the agent keeps the
/// credential itself, and the next turn starts a fresh handshake that finds
/// it. Every agent probed advertises one of these or a terminal login, so
/// between the two there is a sign-in for each of them (#19).
pub fn authenticate_agent(
    agent_id: String,
    cmd: String,
    bin: PathBuf,
    args: Vec<String>,
    project_root: PathBuf,
    method_id: String,
) -> Res<()> {
    let spawn = AcpSpawn {
        agent_id,
        agent_name: String::new(),
        bin,
        cmd,
        args,
        project_root,
        project_hash: String::new(),
        thread_id: String::new(),
        mode: "spec".into(),
        bypass: false,
        model: None,
        palisade_home: PathBuf::new(),
        extra_env: vec![],
    };
    let agent = agent_config(&spawn);
    start_with_transport(agent, spawn, Arc::new(NullSink), false, Some(method_id))?;
    Ok(())
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
        self.0.lock_or_recover().accept(&envelope.event);
    }
}

/// Run one prompt on a throwaway session and return the assistant's reply.
///
/// The session is terminated either way — this is not a thread the user can
/// see or resume, so leaving it live would leak a child process per click.
pub fn agent_oneshot(spawn: AcpSpawn, prompt: &str, timeout: Duration) -> Res<String> {
    let collected = Arc::new(Mutex::new(Collected::default()));
    let sink = Arc::new(CollectingSink(collected.clone()));
    let agent = agent_config(&spawn);
    let (_id, models, cmd_tx, busy, _acp_id, _pending) =
        start_with_transport(agent, spawn, sink, false, None)?;
    let _ = models;

    busy.store(true, Ordering::SeqCst);
    cmd_tx
        .send(BridgeCommand::Prompt(Prompt::text(prompt)))
        .map_err(|_| crate::PalisadeError::from("agent connection is closed"))?;

    let deadline = std::time::Instant::now() + timeout;
    loop {
        if collected.lock_or_recover().finished {
            break;
        }
        if std::time::Instant::now() >= deadline {
            let _ = cmd_tx.send(BridgeCommand::Shutdown);
            return Err("agent did not answer in time".into());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let _ = cmd_tx.send(BridgeCommand::Shutdown);

    let collected = collected.lock_or_recover();
    if let Some(error) = &collected.error {
        return Err(error.clone().into());
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
        pending_permissions: PendingPermissions,
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
            pending_permissions,
        }
    }
}

/// Send a user message to a live ACP session. The prompt response arrives
/// on the bridge thread, which emits `Done` (or `Crashed`) and clears busy.
/// `prompt` carries the user's own turn; Palisade's instructions and any
/// parked handoff `prefix` are put ahead of it here.
pub fn send_acp_prompt(session: &AcpSession, prefix: Option<&str>, mut prompt: Prompt) -> Res<()> {
    if session.is_busy() {
        return Err("executor is mid-turn".into());
    }
    let tx = session.cmd_tx.as_ref().ok_or("session is shut down")?;
    session.busy.store(true, Ordering::SeqCst);
    // Shared by all registry agents, including resumed and handoff sessions.
    // Bundled prompt instructions need no agent-specific installation or writes
    // into the user's project. One-shot metadata requests bypass this path.
    let preview = include_str!("../skills/palisade-preview.md");
    let mut context = vec![preview.to_string()];
    context.extend(prefix.map(str::to_string));
    context.append(&mut prompt.context);
    prompt.context = context;
    tx.send(BridgeCommand::Prompt(prompt))
        .map_err(|_| crate::PalisadeError::from("agent connection is closed"))
}

fn agent_config(spawn: &AcpSpawn) -> acp::AcpAgent {
    let mut config = acp::AcpAgentConfig::new(spawn.bin.clone());
    config = config.args(spawn.args.iter().cloned());
    // A GUI-launched Palisade inherits launchd's minimal PATH; the agent (and
    // anything it shells out to) needs the user's real one.
    if let Some(path) = crate::executor::login_shell_path() {
        config = config.env("PATH", path.to_string_lossy().into_owned());
    }
    for (key, value) in &spawn.extra_env {
        config = config.env(key.clone(), value.clone());
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
            pending_permissions: Arc::new(Mutex::new(HashMap::new())),
        },
        cmd_rx,
    )
}

// ------------------------------------------------------------------ tests

#[cfg(test)]
mod tests {
    use crate::locks::MutexExt;
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
        collected.accept(&ExecutorEvent::Reasoning { text: "thinking".into(), elapsed_secs: 0 });
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
        collected.accept(&ExecutorEvent::agent_died(Some(1), "agent exited".into()));

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
                v1::SessionConfigSelectOption::new("default", "Default"),
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
                ModelInfo { id: "default".into(), name: "Default".into() },
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

    // --------------------------------------------------------- port/db conflict detection

    /// RED→GREEN: two sessions in the same project running dev servers on
    /// the same literal port number trigger a conflict warning.
    #[test]
    fn conflict_warning_flags_same_port_same_project() {
        let mut active = HashMap::new();
        active.insert(
            "sess-a".to_string(),
            ActiveCommand { project_hash: "proj-1".into(), command: "npm run dev -- --port 3000".into() },
        );
        let warning = conflict_warning("proj-1", "npm run dev -- --port 3000", "sess-b", &active);
        assert!(warning.is_some());
        assert!(warning.unwrap().contains("3000"));
    }

    /// RED→GREEN: same port, but the other session is in a different
    /// project — no warning, worktrees already isolate that.
    #[test]
    fn conflict_warning_ignores_same_port_different_project() {
        let mut active = HashMap::new();
        active.insert(
            "sess-a".to_string(),
            ActiveCommand { project_hash: "proj-1".into(), command: "npm run dev -- --port 3000".into() },
        );
        assert!(conflict_warning("proj-2", "npm run dev -- --port 3000", "sess-b", &active).is_none());
    }

    /// RED→GREEN: non-conflicting ports in the same project pass through.
    #[test]
    fn conflict_warning_ignores_different_ports_same_project() {
        let mut active = HashMap::new();
        active.insert(
            "sess-a".to_string(),
            ActiveCommand { project_hash: "proj-1".into(), command: "npm run dev -- --port 3000".into() },
        );
        assert!(conflict_warning("proj-1", "npm run dev -- --port 4000", "sess-b", &active).is_none());
    }

    /// RED→GREEN: a session never compares against its own recorded command.
    #[test]
    fn conflict_warning_ignores_self() {
        let mut active = HashMap::new();
        active.insert(
            "sess-a".to_string(),
            ActiveCommand { project_hash: "proj-1".into(), command: "npm run dev -- --port 3000".into() },
        );
        assert!(conflict_warning("proj-1", "npm run dev -- --port 3000", "sess-a", &active).is_none());
    }

    /// RED→GREEN: the DB-env-var case is its own, separately tested path —
    /// two sessions pointed at the same DATABASE_URL in the same project.
    #[test]
    fn conflict_warning_flags_same_database_url_same_project() {
        let mut active = HashMap::new();
        active.insert(
            "sess-a".to_string(),
            ActiveCommand {
                project_hash: "proj-1".into(),
                command: "DATABASE_URL=postgres://localhost/app npm run migrate".into(),
            },
        );
        let warning = conflict_warning(
            "proj-1",
            "DATABASE_URL=postgres://localhost/app npm test",
            "sess-b",
            &active,
        );
        assert!(warning.is_some());
        assert!(warning.unwrap().contains("postgres://localhost/app"));
    }

    /// RED→GREEN: different DATABASE_URL values in the same project don't
    /// warn — only a literal match does (ponytail ceiling).
    #[test]
    fn conflict_warning_ignores_different_database_urls() {
        let mut active = HashMap::new();
        active.insert(
            "sess-a".to_string(),
            ActiveCommand {
                project_hash: "proj-1".into(),
                command: "DATABASE_URL=postgres://localhost/app_a npm run migrate".into(),
            },
        );
        assert!(conflict_warning(
            "proj-1",
            "DATABASE_URL=postgres://localhost/app_b npm test",
            "sess-b",
            &active,
        )
        .is_none());
    }

    // --------------------------------------------------------- tool output dedup

    /// RED→GREEN: an agent that resends the full accumulated output on every
    /// `InProgress` update must still stream just the new suffix each time —
    /// "one" then "two", not "one" then "onetwo".
    #[test]
    fn repeated_cumulative_output_is_emitted_once() {
        let mut seen = HashMap::new();
        assert_eq!(dedup_tool_output(&mut seen, "tc-1", "one"), "one");
        assert_eq!(dedup_tool_output(&mut seen, "tc-1", "onetwo"), "two");
    }

    /// An exact repeat is ambiguous: a tail-streaming agent may legitimately
    /// emit the same line twice, so preserving bytes wins until the stream
    /// has demonstrated cumulative behavior.
    #[test]
    fn an_exact_repeated_tail_is_not_dropped() {
        let mut seen = HashMap::new();
        assert_eq!(dedup_tool_output(&mut seen, "tc-1", "one"), "one");
        assert_eq!(dedup_tool_output(&mut seen, "tc-1", "one"), "one");
    }

    #[test]
    fn a_tail_chunk_that_starts_with_the_previous_tail_is_not_truncated() {
        let mut seen = HashMap::new();
        assert_eq!(dedup_tool_output(&mut seen, "tc-1", "alpha"), "alpha");
        // This non-prefix update establishes that this agent sends tails.
        assert_eq!(dedup_tool_output(&mut seen, "tc-1", "beta"), "beta");
        assert_eq!(
            dedup_tool_output(&mut seen, "tc-1", "beta again"),
            "beta again"
        );
    }

    /// A different tool call id has its own independent tracking.
    #[test]
    fn different_tool_calls_track_independently() {
        let mut seen = HashMap::new();
        assert_eq!(dedup_tool_output(&mut seen, "tc-1", "one"), "one");
        assert_eq!(dedup_tool_output(&mut seen, "tc-2", "one"), "one");
    }

    #[test]
    fn a_status_only_completion_keeps_the_output_already_streamed() {
        let mut seen = HashMap::new();
        assert_eq!(dedup_tool_output(&mut seen, "tc-1", "one"), "one");
        assert_eq!(dedup_tool_output(&mut seen, "tc-1", "onetwo"), "two");

        assert_eq!(complete_tool_output(&mut seen, "tc-1", ""), "onetwo");
        assert!(!seen.contains_key("tc-1"));
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

    /// Test rig for `answer_permission`: fresh session-allow-list, pending
    /// map, and an event-observing sink, all handed back so a test can both
    /// await the response and inspect what was emitted/registered.
    struct PermissionRig {
        session_allowed: Mutex<HashSet<permissions::ToolKind>>,
        pending: PendingPermissions,
        sink: Arc<dyn Sink>,
        events: std::sync::mpsc::Receiver<Envelope>,
        session_id: String,
        project_hash: String,
        active_commands: ActiveCommands,
    }

    impl PermissionRig {
        fn new() -> Self {
            Self::for_session("sess-1", "proj-1", Arc::new(Mutex::new(HashMap::new())))
        }

        /// A rig for a specific session id, sharing `active_commands` with
        /// whatever other rig(s) the caller built from the same registry —
        /// how a same-project conflict test observes what another live
        /// session already registered.
        fn for_session(session_id: &str, project_hash: &str, active_commands: ActiveCommands) -> Self {
            let (tx, rx) = std::sync::mpsc::channel();
            Self {
                session_allowed: Mutex::new(HashSet::new()),
                pending: Arc::new(Mutex::new(HashMap::new())),
                sink: Arc::new(ChannelSink(tx)),
                events: rx,
                session_id: session_id.to_string(),
                project_hash: project_hash.to_string(),
                active_commands,
            }
        }

        async fn answer(&self, req: &v1::RequestPermissionRequest, mode: PermissionMode) -> v1::RequestPermissionResponse {
            answer_permission(
                req,
                mode,
                &self.session_allowed,
                &self.pending,
                &self.sink,
                &self.session_id,
                "thread-1",
                &self.project_hash,
                &self.active_commands,
            )
            .await
        }
    }

    /// RED→GREEN: spec mode auto-approves reads.
    #[tokio::test]
    async fn spec_mode_allows_read() {
        let req = permission_request(v1::ToolKind::Read, None);
        let res = PermissionRig::new().answer(&req, PermissionMode::Spec).await;
        assert_eq!(selected_option(res).as_deref(), Some("allow"));
    }

    /// RED→GREEN: spec mode denies edits by cancelling.
    #[tokio::test]
    async fn spec_mode_denies_edit() {
        let req = permission_request(v1::ToolKind::Edit, None);
        let res = PermissionRig::new().answer(&req, PermissionMode::Spec).await;
        assert!(matches!(
            res.outcome,
            v1::RequestPermissionOutcome::Cancelled
        ));
    }

    /// RED→GREEN: bypass mode allows everything.
    #[tokio::test]
    async fn bypass_allows_execute() {
        let req = permission_request(v1::ToolKind::Execute, Some(serde_json::json!({"command": "rm -rf /tmp/x"})));
        let res = PermissionRig::new().answer(&req, PermissionMode::Bypass).await;
        assert_eq!(selected_option(res).as_deref(), Some("allow"));
    }

    /// RED→GREEN: openspec commands are whitelisted even in spec mode (D20).
    #[tokio::test]
    async fn spec_mode_allows_openspec_execute() {
        let req = permission_request(v1::ToolKind::Execute, Some(serde_json::json!({"command": "openspec list"})));
        let res = PermissionRig::new().answer(&req, PermissionMode::Spec).await;
        assert_eq!(selected_option(res).as_deref(), Some("allow"));
    }

    /// RED→GREEN: a second session in the same project running a command on
    /// the same port escalates an otherwise auto-allowed Spec-mode Execute
    /// to a Prompt carrying the conflict warning — the whole point of
    /// port-and-db-conflict-detection.
    #[tokio::test]
    async fn conflicting_port_escalates_to_prompt_with_warning() {
        let active: ActiveCommands = Arc::new(Mutex::new(HashMap::new()));
        let first = PermissionRig::for_session("sess-a", "proj-1", active.clone());
        let first_req = permission_request(
            v1::ToolKind::Execute,
            Some(serde_json::json!({"command": "npm run dev -- --port 3000"})),
        );
        // Spec mode auto-allows execute, so this resolves immediately and
        // just needs to register in the shared registry for the next check.
        first.answer(&first_req, PermissionMode::Spec).await;

        let second = PermissionRig::for_session("sess-b", "proj-1", active.clone());
        let second_req = permission_request(
            v1::ToolKind::Execute,
            Some(serde_json::json!({"command": "npm run dev -- --port 3000"})),
        );
        let fut = second.answer(&second_req, PermissionMode::Spec);
        tokio::pin!(fut);
        let raced = tokio::time::timeout(Duration::from_millis(50), &mut fut).await;
        assert!(raced.is_err(), "a conflict must pause for the user even though Spec mode would auto-allow");

        let event = second.events.recv_timeout(Duration::from_millis(50)).expect("PermissionRequest should have been emitted");
        let ExecutorEvent::PermissionRequest { id, warning, .. } = event.event else {
            panic!("expected a PermissionRequest event, got {:?}", event.event);
        };
        assert!(warning.expect("conflict warning should be attached").contains("3000"));

        let tx = second.pending.lock_or_recover().remove(&id).expect("pending entry should be registered");
        tx.send(PermissionAnswer::Allow).unwrap();
        fut.await;
    }

    /// RED→GREEN: no conflict means Spec mode's normal auto-allow still
    /// applies — the check must never block ordinary, non-colliding work.
    #[tokio::test]
    async fn non_conflicting_command_still_auto_allows() {
        let active: ActiveCommands = Arc::new(Mutex::new(HashMap::new()));
        let first = PermissionRig::for_session("sess-a", "proj-1", active.clone());
        let first_req = permission_request(
            v1::ToolKind::Execute,
            Some(serde_json::json!({"command": "npm run dev -- --port 3000"})),
        );
        first.answer(&first_req, PermissionMode::Spec).await;

        let second = PermissionRig::for_session("sess-b", "proj-1", active.clone());
        let second_req = permission_request(
            v1::ToolKind::Execute,
            Some(serde_json::json!({"command": "npm run dev -- --port 4000"})),
        );
        let res = second.answer(&second_req, PermissionMode::Spec).await;
        assert_eq!(selected_option(res).as_deref(), Some("allow"));
        assert!(second.events.try_recv().is_err(), "no warning should be emitted when nothing conflicts");
    }

    /// RED→GREEN 1.2: a Prompt-tier request registers a pending entry and
    /// emits `PermissionRequest`, and does not resolve until answered.
    #[tokio::test]
    async fn go_mode_prompt_registers_pending_and_waits() {
        let req = permission_request(v1::ToolKind::Execute, Some(serde_json::json!({"command": "cargo build"})));
        let rig = PermissionRig::new();

        // Race the future against a short timeout: it must NOT resolve on
        // its own — only once a decision is sent through the pending sender.
        let fut = rig.answer(&req, PermissionMode::Go);
        tokio::pin!(fut);
        let raced = tokio::time::timeout(Duration::from_millis(50), &mut fut).await;
        assert!(raced.is_err(), "should still be waiting for the user's decision");

        let event = rig.events.recv_timeout(Duration::from_millis(50)).expect("PermissionRequest should have been emitted");
        let ExecutorEvent::PermissionRequest { id, tool_kind, command, .. } = event.event else {
            panic!("expected a PermissionRequest event, got {:?}", event.event);
        };
        assert_eq!(tool_kind, "execute");
        assert_eq!(command.as_deref(), Some("cargo build"));

        let tx = rig.pending.lock_or_recover().remove(&id).expect("pending entry should be registered");
        tx.send(PermissionAnswer::Allow).unwrap();
        let res = fut.await;
        assert_eq!(selected_option(res).as_deref(), Some("allow"));
    }

    /// RED→GREEN 1.3: Allow/Deny sent through the paired sender resolve
    /// `answer_permission` to the corresponding response.
    #[tokio::test]
    async fn pending_decision_resolves_to_matching_response() {
        for (answer, expect_allow) in [(PermissionAnswer::Allow, true), (PermissionAnswer::Deny, false)] {
            let req = permission_request(v1::ToolKind::Delete, None);
            let rig = PermissionRig::new();
            let fut = rig.answer(&req, PermissionMode::Go);
            tokio::pin!(fut);
            let _ = tokio::time::timeout(Duration::from_millis(20), &mut fut).await;
            let event = rig.events.recv_timeout(Duration::from_millis(50)).unwrap();
            let ExecutorEvent::PermissionRequest { id, .. } = event.event else { panic!("expected PermissionRequest") };
            let tx = rig.pending.lock_or_recover().remove(&id).unwrap();
            tx.send(answer).unwrap();
            let res = fut.await;
            assert_eq!(selected_option(res).is_some(), expect_allow);
        }
    }

    /// RED→GREEN 2.1: once a kind is allowed for the session, later
    /// Prompt-tier requests of that kind auto-allow without a new pending entry.
    #[tokio::test]
    async fn allow_session_auto_allows_later_calls_of_the_same_kind() {
        let rig = PermissionRig::new();
        let first = permission_request(v1::ToolKind::Execute, Some(serde_json::json!({"command": "cargo build"})));
        let fut = rig.answer(&first, PermissionMode::Go);
        tokio::pin!(fut);
        let _ = tokio::time::timeout(Duration::from_millis(20), &mut fut).await;
        let event = rig.events.recv_timeout(Duration::from_millis(50)).unwrap();
        let ExecutorEvent::PermissionRequest { id, .. } = event.event else { panic!("expected PermissionRequest") };
        let tx = rig.pending.lock_or_recover().remove(&id).unwrap();
        tx.send(PermissionAnswer::AllowSession).unwrap();
        let res = fut.await;
        assert_eq!(selected_option(res).as_deref(), Some("allow"));

        // A second Execute request of the same kind auto-allows: no new
        // pending entry, no new PermissionRequest event.
        let second = permission_request(v1::ToolKind::Execute, Some(serde_json::json!({"command": "cargo test"})));
        let res2 = rig.answer(&second, PermissionMode::Go).await;
        assert_eq!(selected_option(res2).as_deref(), Some("allow"));
        assert!(rig.events.try_recv().is_err(), "no second PermissionRequest should have been emitted");
        assert!(rig.pending.lock_or_recover().is_empty());
    }

    /// RED→GREEN 3.1: draining a session's pending permissions on teardown
    /// resolves every still-pending sender to Deny.
    #[tokio::test]
    async fn terminate_drains_pending_permissions_as_denied() {
        let (mut session, _cmd_rx) = stub_session(false);
        let (tx, rx) = oneshot::channel();
        session.pending_permissions.lock_or_recover().insert("req-1".into(), tx);

        session.terminate();

        assert_eq!(rx.await, Ok(PermissionAnswer::Deny));
        assert!(session.pending_permissions.lock_or_recover().is_empty());
    }

    /// RED→GREEN: `answer_permission_prompt` resolves a registered pending
    /// entry and is a no-op for an unknown/already-resolved id.
    #[tokio::test]
    async fn answer_permission_prompt_resolves_or_no_ops() {
        let (session, _cmd_rx) = stub_session(false);
        let (tx, mut rx) = oneshot::channel();
        session.pending_permissions.lock_or_recover().insert("req-1".into(), tx);

        session.answer_permission_prompt("does-not-exist", PermissionAnswer::Allow);
        assert!(rx.try_recv().is_err(), "unknown id must not resolve the real pending entry");

        session.answer_permission_prompt("req-1", PermissionAnswer::Allow);
        assert_eq!(rx.await, Ok(PermissionAnswer::Allow));

        // Already-resolved id: a second call is a harmless no-op.
        session.answer_permission_prompt("req-1", PermissionAnswer::Deny);
    }

    /// RED→GREEN: `needs_attention` is true exactly while a permission
    /// request is pending, and false again once it's answered.
    #[tokio::test]
    async fn needs_attention_tracks_pending_permissions() {
        let (session, _cmd_rx) = stub_session(false);
        assert!(!session.needs_attention());

        let (tx, _rx) = oneshot::channel();
        session.pending_permissions.lock_or_recover().insert("req-1".into(), tx);
        assert!(session.needs_attention());

        session.answer_permission_prompt("req-1", PermissionAnswer::Allow);
        assert!(!session.needs_attention());
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
        let result = send_acp_prompt(&session, None, Prompt::text("hello"));
        assert!(result.unwrap_err().contains("mid-turn"));
        assert!(cmd_rx.try_recv().is_err());
    }

    /// RED→GREEN: send marks busy and queues the prompt for the bridge.
    #[test]
    fn send_queues_prompt_when_idle() {
        let (session, mut cmd_rx) = stub_session(false);
        send_acp_prompt(&session, None, Prompt::text("hello")).unwrap();
        assert!(session.is_busy());
        match cmd_rx.try_recv() {
            Ok(BridgeCommand::Prompt(prompt)) => assert!(prompt.joined().ends_with("\n\nhello")),
            _ => panic!("expected a Prompt command"),
        }
    }

    fn block_kinds(blocks: &[v1::ContentBlock]) -> Vec<&'static str> {
        blocks
            .iter()
            .map(|b| match b {
                v1::ContentBlock::Text(_) => "text",
                v1::ContentBlock::Image(_) => "image",
                _ => "other",
            })
            .collect()
    }

    /// The user's text must be the final block — that is where Claude Code
    /// looks for a leading `/skill` — with images just before it.
    #[test]
    fn prompt_puts_context_then_images_then_user_text_last() {
        let prompt = Prompt {
            context: vec!["preview".into(), "handoff".into()],
            images: vec![PromptImage { path: "/a.png".into(), mime_type: "image/png".into(), data: "AAA".into() }],
            skills: vec![],
            chats: vec![],
            text: "/tdd fix it".into(),
        };
        let blocks = prompt.blocks(true);
        assert_eq!(block_kinds(&blocks), ["text", "text", "image", "text"]);
        let v1::ContentBlock::Text(last) = blocks.last().unwrap() else { panic!() };
        assert_eq!(last.text, "/tdd fix it");
    }

    /// Tray skills reach the agent as a leading command plus a plain
    /// instruction for the rest, in the final text block.
    #[test]
    fn tray_skills_lead_the_users_text() {
        let with = |skills: &[&str], text: &str| {
            Prompt { skills: skills.iter().map(|s| s.to_string()).collect(), ..Prompt::text(text) }.user_text()
        };
        assert_eq!(with(&[], "fix it"), "fix it");
        assert_eq!(with(&["tdd"], "fix it"), "/tdd fix it");
        assert_eq!(with(&["tdd"], ""), "/tdd");
        assert_eq!(with(&["$codex-skill"], "go"), "$codex-skill go");
        assert_eq!(with(&["tdd", "grill-apply"], "fix it"), "/tdd fix it\n\nAlso use these skills: grill-apply");
        let chat = ("Auth fix".to_string(), "/t/1.jsonl".to_string());
        let prompt = Prompt { skills: vec!["tdd".into()], chats: vec![chat], ..Prompt::text("fix it") };
        assert!(prompt.user_text().ends_with("\n- Auth fix → /t/1.jsonl"));
        let prompt = Prompt { context: vec!["ctx".into()], skills: vec!["tdd".into()], ..Prompt::text("fix it") };
        let v1::ContentBlock::Text(last) = prompt.blocks(true).pop().unwrap() else { panic!() };
        assert_eq!(last.text, "/tdd fix it");
    }

    /// An agent without image support still gets the images — as paths.
    #[test]
    fn prompt_without_image_support_sends_paths_in_the_text() {
        let prompt = Prompt {
            context: vec![],
            images: vec![PromptImage { path: "/a.png".into(), mime_type: "image/png".into(), data: "AAA".into() }],
            skills: vec![],
            chats: vec![],
            text: "look".into(),
        };
        let blocks = prompt.blocks(false);
        assert_eq!(block_kinds(&blocks), ["text"]);
        let v1::ContentBlock::Text(only) = &blocks[0] else { panic!() };
        assert!(only.text.starts_with("look") && only.text.contains("- /a.png"));
    }

    #[test]
    fn every_interactive_agent_receives_preview_activation_instructions() {
        for mode in ["spec", "go"] {
            let (mut session, mut cmd_rx) = stub_session(false);
            session.mode = mode.into();
            session.agent_id = "any-registry-agent".into();
            send_acp_prompt(&session, None, Prompt::text("Show my app")).unwrap();
            let BridgeCommand::Prompt(prompt) = cmd_rx.try_recv().unwrap() else {
                panic!("expected a prompt");
            };
            let text = prompt.joined();
            assert!(text.contains("palisade-preview"));
            assert!(text.contains("http://localhost:"));
            assert!(text.contains("tool output"));
            assert!(text.ends_with("Show my app"));
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
        authenticate_requests: Arc<std::sync::Mutex<Vec<String>>>,
        /// Also stream a couple of `AgentThoughtChunk`s before the reply —
        /// opt-in so `bridge_prompt_round_trips`' text-only event sequence
        /// stays exact for every other test using this fake.
        emit_thoughts: bool,
        /// Send a `session/request_permission` request before the reply
        /// chunks, and — critically — without awaiting its response. This is
        /// what a real agent does while its own tool call is blocked on the
        /// user's Allow/Deny: it must still be free to stream other session
        /// updates on the same connection while that request sits pending.
        emit_permission_request_first: bool,
        advertise_protocol_login: bool,
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
            let authenticate_requests = self.authenticate_requests.clone();
            let emit_thoughts = self.emit_thoughts;
            let emit_permission_request_first = self.emit_permission_request_first;
            let advertise_protocol_login = self.advertise_protocol_login;
            tokio::spawn(async move {
                let _ = acp::Agent
                    .builder()
                    .name("fake-agent")
                    .on_receive_request(
                        async |req: v1::InitializeRequest, responder, _cx| {
                            let mut response = v1::InitializeResponse::new(req.protocol_version)
                                .agent_capabilities(v1::AgentCapabilities::new());
                            if advertise_protocol_login {
                                response = response.auth_methods(vec![v1::AuthMethod::Agent(
                                    v1::AuthMethodAgent::new(
                                        v1::AuthMethodId::new("chat-gpt"),
                                        "ChatGPT",
                                    ),
                                )]);
                            }
                            responder.respond(response)
                        },
                        acp::on_receive_request!(),
                    )
                    .on_receive_request(
                        async move |req: v1::AuthenticateRequest, responder, _cx| {
                            authenticate_requests
                                .lock()
                                .unwrap()
                                .push(req.method_id.to_string());
                            responder.respond(v1::AuthenticateResponse::new())
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
                                        v1::SessionConfigSelectOption::new("default", "Default"),
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
                        async move |req: v1::PromptRequest, responder, cx| {
                          // The whole body runs in its own spawned task —
                          // calling `.block_task().await` on a request this
                          // same handler sends (the terminal scenarios do,
                          // sequentially) would otherwise block the fake
                          // agent's *own* dispatch loop, which is exactly
                          // what stops it from ever seeing the response.
                          // That's the phase 2 bug, reproduced on this
                          // harness's own agent side, not the client's.
                          let cx2 = cx.clone();
                          cx.spawn(async move {
                            let cx = cx2;
                            if emit_permission_request_first {
                                let mut fields = v1::ToolCallUpdateFields::new();
                                fields.kind = Some(v1::ToolKind::Execute);
                                fields.raw_input =
                                    Some(serde_json::json!({"command": "cargo build"}));
                                let perm_req = v1::RequestPermissionRequest::new(
                                    req.session_id.clone(),
                                    v1::ToolCallUpdate::new("tc-perm", fields),
                                    vec![
                                        v1::PermissionOption::new(
                                            "allow",
                                            "Allow once",
                                            v1::PermissionOptionKind::AllowOnce,
                                        ),
                                        v1::PermissionOption::new(
                                            "deny",
                                            "Deny",
                                            v1::PermissionOptionKind::RejectOnce,
                                        ),
                                    ],
                                );
                                // Sent and NOT awaited here — dropping the
                                // `SentRequest` immediately would auto-cancel
                                // it, so the wait moves into its own spawned
                                // task while this handler goes on to stream
                                // the notification below on the same turn.
                                let sent = cx.send_request(perm_req);
                                cx.spawn(async move {
                                    let _ = sent.block_task().await;
                                    Ok(())
                                })?;
                            }
                            if emit_thoughts {
                                for piece in ["hmm ", "thinking"] {
                                    let _ = cx.send_notification(v1::SessionNotification::new(
                                        req.session_id.clone(),
                                        v1::SessionUpdate::AgentThoughtChunk(v1::ContentChunk::new(
                                            v1::ContentBlock::Text(v1::TextContent::new(piece)),
                                        )),
                                    ));
                                }
                            }
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
                          })
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
        fake_agent_pair_with(false)
    }

    fn fake_agent_pair_with(
        emit_thoughts: bool,
    ) -> (
        acp::ByteStreams<
            impl futures::AsyncWrite + Send + 'static,
            impl futures::AsyncRead + Send + 'static,
        >,
        FakeAgent,
        tokio::task::JoinHandle<()>,
    ) {
        fake_agent_pair_with_permission(emit_thoughts, false)
    }

    /// A fake agent that sends a `session/request_permission` request before
    /// its reply chunks, without awaiting the answer — the shape a permission
    /// prompt takes on a live connection.
    fn fake_agent_pair_with_permission_first() -> (
        acp::ByteStreams<
            impl futures::AsyncWrite + Send + 'static,
            impl futures::AsyncRead + Send + 'static,
        >,
        FakeAgent,
        tokio::task::JoinHandle<()>,
    ) {
        fake_agent_pair_with_permission(false, true)
    }

    fn fake_agent_pair_with_permission(
        emit_thoughts: bool,
        emit_permission_request_first: bool,
    ) -> (
        acp::ByteStreams<
            impl futures::AsyncWrite + Send + 'static,
            impl futures::AsyncRead + Send + 'static,
        >,
        FakeAgent,
        tokio::task::JoinHandle<()>,
    ) {
        fake_agent_pair_full(emit_thoughts, emit_permission_request_first, false)
    }

    fn fake_agent_pair_with_protocol_login() -> (
        acp::ByteStreams<
            impl futures::AsyncWrite + Send + 'static,
            impl futures::AsyncRead + Send + 'static,
        >,
        FakeAgent,
        tokio::task::JoinHandle<()>,
    ) {
        fake_agent_pair_full(false, false, true)
    }

    fn fake_agent_pair_full(
        emit_thoughts: bool,
        emit_permission_request_first: bool,
        advertise_protocol_login: bool,
    ) -> (
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
            authenticate_requests: Arc::new(std::sync::Mutex::new(vec![])),
            emit_thoughts,
            emit_permission_request_first,
            advertise_protocol_login,
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
            extra_env: vec![],
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
    /// the agent's model selector. With no thread choice it moves off the
    /// model the agent booted on (for Claude, the user's settings pin) onto
    /// the agent's own "default".
    #[tokio::test(flavor = "multi_thread")]
    async fn bridge_session_reports_models() {
        let (transport, fake, _agent) = fake_agent_pair();
        let (tx, _rx) = std::sync::mpsc::channel();
        let session = start_with_transport(transport, test_spawn(None), Arc::new(ChannelSink(tx)), false, None);
        let (_id, models, _cmds, _busy, acp_id, _pending) = session.expect("session should start");
        assert_eq!(models.current.as_deref(), Some("default"));
        assert_eq!(models.models.len(), 3);
        assert_eq!(acp_id, "acp-sess-1");
        assert_eq!(
            *fake.set_config_requests.lock_or_recover(),
            vec![("model".to_string(), "default".to_string())]
        );
    }

    /// A connection advertising several login choices must not be prompted or
    /// authenticated merely because Palisade opened a thread. The agent's
    /// `session/new` response is the authority on whether auth is needed.
    #[tokio::test(flavor = "multi_thread")]
    async fn bridge_does_not_authenticate_until_the_agent_requires_it() {
        let (transport, fake, _agent) = fake_agent_pair_with_protocol_login();
        let (tx, _rx) = std::sync::mpsc::channel();

        start_with_transport(transport, test_spawn(None), Arc::new(ChannelSink(tx)), false, None)
            .expect("an already-authorized session should start");

        assert!(
            fake.authenticate_requests.lock_or_recover().is_empty(),
            "opening a thread must not select or invoke an advertised login method"
        );
    }

    /// RED→GREEN: a prompt round-trips — the agent's chunk arrives at the
    /// sink, and the prompt response closes the turn with Done. The busy
    /// flag the session handle holds is the one the bridge clears.
    #[tokio::test(flavor = "multi_thread")]
    async fn bridge_prompt_round_trips() {
        let (transport, _fake, _agent) = fake_agent_pair();
        let (tx, rx) = std::sync::mpsc::channel();
        let (id, _models, cmds, busy, _acp_id, pending) =
            start_with_transport(transport, test_spawn(None), Arc::new(ChannelSink(tx)), false, None)
                .unwrap();

        let session = SessionIdentity::from(&test_spawn(None))
            .into_session(id, ModelState::default(), cmds, busy, pending);
        send_acp_prompt(&session, None, Prompt::text("hello")).unwrap();

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

    /// RED→GREEN 1.2: reasoning deltas accumulate and the turn-completion
    /// flush emits a complete `Reasoning` event carrying a real elapsed time
    /// (reasoning-collapse-ux D-design-2) — not the placeholder 0 the
    /// unreachable `acp_events::map_acp_update` arm uses.
    #[tokio::test(flavor = "multi_thread")]
    async fn bridge_reasoning_round_trips_with_elapsed_time() {
        let (transport, _fake, _agent) = fake_agent_pair_with(true);
        let (tx, rx) = std::sync::mpsc::channel();
        let (id, _models, cmds, busy, _acp_id, pending) =
            start_with_transport(transport, test_spawn(None), Arc::new(ChannelSink(tx)), false, None)
                .unwrap();
        let session = SessionIdentity::from(&test_spawn(None))
            .into_session(id, ModelState::default(), cmds, busy, pending);
        send_acp_prompt(&session, None, Prompt::text("hello")).unwrap();

        // Reasoning deltas stream before the text ones (FakeAgent's order).
        let first = recv_event(&rx);
        assert!(matches!(first.event, ExecutorEvent::ReasoningDelta { ref text } if text == "hmm "));
        let second = recv_event(&rx);
        assert!(matches!(second.event, ExecutorEvent::ReasoningDelta { ref text } if text == "thinking"));

        // Drain the text events, then the complete Reasoning event.
        loop {
            let event = recv_event(&rx);
            if let ExecutorEvent::Reasoning { text, elapsed_secs } = event.event {
                assert_eq!(text, "hmm thinking");
                // Real time elapsed, not the acp_events placeholder — a
                // same-process round trip is well under a second, so this
                // just proves it's a real (small) duration, not garbage.
                assert!(elapsed_secs < 5, "elapsed_secs should be a small real duration, got {elapsed_secs}");
                break;
            }
        }
    }

    /// RED→GREEN: the crate's own dispatch-loop rule (`concepts::ordering`)
    /// says a request handler that awaits the user holds the loop, so no
    /// other message is processed while a permission prompt sits open. This
    /// is the whole-session freeze this guards against — proven here by
    /// having the agent send a `session/request_permission` and then, without
    /// waiting for its answer, a normal `session/update` text chunk. Under
    /// the bug, the client's `on_receive_request` handler for
    /// `RequestPermissionRequest` awaits `answer_permission` inline and never
    /// returns to the dispatch loop, so the text chunk is never processed
    /// until the prompt is answered. Bounded timeouts throughout so a
    /// regression fails clean instead of hanging the suite.
    #[tokio::test(flavor = "multi_thread")]
    async fn session_updates_keep_flowing_while_a_permission_prompt_is_open() {
        // Go mode, not the other tests' Spec: an Execute request is
        // Prompt-tier in Go mode (permissions::decide_permission), so the
        // fake agent's permission request actually reaches the pending path
        // this test is exercising, rather than auto-allowing silently.
        let mut spawn_for_start = test_spawn(None);
        spawn_for_start.mode = "go".into();
        let mut spawn_for_identity = test_spawn(None);
        spawn_for_identity.mode = "go".into();

        let (transport, _fake, _agent) = fake_agent_pair_with_permission_first();
        let (tx, rx) = std::sync::mpsc::channel();
        let (id, _models, cmds, busy, _acp_id, pending) = start_with_transport(
            transport,
            spawn_for_start,
            Arc::new(ChannelSink(tx)),
            false,
            None,
        )
        .unwrap();
        let session = SessionIdentity::from(&spawn_for_identity)
            .into_session(id, ModelState::default(), cmds, busy, pending);
        send_acp_prompt(&session, None, Prompt::text("hello")).unwrap();

        // Both the permission prompt and the turn's own text chunk must
        // reach the sink before either is answered — the dispatch loop must
        // not be stuck behind the open prompt. `cx.spawn` makes the two
        // handlers run concurrently, so their relative order is no longer
        // guaranteed (unlike under the bug, where the request handler held
        // the loop and nothing else could be processed at all); this only
        // asserts that both arrive, unblocked, within a bounded window.
        // Nothing gates the fake agent's own turn completion on the
        // permission answer, so a `Done` may legitimately show up in this
        // window too — tracked so the final wait below doesn't block on an
        // event that already went by.
        let mut request_id: Option<String> = None;
        let mut saw_text_delta = false;
        let mut saw_done = false;
        let deadline = std::time::Instant::now() + Duration::from_millis(500);
        while std::time::Instant::now() < deadline && !(request_id.is_some() && saw_text_delta) {
            let Ok(event) = rx.recv_timeout(Duration::from_millis(500)) else {
                break;
            };
            match event.event {
                ExecutorEvent::PermissionRequest { id, .. } => request_id = Some(id),
                ExecutorEvent::TextDelta { ref text } if text == "agent " => saw_text_delta = true,
                ExecutorEvent::Done => saw_done = true,
                // The second "reply" chunk (or anything else the fake agent
                // streams) may legitimately arrive in this window too — only
                // the events above are what this test is checking for.
                _ => {}
            }
        }
        let request_id = request_id.expect(
            "PermissionRequest should have arrived, unblocked, before the prompt was answered",
        );
        assert!(
            saw_text_delta,
            "the streamed text delta should have arrived, unblocked, before the prompt was answered"
        );

        // Answering the prompt lets its own turn (the fake agent's spawned
        // `block_task` wait) resolve too — nothing is left dangling.
        session.answer_permission_prompt(&request_id, PermissionAnswer::Allow);

        // The prompt's own turn still completes normally (unless it already
        // did, above).
        if !saw_done {
            loop {
                let event = recv_event(&rx);
                if matches!(event.event, ExecutorEvent::Done) {
                    break;
                }
            }
        }
    }

    /// RED→GREEN: a thread-chosen model is applied via set_config_option
    /// right after session/new.
    #[tokio::test(flavor = "multi_thread")]
    async fn bridge_applies_model_choice() {
        let (transport, fake, _agent) = fake_agent_pair();
        let (tx, _rx) = std::sync::mpsc::channel();
        let (_id, models, _cmds, _busy, _acp_id, _pending) = start_with_transport(
            transport,
            test_spawn(Some("model-b".into())),
            Arc::new(ChannelSink(tx)),
            false,
            None,
        )
        .unwrap();

        assert_eq!(models.current.as_deref(), Some("model-b"));
        assert_eq!(
            *fake.set_config_requests.lock_or_recover(),
            vec![("model".to_string(), "model-b".to_string())]
        );
    }

    /// RED→GREEN: a probe reports models and then lets the connection die.
    #[tokio::test(flavor = "multi_thread")]
    async fn probe_returns_models_without_a_session() {
        let (transport, fake, agent) = fake_agent_pair();
        let (tx, _rx) = std::sync::mpsc::channel();
        let (_id, models, _cmds, _busy, _acp_id, _pending) =
            start_with_transport(transport, test_spawn(None), Arc::new(ChannelSink(tx)), true, None)
                .unwrap();
        assert_eq!(models.models.len(), 3);
        // A probe never switches the agent's model, but reports the one a
        // session would run, so pickers default to what actually runs.
        assert!(fake.set_config_requests.lock_or_recover().is_empty());
        assert_eq!(models.current.as_deref(), Some("default"));
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

    // ------------------------------------------------- #19: ACP auth signal

    /// The protocol's own signal: JSON-RPC -32000. Recognising this (rather
    /// than any one agent's prose) is what makes the auth handling work for
    /// every compliant agent.
    #[test]
    fn the_protocol_auth_required_code_is_recognised() {
        assert!(is_auth_required(&acp::Error::auth_required()));
        assert!(is_auth_required(
            &acp::Error::auth_required().data(serde_json::json!({ "reason": "auth_required" }))
        ));
    }

    /// The spec's examples also carry `data.reason`, on an error whose code an
    /// agent may not have set to -32000.
    #[test]
    fn the_spec_data_reason_is_recognised_without_the_code() {
        let err = acp::Error::internal_error()
            .data(serde_json::json!({ "reason": "auth_required" }));
        assert!(is_auth_required(&err));
    }

    /// Both messages from #19, verbatim. Agents that only say it in prose are
    /// still understood — the text check is the fallback, not the contract.
    #[test]
    fn an_agents_prose_auth_failure_is_recognised() {
        for detail in [
            "Failed to authenticate: OAuth session expired and could not be refreshed (errorKind: authentication_failed)",
            "Authentication required",
            "Unauthorized",
            "Please log in to continue",
        ] {
            let err = acp::Error::internal_error().data(serde_json::json!(detail));
            assert!(is_auth_required(&err), "should read as auth: {detail}");
        }
    }

    #[test]
    fn an_ordinary_failure_is_not_mistaken_for_an_auth_failure() {
        for detail in [
            "session/new failed: no such directory",
            "context window exceeded",
            "tool call failed: exit status 1",
        ] {
            let err = acp::Error::internal_error().data(serde_json::json!(detail));
            assert!(!is_auth_required(&err), "should not read as auth: {detail}");
        }
    }

    /// The exact failure from the bug report: Claude Code's OAuth refresh
    /// token is single-use, so a losing process's own suggestion to "sign in
    /// again" must not be read as an actual expired login — the agent's
    /// `errorKind` says this one is a retryable `server_error`, not
    /// `authentication_failed`.
    #[test]
    fn a_transient_oauth_refresh_race_is_not_mistaken_for_an_auth_failure() {
        let detail = "Failed to refresh OAuth token: another Claude Code process is \
            refreshing it or exited mid-refresh. This is usually transient; retry in a \
            minute, and if it persists close other Claude Code processes or sign in \
            again: { \"errorKind\": \"server_error\" }";
        let err = acp::Error::internal_error().data(serde_json::json!(detail));
        assert!(!is_auth_required(&err), "a transient race must not read as auth: {detail}");
        assert!(!reads_as_auth_failure(detail));
        assert!(is_transient_server_error(
            &acp::Error::internal_error().data(serde_json::json!({ "errorKind": "server_error" }))
        ));
        assert!(!is_transient_server_error(
            &acp::Error::internal_error()
                .data(serde_json::json!({ "errorKind": "authentication_failed" }))
        ));
    }

    #[test]
    fn structured_failure_classification_overrides_misleading_prose() {
        let transient = acp::Error::internal_error().data(serde_json::json!({
            "errorKind": "server_error",
            "detail": "please sign in again"
        }));
        assert_eq!(classify_acp_error(&transient), FailureClass::TransientProvider);
        assert_eq!(classify_acp_error(&acp::Error::auth_required()), FailureClass::AuthRequired);
        assert_eq!(
            classify_acp_error(&acp::Error::internal_error().data(serde_json::json!({ "errorKind": "authentication_failed" }))),
            FailureClass::AuthRequired
        );
    }

    /// #19's actual finding: the thing Palisade launched is not necessarily
    /// the CLI the user re-authenticated, so the message has to name what was
    /// launched instead of telling them to "sign in outside Palisade".
    #[test]
    fn the_auth_message_names_the_agent_and_how_it_was_launched() {
        let launch = launch_label("npx", &["@agentclientprotocol/claude-agent-acp".to_string()]);
        assert_eq!(launch, "npx @agentclientprotocol/claude-agent-acp");

        let help = auth_help("Claude Agent", &launch, "OAuth session expired");
        assert!(help.contains("Claude Agent"));
        assert!(help.contains("@agentclientprotocol/claude-agent-acp"));
        assert!(help.contains("OAuth session expired"), "the agent's own words survive");
        assert!(help.contains("npm"), "says the adapter keeps its own login: {help}");
    }

    #[test]
    fn a_binary_agent_gets_a_message_without_npm_advice() {
        let launch = launch_label("devin", &["acp".to_string()]);
        assert_eq!(launch, "devin acp");
        let help = auth_help("Devin", &launch, "Authentication required");
        assert!(help.contains("Devin"));
        assert!(help.contains("devin acp"));
        assert!(!help.contains("npm"));
    }

    // ------------------------------------------- #19: in-app agent sign-in

    fn terminal_method(id: &str, name: &str, args: &[&str]) -> v1::AuthMethod {
        v1::AuthMethod::Terminal(
            v1::AuthMethodTerminal::new(v1::AuthMethodId::new(id), name)
                .args(args.iter().map(|a| a.to_string()).collect()),
        )
    }

    /// ACP terminal auth: the client runs the agent's own binary with the
    /// advertised extra args. Palisade already knows how it launched the
    /// agent, so the login command is that launch plus those args — which is
    /// what makes this work for any agent, not one adapter.
    #[test]
    fn a_terminal_auth_method_becomes_the_agents_launch_command_plus_its_args() {
        let methods = vec![terminal_method(
            "claude-ai-login",
            "Claude Subscription",
            &["--cli", "auth", "login", "--claudeai"],
        )];
        let logins = logins_from(
            &methods,
            "npx",
            &["-y".into(), "@agentclientprotocol/claude-agent-acp@0.74.0".into()],
        );

        assert_eq!(logins.len(), 1);
        assert_eq!(logins[0].method_id, "claude-ai-login");
        assert_eq!(logins[0].label, "Claude Subscription");
        assert_eq!(logins[0].command, "npx");
        assert_eq!(
            logins[0].args,
            vec![
                "-y",
                "@agentclientprotocol/claude-agent-acp@0.74.0",
                "--cli",
                "auth",
                "login",
                "--claudeai"
            ]
        );
        assert_eq!(
            logins[0].shell_line(),
            "npx -y @agentclientprotocol/claude-agent-acp@0.74.0 --cli auth login --claudeai"
        );
    }

    /// An agent that resolves the command itself (the `terminal-auth` _meta
    /// extension) is taken at its word rather than reconstructed.
    #[test]
    fn a_resolved_terminal_auth_meta_wins_over_the_launch_command() {
        let mut meta = serde_json::Map::new();
        meta.insert(
            "terminal-auth".into(),
            serde_json::json!({
                "command": "/usr/local/bin/node",
                "args": ["/path/to/cli.js", "--cli", "auth", "login"],
                "label": "Claude Login",
            }),
        );
        let methods = vec![v1::AuthMethod::Terminal(
            v1::AuthMethodTerminal::new(v1::AuthMethodId::new("claude-ai-login"), "Claude Subscription")
                .args(vec!["--cli".into()])
                .meta(meta),
        )];
        let logins = logins_from(&methods, "npx", &["-y".into(), "pkg".into()]);

        assert_eq!(logins[0].command, "/usr/local/bin/node");
        assert_eq!(logins[0].args, vec!["/path/to/cli.js", "--cli", "auth", "login"]);
        assert_eq!(logins[0].label, "Claude Login");
    }

    /// Methods the client can't run itself are still offered — as a protocol
    /// login, which `authenticate` drives. Treating "not terminal" as "no
    /// login" is what hid Codex's, OpenCode's and Devin's sign-ins (#19).
    #[test]
    fn a_non_terminal_method_is_offered_as_a_protocol_login() {
        let methods = vec![v1::AuthMethod::Agent(v1::AuthMethodAgent::new(
            v1::AuthMethodId::new("windsurf-api-key"),
            "API key",
        ))];
        let logins = logins_from(&methods, "devin", &["acp".into()]);
        assert_eq!(logins.len(), 1);
        assert_eq!(logins[0].kind, AgentLoginKind::Protocol);
        assert_eq!(logins[0].method_id, "windsurf-api-key");
    }

    #[test]
    fn every_advertised_terminal_method_is_offered() {
        let methods = vec![
            terminal_method("claude-ai-login", "Claude Subscription", &["--claudeai"]),
            terminal_method("console-login", "Anthropic Console", &["--console"]),
        ];
        let logins = logins_from(&methods, "npx", &["pkg".into()]);
        assert_eq!(
            logins.iter().map(|l| l.label.as_str()).collect::<Vec<_>>(),
            vec!["Claude Subscription", "Anthropic Console"]
        );
    }

    /// Arguments with spaces have to survive being written to a shell.
    #[test]
    fn the_shell_line_quotes_arguments_that_need_it() {
        let methods = vec![terminal_method("m", "M", &["--flag", "two words"])];
        let logins = logins_from(&methods, "my agent", &[]);
        assert_eq!(logins[0].shell_line(), "'my agent' --flag 'two words'");
    }

    /// The client capability is the whole reason any of this is advertised:
    /// agents only include terminal login methods when the client says it can
    /// run them (#19).
    #[test]
    fn palisade_advertises_that_it_can_run_a_terminal_login() {
        let caps = client_capabilities();
        assert!(caps.auth.terminal, "the spec capability agents key off");
        assert_eq!(
            caps.auth
                .meta
                .as_ref()
                .and_then(|m| m.get("terminal-auth"))
                .and_then(|v| v.as_bool()),
            Some(true),
            "and the _meta variant, for agents that resolve the command for us"
        );
    }

    // --------------------- #19: the protocol contract, not one agent's shape

    /// ACP: a `terminal` method is run by the client and is deliberately NOT
    /// passed to the auth endpoints. Calling `authenticate` with one is what
    /// made the Claude adapter answer "Method not implemented" — and would do
    /// the same to any agent whose login is client-run.
    #[test]
    fn authenticate_is_never_offered_a_terminal_method() {
        let methods = vec![
            terminal_method("claude-ai-login", "Claude Subscription", &["--claudeai"]),
            terminal_method("console-login", "Anthropic Console", &["--console"]),
        ];
        assert_eq!(protocol_login_method(&methods), None);
    }

    /// An agent that does own a protocol-driven login still gets one.
    #[test]
    fn authenticate_uses_the_first_protocol_driven_method() {
        let methods = vec![
            terminal_method("terminal-first", "Terminal", &[]),
            v1::AuthMethod::Agent(v1::AuthMethodAgent::new(
                v1::AuthMethodId::new("windsurf-api-key"),
                "API key",
            )),
        ];
        assert_eq!(
            protocol_login_method(&methods).map(|id| id.to_string()),
            Some("windsurf-api-key".to_string()),
            "the terminal method is skipped, not picked because it came first"
        );
    }

    #[test]
    fn no_methods_means_no_authenticate_call() {
        assert_eq!(protocol_login_method(&[]), None);
    }

    /// Terminal methods carry environment the agent needs for its login
    /// ("Clients launch the Agent program using the arguments *and
    /// environment variables* provided by the Agent"). Dropping them means
    /// running a login the agent did not ask for.
    #[test]
    fn a_terminal_login_carries_the_environment_the_agent_asked_for() {
        let method = v1::AuthMethod::Terminal(
            v1::AuthMethodTerminal::new(v1::AuthMethodId::new("agent-login"), "Log in")
                .args(vec!["--login".into()])
                .env(HashMap::from([("ACP_INTERACTIVE_LOGIN".to_string(), "1".to_string())])),
        );
        let logins = logins_from(&[method], "some-agent", &["acp".into()]);

        assert_eq!(logins[0].env, vec![("ACP_INTERACTIVE_LOGIN".to_string(), "1".to_string())]);
        assert_eq!(
            logins[0].shell_line(),
            "ACP_INTERACTIVE_LOGIN=1 some-agent acp --login",
            "the env goes on the command line the terminal runs"
        );
    }

    #[test]
    fn a_login_env_value_that_needs_quoting_gets_it() {
        let method = v1::AuthMethod::Terminal(
            v1::AuthMethodTerminal::new(v1::AuthMethodId::new("m"), "M")
                .env(HashMap::from([("TOKEN_HINT".to_string(), "two words".to_string())])),
        );
        let logins = logins_from(&[method], "agent", &[]);
        assert_eq!(logins[0].shell_line(), "TOKEN_HINT='two words' agent");
    }

    /// An agent-typed method is never *run* by the client, but it is still a
    /// login the client can start — with `authenticate`, not a command.
    #[test]
    fn an_agent_typed_method_is_a_protocol_login_not_a_command() {
        let methods = vec![v1::AuthMethod::Agent(v1::AuthMethodAgent::new(
            v1::AuthMethodId::new("oauth"),
            "OAuth",
        ))];
        let logins = logins_from(&methods, "agent", &[]);
        assert_eq!(logins[0].kind, AgentLoginKind::Protocol);
        assert!(logins[0].command.is_empty());
        assert!(protocol_login_method(&methods).is_some());
    }

    /// Version robustness: an agent from a newer protocol revision may
    /// advertise method types this build has never heard of. The handshake has
    /// to survive that and still use the methods it *does* understand.
    #[test]
    fn a_future_method_type_does_not_break_the_handshake() {
        let wire = serde_json::json!({
            "protocolVersion": 1,
            "authMethods": [
                { "type": "quantum_handshake", "id": "future", "name": "Future method" },
                { "type": "terminal", "id": "agent-login", "name": "Log in", "args": ["--login"] }
            ]
        });
        let response: v1::InitializeResponse =
            serde_json::from_value(wire).expect("an unknown method type must not fail initialize");

        // The terminal login is understood as such; the unknown type falls
        // back to the protocol's default rather than being dropped.
        let logins = logins_from(&response.auth_methods, "agent", &["acp".into()]);
        let terminal = logins.iter().find(|l| l.kind == AgentLoginKind::Terminal).unwrap();
        assert_eq!(terminal.method_id, "agent-login");
        assert_eq!(terminal.shell_line(), "agent acp --login");
        assert!(
            logins.iter().any(|l| l.method_id == "future" && l.kind == AgentLoginKind::Protocol),
            "an unrecognised type is the protocol's default, not a dropped method"
        );
    }

    /// The same applies to a response that carries no auth surface at all —
    /// most agents today. Nothing is offered, and nothing is called.
    #[test]
    fn an_agent_that_advertises_nothing_is_handled_without_a_login_or_a_call() {
        let response: v1::InitializeResponse =
            serde_json::from_value(serde_json::json!({ "protocolVersion": 1 })).unwrap();
        assert!(logins_from(&response.auth_methods, "agent", &[]).is_empty());
        assert_eq!(protocol_login_method(&response.auth_methods), None);
    }

    /// Every agent probed advertises a login; they just don't all advertise
    /// the same *kind*. Codex/OpenCode/Devin offer `agent`-typed methods,
    /// which ACP drives with `authenticate` — surfacing only the client-run
    /// kind meant three of four agents appeared to offer nothing (#19).
    #[test]
    fn both_kinds_of_login_are_offered() {
        let methods = vec![
            terminal_method("claude-ai-login", "Claude Subscription", &["--claudeai"]),
            v1::AuthMethod::Agent(v1::AuthMethodAgent::new(
                v1::AuthMethodId::new("chat-gpt"),
                "ChatGPT",
            )),
        ];
        let logins = logins_from(&methods, "npx", &["pkg".into()]);

        assert_eq!(logins.len(), 2);
        assert_eq!(logins[0].kind, AgentLoginKind::Terminal);
        assert_eq!(logins[0].shell_line(), "npx pkg --claudeai");

        assert_eq!(logins[1].kind, AgentLoginKind::Protocol);
        assert_eq!(logins[1].method_id, "chat-gpt");
        assert_eq!(logins[1].label, "ChatGPT");
        assert!(
            logins[1].command.is_empty(),
            "a protocol login has no command — the client calls `authenticate`"
        );
    }

    /// The real shapes, from probing each agent directly.
    #[test]
    fn the_installed_agents_all_produce_a_usable_login() {
        let cases: Vec<(&str, &str, &[String], Vec<v1::AuthMethod>, Vec<(&str, AgentLoginKind)>)> = vec![
            (
                "codex-acp",
                "npx",
                &[],
                vec![
                    v1::AuthMethod::Agent(v1::AuthMethodAgent::new(v1::AuthMethodId::new("api-key"), "API Key")),
                    v1::AuthMethod::Agent(v1::AuthMethodAgent::new(v1::AuthMethodId::new("chat-gpt"), "ChatGPT")),
                ],
                vec![("api-key", AgentLoginKind::Protocol), ("chat-gpt", AgentLoginKind::Protocol)],
            ),
            (
                "opencode",
                "opencode",
                &[],
                vec![v1::AuthMethod::Agent(v1::AuthMethodAgent::new(
                    v1::AuthMethodId::new("opencode-login"),
                    "Login with opencode",
                ))],
                vec![("opencode-login", AgentLoginKind::Protocol)],
            ),
            (
                "devin",
                "devin",
                &[],
                vec![v1::AuthMethod::Agent(v1::AuthMethodAgent::new(
                    v1::AuthMethodId::new("windsurf-api-key"),
                    "API Key",
                ))],
                vec![("windsurf-api-key", AgentLoginKind::Protocol)],
            ),
        ];

        for (agent, cmd, args, methods, expected) in cases {
            let logins = logins_from(&methods, cmd, args);
            assert_eq!(
                logins.iter().map(|l| (l.method_id.as_str(), l.kind)).collect::<Vec<_>>(),
                expected,
                "{agent} must offer a login"
            );
        }
    }
}
