//! Executor detection, preflight checks, and the ACP client transport.
//!
//! All executors are now discovered at runtime via the ACP Registry and
//! spoken to over ACP (JSON-RPC 2.0 over stdio). The compiled-in agent table
//! and proprietary stream-json parsers are removed.

use std::collections::HashMap;

// ------------------------------------------------------------- grill skills
//
// The four grill skills are baked into Palisade as bundled resources so they
// work with every ACP agent without per-agent installation (D19). Each
// skill's full SKILL.md is injected into the agent's prompt based on the
// thread's mode — the agent receives the instructions as prompt text.

pub const GRILL_EXPLORE: &str = include_str!("../skills/grill-explore.md");
pub const GRILL_PROPOSE: &str = include_str!("../skills/grill-propose.md");
pub const GRILL_APPLY: &str = include_str!("../skills/grill-apply.md");
pub const GRILL_ARCHIVE: &str = include_str!("../skills/grill-archive.md");
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::acp_client::AcpSession;
use crate::store::{self, Res};
use crate::locks::MutexExt;

// Old compiled-in agent table removed — agents are now discovered at
// runtime via the ACP Registry (D1, D2). The Transport enum, Agent struct,
// KNOWN_AGENTS, CLAUDE, CODEX, and per-agent parsers are all gone (D3).
// See acp_registry.rs, acp_client.rs, acp_events.rs for replacements.

/// PATH lookup without spawning a shell (E6). Stdlib rather than the `which`
/// crate — same behavior in ~15 lines, one fewer dependency.
pub fn find_on_path(bin: &str) -> Option<PathBuf> {
    lookup(&std::env::var_os("PATH")?, bin).or_else(|| lookup(login_shell_path()?, bin))
}

fn lookup(path: &std::ffi::OsStr, bin: &str) -> Option<PathBuf> {
    std::env::split_paths(path)
        .map(|dir| dir.join(bin))
        .find(|candidate| is_executable(candidate))
}

/// The PATH to hand a spawned executor child.
///
/// `find_on_path` resolves the *binary itself* via the login shell fallback,
/// but `Command::spawn` otherwise hands the child this process's own inherited
/// environment — launchd's minimal PATH when launched from Finder/`/Applications`.
/// Both `claude` and `codex` shell out to their own tooling (git, node, ...),
/// so a child that resolves fine but starts with that minimal PATH can still
/// exit immediately. Give it the same PATH the login shell fallback used to
/// find it in the first place.
pub(crate) fn child_path_env() -> std::ffi::OsString {
    login_shell_path()
        .cloned()
        .or_else(|| std::env::var_os("PATH"))
        .unwrap_or_else(|| "/usr/bin:/bin:/usr/sbin:/sbin".into())
}

/// The login shell's PATH, resolved at most once.
///
/// An app launched from Finder inherits launchd's minimal PATH
/// (`/usr/bin:/bin:/usr/sbin:/sbin`), not the shell's — so a `claude` installed
/// under `~/.nvm/...` or `~/.local/bin` is invisible and the harness would sit
/// in chat-only mode with no way for the user to tell why. Asking the login
/// shell is the only way to see what the user's own terminal would see.
///
/// This is the one place a shell is spawned; E6's "no shell invocation" applies
/// to locating the binary, and this path only runs when the direct lookup has
/// already failed, so a terminal-launched app never pays for it.
pub(crate) fn login_shell_path() -> Option<&'static std::ffi::OsString> {
    static SHELL_PATH: std::sync::OnceLock<Option<std::ffi::OsString>> = std::sync::OnceLock::new();
    SHELL_PATH
        .get_or_init(|| {
            // launchd normally supplies SHELL, but default rather than give up:
            // returning None here would put the app back in chat-only mode.
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
            let output = Command::new(shell)
                .args(["-lic", "printf %s \"$PATH\""])
                .stderr(Stdio::null())
                .output()
                .ok()?;
            let path = String::from_utf8(output.stdout).ok()?;
            let path = path.trim();
            (!path.is_empty()).then(|| std::ffi::OsString::from(path))
        })
        .as_ref()
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

pub(crate) fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

// Old AgentStatus, Preflight, and preflight() removed — replaced by
// acp_preflight.rs (D16).

// ----------------------------------------------------------------- events

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
// `rename_all` covers variant names only — the fields need their own rule, or
// the frontend sees `is_error`/`exit_code` while its types expect camelCase.
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ExecutorEvent {
    Text { text: String },
    /// A turn's complete reasoning/thinking content, rendered as a
    /// collapsed "Thought for Ns" block (reasoning-collapse-ux D-design-2).
    /// `elapsed_secs` is computed backend-side, from the first reasoning
    /// delta to this complete event, so a reload shows the same number the
    /// live view did.
    Reasoning { text: String, elapsed_secs: u64 },
    /// A live fragment of an in-progress `Text`/`Reasoning` message
    /// (Claude's `stream_event` content-block deltas, D6/D27) — a
    /// rendering signal only, never persisted; the complete `Text`/
    /// `Reasoning` event that follows is the thing written to the log.
    TextDelta { text: String },
    ReasoningDelta { text: String },
    FileEdit { id: String, path: String, before: String, after: String },
    /// Emitted when the tool starts; `ToolResult` fills in its output later.
    ToolCall { id: String, name: String, command: String },
    /// A live fragment of a running tool call's output — a rendering signal
    /// only, never persisted. The `ToolResult` that follows is the thing
    /// written to the log. Without this a command's output does not appear
    /// until it exits.
    ToolOutputDelta { id: String, chunk: String },
    ToolResult { id: String, output: String, is_error: bool },
    /// A tool call whose permission policy returned `Prompt` (D7, D-design-1)
    /// — the agent's turn is paused awaiting `answer_permission_prompt`.
    /// Live-only, like the deltas: the fail-safe teardown resolves any
    /// still-pending request to denied, so nothing survives to replay.
    PermissionRequest {
        id: String,
        tool_call_id: String,
        tool_kind: String,
        command: Option<String>,
        paths: Vec<String>,
        /// Set when this command looks like it collides with another live
        /// session in the same project (same port or DATABASE_URL) —
        /// port-and-db-conflict-detection D1. Surfaced inline in the same
        /// prompt rather than a separate dialog.
        warning: Option<String>,
    },
    Done,
    /// A turn ended badly. `retryable` separates the two cases that used to
    /// share this variant: a turn the *live* agent refused or failed (auth
    /// expired, a cancelled turn) versus the agent process/connection being
    /// gone. Only the latter drops the thread's intent back to spec (#18).
    /// Absent on records written before the flag existed, which were all
    /// treated as real deaths — hence `default` (false).
    Crashed {
        exit_code: Option<i32>,
        message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        failure_class: Option<crate::acp_client::FailureClass>,
        #[serde(default)]
        retryable: bool,
    },
}

impl ExecutorEvent {
    /// The turn failed but the agent is still there — a prompt error, an
    /// expired login, a policy cancellation. The user can retry.
    pub fn turn_failed(message: String) -> Self {
        Self::turn_failed_classified(message, None)
    }

    pub fn turn_failed_classified(message: String, failure_class: Option<crate::acp_client::FailureClass>) -> Self {
        Self::Crashed { exit_code: None, message, failure_class, retryable: true }
    }

