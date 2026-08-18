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
    },
    Done,
    Crashed { exit_code: Option<i32>, message: String },
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
    let (role, content) = match event {
        ExecutorEvent::Text { text } => ("assistant", text.clone()),
        // Deltas are a live-rendering signal only — the complete
        // Text/Reasoning event that follows each one is what actually gets
        // persisted (below, capped like tool output).
        ExecutorEvent::TextDelta { .. }
        | ExecutorEvent::ReasoningDelta { .. }
        | ExecutorEvent::PermissionRequest { .. }
        | ExecutorEvent::Done => return,
        ExecutorEvent::Crashed { message, .. } => ("system", message.clone()),
        structured => ("tool", serde_json::to_string(&capped(structured)).unwrap_or_default()),
    };
    let _ = store::append_message(home, project_hash, thread_id, role, mode, &content, Some(session_id));
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
    if let Some(body) = cache.list(project_root) {
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
    let body = cache.show(project_root, name)?;
    serde_json::from_str(&body).ok()
}

/// Parse `isComplete` from `openspec status --change <name> --json` stdout.
/// Pure function for testability; `change_status` wraps it with the subprocess call.
pub fn parse_change_status(body: &str) -> Option<bool> {
    let v: Value = serde_json::from_str(body).ok()?;
    v.get("isComplete")?.as_bool()
}

/// Whether a change's planning artifacts are all complete, per `openspec status`.
/// Returns `None` when `openspec` isn't installed or the change doesn't exist.
pub fn openspec_change_status(
    cache: &crate::openspec_cache::OpenSpecCache,
    project_root: &Path,
    name: &str,
) -> Option<bool> {
    let body = cache.status(project_root, name)?;
    parse_change_status(&body)
}

/// Whether the project's changes validate, as the CLI judges it.
pub fn openspec_validate(
    cache: &crate::openspec_cache::OpenSpecCache,
    project_root: &Path,
) -> Option<bool> {
    // `validate` exits non-zero when something is invalid, which the adapter
    // reports as `None` — so a successful run means valid and a failed one
    // means either invalid or unavailable. Distinguishing those needs the
    // binary itself to exist.
    find_on_path("openspec")?;
    Some(cache.validate(project_root).is_some())
}

/// Archive one change via the openspec CLI. `--yes` skips the interactive
/// confirmation prompt (the subprocess has no stdin to answer it); `--json`
/// gives a stable machine-readable stdout. Returns that stdout on success;
/// `openspec` missing or a non-zero exit becomes an error string.
pub fn openspec_archive(
    cache: &crate::openspec_cache::OpenSpecCache,
    project_root: &Path,
    name: &str,
) -> crate::store::Res<String> {
    cache.archive(project_root, name).ok_or_else(|| {
        format!("`openspec archive {name}` failed — check that `openspec` is on PATH and the change exists")
    })
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

/// Snapshot for `newly_added_change` to diff against.
pub fn openspec_changes(
    cache: &crate::openspec_cache::OpenSpecCache,
    project_root: &Path,
) -> Vec<String> {
    openspec_list(cache, project_root).into_iter().map(|c| c.name).collect()
}

/// What a `/propose` turn produced. Ambiguity is surfaced, never dropped:
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

/// Set when `/propose` is in flight, so the change that `grill-propose`
/// creates can be spotted the moment the turn finishes.
pub struct ProposeWatch {
    pub project_hash: String,
    pub thread_id: String,
    pub project_root: PathBuf,
    pub before: Vec<String>,
}

pub struct Harness {
    /// Every live ACP session, keyed by its own id.
    pub acp_sessions: Mutex<HashMap<String, AcpSession>>,
    pub preflight: Mutex<Option<crate::acp_preflight::Preflight>>,
    /// Handoff transcripts waiting to ride along with a session's next prompt,
    /// keyed by session id. `ensure_session` parks the prefix here rather than
    /// handing it back, because a caller that starts a session without sending
    /// a prompt (`/go`) would otherwise drop it and lose the conversation.
    pub pending_prefix: Mutex<HashMap<String, String>>,
    pub pending_propose: Mutex<Option<ProposeWatch>>,
    pub watch: Mutex<Option<crate::integrations::Watcher>>,
    pub terminal: Mutex<Option<(String, crate::terminal::Terminal)>>,
    pub fswatch: Mutex<Option<crate::fswatch::FsWatcher>>,
    /// Buffered JSONL writer for session and thread logs; flushed on turn-done
    /// and app-quit (D9).
    pub session_log_writer: crate::session_log_writer::SharedSessionLogWriter,
    /// Mtime-keyed cache over `openspec` CLI output (D10).
    pub openspec_cache: std::sync::Arc<crate::openspec_cache::OpenSpecCache>,
    /// Local FIM completion sidecar (llama-server).
    pub completion_server: Mutex<Option<crate::completion::CompletionServer>>,
    /// Consecutive sidecar crashes; one restart, then disable for the session (D33).
    pub completion_crashes: Mutex<u8>,
    /// User-toggled enable/disable for AI completion.
    pub completion_enabled: Mutex<bool>,
    /// Configurable accept keybinding, stored as a CodeMirror key name.
    pub completion_keybinding: Mutex<String>,
}

impl Default for Harness {
    fn default() -> Self {
        Self {
            acp_sessions: Default::default(),
            preflight: Default::default(),
            pending_prefix: Default::default(),
            pending_propose: Default::default(),
            watch: Default::default(),
            terminal: Default::default(),
            fswatch: Default::default(),
            session_log_writer: crate::session_log_writer::shared_session_log_writer(),
            openspec_cache: std::sync::Arc::new(crate::openspec_cache::OpenSpecCache::with_real_adapter()),
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
    pub fn with_pending_prefix(&self, session_id: &str, content: &str) -> String {
        match self.pending_prefix.lock().unwrap().get(session_id) {
            Some(prefix) => format!("{prefix}\n\n{content}"),
            None => content.to_string(),
        }
    }

    /// Drop a session's parked transcript, once it has actually been sent.
    pub fn clear_pending_prefix(&self, session_id: &str) {
        self.pending_prefix.lock().unwrap().remove(session_id);
    }

    /// Whether *any* of a thread's sessions is mid-turn. A thread can hold
    /// several at once, so checking only the most recent one would let a
    /// delete land on files a live turn is about to append to.
    /// How many live sessions share a project root. More than one means two
    /// agents are writing the same tree with no coordination, so the dirty set
    /// cannot honestly be split between them (D13) — attribution says so
    /// rather than guessing.
    pub fn sessions_in_project(&self, project_hash: &str) -> usize {
        self.acp_sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .filter(|s| s.project_hash == project_hash)
            .count()
    }

    pub fn thread_is_busy(&self, thread_id: &str) -> bool {
        self.acp_sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .any(|s| s.thread_id == thread_id && s.is_busy())
    }
}

// ------------------------------------------------------------------ tests

#[cfg(test)]
mod tests {
    use super::*;

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
            serde_json::to_value(ExecutorEvent::Crashed { exit_code: Some(9), message: "x".into() })
                .unwrap();
        assert_eq!(crashed, serde_json::json!({ "kind": "crashed", "exitCode": 9, "message": "x" }));

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
}