    /// The agent process or its connection is gone. Nothing to retry against.
    pub fn agent_died(exit_code: Option<i32>, message: String) -> Self {
        Self::Crashed { exit_code, message, failure_class: None, retryable: false }
    }
}

/// Whether this event should drop the thread's intent back to spec.
///
/// Only a dead agent does. Folding every failed prompt into `Crashed` meant a
/// retryable auth error silently flipped a Go thread back to Spec while the
/// UI was still offering a Retry button (#18).
pub fn crash_resets_mode(event: &ExecutorEvent) -> bool {
    matches!(event, ExecutorEvent::Crashed { retryable: false, .. })
}

// Old per-agent parsers removed — events are now mapped from ACP
// notifications via acp_events.rs (D13).

// ------------------------------------------------------- event persistence

/// How an event is written into the thread's JSONL so a reload can re-render
/// it. Plain text keeps its role; structured events are stored as JSON under
/// `role: "tool"` and re-parsed by the frontend.
pub fn persist(
    home: &Path,
    project_hash: &str,
    thread_id: &str,
    session_id: &str,
    mode: &str,
    event: &ExecutorEvent,
) {
    let (role, content, failure_class) = match event {
        ExecutorEvent::Text { text } => ("assistant", text.clone(), None),
        // Deltas are a live-rendering signal only — the complete
        // Text/Reasoning event that follows each one is what actually gets
        // persisted (below, capped like tool output).
        ExecutorEvent::TextDelta { .. }
        | ExecutorEvent::ReasoningDelta { .. }
        | ExecutorEvent::ToolOutputDelta { .. }
        | ExecutorEvent::PermissionRequest { .. }
        | ExecutorEvent::Done => return,
        ExecutorEvent::Crashed { message, failure_class, .. } => ("system", message.clone(), *failure_class),
        structured => ("tool", serde_json::to_string(&capped(structured)).unwrap_or_default(), None),
    };
    let _ = store::append_message_with_failure_class(home, project_hash, thread_id, role, mode, &content, Some(session_id), failure_class);
}

/// A full-file rewrite or a verbose build log written verbatim into permanent
/// thread history is unbounded growth for no benefit — nothing reads past the
/// cap. Only the durable copy is trimmed; the event handed to the sink (and so
/// to the live UI) keeps its whole payload.
const PERSIST_CAP: usize = 64 * 1024;

fn cap(text: &str) -> String {
    if text.len() <= PERSIST_CAP {
        return text.to_string();
    }
    // Never split a UTF-8 code point: back off to the nearest boundary at or
    // below the cap.
    let mut end = PERSIST_CAP;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n… [truncated {} bytes]", &text[..end], text.len() - end)
}

fn capped(event: &ExecutorEvent) -> ExecutorEvent {
    match event {
        ExecutorEvent::FileEdit { id, path, before, after } => ExecutorEvent::FileEdit {
            id: id.clone(),
            path: path.clone(),
            before: cap(before),
            after: cap(after),
        },
        ExecutorEvent::ToolResult { id, output, is_error } => ExecutorEvent::ToolResult {
            id: id.clone(),
            output: cap(output),
            is_error: *is_error,
        },
        ExecutorEvent::Reasoning { text, elapsed_secs } => ExecutorEvent::Reasoning {
            text: cap(text),
            elapsed_secs: *elapsed_secs,
        },
        other => other.clone(),
    }
}

// Old process management (Live, Session, Spawn, start, send, PumpCtx,
// pump, uuid_v4) removed — sessions are now backed by ACP ActiveSession
// via acp_client.rs (D17).

/// Every event leaves the harness stamped with where it came from.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Envelope {
    pub session_id: String,
    pub thread_id: String,
    pub event: ExecutorEvent,
}

/// Anything that can receive parsed events.
pub trait Sink: Send + Sync + 'static {
    fn emit_context(&self, _session_id: &str, _thread_id: &str, _update: serde_json::Value) {}
    fn emit(&self, envelope: &Envelope);

    /// The slash commands the agent advertises for a session. Session
    /// metadata, not conversation, so it bypasses `Envelope`/persistence
    /// entirely. Carries the thread id because this fires at session start,
    /// before any event has streamed — the frontend has no other way to know
    /// which thread's composer these belong to yet. Default no-op: only the
    /// app sink has a `/` menu to fill.
    fn emit_commands(
        &self,
        _session_id: &str,
        _thread_id: &str,
        _commands: &[crate::acp_events::AgentCommand],
    ) {
    }

    /// Whether the session's agent accepts image blocks (ACP
    /// `promptCapabilities.image`), sent once the session is live so the
    /// composer can say when an attached image will go as a path instead.
    fn emit_image_support(&self, _session_id: &str, _thread_id: &str, _images: bool) {}

    /// ACP usage is transport metadata rather than a transcript event. The
    /// app sink forwards billed cost to a chain turn watcher when one exists;
    /// ordinary sessions intentionally ignore it for now (D-d scope).
    fn emit_usage(
        &self,
        _session_id: &str,
        _thread_id: &str,
        _cost: Option<crate::acp_events::Cost>,
    ) {
    }
}

/// One change, as the `openspec` CLI reports it. Task counts are the agent's
/// own checkbox self-report and are labeled as such wherever shown — never
/// aggregated by Palisade into a claim that anything is complete (D11).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpecChange {
    pub name: String,
    #[serde(default)]
    pub completed_tasks: u32,
    #[serde(default)]
    pub total_tasks: u32,
    #[serde(default)]
    pub last_modified: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
}

/// The project's OpenSpec changes, asked of the CLI — which is the authority
/// on what a change *is* (D11). Falls back to the directory listing when
/// `openspec` isn't installed, which is exactly today's behavior.
pub fn openspec_list(
    cache: &crate::openspec_cache::OpenSpecCache,
    project_root: &Path,
) -> Vec<SpecChange> {
    if let Ok(body) = cache.list(project_root) {
        if let Some(changes) = parse_openspec_list(&body) {
            return changes;
        }
    }
    openspec_change_dirs(project_root)
        .into_iter()
        .map(|name| SpecChange {
            name,
            completed_tasks: 0,
            total_tasks: 0,
            last_modified: None,
            status: None,
        })
        .collect()
}

/// Split out from `openspec_list` so a captured real payload can be tested
/// without running the binary.
pub fn parse_openspec_list(body: &str) -> Option<Vec<SpecChange>> {
    serde_json::from_str::<Value>(body)
        .ok()?
        .get("changes")?
        .as_array()
        .map(|changes| {
            changes.iter().filter_map(|c| serde_json::from_value(c.clone()).ok()).collect()
        })
}

/// The full detail of one change, verbatim from the CLI. Palisade renders this and
/// writes none of it: the filesystem and `openspec` stay authoritative (D11).
pub fn openspec_show(
    cache: &crate::openspec_cache::OpenSpecCache,
    project_root: &Path,
    name: &str,
) -> Option<Value> {
    let body = cache.show(project_root, name).ok()?;
    serde_json::from_str(&body).ok()
}

/// Whether a change is ready to apply, from `openspec status --change <name>
/// --json` stdout. The CLI's own gate is `applyRequires` (e.g. just `tasks`):
/// `isComplete` also demands optional artifacts like `design`, so a change that
/// skips design on purpose would never be appliable. Falls back to `isComplete`
/// when the CLI doesn't report `applyRequires`.
/// Pure function for testability; `change_status` wraps it with the subprocess call.
pub fn parse_change_status(body: &str) -> Option<bool> {
    let v: Value = serde_json::from_str(body).ok()?;
    let complete = v.get("isComplete")?.as_bool()?;
    let (Some(required), Some(artifacts)) = (
        v.get("applyRequires").and_then(Value::as_array),
        v.get("artifacts").and_then(Value::as_array),
    ) else {
        return Some(complete);
    };
    Some(required.iter().filter_map(Value::as_str).all(|id| {
        artifacts.iter().any(|a| {
            a.get("id").and_then(Value::as_str) == Some(id)
                && a.get("status").and_then(Value::as_str) == Some("done")
        })
    }))
}

/// Whether a change's planning artifacts are all complete, per `openspec status`.
/// Returns `None` when `openspec` isn't installed or the change doesn't exist.
pub fn openspec_change_status(
    cache: &crate::openspec_cache::OpenSpecCache,
    project_root: &Path,
    name: &str,
) -> Option<bool> {
    let body = cache.status(project_root, name).ok()?;
    parse_change_status(&body)
}

/// Whether the project's changes validate, as the CLI judges it.
pub fn openspec_validate(
    cache: &crate::openspec_cache::OpenSpecCache,
    project_root: &Path,
) -> Option<bool> {
    // `validate` exits non-zero when something is invalid — that is a real
    // verdict. Every other failure (no binary, wouldn't start, hung) is "we
    // can't tell", which must not be rendered as "invalid" (#16).
    match cache.validate(project_root) {
        Ok(_) => Some(true),
        Err(crate::openspec_cache::OpenSpecError::Exit { .. }) => Some(false),
        Err(_) => None,
    }
}

/// Archive one change via the openspec CLI. `--yes` skips the interactive
/// confirmation prompt (the subprocess has no stdin to answer it); `--json`
/// gives a stable machine-readable stdout. Returns that stdout on success; on
/// failure the CLI's own diagnostic is what reaches the user, not a guess at
/// what might have gone wrong (#16).
pub fn openspec_archive(
    cache: &crate::openspec_cache::OpenSpecCache,
    project_root: &Path,
    name: &str,
) -> crate::store::Res<String> {
    cache
        .archive(project_root, name)
        .map_err(|e| crate::PalisadeError::from(format!("`openspec archive {name}` failed — {e}")))
}

/// Names of the OpenSpec change directories in a project — the fallback when
/// the CLI isn't there to ask.
pub fn openspec_change_dirs(project_root: &Path) -> Vec<String> {
    let dir = project_root.join("openspec/changes");
    fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .filter(|entry| entry.path().is_dir())
                .map(|entry| entry.file_name().to_string_lossy().to_string())
                .filter(|name| name != "archive")
                .collect()
        })
        .unwrap_or_default()
}

/// Change directories that already hold a `proposal.md`. A directory alone
/// means the agent has only scaffolded the change; linking it then sent users
/// to a viewer with nothing to show.
pub fn openspec_proposed_dirs(project_root: &Path) -> Vec<String> {
    openspec_change_dirs(project_root)
        .into_iter()
        .filter(|name| project_root.join("openspec/changes").join(name).join("proposal.md").is_file())
        .collect()
}

/// What a Spec turn produced. Ambiguity is surfaced, never dropped:
/// returning `None` for "two appeared" is how the durable spec link used to go
/// missing silently (D12).
#[derive(Debug, Clone, PartialEq)]
pub enum ProposeOutcome {
    None,
    One(String),
    /// More than one change appeared during a single propose turn — the user
    /// has to say which one this thread is working on.
    Ambiguous(Vec<String>),
}

pub fn newly_added_change(before: &[String], after: &[String]) -> ProposeOutcome {
    let mut added: Vec<String> =
        after.iter().filter(|name| !before.contains(name)).cloned().collect();
    added.sort();
    match added.len() {
        0 => ProposeOutcome::None,
        1 => ProposeOutcome::One(added.remove(0)),
        _ => ProposeOutcome::Ambiguous(added),
    }
}

/// How a thread recovers from an executor dying: its *intent* drops back to
/// spec, so the next turn doesn't start write-enabled off the back of a crash.
/// The dead session's handle is not cleared — it lives on that session's own
/// closed record now, and a record closed `crashed` is never resumed from.
/// History is append-only, so nothing here can cost messages.
pub fn on_crash(home: &Path, hash: &str, thread_id: &str) -> Res<()> {
    store::set_thread_mode(home, hash, thread_id, "spec")?;
    Ok(())
}

/// Snapshot for a Spec session so a newly created change can be linked to
/// its thread, whether the agent used grill-propose or created it directly.
pub struct ChangeWatch {
    pub project_hash: String,
    pub thread_id: String,
    pub project_root: PathBuf,
    pub before: Vec<String>,
}

/// A user turn that was written to its thread but could not be delivered
/// because the selected executor requested authentication. The payload is
/// deliberately non-secret and exists only for this app run; credentials stay
/// with the ACP agent.
#[derive(Debug, Clone)]
pub struct PendingAuthTurn {
    pub project_hash: String,
    pub thread_id: String,
    pub content: String,
    pub mode: String,
    pub bypass: bool,
    /// Stored image paths the blocked turn carried.
    pub attachments: Vec<String>,
    /// Skills picked into the tray for the blocked turn.
    pub skills: Vec<String>,
}

/// Everything belonging to a live ACP agent conversation.
///
/// Lifecycle: a session starts when a thread first needs an agent and ends
/// when that agent's process does. Nothing here outlives the agent.
#[derive(Default)]
pub struct AgentState {
    /// Latest ACP context occupancy and compaction state, keyed by session.
    pub contexts: Mutex<HashMap<String, crate::context_status::ContextStatus>>,
    /// Every live ACP session, keyed by its own id.
    pub acp_sessions: Mutex<HashMap<String, AcpSession>>,
    pub preflight: Mutex<Option<crate::acp_preflight::Preflight>>,
    /// Handoff transcripts waiting to ride along with a session's next prompt,
    /// keyed by session id. `ensure_session` parks the prefix here rather than
    /// handing it back, because a caller that starts a session without sending
    /// a prompt (`/go`) would otherwise drop it and lose the conversation.
    pub pending_prefix: Mutex<HashMap<String, String>>,
    /// Every user turn blocked on this executor's sign-in, queued in the
    /// order they were sent. A login is executor-scoped, so blocked turns
    /// queue behind one another rather than each triggering a competing
    /// OAuth flow; queuing (not dropping) is what backs the "will resume
    /// automatically" message a blocked turn is given.
    pub pending_auth_turns: Mutex<HashMap<String, Vec<PendingAuthTurn>>>,
    pub pending_changes: Mutex<HashMap<String, ChangeWatch>>,
    /// Threads whose built change a spec turn revised since their last build
    /// turn; the next build turn is told to re-read the proposal.
    pub revised_changes: Mutex<std::collections::HashSet<String>>,
    /// The last slash commands each session's agent advertised, keyed by
    /// session id. Agents send the list only at session start, so a reloaded
    /// webview reads it back from here instead of waiting for a new session.
    pub session_commands: Mutex<HashMap<String, Vec<crate::acp_events::AgentCommand>>>,
}

/// Everything scoped to an open project or window.
///
/// Lifecycle: created when a window opens a project and torn down when the
/// last window showing that project closes — which is why `fswatch` is a
/// map keyed by project hash rather than a single slot (#33).
pub struct WorkspaceState {
    /// Which project each window is showing, keyed by window label. The
    /// watchers below live exactly as long as some window still needs them.
    pub window_projects: Mutex<HashMap<String, String>>,
    /// Filesystem watchers, keyed by project hash. A map, not a slot: every
    /// project window shares this watcher (#33), and a single slot meant
    /// opening a second window silently stopped watching the first project.
    pub fswatch: Mutex<HashMap<String, crate::fswatch::FsWatcher>>,
    /// Mtime-keyed cache over `openspec` CLI output (D10).
    pub openspec_cache: std::sync::Arc<crate::openspec_cache::OpenSpecCache>,
}

/// Long-running child processes the editor drives: the debugger, the
/// terminals, the notebook kernels.
///
/// Lifecycle: each is started on demand by a pane and lives until that pane
/// closes or the app quits. Grouped because they share one hazard — every one
/// of them owns an OS process that has to be reaped (see `pidguard`).
#[derive(Default)]
pub struct ToolingState {
    /// The one live debug session, if any. Single by design: two debuggers
    /// attached to one project fight over breakpoints and the debuggee.
    pub debug_session: Mutex<Option<std::sync::Arc<crate::dap::DebugSession>>>,
    /// Every live terminal tab, keyed by tab id (several per project).
    pub terminals: crate::terminal::TerminalRegistry,
    /// Every open notebook's kernel process (design.md D2, decisions.md
    /// D16/D18), keyed by `notebook::notebook_id`.
    pub notebook_kernels: crate::notebook::NotebookRegistry,
}

/// The local FIM completion sidecar and the settings governing it.
///
/// Lifecycle: one sidecar per app, started lazily and restarted at most once
/// per session (D33).
pub struct CompletionState {
    /// Local FIM completion sidecar (llama-server).
    pub completion_server: Mutex<Option<crate::completion::CompletionServer>>,
    /// Consecutive sidecar crashes; one restart, then disable for the session (D33).
    pub completion_crashes: Mutex<u8>,
    /// User-toggled enable/disable for AI completion.
    pub completion_enabled: Mutex<bool>,
    /// Configurable accept keybinding, stored as a CodeMirror key name.
    pub completion_keybinding: Mutex<String>,
}

/// Everything belonging to a chain run in flight.
///
/// Lifecycle: created when a run starts and dropped when it finishes,
/// crashes or is cancelled. Held separately from `AgentState` on purpose —
/// a chain's sessions must never be handed to a user's `/go` (D25).
#[derive(Default)]
pub struct ChainState {
    /// Sessions a chain run owns, so `find_live_session` never hands one to a
    /// user pressing `/go` on the same thread (D25). Chain nodes run with
    /// go-mode permissions, which would otherwise make them look reusable.
    pub chain_sessions: Mutex<std::collections::HashSet<String>>,
    /// Per-session collectors letting a chain run await one node's turn:
    /// the sink appends `Text` and resolves on `Done`/`Crashed`.
    pub turn_watchers: Mutex<HashMap<String, std::sync::Arc<TurnWatch>>>,
    /// Approval gates waiting on a human, keyed by run id (D9).
    pub chain_gates: Mutex<HashMap<String, std::sync::mpsc::Sender<crate::chain_runner::Approval>>>,
    /// Cancellation flags for in-progress chain runs, keyed by run id (§4.2).
    /// The same `Arc` is handed to `ChainRun::walk`'s `cancel` parameter and
    /// to the run's `AcpNodeRunner`, so `cancel_chain_run` flipping it here
    /// is immediately visible to both the scheduler and any node turn
    /// currently polling it — one flag, not two mechanisms. Mirrors
    /// `chain_gates`'s shape and locking discipline exactly.
    pub chain_cancels: Mutex<HashMap<String, std::sync::Arc<std::sync::atomic::AtomicBool>>>,
}

/// The app's shared state, as five groups rather than twenty-one fields.
///
/// It was a single struct of twenty-one mutexes that twenty-one of the
/// thirty-four backend modules reached into. The per-field mutexes were never
/// the problem — subsystems genuinely do not contend, and that stays true
/// here, since the groups below hold the same mutexes and not a lock of their
/// own. What a flat struct could not say is which fields belong together and
/// how long each lives, so every new subsystem widened the same object.
///
/// Grouped by lifecycle, because that is what actually distinguishes them:
/// an agent's state dies with its process, a workspace's with its window, a
/// chain's with its run. Harness stays a thin container so a call site moves
/// by naming its group and nothing else.
///
/// Lock ordering across these groups is documented in `crate::locks`.
#[derive(Default)]
pub struct Harness {
    pub agent: AgentState,
    pub workspace: WorkspaceState,
    pub tooling: ToolingState,
    pub completion: CompletionState,
    pub chain: ChainState,
}

#[cfg(test)]
mod harness_shape_tests {
    use std::collections::BTreeMap;

    /// `pub` field counts per struct, read from this file.
    fn field_counts() -> BTreeMap<String, usize> {
        let src = include_str!("executor.rs");
        let mut counts = BTreeMap::new();
        for name in [
            "AgentState",
            "WorkspaceState",
            "ToolingState",
            "CompletionState",
            "ChainState",
            "Harness",
        ] {
            let at = src
                .find(&format!("pub struct {name} {{"))
                .unwrap_or_else(|| panic!("{name} is gone"));
            let end = src[at..].find("\n}").unwrap() + at;
            counts.insert(
                name.to_string(),
                src[at..end].matches("\n    pub ").count(),
            );
        }
        counts
    }

    /// Harness was one struct of twenty-one mutexes that twenty-one of the
    /// thirty-four backend modules reached into, and it widened with every
    /// subsystem added. The split only stays a split if the next subsystem
    /// has to choose a group rather than appending to a pile.
    #[test]
    fn no_group_grows_back_into_a_god_object() {
        for (name, count) in field_counts() {
            assert!(
                count <= 8,
                "{name} has {count} fields — pick a group, or add one"
            );
        }
    }

    /// The container itself must stay thin: it holds groups, never fields.
    /// A field added directly to Harness is a field that belongs to nothing.
    #[test]
    fn the_container_holds_only_groups() {
        let counts = field_counts();
        assert_eq!(counts["Harness"], 5, "Harness should hold exactly its groups");
        let grouped: usize = ["AgentState", "WorkspaceState", "ToolingState", "CompletionState", "ChainState"]
            .iter()
            .map(|n| counts[*n])
            .sum();
        assert_eq!(grouped, 22, "a field was dropped or added without a home");
    }

    /// The field comments are why this codebase is auditable; a refactor that
    /// loses them costs more than it saved.
    #[test]
    fn the_decision_notes_travelled_with_their_fields() {
        let src = include_str!("executor.rs");
        for note in ["#33", "D25", "D33", "D16/D18", "\u{a7}4.2"] {
            assert!(src.contains(note), "decision note {note} was lost in the split");
        }
    }
}

/// How a chain run watches one node's turn. The sink owns the writing end;
/// the runner blocks on `rx` until the turn ends.
pub struct TurnWatch {
    text: Mutex<String>,
    /// Latest cumulative billed cost reported by ACP for this turn's session.
    /// `None` is meaningful: the agent did not report cost, not that it was
    /// free. Kept out of `ExecutorEvent` so transcript events remain capped
    /// at their existing nine variants (D-d).
    cost: Mutex<Option<crate::acp_events::Cost>>,
    tx: Mutex<Option<std::sync::mpsc::Sender<TurnEnd>>>,
}

/// How a node's turn finished, from the sink's point of view.
#[derive(Debug, Clone, PartialEq)]
pub enum TurnEnd {
    Done,
    Crashed(String),
}

impl TurnWatch {
    pub fn new(tx: std::sync::mpsc::Sender<TurnEnd>) -> Self {
        Self { text: Mutex::new(String::new()), cost: Mutex::new(None), tx: Mutex::new(Some(tx)) }
    }

    pub fn push_text(&self, text: &str) {
        let mut buffer = self.text.lock_or_recover();
        if !buffer.is_empty() {
            buffer.push_str("\n\n");
        }
        buffer.push_str(text);
    }

    /// Everything the node said this turn — what feeds the next node.
    pub fn take_text(&self) -> String {
        std::mem::take(&mut *self.text.lock_or_recover())
    }

    /// Records ACP's cumulative session cost. A later usage update replaces
    /// the earlier total; adding them would double-count.
    pub fn record_cost(&self, cost: crate::acp_events::Cost) {
        *self.cost.lock_or_recover() = Some(cost);
    }

    /// Returns the latest reported cost without inventing a zero when the
    /// agent never supplied one.
    pub fn take_cost(&self) -> Option<crate::acp_events::Cost> {
        self.cost.lock_or_recover().clone()
    }

    /// Resolves the turn exactly once; a second `Done` (or a `Crashed` after
    /// one) is dropped rather than racing a later turn's receiver.
    pub fn finish(&self, end: TurnEnd) {
        if let Some(tx) = self.tx.lock_or_recover().take() {
            let _ = tx.send(end);
        }
    }
}

#[cfg(test)]
mod turn_watch_tests {
    use super::*;

    /// D-d: a chain watcher must retain an agent-reported billed cost while
    /// preserving absence for agents that do not report one. The field is
    /// deliberately outside `ExecutorEvent`: that enum is capped at nine
    /// variants and transcript events must not fabricate a cost update.
    #[test]
    fn cost_is_optional_and_latest_report_wins() {
        let (tx, _rx) = std::sync::mpsc::channel();
        let watch = TurnWatch::new(tx);

        assert_eq!(watch.take_cost(), None);
        watch.record_cost(crate::acp_events::Cost { amount: 0.001, currency: "USD".into() });
        watch.record_cost(crate::acp_events::Cost { amount: 0.0043, currency: "USD".into() });

        assert_eq!(
            watch.take_cost(),
            Some(crate::acp_events::Cost { amount: 0.0043, currency: "USD".into() })
        );
    }
}

impl Default for WorkspaceState {
    fn default() -> Self {
        Self {
            window_projects: Default::default(),
            fswatch: Default::default(),
            openspec_cache: std::sync::Arc::new(
                crate::openspec_cache::OpenSpecCache::with_real_adapter(),
            ),
        }
    }
}

impl Default for CompletionState {
    fn default() -> Self {
        Self {
            completion_server: Default::default(),
            completion_crashes: Mutex::new(0),
            completion_enabled: Mutex::new(true),
            completion_keybinding: Mutex::new("Alt-Tab".into()),
        }
    }
}

impl Harness {
    /// The text to actually send on a session: any handoff transcript parked
    /// for it rides along with this turn. Peeks rather than drains — a send
    /// that fails (session gone, agent mid-turn) must leave the transcript
    /// parked for the next attempt instead of eating it.
    /// The handoff transcript parked on a session, if any — sent as context
    /// ahead of the user's own words, never glued into them.
    pub fn pending_prefix(&self, session_id: &str) -> Option<String> {
        self.agent.pending_prefix.lock_or_recover().get(session_id).cloned()
    }

    /// Drop a session's parked transcript, once it has actually been sent.
    pub fn clear_pending_prefix(&self, session_id: &str) {
        self.agent.pending_prefix.lock_or_recover().remove(session_id);
    }

    /// Whether *any* of a thread's sessions is mid-turn. A thread can hold
    /// several at once, so checking only the most recent one would let a
    /// delete land on files a live turn is about to append to.
    /// How many live sessions share a project root. More than one means two
    /// agents are writing the same tree with no coordination, so the dirty set
    /// cannot honestly be split between them (D13) — attribution says so
    /// rather than guessing.
    pub fn sessions_in_project(&self, project_hash: &str) -> usize {
        self.agent.acp_sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .filter(|s| s.project_hash == project_hash)
            .count()
    }

    pub fn thread_is_busy(&self, thread_id: &str) -> bool {
        self.agent.acp_sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .any(|s| s.thread_id == thread_id && s.is_busy())
    }

    /// Queues a turn blocked on `agent_id`'s sign-in. A second (or third)
    /// blocked turn for the same executor appends rather than replacing the
    /// first — dropping it silently would break the "will resume
    /// automatically" promise the caller gives the user for every one of
    /// them.
    pub fn queue_pending_auth_turn(&self, agent_id: &str, turn: PendingAuthTurn) {
        self.agent.pending_auth_turns.lock_or_recover().entry(agent_id.to_string()).or_default().push(turn);
    }

    /// Takes every turn queued for `agent_id`, oldest first, leaving none
    /// behind. Pair with `requeue_pending_auth_turns` when delivery of one
    /// fails partway through, so turns not yet attempted are not lost.
    pub fn take_pending_auth_turns(&self, agent_id: &str) -> Vec<PendingAuthTurn> {
        self.agent.pending_auth_turns.lock_or_recover().remove(agent_id).unwrap_or_default()
    }

    /// Puts turns back at the front of `agent_id`'s queue, ahead of any that
    /// arrived while delivery was in progress.
    pub fn requeue_pending_auth_turns(&self, agent_id: &str, mut turns: Vec<PendingAuthTurn>) {
        if turns.is_empty() {
            return;
        }
        let mut map = self.agent.pending_auth_turns.lock_or_recover();
        let existing = map.entry(agent_id.to_string()).or_default();
        turns.append(existing);
        *existing = turns;
    }
}

// ------------------------------------------------------------------ tests

#[cfg(test)]
mod tests {
    use super::*;

    /// RED→GREEN: a second turn blocked on the same executor's sign-in must
    /// not be silently dropped — the system message told the user both turns
    /// would resume automatically.
    #[test]
    fn a_second_pending_auth_turn_for_the_same_agent_is_not_dropped() {
        let harness = Harness::default();
        let turn = |content: &str| PendingAuthTurn {
            project_hash: "proj".into(),
            thread_id: "thread-1".into(),
            content: content.into(),
            mode: "go".into(),
            bypass: false,
            attachments: Vec::new(),
            skills: Vec::new(),
        };
        harness.queue_pending_auth_turn("codex", turn("first message"));
        harness.queue_pending_auth_turn("codex", turn("second message"));

        let queued = harness.take_pending_auth_turns("codex");
        assert_eq!(
            queued.iter().map(|t| t.content.as_str()).collect::<Vec<_>>(),
            vec!["first message", "second message"],
            "both blocked turns must still be queued, in the order they were sent"
        );
    }

    /// A turn that fails auth again on delivery must go back in front of any
    /// turns queued after it, not lose them.
    #[test]
    fn requeueing_a_failed_delivery_preserves_turns_queued_meanwhile() {
        let harness = Harness::default();
        let turn = |content: &str| PendingAuthTurn {
            project_hash: "proj".into(),
            thread_id: "thread-1".into(),
            content: content.into(),
            mode: "go".into(),
            bypass: false,
            attachments: Vec::new(),
            skills: Vec::new(),
        };
        let mut queued = harness.take_pending_auth_turns("codex");
        queued.push(turn("still-blocked"));
        // A new turn arrives while delivery of the queue above is in flight.
        harness.queue_pending_auth_turn("codex", turn("arrived-during-retry"));
        harness.requeue_pending_auth_turns("codex", queued);

        let result = harness.take_pending_auth_turns("codex");
        assert_eq!(
            result.iter().map(|t| t.content.as_str()).collect::<Vec<_>>(),
            vec!["still-blocked", "arrived-during-retry"]
        );
    }

    #[test]
    fn find_on_path_locates_a_real_binary_and_rejects_a_fake_one() {
        assert!(find_on_path("sh").is_some());
        assert!(find_on_path("definitely-not-a-real-binary-xyz").is_none());
    }

    // --------------------------------------------------- 6a.3: parse_change_status

    /// RED→GREEN 6a.3: parse_change_status reads isComplete from openspec status JSON.
    #[test]
    fn parse_change_status_reads_is_complete() {
        let body = r#"{"isComplete": true, "changeName": "my-change"}"#;
        assert_eq!(parse_change_status(body), Some(true));
    }

    #[test]
    fn parse_change_status_reads_false() {
        let body = r#"{"isComplete": false, "changeName": "my-change"}"#;
        assert_eq!(parse_change_status(body), Some(false));
    }

    #[test]
    fn a_change_that_skips_optional_design_is_ready_when_apply_requires_are_done() {
        let body = r#"{"isComplete": false, "applyRequires": ["tasks"], "artifacts": [
            {"id": "proposal", "status": "done"}, {"id": "design", "status": "ready"},
            {"id": "tasks", "status": "done"}]}"#;
        assert_eq!(parse_change_status(body), Some(true));
        let unfinished = body.replace(r#"{"id": "tasks", "status": "done"}"#, r#"{"id": "tasks", "status": "blocked"}"#);
        assert_eq!(parse_change_status(&unfinished), Some(false));
    }

    #[test]
    fn parse_change_status_returns_none_for_invalid_json() {
        assert_eq!(parse_change_status("not json"), None);
    }

    #[test]
    fn parse_change_status_returns_none_when_field_missing() {
        assert_eq!(parse_change_status(r#"{"changeName": "my-change"}"#), None);
    }

    #[test]
    fn a_binary_outside_the_minimal_path_is_still_found() {
        let on_env_path = std::env::var_os("PATH")
            .and_then(|path| lookup(&path, "claude"))
            .is_some();
        let found = find_on_path("claude");
        println!(
            "claude on the inherited PATH: {on_env_path}; resolved: {:?}",
            found.as_deref()
        );
        if let Some(claude) = found {
            assert!(claude.exists(), "resolved claude must be a real file");
            assert!(is_executable(&claude));
        } else {
            assert!(
                login_shell_path().is_none_or(|path| lookup(path, "claude").is_none()),
                "claude is on the login shell PATH but find_on_path missed it"
            );
        }
    }

    #[test]
    fn events_serialize_as_camel_case_for_the_frontend() {
        let json = serde_json::to_value(ExecutorEvent::ToolResult {
            id: "t1".into(),
            output: "out".into(),
            is_error: true,
        })
        .unwrap();
        assert_eq!(json, serde_json::json!({ "kind": "toolResult", "id": "t1", "output": "out", "isError": true }));

        let crashed =
            serde_json::to_value(ExecutorEvent::agent_died(Some(9), "x".into())).unwrap();
        assert_eq!(
            crashed,
            serde_json::json!({ "kind": "crashed", "exitCode": 9, "message": "x", "retryable": false })
        );

        let edit = serde_json::to_value(ExecutorEvent::FileEdit {
            id: "t2".into(),
            path: "/a".into(),
            before: "b".into(),
            after: "a".into(),
        })
        .unwrap();
        assert_eq!(edit["kind"], "fileEdit");

        let text_delta = serde_json::to_value(ExecutorEvent::TextDelta { text: "hi".into() }).unwrap();
        assert_eq!(text_delta, serde_json::json!({ "kind": "textDelta", "text": "hi" }));

        let reasoning_delta =
            serde_json::to_value(ExecutorEvent::ReasoningDelta { text: "hm".into() }).unwrap();
        assert_eq!(reasoning_delta, serde_json::json!({ "kind": "reasoningDelta", "text": "hm" }));

        let reasoning = serde_json::to_value(ExecutorEvent::Reasoning {
            text: "thinking".into(),
            elapsed_secs: 4,
        })
        .unwrap();
        assert_eq!(
            reasoning,
            serde_json::json!({ "kind": "reasoning", "text": "thinking", "elapsedSecs": 4 })
        );

        let permission_request = serde_json::to_value(ExecutorEvent::PermissionRequest {
            id: "req-1".into(),
            tool_call_id: "tc-1".into(),
            tool_kind: "execute".into(),
            command: Some("cargo build".into()),
            paths: vec![],
            warning: None,
        })
        .unwrap();
        assert_eq!(
            permission_request,
            serde_json::json!({
                "kind": "permissionRequest",
                "id": "req-1",
                "toolCallId": "tc-1",
                "toolKind": "execute",
                "command": "cargo build",
                "paths": [],
                "warning": null,
            })
        );
    }

    #[test]
    fn a_new_openspec_change_is_detected_and_ambiguity_is_surfaced() {
        let before = vec!["a".to_string()];
        assert_eq!(
            newly_added_change(&before, &["a".into(), "b".into()]),
            ProposeOutcome::One("b".into())
        );
        assert_eq!(newly_added_change(&before, &["a".into()]), ProposeOutcome::None);
        assert_eq!(
            newly_added_change(&before, &["a".into(), "c".into(), "b".into()]),
            ProposeOutcome::Ambiguous(vec!["b".into(), "c".into()]),
            "both candidates are reported, so the user can pick"
        );
    }

    #[test]
    fn a_real_openspec_list_payload_parses() {
        let captured = r#"{
          "changes": [
            {
              "name": "agent-session-architecture",
              "completedTasks": 48,
              "totalTasks": 71,
              "lastModified": "2026-08-09T17:52:49.239Z",
              "status": "in-progress"
            },
            {
              "name": "ide-pivot",
              "completedTasks": 66,
              "totalTasks": 66,
              "lastModified": "2026-08-07T13:33:07.153Z",
              "status": "complete"
            }
          ],
          "root": { "path": "/Users/x/dev/palisade-code", "source": "nearest" }
        }"#;
        let changes = parse_openspec_list(captured).unwrap();
        assert_eq!(changes.len(), 2);
        assert_eq!(changes[0].name, "agent-session-architecture");
        assert_eq!((changes[0].completed_tasks, changes[0].total_tasks), (48, 71));
        assert_eq!(changes[1].status.as_deref(), Some("complete"));

        let sparse = r#"{"changes":[{"name":"x","somethingNew":1}]}"#;
        let changes = parse_openspec_list(sparse).unwrap();
        assert_eq!(changes[0].name, "x");
        assert_eq!(changes[0].total_tasks, 0);

        assert!(parse_openspec_list("not json").is_none());
        assert!(parse_openspec_list(r#"{"other":[]}"#).is_none());
    }

    #[test]
    fn a_scaffolded_change_without_a_proposal_is_not_proposed() {
        let repo = tempfile::tempdir().unwrap();
        let changes = repo.path().join("openspec/changes");
        fs::create_dir_all(changes.join("scaffold-only")).unwrap();
        fs::create_dir_all(changes.join("written")).unwrap();
        fs::write(changes.join("written/proposal.md"), "# p").unwrap();

        assert_eq!(openspec_proposed_dirs(repo.path()), vec!["written".to_string()]);
        // The link fires when the proposal lands, not when the directory does.
        let before = openspec_proposed_dirs(repo.path());
        fs::write(changes.join("scaffold-only/proposal.md"), "# p").unwrap();
        let after = openspec_proposed_dirs(repo.path());
        assert_eq!(newly_added_change(&before, &after), ProposeOutcome::One("scaffold-only".into()));
    }

    #[test]
    fn a_missing_openspec_binary_degrades_to_the_directory_listing() {
        let repo = tempfile::tempdir().unwrap();
        let changes = repo.path().join("openspec/changes");
        fs::create_dir_all(changes.join("some-change")).unwrap();
        fs::create_dir_all(changes.join("archive")).unwrap();

        let cache = crate::openspec_cache::OpenSpecCache::with_real_adapter();
        let listed = openspec_list(&cache, repo.path());
        assert_eq!(listed.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), vec!["some-change"]);
        assert_eq!(listed[0].total_tasks, 0, "the fallback claims no task counts it can't know");

        assert_eq!(openspec_show(&cache, repo.path(), "some-change"), None);
        assert!(openspec_change_dirs(repo.path()).contains(&"some-change".to_string()));
    }

    /// RED→GREEN: reasoning now persists (role "tool", capped JSON) like
    /// tool calls, so it survives a reload (reasoning-collapse-ux D-design-1)
    /// — `Done` is still the only one of this group that's discarded.
    #[test]
    fn reasoning_is_persisted_like_tool_calls_and_text() {
        let home = tempfile::tempdir().unwrap();
        let repo = tempfile::tempdir().unwrap();
        let project = store::add_project(home.path(), repo.path()).unwrap();
        let thread = store::create_thread(home.path(), &project.hash, "t").unwrap();

        for event in [
            ExecutorEvent::Reasoning { text: "secret".into(), elapsed_secs: 3 },
            ExecutorEvent::Text { text: "visible".into() },
            ExecutorEvent::ToolCall { id: "t1".into(), name: "Bash".into(), command: "ls".into() },
            ExecutorEvent::Done,
        ] {
            persist(home.path(), &project.hash, &thread.id, "sess-1", "go", &event);
        }
        store::flush_session_log_writer().unwrap();

        let messages = store::read_thread(home.path(), &project.hash, &thread.id).unwrap();
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0].role, "tool");
        let reasoning: ExecutorEvent = serde_json::from_str(&messages[0].content).unwrap();
        assert_eq!(
            reasoning,
            ExecutorEvent::Reasoning { text: "secret".into(), elapsed_secs: 3 }
        );
        assert_eq!(messages[1].role, "assistant");
        assert_eq!(messages[1].content, "visible");
        assert_eq!(messages[2].role, "tool");
        let round_trip: ExecutorEvent = serde_json::from_str(&messages[2].content).unwrap();
        assert!(matches!(round_trip, ExecutorEvent::ToolCall { .. }));
    }

    fn fixture() -> (tempfile::TempDir, tempfile::TempDir, String, String) {
        let home = tempfile::tempdir().unwrap();
        let repo = tempfile::tempdir().unwrap();
        let project = store::add_project(home.path(), repo.path()).unwrap();
        let thread = store::create_thread(home.path(), &project.hash, "t").unwrap();
        (home, repo, project.hash, thread.id)
    }

    #[test]
    fn a_crash_reverts_the_thread_and_clears_its_session() {
        let (home, _repo, hash, thread_id) = fixture();
        store::append_message(home.path(), &hash, &thread_id, "user", "go", "before the crash", None).unwrap();
        store::set_thread_mode(home.path(), &hash, &thread_id, "go").unwrap();
        store::open_session(
            home.path(), &hash, &thread_id, "s1", "claude", "go", Some("sess-1"), None, None,
        )
        .unwrap();
        store::close_session(home.path(), &hash, &thread_id, "s1", "crashed", None).unwrap();
        store::flush_session_log_writer().unwrap();

        on_crash(home.path(), &hash, &thread_id).unwrap();

        let meta = store::list_threads(home.path(), &hash).unwrap().remove(0);
        assert_eq!(meta.current_mode, "spec", "a crash drops the thread's intent back to spec");
        let records = store::read_sessions(home.path(), &hash, &thread_id).unwrap();
        assert_eq!(records[0].outcome.as_deref(), Some("crashed"));
        assert_eq!(records[0].provider_handle.as_deref(), Some("sess-1"));
        let messages = store::read_thread(home.path(), &hash, &thread_id).unwrap();
        assert!(messages.iter().any(|m| m.content == "before the crash"));
    }

    #[test]
    fn capping_never_splits_a_utf8_code_point() {
        let text = "é".repeat(PERSIST_CAP);
        let capped = cap(&text);
        assert!(capped.starts_with('é'));
        assert!(capped.contains("[truncated"));
    }

    /// RED→GREEN 1.5: reasoning longer than PERSIST_CAP is truncated without
    /// splitting a UTF-8 code point, mirroring `capping_never_splits_a_utf8_code_point`.
    #[test]
    fn reasoning_capping_never_splits_a_utf8_code_point() {
        let text = "é".repeat(PERSIST_CAP);
        let event = ExecutorEvent::Reasoning { text: text.clone(), elapsed_secs: 5 };
        let ExecutorEvent::Reasoning { text: capped_text, elapsed_secs } = capped(&event) else {
            panic!("expected Reasoning");
        };
        assert!(capped_text.starts_with('é'));
        assert!(capped_text.contains("[truncated"));
        assert_eq!(elapsed_secs, 5);
    }

    // ------------------------------------------------- openspec error paths

    use crate::openspec_cache::{InMemoryOpenSpecAdapter, OpenSpecCache, OpenSpecError};

    fn spec_cache(adapter: InMemoryOpenSpecAdapter) -> OpenSpecCache {
        OpenSpecCache::new(std::sync::Arc::new(adapter))
    }

    /// #16 RED: the reported bug — every archive failure read as "check that
    /// openspec is on PATH", whatever actually went wrong.
    #[test]
    fn archive_failure_surfaces_the_real_openspec_error() {
        let repo = tempfile::tempdir().unwrap();
        let mut adapter = InMemoryOpenSpecAdapter::default();
        adapter.archive.insert(
            "add-thing".into(),
            Err(OpenSpecError::Exit {
                code: Some(1),
                output: "Error: change 'add-thing' has incomplete tasks".into(),
            }),
        );
        let err = openspec_archive(&spec_cache(adapter), repo.path(), "add-thing").unwrap_err();

        assert!(err.contains("change 'add-thing' has incomplete tasks"), "got: {err}");
        assert!(err.contains("add-thing"));
        assert!(
            !err.contains("check that `openspec` is on PATH"),
            "the generic guess must not replace the real error: {err}"
        );
    }

    /// The one case the old message actually described still says so.
    #[test]
    fn archive_without_the_binary_still_says_it_is_not_installed() {
        let repo = tempfile::tempdir().unwrap();
        let err = openspec_archive(&spec_cache(InMemoryOpenSpecAdapter::default()), repo.path(), "c")
            .unwrap_err();
        assert!(err.contains("not on PATH"), "got: {err}");
    }

    #[test]
    fn archive_timeout_is_reported_as_a_timeout() {
        let repo = tempfile::tempdir().unwrap();
        let mut adapter = InMemoryOpenSpecAdapter::default();
        adapter.archive.insert("c".into(), Err(OpenSpecError::TimedOut { seconds: 10 }));
        let err = openspec_archive(&spec_cache(adapter), repo.path(), "c").unwrap_err();
        assert!(err.contains("timed out"), "got: {err}");
    }

    #[test]
    fn archive_success_returns_the_cli_stdout_verbatim() {
        let repo = tempfile::tempdir().unwrap();
        let mut adapter = InMemoryOpenSpecAdapter::default();
        adapter.archive.insert("c".into(), Ok(r#"{"archived":"c"}"#.into()));
        assert_eq!(
            openspec_archive(&spec_cache(adapter), repo.path(), "c").unwrap(),
            r#"{"archived":"c"}"#
        );
    }

    /// The read paths keep degrading the way they always did — an error is
    /// still "we can't tell", it just no longer starts life as a `None`.
    #[test]
    fn list_falls_back_to_the_directory_listing_when_the_cli_errors() {
        let repo = tempfile::tempdir().unwrap();
        fs::create_dir_all(repo.path().join("openspec/changes/on-disk")).unwrap();
        let mut adapter = InMemoryOpenSpecAdapter::default();
        adapter.list = Err(OpenSpecError::Exit { code: Some(1), output: "broken".into() });

        let listed = openspec_list(&spec_cache(adapter), repo.path());
        assert_eq!(listed.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), vec!["on-disk"]);
    }

    #[test]
    fn show_and_status_are_none_when_the_cli_errors() {
        let repo = tempfile::tempdir().unwrap();
        let mut adapter = InMemoryOpenSpecAdapter::default();
        adapter.show.insert("c".into(), Err(OpenSpecError::TimedOut { seconds: 10 }));
        adapter.status.insert("c".into(), Err(OpenSpecError::Spawn("nope".into())));
        let cache = spec_cache(adapter);

        assert_eq!(openspec_show(&cache, repo.path(), "c"), None);
        assert_eq!(openspec_change_status(&cache, repo.path(), "c"), None);
    }

    /// "Invalid" and "we couldn't ask" were the same answer before: the CLI
    /// exits non-zero for invalid changes, and that collapsed into the same
    /// `None` a missing binary produced.
    #[test]
    fn validate_distinguishes_invalid_from_unavailable() {
        let repo = tempfile::tempdir().unwrap();

        let mut valid = InMemoryOpenSpecAdapter::default();
        valid.validate = Ok("all good".into());
        assert_eq!(openspec_validate(&spec_cache(valid), repo.path()), Some(true));

        let mut invalid = InMemoryOpenSpecAdapter::default();
        invalid.validate = Err(OpenSpecError::Exit { code: Some(1), output: "3 issues".into() });
        assert_eq!(openspec_validate(&spec_cache(invalid), repo.path()), Some(false));

        // Not installed, couldn't start, or hung: no verdict to report.
        for unavailable in [
            OpenSpecError::NotInstalled,
            OpenSpecError::Spawn("permission denied".into()),
            OpenSpecError::TimedOut { seconds: 10 },
        ] {
            let mut adapter = InMemoryOpenSpecAdapter::default();
            adapter.validate = Err(unavailable);
            assert_eq!(openspec_validate(&spec_cache(adapter), repo.path()), None);
        }
    }

    // ------------------------------------------- #18: retryable vs fatal

    /// #18 RED: an auth failure mid-turn is a failed *turn*, not a dead
    /// agent — the thread's Go intent must survive it, because the UI is
    /// offering the user a Retry for exactly that error.
    #[test]
    fn a_retryable_turn_failure_does_not_reset_the_thread_mode() {
        let (home, _repo, hash, thread_id) = fixture();
        store::set_thread_mode(home.path(), &hash, &thread_id, "go").unwrap();

        let event = ExecutorEvent::turn_failed(
            "prompt failed: Failed to authenticate: OAuth session expired".into(),
        );
        assert!(!crash_resets_mode(&event), "a live agent's failed turn is not a crash");

        // The gate is what lib.rs applies; with it, mode is left alone.
        if crash_resets_mode(&event) {
            on_crash(home.path(), &hash, &thread_id).unwrap();
        }
        let meta = store::list_threads(home.path(), &hash).unwrap().remove(0);
        assert_eq!(meta.current_mode, "go");
    }

    #[test]
    fn a_dead_agent_still_resets_the_thread_mode() {
        let (home, _repo, hash, thread_id) = fixture();
        store::set_thread_mode(home.path(), &hash, &thread_id, "go").unwrap();

        let event = ExecutorEvent::agent_died(Some(1), "connection closed".into());
        assert!(crash_resets_mode(&event));

        if crash_resets_mode(&event) {
            on_crash(home.path(), &hash, &thread_id).unwrap();
        }
        let meta = store::list_threads(home.path(), &hash).unwrap().remove(0);
        assert_eq!(meta.current_mode, "spec", "a dead agent must not leave the thread write-enabled");
    }

    #[test]
    fn only_a_crash_can_reset_the_mode_at_all() {
        for event in [ExecutorEvent::Done, ExecutorEvent::Text { text: "hi".into() }] {
            assert!(!crash_resets_mode(&event));
        }
    }

    /// Crash records written before the flag existed have to keep reading as
    /// what they were: real process deaths.
    #[test]
    fn a_crash_record_without_the_flag_deserializes_as_fatal() {
        let old: ExecutorEvent =
            serde_json::from_value(serde_json::json!({ "kind": "crashed", "message": "boom" }))
                .unwrap();
        assert_eq!(old, ExecutorEvent::agent_died(None, "boom".into()));
        assert!(crash_resets_mode(&old));
    }

    #[test]
    fn the_retryable_flag_reaches_the_frontend_as_camel_case_json() {
        let json = serde_json::to_value(ExecutorEvent::turn_failed("nope".into())).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "kind": "crashed", "exitCode": null, "message": "nope", "retryable": true })
        );
    }

    /// Both kinds still land in the transcript as the user-visible system
    /// line they always were — the flag changes recovery, not the record.
    #[test]
    fn both_kinds_of_crash_are_still_persisted_as_system_messages() {
        let (home, _repo, hash, thread_id) = fixture();
        for event in [
            ExecutorEvent::turn_failed("prompt failed: Authentication required".into()),
            ExecutorEvent::agent_died(Some(1), "process exited".into()),
        ] {
            persist(home.path(), &hash, &thread_id, "s1", "go", &event);
        }
        store::flush_session_log_writer().unwrap();

        let messages = store::read_thread(home.path(), &hash, &thread_id).unwrap();
        assert_eq!(messages.len(), 2);
        assert!(messages.iter().all(|m| m.role == "system"));
        assert!(messages[0].content.contains("Authentication required"));
    }
}
