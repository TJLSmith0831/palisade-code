//! Executor detection, preflight checks, and the two process adapters.
//!
//! Claude and Codex are architecturally different (D11): Claude is one
//! persistent process fed newline-delimited JSON on stdin; Codex has no
//! persistent mode, so every turn is a fresh `codex exec resume --last`.
//! Both parsers map into one `ExecutorEvent` so nothing downstream cares.

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::store::{self, Res};

// ------------------------------------------------------------- detection

/// How an agent's process is shaped. A genuine difference, not accidental
/// coupling: Claude is one long-lived process fed JSON on stdin; Codex has no
/// persistent mode, so every turn is its own `codex exec`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Transport {
    Persistent,
    PerTurn,
}

/// Everything the harness needs to build one turn's argv.
pub struct SpawnCtx<'a> {
    pub mode: &'a str,
    /// The agent's own conversation handle.
    pub handle: &'a str,
    /// Continue an existing conversation rather than start one.
    pub resume: bool,
    pub project_root: &'a Path,
    /// The turn text — only per-turn transports put it in argv.
    pub message: &'a str,
    /// The model alias to pass to `--model`, if the thread overrode the default.
    /// None means the executor's own default model is used.
    pub model: Option<&'a str>,
    /// Whether to spawn with the executor's approval-skipping flag.
    pub bypass: bool,
}

/// One known agent, as data. Adding a third is one row here plus its parser:
/// no new enum variant, no new `match` arm in `lib.rs`, no change to the TS
/// boundary. Deliberately *not* a `trait Executor` with `Box<dyn>` (D5) — two
/// implementations with genuinely different process shapes are better served
/// by an explicit table than by a trait general enough to hide the difference.
pub struct Agent {
    pub id: &'static str,
    pub bin: &'static str,
    pub label: &'static str,
    pub transport: Transport,
    /// How a skill is invoked in this agent's chat input.
    pub skill_prefix: &'static str,
    /// Where this agent looks for user-level skills, relative to `$HOME`.
    pub skill_dir: &'static str,
    /// Where the Ponytail plugin lands for this agent, relative to `$HOME`.
    pub plugin_dir: &'static str,
    /// The permission flag value for a given harness mode.
    pub permission: fn(&str) -> &'static str,
    pub args: fn(&SpawnCtx) -> Vec<String>,
    pub parse: fn(&Value, &dyn Fn(&str) -> String) -> Vec<ExecutorEvent>,
}

impl PartialEq for Agent {
    fn eq(&self, other: &Self) -> bool {
        self.id == other.id
    }
}

impl std::fmt::Debug for Agent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Agent").field("id", &self.id).finish()
    }
}

pub const KNOWN_AGENTS: &[Agent] = &[CLAUDE, CODEX];

/// The agent with this id, if the table knows it.
pub fn agent_by_id(id: &str) -> Option<&'static Agent> {
    KNOWN_AGENTS.iter().find(|agent| agent.id == id)
}

const CLAUDE: Agent = Agent {
    id: "claude",
    bin: "claude",
    label: "Claude Code",
    transport: Transport::Persistent,
    skill_prefix: "/",
    skill_dir: ".claude/skills",
    plugin_dir: ".claude/plugins/cache/ponytail",
    permission: |mode| if mode == "go" { "acceptEdits" } else { "plan" },
    args: |ctx| {
        let mut args: Vec<String> = [
            "--print",
            "--verbose",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--include-partial-messages",
            "--permission-mode",
            (CLAUDE.permission)(ctx.mode),
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        // --session-id sets the id up front; --resume reuses it after a handoff.
        args.push(if ctx.resume { "--resume".into() } else { "--session-id".into() });
        args.push(ctx.handle.to_string());
        if let Some(model) = ctx.model {
            args.push("--model".into());
            args.push(model.to_string());
        }
        if ctx.bypass {
            args.push("--dangerously-skip-permissions".into());
        }
        args
    },
    parse: parse_claude_line,
};

const CODEX: Agent = Agent {
    id: "codex",
    bin: "codex",
    label: "Codex",
    transport: Transport::PerTurn,
    skill_prefix: "$",
    skill_dir: ".agents/skills",
    plugin_dir: ".agents/skills/ponytail",
    permission: |mode| if mode == "go" { "workspace-write" } else { "read-only" },
    args: |ctx| {
        let mut args: Vec<String> = vec!["exec".into()];
        if ctx.resume {
            args.push("resume".into());
            args.push("--last".into());
        }
        args.push(ctx.message.to_string());
        args.push("--json".into());
        args.push("--sandbox".into());
        args.push((CODEX.permission)(ctx.mode).into());
        // Observed: `codex exec` refuses to run outside a git repo ("Not
        // inside a trusted directory"). The harness registers projects by path
        // and never required them to be git repos, so without this every turn
        // fails on a non-git project.
        args.push("--skip-git-repo-check".into());
        args.push("-C".into());
        args.push(ctx.project_root.to_string_lossy().to_string());
        if let Some(model) = ctx.model {
            args.push("--model".into());
            args.push(model.to_string());
        }
        if ctx.bypass {
            args.push("--dangerously-bypass-approvals-and-sandbox".into());
        }
        args
    },
    // Codex's parser takes no `read_before`: its `file_change` items already
    // carry both sides of the edit.
    parse: |value, _| parse_codex_line(value),
};

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
fn login_shell_path() -> Option<&'static std::ffi::OsString> {
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

/// Detection status for one known agent. A list of these replaces the named
/// `claude`/`codex` fields, so a third agent needs no new field and no
/// frontend change to be shown.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    pub id: String,
    pub label: String,
    pub path: Option<String>,
    pub skills_ok: bool,
    pub plugin_ok: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preflight {
    /// One entry per row of `KNOWN_AGENTS`, in table order.
    pub agents: Vec<AgentStatus>,
    /// The id of the first agent in table order that was found on PATH.
    pub selected: Option<String>,
    pub openspec: bool,
    pub grill_apply: bool,
    pub ponytail: bool,
    pub graphify: bool,
    /// True when a change-linked `/go` has everything it needs.
    pub ready: bool,
    pub warnings: Vec<String>,
    pub checked_at: String,
}

impl Preflight {
    pub fn agent(&self, id: &str) -> Option<&AgentStatus> {
        self.agents.iter().find(|a| a.id == id)
    }
}

pub fn preflight() -> Preflight {
    let agents: Vec<AgentStatus> = KNOWN_AGENTS
        .iter()
        .map(|agent| AgentStatus {
            id: agent.id.to_string(),
            label: agent.label.to_string(),
            path: find_on_path(agent.bin).map(|p| p.to_string_lossy().to_string()),
            skills_ok: home().join(agent.skill_dir).join("grill-apply").is_dir(),
            plugin_ok: home().join(agent.plugin_dir).is_dir(),
        })
        .collect();
    // Table order is preference order — `claude` wins when both are installed.
    let selected = agents.iter().find(|a| a.path.is_some());

    let openspec = find_on_path("openspec").is_some();
    let graphify = find_on_path("graphify").is_some();
    let (grill_apply, ponytail) =
        selected.map_or((false, false), |a| (a.skills_ok, a.plugin_ok));

    let mut warnings = vec![];
    if selected.is_none() {
        let names: Vec<&str> = KNOWN_AGENTS.iter().map(|a| a.bin).collect();
        warnings.push(format!(
            "No agent found on PATH (looked for {}) — chat-only mode, /go unavailable.",
            names.join(", ")
        ));
    }
    if selected.is_some() && !grill_apply {
        warnings.push("grill-apply skill not installed for the detected executor — change-linked /go will not work.".into());
    }
    if selected.is_some() && !openspec {
        warnings.push("`openspec` not on PATH — change-linked /go will not work.".into());
    }
    if selected.is_some() && !ponytail {
        warnings.push("Ponytail plugin not detected — install it in the executor itself (the harness cannot).".into());
    }
    if !graphify {
        warnings.push("`graphify` not on PATH — code maps won't build. Install: `uv tool install \"graphifyy[watch]\"`.".into());
    }

    Preflight {
        selected: selected.map(|a| a.id.clone()),
        agents,
        openspec,
        grill_apply,
        ponytail,
        graphify,
        ready: grill_apply && openspec,
        warnings,
        checked_at: chrono::Utc::now().to_rfc3339(),
    }
}

// ----------------------------------------------------------------- events

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
// `rename_all` covers variant names only — the fields need their own rule, or
// the frontend sees `is_error`/`exit_code` while its types expect camelCase.
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ExecutorEvent {
    Text { text: String },
    Reasoning { text: String },
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
    Done,
    Crashed { exit_code: Option<i32>, message: String },
}

fn text_of(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| item.get("text").and_then(Value::as_str).unwrap_or("").to_string())
            .collect::<Vec<_>>()
            .join("\n"),
        other => other.to_string(),
    }
}

/// Map one line of Claude's `stream-json` output into zero or more events.
/// `read_before` supplies a file's current content so a `Write` can be shown
/// as a diff rather than an unexplained blob.
pub fn parse_claude_line(value: &Value, read_before: &dyn Fn(&str) -> String) -> Vec<ExecutorEvent> {
    let mut events = vec![];
    match value.get("type").and_then(Value::as_str) {
        Some("assistant") => {
            let blocks = value
                .pointer("/message/content")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            for block in blocks {
                let id = block.get("id").and_then(Value::as_str).unwrap_or("").to_string();
                match block.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        let text = block.get("text").and_then(Value::as_str).unwrap_or("");
                        if !text.trim().is_empty() {
                            events.push(ExecutorEvent::Text { text: text.to_string() });
                        }
                    }
                    Some("thinking") => {
                        let text = block.get("thinking").and_then(Value::as_str).unwrap_or("");
                        if !text.trim().is_empty() {
                            events.push(ExecutorEvent::Reasoning { text: text.to_string() });
                        }
                    }
                    Some("tool_use") => {
                        let name = block.get("name").and_then(Value::as_str).unwrap_or("").to_string();
                        let input = block.get("input").cloned().unwrap_or(json!({}));
                        events.push(tool_event(id, &name, &input, read_before));
                    }
                    _ => {}
                }
            }
        }
        Some("user") => {
            let blocks = value
                .pointer("/message/content")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            for block in blocks {
                if block.get("type").and_then(Value::as_str) == Some("tool_result") {
                    events.push(ExecutorEvent::ToolResult {
                        id: block.get("tool_use_id").and_then(Value::as_str).unwrap_or("").to_string(),
                        output: text_of(block.get("content").unwrap_or(&Value::Null)),
                        is_error: block.get("is_error").and_then(Value::as_bool).unwrap_or(false),
                    });
                }
            }
        }
        Some("result") => {
            if value.get("is_error").and_then(Value::as_bool) == Some(true) {
                events.push(ExecutorEvent::Text {
                    text: format!(
                        "Executor reported an error: {}",
                        value.get("result").map(text_of).unwrap_or_default()
                    ),
                });
            }
            events.push(ExecutorEvent::Done);
        }
        // Real shape, captured from a live `claude --include-partial-messages`
        // run (D27): {"type":"stream_event","event":{"type":
        // "content_block_delta","delta":{"type":"text_delta"|"thinking_delta",
        // ...}}}. Only those two delta types carry renderable text;
        // `signature_delta` (the thinking block's closing cryptographic
        // signature) and every other `event.type` are silently ignored.
        Some("stream_event") => {
            let is_delta = value.pointer("/event/type").and_then(Value::as_str) == Some("content_block_delta");
            if is_delta {
                let delta = value.pointer("/event/delta");
                match delta.and_then(|d| d.get("type")).and_then(Value::as_str) {
                    Some("text_delta") => {
                        let text = delta.and_then(|d| d.get("text")).and_then(Value::as_str).unwrap_or("");
                        // Not `.trim()` — a delta can be pure whitespace
                        // between two words and must survive concatenation.
                        if !text.is_empty() {
                            events.push(ExecutorEvent::TextDelta { text: text.to_string() });
                        }
                    }
                    Some("thinking_delta") => {
                        let text = delta.and_then(|d| d.get("thinking")).and_then(Value::as_str).unwrap_or("");
                        if !text.is_empty() {
                            events.push(ExecutorEvent::ReasoningDelta { text: text.to_string() });
                        }
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }
    events
}

/// File-writing tools become diffs; everything else becomes a tool call.
fn tool_event(
    id: String,
    name: &str,
    input: &Value,
    read_before: &dyn Fn(&str) -> String,
) -> ExecutorEvent {
    let string = |key: &str| input.get(key).and_then(Value::as_str).unwrap_or("").to_string();
    match name {
        "Write" => {
            let path = string("file_path");
            ExecutorEvent::FileEdit {
                id,
                before: read_before(&path),
                after: string("content"),
                path,
            }
        }
        "Edit" => ExecutorEvent::FileEdit {
            id,
            path: string("file_path"),
            before: string("old_string"),
            after: string("new_string"),
        },
        _ => {
            let command = if name == "Bash" {
                string("command")
            } else {
                serde_json::to_string_pretty(input).unwrap_or_default()
            };
            ExecutorEvent::ToolCall { id, name: name.to_string(), command }
        }
    }
}

/// Map one line of Codex's JSONL output into zero or more events.
///
/// ponytail: written against Codex's documented `item.started`/`item.completed`
/// schema but unverified — `codex` is not installed on this machine, so only
/// the fake-executor stub exercises it. Re-check against a real Codex before
/// relying on it on the work laptop.
pub fn parse_codex_line(value: &Value) -> Vec<ExecutorEvent> {
    let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
    let message_at = |pointer: &str| {
        value
            .pointer(pointer)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };

    if !matches!(kind, "item.started" | "item.completed") {
        return match kind {
            "turn.completed" => vec![ExecutorEvent::Done],
            // Observed against Codex CLI 0.146.0: a turn that gives up emits
            // `turn.failed`, never `turn.completed`. Without a terminal event
            // here the harness stays busy forever and the composer locks up.
            "turn.failed" => vec![
                ExecutorEvent::Text { text: message_at("/error/message") },
                ExecutorEvent::Crashed {
                    exit_code: None,
                    message: "Codex turn failed.".into(),
                },
            ],
            // Retryable stream errors arrive as their own events; surfacing
            // them is the only way the user learns what went wrong.
            "error" => vec![ExecutorEvent::Text { text: message_at("/message") }],
            _ => vec![],
        };
    }
    let item = value.get("item").cloned().unwrap_or(json!({}));
    let id = item.get("id").and_then(Value::as_str).unwrap_or("").to_string();
    let string = |key: &str| item.get(key).and_then(Value::as_str).unwrap_or("").to_string();

    match item.get("item_type").or_else(|| item.get("type")).and_then(Value::as_str) {
        Some("agent_message") if kind == "item.completed" => {
            vec![ExecutorEvent::Text { text: string("text") }]
        }
        Some("reasoning") if kind == "item.completed" => {
            vec![ExecutorEvent::Reasoning { text: string("text") }]
        }
        Some("file_change") if kind == "item.completed" => vec![ExecutorEvent::FileEdit {
            id,
            path: string("path"),
            before: string("old_content"),
            after: string("new_content"),
        }],
        // An error item carries its explanation under `message`, not `text`.
        Some("error") => vec![ExecutorEvent::Text {
            text: item.get("message").and_then(Value::as_str).unwrap_or("").to_string(),
        }],
        Some("command_execution") => {
            if kind == "item.started" {
                // Codex's own vocabulary, verbatim. This used to be hardcoded
                // to Claude's `"Bash"` — one agent's parser wearing another
                // agent's naming, which stops being harmless the moment a
                // third agent exists.
                vec![ExecutorEvent::ToolCall {
                    id,
                    name: "command_execution".into(),
                    command: string("command"),
                }]
            } else {
                vec![ExecutorEvent::ToolResult {
                    id,
                    output: string("aggregated_output"),
                    is_error: item.get("exit_code").and_then(Value::as_i64).unwrap_or(0) != 0,
                }]
            }
        }
        _ => vec![],
    }
}

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
        // Reasoning is transient and can be enormous; not persisted. Deltas
        // are a live-rendering signal only — the complete Text/Reasoning
        // event that follows each one is what actually gets persisted.
        ExecutorEvent::Reasoning { .. }
        | ExecutorEvent::TextDelta { .. }
        | ExecutorEvent::ReasoningDelta { .. }
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
        other => other.clone(),
    }
}

// -------------------------------------------------------------- processes

struct Live {
    child: Child,
    stdin: Option<ChildStdin>,
}

pub struct Session {
    /// Floo's own identity for this session, distinct from `provider_handle`
    /// (the agent's private conversation handle). Every event and message this
    /// session produces is stamped with it.
    pub id: String,
    pub agent: &'static Agent,
    /// The executable detection resolved. Codex re-spawns it every turn, so
    /// this has to be the real path — looking `codex` up by name again would
    /// ignore what detection found and can't be pointed at a test stub.
    pub bin: PathBuf,
    pub project_hash: String,
    pub thread_id: String,
    pub project_root: PathBuf,
    pub mode: String,
    /// The store home this session writes into. Carried on the session rather
    /// than looked up globally so a test fixture pointing at a tempdir can't
    /// leak writes into the real `~/.floo-network` (the Codex per-turn spawn
    /// path used to call `store::floo_home()` directly).
    pub floo_home: PathBuf,
    /// The agent's own conversation handle — Claude's UUID for `--resume`.
    /// Provider-private: it means nothing to any other agent (D14).
    pub provider_handle: String,
    /// The model alias passed to `--model` when this session was spawned. A
    /// per-turn agent (Codex) rebuilds argv every turn, so the choice has to
    /// live on the session, not just the initial SpawnCtx.
    pub model: Option<String>,
    /// Whether this session was spawned with the executor's approval-skipping
    /// flag. Carried on the session for the same per-turn rebuild reason as
    /// `model`.
    pub bypass: bool,
    live: Option<Live>,
    /// Codex spawns a fresh child per turn. Shared with the pump thread rather
    /// than moved into it, so `terminate()` can actually kill the turn in
    /// flight instead of only detaching from it.
    turn_child: Arc<Mutex<Option<Child>>>,
    /// Set once a per-turn agent has had a first turn, so the next one resumes.
    started: bool,
    pub busy: Arc<AtomicBool>,
    stopping: Arc<AtomicBool>,
}

impl Session {
    pub fn is_busy(&self) -> bool {
        self.busy.load(Ordering::SeqCst)
    }

    /// Kill this session's process outright — never background it. Scoped to
    /// one session: other live sessions are untouched.
    pub fn terminate(&mut self) {
        self.stopping.store(true, Ordering::SeqCst);
        if let Some(live) = self.live.as_mut() {
            drop(live.stdin.take());
            let _ = live.child.kill();
            let _ = live.child.wait();
        }
        // Whoever takes the child first owns reaping it; the pump thread sees
        // `None` and falls through to its `stopping` check.
        if let Some(mut child) = self.turn_child.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        self.busy.store(false, Ordering::SeqCst);
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.terminate();
    }
}

/// Every event leaves the harness stamped with where it came from. Without
/// this the frontend has one global stream and no way to tell two sessions
/// apart — which is what makes concurrent sessions impossible today.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Envelope {
    /// Floo's own session id (a ULID), not the provider's conversation handle.
    pub session_id: String,
    pub thread_id: String,
    pub event: ExecutorEvent,
}

/// Anything that can receive parsed events — the Tauri app handle in
/// production, a channel in tests.
pub trait Sink: Send + Sync + 'static {
    fn emit(&self, envelope: &Envelope);
}

pub struct Spawn<'a> {
    pub agent: &'static Agent,
    pub bin: PathBuf,
    pub project_root: PathBuf,
    pub project_hash: &'a str,
    pub thread_id: &'a str,
    pub mode: &'a str,
    /// Reuse an existing conversation instead of starting one.
    pub resume: Option<String>,
    pub floo_home: PathBuf,
    /// The model alias to pass to the executor's `--model` flag, if any.
    pub model: Option<String>,
    /// Whether to spawn with the executor's approval-skipping flag.
    pub bypass: bool,
}

pub fn start(spawn: Spawn, sink: Arc<dyn Sink>) -> Res<Session> {
    let session_id = spawn
        .resume
        .clone()
        .unwrap_or_else(|| uuid_v4());
    let id = ulid::Ulid::new().to_string();
    let turn_child: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(None));
    let busy = Arc::new(AtomicBool::new(false));
    let stopping = Arc::new(AtomicBool::new(false));

    let live = match spawn.agent.transport {
        Transport::Persistent => {
            let args = (spawn.agent.args)(&SpawnCtx {
                mode: spawn.mode,
                handle: &session_id,
                resume: spawn.resume.is_some(),
                project_root: &spawn.project_root,
                message: "",
                model: spawn.model.as_deref(),
                bypass: spawn.bypass,
            });
            let mut child = Command::new(&spawn.bin)
                .args(args)
                .current_dir(&spawn.project_root)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|err| format!("spawn {}: {err}", spawn.agent.id))?;
            let stdout = child.stdout.take().ok_or("agent stdout unavailable")?;
            let stdin = child.stdin.take();
            pump(
                stdout,
                spawn.agent,
                sink,
                PumpCtx {
                    session_id: id.clone(),
                    floo_home: spawn.floo_home.clone(),
                    project_hash: spawn.project_hash.to_string(),
                    thread_id: spawn.thread_id.to_string(),
                    mode: spawn.mode.to_string(),
                },
                busy.clone(),
                stopping.clone(),
                None,
            );
            Some(Live { child, stdin })
        }
        // A per-turn agent has no persistent process; each turn spawns its own.
        Transport::PerTurn => None,
    };

    Ok(Session {
        id,
        agent: spawn.agent,
        bin: spawn.bin,
        project_hash: spawn.project_hash.to_string(),
        thread_id: spawn.thread_id.to_string(),
        project_root: spawn.project_root,
        mode: spawn.mode.to_string(),
        floo_home: spawn.floo_home,
        provider_handle: session_id,
        model: spawn.model,
        bypass: spawn.bypass,
        live,
        // A per-turn agent carries a conversation forward on its *next* turn
        // (Codex: `resume --last`) rather than via a handle, so for it this is
        // all "resume" means.
        started: spawn.agent.transport == Transport::PerTurn && spawn.resume.is_some(),
        turn_child,
        busy,
        stopping,
    })
}

/// Send one user turn to the executor.
pub fn send(session: &mut Session, sink: Arc<dyn Sink>, message: &str) -> Res<()> {
    if session.is_busy() {
        return Err("executor is mid-turn".into());
    }
    session.busy.store(true, Ordering::SeqCst);

    match session.agent.transport {
        Transport::Persistent => {
            let line = serde_json::to_string(&json!({
                "type": "user",
                "message": { "role": "user", "content": [{ "type": "text", "text": message }] }
            }))
            .map_err(|err| format!("encode turn: {err}"))?;
            let stdin = session
                .live
                .as_mut()
                .and_then(|live| live.stdin.as_mut())
                .ok_or("agent process is not running")?;
            writeln!(stdin, "{line}").map_err(|err| {
                session.busy.store(false, Ordering::SeqCst);
                format!("write to agent: {err}")
            })?;
            stdin.flush().map_err(|err| format!("flush agent stdin: {err}"))?;
        }
        Transport::PerTurn => {
            let args = (session.agent.args)(&SpawnCtx {
                mode: &session.mode,
                handle: &session.provider_handle,
                resume: session.started,
                project_root: &session.project_root,
                message,
                model: session.model.as_deref(),
                bypass: session.bypass,
            });
            let mut child = Command::new(&session.bin)
                .args(args)
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                // Observed: `codex exec` reads stdin ("Reading additional
                // input from stdin..."). Inheriting it risks the turn blocking
                // on a terminal that will never send anything.
                .stdin(Stdio::null())
                .spawn()
                .map_err(|err| format!("spawn {}: {err}", session.agent.id))?;
            let stdout = child.stdout.take().ok_or("agent stdout unavailable")?;
            session.started = true;
            *session.turn_child.lock().unwrap_or_else(|e| e.into_inner()) = Some(child);
            pump(
                stdout,
                session.agent,
                sink,
                PumpCtx {
                    session_id: session.id.clone(),
                    floo_home: session.floo_home.clone(),
                    project_hash: session.project_hash.clone(),
                    thread_id: session.thread_id.clone(),
                    mode: session.mode.clone(),
                },
                session.busy.clone(),
                session.stopping.clone(),
                Some(session.turn_child.clone()),
            );
        }
    }
    Ok(())
}

/// Everything a pump thread needs to stamp and persist what it reads. Grouped
/// because both spawn paths pass the same five values and `pump` had already
/// outgrown its argument list.
struct PumpCtx {
    session_id: String,
    floo_home: PathBuf,
    project_hash: String,
    thread_id: String,
    mode: String,
}

impl PumpCtx {
    /// Persist (capped) and emit (whole) one event, stamped with its origin.
    fn deliver(&self, sink: &Arc<dyn Sink>, event: ExecutorEvent) {
        persist(&self.floo_home, &self.project_hash, &self.thread_id, &self.session_id, &self.mode, &event);
        sink.emit(&Envelope {
            session_id: self.session_id.clone(),
            thread_id: self.thread_id.clone(),
            event,
        });
    }
}

/// Read an executor's stdout to EOF on a background thread, mapping each line
/// into events, persisting them, and forwarding them to the sink.
fn pump(
    stdout: impl std::io::Read + Send + 'static,
    agent: &'static Agent,
    sink: Arc<dyn Sink>,
    ctx: PumpCtx,
    busy: Arc<AtomicBool>,
    stopping: Arc<AtomicBool>,
    own_child: Option<Arc<Mutex<Option<Child>>>>,
) {
    std::thread::spawn(move || {
        let read_before = |path: &str| fs::read_to_string(path).unwrap_or_default();
        let mut saw_done = false;

        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            let events = (agent.parse)(&value, &read_before);
            for event in events {
                if matches!(event, ExecutorEvent::Done) {
                    saw_done = true;
                    busy.store(false, Ordering::SeqCst);
                }
                ctx.deliver(&sink, event);
            }
        }

        busy.store(false, Ordering::SeqCst);
        if stopping.load(Ordering::SeqCst) {
            return;
        }

        // Codex owns a child per turn, so ending is normal — only a bad exit
        // or a turn that never reached Done is a crash. Claude's process is
        // persistent: if it ends and we didn't stop it, that is always a
        // crash, however cleanly the *previous* turn happened to finish.
        let (exit_code, crashed) = match own_child {
            Some(slot) => {
                let reaped = slot.lock().unwrap_or_else(|e| e.into_inner()).take();
                // `None` means `terminate()` already reaped it — but that also
                // sets `stopping`, so this path is only reached on a real exit.
                let code = reaped.and_then(|mut child| child.wait().ok()).and_then(|s| s.code());
                (code, code.is_some_and(|code| code != 0) || !saw_done)
            }
            None => (None, true),
        };
        if crashed {
            ctx.deliver(
                &sink,
                ExecutorEvent::Crashed {
                    exit_code,
                    message: "Executor process ended unexpectedly.".into(),
                },
            );
        }
    });
}

/// Random v4 UUID from OS entropy — Claude requires this exact shape for
/// `--session-id`. ponytail: 8 lines beats adding the `uuid` crate.
pub fn uuid_v4() -> String {
    let mut bytes = [0u8; 16];
    fs::File::open("/dev/urandom")
        .and_then(|mut f| std::io::Read::read_exact(&mut f, &mut bytes))
        .expect("read /dev/urandom");
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &hex[0..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..32])
}

/// One change, as the `openspec` CLI reports it. Task counts are the agent's
/// own checkbox self-report and are labeled as such wherever shown — never
/// aggregated by Floo into a claim that anything is complete (D11).
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

/// Run an `openspec` subcommand in `project_root` and return its stdout.
/// `None` when the binary is missing, the run fails, or it outstays its
/// welcome — every caller degrades rather than erroring (task 4.4).
fn openspec_json(project_root: &Path, args: &[&str]) -> Option<String> {
    const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
    let bin = find_on_path("openspec")?;
    let mut child = Command::new(bin)
        .args(args)
        .current_dir(project_root)
        .env("PATH", child_path_env())
        .stdout(Stdio::piped())
        // The CLI prints deprecation notices on stderr; only stdout is JSON.
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .spawn()
        .ok()?;

    let deadline = std::time::Instant::now() + TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            // A non-zero exit is a real answer ("not an OpenSpec project"),
            // not something to retry or surface as an error.
            Ok(Some(_)) => return None,
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Err(_) => return None,
        }
    }
    let mut body = String::new();
    std::io::Read::read_to_string(&mut child.stdout.take()?, &mut body).ok()?;
    Some(body)
}

/// The project's OpenSpec changes, asked of the CLI — which is the authority
/// on what a change *is* (D11). Falls back to the directory listing when
/// `openspec` isn't installed, which is exactly today's behavior.
pub fn openspec_list(project_root: &Path) -> Vec<SpecChange> {
    if let Some(body) = openspec_json(project_root, &["list", "--json"]) {
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

/// The full detail of one change, verbatim from the CLI. Floo renders this and
/// writes none of it: the filesystem and `openspec` stay authoritative (D11).
pub fn openspec_show(project_root: &Path, name: &str) -> Option<Value> {
    let body = openspec_json(project_root, &["show", name, "--json"])?;
    serde_json::from_str(&body).ok()
}

/// Whether the project's changes validate, as the CLI judges it.
pub fn openspec_validate(project_root: &Path) -> Option<bool> {
    // `validate` exits non-zero when something is invalid, which
    // `openspec_json` reports as `None` — so a successful run means valid and
    // a failed one means either invalid or unavailable. Distinguishing those
    // needs the binary itself to exist.
    find_on_path("openspec")?;
    Some(openspec_json(project_root, &["validate", "--changes"]).is_some())
}

/// Archive one change via the openspec CLI. `--yes` skips the interactive
/// confirmation prompt (the subprocess has no stdin to answer it); `--json`
/// gives a stable machine-readable stdout. Returns that stdout on success;
/// `openspec` missing or a non-zero exit becomes an error string.
pub fn openspec_archive(project_root: &Path, name: &str) -> crate::store::Res<String> {
    openspec_json(project_root, &["archive", name, "--yes", "--json"]).ok_or_else(|| {
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
pub fn openspec_changes(project_root: &Path) -> Vec<String> {
    openspec_list(project_root).into_iter().map(|c| c.name).collect()
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

#[derive(Default)]
pub struct Harness {
    /// Every live session, keyed by its own id. Was a single global
    /// `Option<Session>`, which made concurrency structurally impossible: any
    /// new session had to kill whatever was already running.
    pub sessions: Mutex<HashMap<String, Session>>,
    pub preflight: Mutex<Option<Preflight>>,
    pub pending_propose: Mutex<Option<ProposeWatch>>,
    /// The `graphify watch` process for whichever project is currently
    /// active — never more than one at a time (D16).
    pub watch: Mutex<Option<crate::integrations::Watcher>>,
    /// The PTY terminal, if the user has opened the panel — `None` until
    /// then (spawned lazily, not on every project switch). Paired with the
    /// project hash it belongs to so a re-open after a project switch knows
    /// to kill the stale one instead of re-attaching to it.
    pub terminal: Mutex<Option<(String, crate::terminal::Terminal)>>,
    /// Watches the active project for changes Floo didn't make, so the open
    /// editor and file tree can reconcile instead of silently going stale.
    /// Also owns the "we just wrote this" suppression set — kept inside the
    /// watcher rather than as a sibling field so the two can't disagree.
    pub fswatch: Mutex<Option<crate::fswatch::FsWatcher>>,
}

impl Harness {
    /// Whether *any* of a thread's sessions is mid-turn. A thread can hold
    /// several at once, so checking only the most recent one would let a
    /// delete land on files a live turn is about to append to.
    /// How many live sessions share a project root. More than one means two
    /// agents are writing the same tree with no coordination, so the dirty set
    /// cannot honestly be split between them (D13) — attribution says so
    /// rather than guessing.
    pub fn sessions_in_project(&self, project_hash: &str) -> usize {
        self.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .filter(|s| s.project_hash == project_hash)
            .count()
    }

    pub fn thread_is_busy(&self, thread_id: &str) -> bool {
        self.sessions
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
    use std::sync::mpsc;

    /// Unwraps the envelope — for the tests that only care what was emitted.
    struct Collector(mpsc::Sender<ExecutorEvent>);
    impl Sink for Collector {
        fn emit(&self, envelope: &Envelope) {
            let _ = self.0.send(envelope.event.clone());
        }
    }

    /// Keeps the envelope — for the tests that care where it came from.
    struct Envelopes(mpsc::Sender<Envelope>);
    impl Sink for Envelopes {
        fn emit(&self, envelope: &Envelope) {
            let _ = self.0.send(envelope.clone());
        }
    }

    fn no_before(_: &str) -> String {
        String::new()
    }

    fn claude() -> &'static Agent {
        agent_by_id("claude").unwrap()
    }

    fn codex() -> &'static Agent {
        agent_by_id("codex").unwrap()
    }

    /// Table order is preference order, so the first installed row wins.
    #[test]
    fn the_first_installed_agent_in_table_order_is_selected() {
        assert_eq!(
            KNOWN_AGENTS.iter().map(|a| a.id).collect::<Vec<_>>(),
            vec!["claude", "codex"],
            "claude must stay ahead of codex in the table"
        );
        let pick = |installed: &[&str]| {
            KNOWN_AGENTS.iter().find(|a| installed.contains(&a.id)).map(|a| a.id)
        };
        assert_eq!(pick(&["claude", "codex"]), Some("claude"));
        assert_eq!(pick(&["claude"]), Some("claude"));
        assert_eq!(pick(&["codex"]), Some("codex"));
        assert_eq!(pick(&[]), None);
    }

    /// Every row must be complete enough to spawn — a half-filled table entry
    /// is the failure mode a const table invites.
    #[test]
    fn every_known_agent_row_is_well_formed() {
        for agent in KNOWN_AGENTS {
            assert!(!agent.id.is_empty() && !agent.bin.is_empty() && !agent.label.is_empty());
            assert!(!agent.skill_prefix.is_empty(), "{} needs a skill prefix", agent.id);
            assert!(agent.skill_dir.contains('/'), "{} needs a skill dir", agent.id);
            assert_ne!(
                (agent.permission)("spec"),
                (agent.permission)("go"),
                "{} must distinguish spec from go, or /go grants nothing",
                agent.id
            );
            assert_eq!(
                KNOWN_AGENTS.iter().filter(|other| other.id == agent.id).count(),
                1,
                "duplicate id {}",
                agent.id
            );
        }
    }

    #[test]
    fn find_on_path_locates_a_real_binary_and_rejects_a_fake_one() {
        assert!(find_on_path("sh").is_some());
        assert!(find_on_path("definitely-not-a-real-binary-xyz").is_none());
    }

    /// A GUI launch gets launchd's minimal PATH, so anything installed under
    /// the user's home (nvm, ~/.local/bin) is invisible until the login shell
    /// is consulted. Simulated here by looking up a binary that is only
    /// reachable via the login shell's PATH, not the minimal one.
    #[test]
    fn a_binary_outside_the_minimal_path_is_still_found() {
        // Run this test under a launchd-style PATH to exercise the fallback:
        //   env -i HOME=$HOME SHELL=$SHELL PATH=/usr/bin:/bin:/usr/sbin:/sbin \
        //     <test-binary> a_binary_outside_the_minimal_path --nocapture
        let on_env_path = std::env::var_os("PATH")
            .and_then(|path| lookup(&path, "claude"))
            .is_some();
        let found = find_on_path("claude");
        println!(
            "claude on the inherited PATH: {on_env_path}; resolved: {:?}",
            found.as_deref()
        );

        // Whatever the PATH looked like, the shell fallback must reach the same
        // binary the user's own terminal would.
        if let Some(claude) = found {
            assert!(claude.exists(), "resolved claude must be a real file");
            assert!(is_executable(&claude));
        } else {
            // Only legitimate when the user genuinely has no claude installed.
            assert!(
                login_shell_path().is_none_or(|path| lookup(path, "claude").is_none()),
                "claude is on the login shell PATH but find_on_path missed it"
            );
        }
    }

    #[test]
    fn preflight_without_an_executor_warns_and_is_not_ready() {
        let flight = preflight();
        // This machine has claude; the invariant under test holds either way.
        if flight.selected.is_none() {
            assert!(!flight.ready);
            assert!(flight.warnings.iter().any(|w| w.contains("chat-only")));
        } else {
            assert_eq!(flight.ready, flight.grill_apply && flight.openspec);
        }
    }

    #[test]
    fn permission_values_match_the_mode() {
        let claude = agent_by_id("claude").unwrap();
        let codex = agent_by_id("codex").unwrap();
        assert_eq!((claude.permission)("spec"), "plan");
        assert_eq!((claude.permission)("go"), "acceptEdits");
        assert_eq!((codex.permission)("spec"), "read-only");
        assert_eq!((codex.permission)("go"), "workspace-write");
    }

    fn args_of(id: &str, mode: &str, resume: bool, message: &str) -> Vec<String> {
        let agent = agent_by_id(id).unwrap();
        (agent.args)(&SpawnCtx {
            mode,
            handle: "abc",
            resume,
            project_root: Path::new("/proj"),
            message,
            model: None,
            bypass: false,
        })
    }

    /// Task 3.10: the argv both agents produce is pinned against what they
    /// produced before the table migration. A table that quietly changes a
    /// flag would be worse than no table.
    #[test]
    fn migrating_to_the_table_left_claude_argv_unchanged() {
        let base = [
            "--print",
            "--verbose",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--include-partial-messages",
            "--permission-mode",
        ];
        // --session-id sets the id up front; --resume reuses it after a handoff.
        let mut fresh: Vec<&str> = base.to_vec();
        fresh.extend(["plan", "--session-id", "abc"]);
        assert_eq!(args_of("claude", "spec", false, ""), fresh);

        let mut handoff: Vec<&str> = base.to_vec();
        handoff.extend(["acceptEdits", "--resume", "abc"]);
        assert_eq!(args_of("claude", "go", true, ""), handoff);
    }

    #[test]
    fn migrating_to_the_table_left_codex_argv_unchanged() {
        assert_eq!(
            args_of("codex", "spec", false, "hello"),
            ["exec", "hello", "--json", "--sandbox", "read-only", "--skip-git-repo-check", "-C", "/proj"]
        );
        assert_eq!(
            args_of("codex", "go", true, "hello"),
            [
                "exec",
                "resume",
                "--last",
                "hello",
                "--json",
                "--sandbox",
                "workspace-write",
                "--skip-git-repo-check",
                "-C",
                "/proj",
            ]
        );
    }

    /// `args_of` with explicit model/bypass — both agents append their own
    /// `--model` and bypass flags, so the per-agent mapping lives in the table
    /// rather than branching in `lib.rs`.
    fn args_of_prefs(
        id: &str,
        mode: &str,
        resume: bool,
        message: &str,
        model: Option<&str>,
        bypass: bool,
    ) -> Vec<String> {
        let agent = agent_by_id(id).unwrap();
        (agent.args)(&SpawnCtx {
            mode,
            handle: "abc",
            resume,
            project_root: Path::new("/proj"),
            message,
            model,
            bypass,
        })
    }

    #[test]
    fn claude_appends_model_and_bypass_flags_when_set() {
        let base = args_of("claude", "spec", false, "");
        let with = args_of_prefs("claude", "spec", false, "", Some("opus"), true);
        assert_eq!(
            with,
            [
                base.as_slice(),
                &["--model".to_string(), "opus".to_string(), "--dangerously-skip-permissions".to_string()],
            ]
            .concat()
        );
    }

    #[test]
    fn codex_appends_model_and_bypass_flags_when_set() {
        let base = args_of("codex", "spec", false, "hello");
        let with = args_of_prefs("codex", "spec", false, "hello", Some("gpt-5"), true);
        assert_eq!(
            with,
            [
                base.as_slice(),
                &["--model".to_string(), "gpt-5".to_string(), "--dangerously-bypass-approvals-and-sandbox".to_string()],
            ]
            .concat()
        );
    }

    #[test]
    fn no_model_and_no_bypass_produces_the_same_argv_as_before() {
        // None / false is the default path — it must not add any flags.
        assert_eq!(args_of_prefs("claude", "spec", false, "", None, false), args_of("claude", "spec", false, ""));
        assert_eq!(args_of_prefs("codex", "go", true, "hi", None, false), args_of("codex", "go", true, "hi"));
    }

    /// Task 3.5: the one deliberate exception to "unchanged" — Codex's tool
    /// name was hardcoded to Claude's `"Bash"`.
    #[test]
    fn codex_reports_its_own_tool_name_not_claudes() {
        let line = json!({
            "type": "item.started",
            "item": { "id": "c1", "item_type": "command_execution", "command": "ls" }
        });
        assert_eq!(
            parse_codex_line(&line),
            vec![ExecutorEvent::ToolCall {
                id: "c1".into(),
                name: "command_execution".into(),
                command: "ls".into(),
            }]
        );
    }

    /// Task 3.8: a third agent is a table row plus a parser — nothing else.
    /// Everything this test needs comes off the row itself; no `match`
    /// anywhere in the codebase had to learn the name "amp".
    #[test]
    fn a_synthetic_third_agent_needs_only_a_row_and_a_parser() {
        fn parse_amp(value: &Value, _: &dyn Fn(&str) -> String) -> Vec<ExecutorEvent> {
            match value.get("event").and_then(Value::as_str) {
                Some("say") => vec![ExecutorEvent::Text {
                    text: value.get("body").and_then(Value::as_str).unwrap_or("").into(),
                }],
                Some("finish") => vec![ExecutorEvent::Done],
                _ => vec![],
            }
        }
        const AMP: Agent = Agent {
            id: "amp",
            bin: "amp",
            label: "Amp",
            transport: Transport::PerTurn,
            skill_prefix: "!",
            skill_dir: ".amp/skills",
            plugin_dir: ".amp/plugins/ponytail",
            permission: |mode| if mode == "go" { "write" } else { "read" },
            args: |ctx| {
                vec!["run".into(), ctx.message.into(), "--mode".into(), (AMP.permission)(ctx.mode).into()]
            },
            parse: parse_amp,
        };

        // Detection status, exactly as `preflight()` builds it.
        let status = AgentStatus {
            id: AMP.id.to_string(),
            label: AMP.label.to_string(),
            path: find_on_path(AMP.bin).map(|p| p.to_string_lossy().to_string()),
            skills_ok: home().join(AMP.skill_dir).join("grill-apply").is_dir(),
            plugin_ok: home().join(AMP.plugin_dir).is_dir(),
        };
        assert_eq!(status.id, "amp");
        assert_eq!(status.label, "Amp");

        assert_eq!(
            (AMP.args)(&SpawnCtx {
                mode: "go",
                handle: "h",
                resume: false,
                project_root: Path::new("/proj"),
                message: "hi",
                model: None,
                bypass: false,
            }),
            ["run", "hi", "--mode", "write"]
        );
        assert_eq!(
            (AMP.parse)(&json!({ "event": "say", "body": "hello" }), &no_before),
            vec![ExecutorEvent::Text { text: "hello".into() }]
        );
        assert_eq!((AMP.parse)(&json!({ "event": "finish" }), &no_before), vec![ExecutorEvent::Done]);
    }

    #[test]
    fn claude_text_and_thinking_map_to_text_and_reasoning() {
        let line = json!({
            "type": "assistant",
            "message": { "content": [
                { "type": "thinking", "thinking": "hmm" },
                { "type": "text", "text": "hello" },
                { "type": "text", "text": "   " }
            ]}
        });
        assert_eq!(
            parse_claude_line(&line, &no_before),
            vec![
                ExecutorEvent::Reasoning { text: "hmm".into() },
                ExecutorEvent::Text { text: "hello".into() },
            ]
        );
    }

    // Fixtures below use the exact envelope shape captured from a real
    // `claude --print --include-partial-messages --output-format
    // stream-json` run (D6/D27): `{"type":"stream_event","event":{"type":
    // "content_block_delta","delta":{"type":"text_delta","text":"..."}}}`.
    // In that capture `thinking_delta.thinking` came through empty (just an
    // `estimated_tokens` counter) for the prompts tried — the envelope
    // shape is verified real; the thinking-delta fixtures below give it
    // synthetic non-empty text to prove the parsing path, since an empty
    // real capture can't exercise it.

    #[test]
    fn claude_stream_event_text_delta_appends_live() {
        let line = json!({
            "type": "stream_event",
            "event": {
                "type": "content_block_delta",
                "index": 1,
                "delta": { "type": "text_delta", "text": "hello there" }
            }
        });
        assert_eq!(
            parse_claude_line(&line, &no_before),
            vec![ExecutorEvent::TextDelta { text: "hello there".into() }]
        );
    }

    #[test]
    fn claude_stream_event_thinking_delta_appends_live() {
        let line = json!({
            "type": "stream_event",
            "event": {
                "type": "content_block_delta",
                "index": 0,
                "delta": { "type": "thinking_delta", "thinking": "let me check" }
            }
        });
        assert_eq!(
            parse_claude_line(&line, &no_before),
            vec![ExecutorEvent::ReasoningDelta { text: "let me check".into() }]
        );
    }

    #[test]
    fn claude_stream_event_empty_deltas_are_dropped() {
        // Real capture: thinking_delta with empty text and only a token
        // count (D27) — must not emit an empty ReasoningDelta.
        let thinking = json!({
            "type": "stream_event",
            "event": { "type": "content_block_delta", "delta":
                { "type": "thinking_delta", "thinking": "", "estimated_tokens": 50 } }
        });
        assert_eq!(parse_claude_line(&thinking, &no_before), vec![]);

        let text = json!({
            "type": "stream_event",
            "event": { "type": "content_block_delta", "delta":
                { "type": "text_delta", "text": "" } }
        });
        assert_eq!(parse_claude_line(&text, &no_before), vec![]);
    }

    #[test]
    fn claude_stream_event_signature_delta_is_not_text() {
        // Real capture: the thinking block's closing delta is a
        // cryptographic signature blob, not readable text — must not leak
        // into ReasoningDelta.
        let line = json!({
            "type": "stream_event",
            "event": { "type": "content_block_delta", "delta":
                { "type": "signature_delta", "signature": "EoYKCg==" } }
        });
        assert_eq!(parse_claude_line(&line, &no_before), vec![]);
    }

    #[test]
    fn claude_stream_event_non_delta_events_are_ignored() {
        for event_type in
            ["message_start", "content_block_start", "content_block_stop", "message_delta", "message_stop"]
        {
            let line = json!({ "type": "stream_event", "event": { "type": event_type } });
            assert_eq!(parse_claude_line(&line, &no_before), vec![], "got events for {event_type}");
        }
    }

    #[test]
    fn claude_write_and_edit_become_file_edits() {
        let write = json!({
            "type": "assistant",
            "message": { "content": [
                { "type": "tool_use", "id": "t1", "name": "Write",
                  "input": { "file_path": "/x/y.txt", "content": "new" } }
            ]}
        });
        assert_eq!(
            parse_claude_line(&write, &|_| "old".to_string()),
            vec![ExecutorEvent::FileEdit {
                id: "t1".into(),
                path: "/x/y.txt".into(),
                before: "old".into(),
                after: "new".into()
            }]
        );

        let edit = json!({
            "type": "assistant",
            "message": { "content": [
                { "type": "tool_use", "id": "t2", "name": "Edit",
                  "input": { "file_path": "/x/y.txt", "old_string": "a", "new_string": "b" } }
            ]}
        });
        assert_eq!(
            parse_claude_line(&edit, &no_before),
            vec![ExecutorEvent::FileEdit {
                id: "t2".into(),
                path: "/x/y.txt".into(),
                before: "a".into(),
                after: "b".into()
            }]
        );
    }

    #[test]
    fn claude_bash_becomes_a_tool_call_then_a_tool_result() {
        let call = json!({
            "type": "assistant",
            "message": { "content": [
                { "type": "tool_use", "id": "t3", "name": "Bash",
                  "input": { "command": "echo hi" } }
            ]}
        });
        assert_eq!(
            parse_claude_line(&call, &no_before),
            vec![ExecutorEvent::ToolCall { id: "t3".into(), name: "Bash".into(), command: "echo hi".into() }]
        );

        let result = json!({
            "type": "user",
            "message": { "content": [
                { "type": "tool_result", "tool_use_id": "t3", "content": "hi", "is_error": false }
            ]}
        });
        assert_eq!(
            parse_claude_line(&result, &no_before),
            vec![ExecutorEvent::ToolResult { id: "t3".into(), output: "hi".into(), is_error: false }]
        );
    }

    #[test]
    fn claude_result_line_ends_the_turn() {
        let ok = json!({ "type": "result", "subtype": "success", "is_error": false });
        assert_eq!(parse_claude_line(&ok, &no_before), vec![ExecutorEvent::Done]);

        let bad = json!({ "type": "result", "is_error": true, "result": "boom" });
        let events = parse_claude_line(&bad, &no_before);
        assert_eq!(events.len(), 2);
        assert!(matches!(&events[0], ExecutorEvent::Text { text } if text.contains("boom")));
        assert_eq!(events[1], ExecutorEvent::Done);
    }

    #[test]
    fn claude_noise_lines_are_ignored() {
        for noise in [
            json!({ "type": "system", "subtype": "init" }),
            json!({ "type": "rate_limit_event" }),
            json!({ "type": "stream_event", "event": {} }),
        ] {
            assert!(parse_claude_line(&noise, &no_before).is_empty());
        }
    }

    #[test]
    fn codex_events_map_into_the_shared_enum() {
        let message = json!({
            "type": "item.completed",
            "item": { "id": "c1", "item_type": "agent_message", "text": "hello" }
        });
        assert_eq!(parse_codex_line(&message), vec![ExecutorEvent::Text { text: "hello".into() }]);

        let started = json!({
            "type": "item.started",
            "item": { "id": "c2", "item_type": "command_execution", "command": "ls" }
        });
        assert_eq!(
            parse_codex_line(&started),
            // Was `"Bash"` — Claude's name on Codex's event. Fixed in task 3.5;
            // see `codex_reports_its_own_tool_name_not_claudes`.
            vec![ExecutorEvent::ToolCall {
                id: "c2".into(),
                name: "command_execution".into(),
                command: "ls".into(),
            }]
        );

        let finished = json!({
            "type": "item.completed",
            "item": { "id": "c2", "item_type": "command_execution",
                      "aggregated_output": "nope", "exit_code": 1 }
        });
        assert_eq!(
            parse_codex_line(&finished),
            vec![ExecutorEvent::ToolResult { id: "c2".into(), output: "nope".into(), is_error: true }]
        );

        assert_eq!(parse_codex_line(&json!({ "type": "turn.completed" })), vec![ExecutorEvent::Done]);
    }

    /// The frontend's `ExecutorEvent` union is written by hand against this
    /// JSON, so the wire shape is pinned here rather than left to inference.
    #[test]
    fn events_serialize_as_camel_case_for_the_frontend() {
        let json = serde_json::to_value(ExecutorEvent::ToolResult {
            id: "t1".into(),
            output: "out".into(),
            is_error: true,
        })
        .unwrap();
        assert_eq!(json, json!({ "kind": "toolResult", "id": "t1", "output": "out", "isError": true }));

        let crashed =
            serde_json::to_value(ExecutorEvent::Crashed { exit_code: Some(9), message: "x".into() })
                .unwrap();
        assert_eq!(crashed, json!({ "kind": "crashed", "exitCode": 9, "message": "x" }));

        let edit = serde_json::to_value(ExecutorEvent::FileEdit {
            id: "t2".into(),
            path: "/a".into(),
            before: "b".into(),
            after: "a".into(),
        })
        .unwrap();
        assert_eq!(edit["kind"], "fileEdit");

        let text_delta = serde_json::to_value(ExecutorEvent::TextDelta { text: "hi".into() }).unwrap();
        assert_eq!(text_delta, json!({ "kind": "textDelta", "text": "hi" }));

        let reasoning_delta =
            serde_json::to_value(ExecutorEvent::ReasoningDelta { text: "hm".into() }).unwrap();
        assert_eq!(reasoning_delta, json!({ "kind": "reasoningDelta", "text": "hm" }));
    }

    /// Real output captured from `codex exec --json` (Codex CLI 0.146.0), not
    /// invented — a fixture I made up would only prove the parser matches my
    /// guess. This is the failing-turn path: the run errored, so what matters
    /// is that the user learns why and the turn actually ends.
    const REAL_CODEX_FAILED_TURN: &str = r#"
{"thread_id":"t-1","type":"thread.started"}
{"type":"turn.started"}
{"message":"stream error: 401 Unauthorized; retrying","type":"error"}
{"item":{"id":"item_0","message":"We're currently experiencing high load","type":"error"},"type":"item.completed"}
{"error":{"message":"exceeded retry limit"},"type":"turn.failed"}
"#;

    #[test]
    fn a_failed_codex_turn_surfaces_the_error_and_ends() {
        let events: Vec<ExecutorEvent> = REAL_CODEX_FAILED_TURN
            .lines()
            .filter(|line| !line.trim().is_empty())
            .flat_map(|line| parse_codex_line(&serde_json::from_str(line).unwrap()))
            .collect();

        assert!(
            events.iter().any(|e| matches!(e, ExecutorEvent::Text { text } if text.contains("401"))),
            "the user must be told why the turn failed; got {events:?}"
        );
        assert!(
            events.iter().any(|e| matches!(e, ExecutorEvent::Text { text } if text.contains("high load"))),
            "an error item carries its message too; got {events:?}"
        );
        // Without a terminal event `busy` is never cleared and the UI locks up.
        assert!(
            matches!(events.last(), Some(ExecutorEvent::Crashed { .. })),
            "a failed turn must terminate, or the harness hangs forever; got {events:?}"
        );
    }

    #[test]
    fn uuid_v4_has_the_shape_claude_requires() {
        let id = uuid_v4();
        assert_eq!(id.len(), 36);
        assert_eq!(id.chars().filter(|c| *c == '-').count(), 4);
        assert_eq!(&id[14..15], "4");
        assert!("89ab".contains(&id[19..20]));
        assert_ne!(uuid_v4(), uuid_v4());
    }

    /// Task 4.8: two changes from one propose turn used to return `None` — the
    /// thread's spec link was silently dropped, which is worse than asking.
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

    /// Task 4.6: a real captured `openspec list --json` payload, so a change in
    /// the CLI's shape shows up here rather than as an empty spec pane.
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
          "root": { "path": "/Users/x/dev/floo-network", "source": "nearest" }
        }"#;
        let changes = parse_openspec_list(captured).unwrap();
        assert_eq!(changes.len(), 2);
        assert_eq!(changes[0].name, "agent-session-architecture");
        assert_eq!((changes[0].completed_tasks, changes[0].total_tasks), (48, 71));
        assert_eq!(changes[1].status.as_deref(), Some("complete"));

        // Unknown keys and missing optional ones must not break parsing — the
        // CLI is free to grow fields without taking the spec pane down.
        let sparse = r#"{"changes":[{"name":"x","somethingNew":1}]}"#;
        let changes = parse_openspec_list(sparse).unwrap();
        assert_eq!(changes[0].name, "x");
        assert_eq!(changes[0].total_tasks, 0);

        assert!(parse_openspec_list("not json").is_none());
        assert!(parse_openspec_list(r#"{"other":[]}"#).is_none());
    }

    /// Task 4.7: no `openspec` on PATH is a normal state, not an error — the
    /// project's change directories are still listed, exactly as before.
    #[test]
    fn a_missing_openspec_binary_degrades_to_the_directory_listing() {
        let repo = tempfile::tempdir().unwrap();
        let changes = repo.path().join("openspec/changes");
        fs::create_dir_all(changes.join("some-change")).unwrap();
        fs::create_dir_all(changes.join("archive")).unwrap();

        // Not a real OpenSpec project, so the CLI (installed or not) declines
        // and the fallback is what answers.
        let listed = openspec_list(repo.path());
        assert_eq!(listed.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), vec!["some-change"]);
        assert_eq!(listed[0].total_tasks, 0, "the fallback claims no task counts it can't know");

        assert_eq!(openspec_show(repo.path(), "some-change"), None);
        assert!(openspec_change_dirs(repo.path()).contains(&"some-change".to_string()));
    }

    #[test]
    fn reasoning_is_not_persisted_but_text_and_tools_are() {
        let home = tempfile::tempdir().unwrap();
        let repo = tempfile::tempdir().unwrap();
        let project = store::add_project(home.path(), repo.path()).unwrap();
        let thread = store::create_thread(home.path(), &project.hash, "t").unwrap();

        for event in [
            ExecutorEvent::Reasoning { text: "secret".into() },
            ExecutorEvent::Text { text: "visible".into() },
            ExecutorEvent::ToolCall { id: "t1".into(), name: "Bash".into(), command: "ls".into() },
            ExecutorEvent::Done,
        ] {
            persist(home.path(), &project.hash, &thread.id, "sess-1", "go", &event);
        }

        let messages = store::read_thread(home.path(), &project.hash, &thread.id).unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, "assistant");
        assert_eq!(messages[0].content, "visible");
        assert_eq!(messages[1].role, "tool");
        let round_trip: ExecutorEvent = serde_json::from_str(&messages[1].content).unwrap();
        assert!(matches!(round_trip, ExecutorEvent::ToolCall { .. }));
    }

    // ------------------------------------------- fake-executor integration

    fn stub_path() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fake-executor.sh")
    }

    fn fixture() -> (tempfile::TempDir, tempfile::TempDir, String, String) {
        let home = tempfile::tempdir().unwrap();
        let repo = tempfile::tempdir().unwrap();
        let project = store::add_project(home.path(), repo.path()).unwrap();
        let thread = store::create_thread(home.path(), &project.hash, "t").unwrap();
        (home, repo, project.hash, thread.id)
    }

    #[test]
    fn fake_claude_turn_streams_events_and_returns_to_idle() {
        let (home, repo, hash, thread_id) = fixture();
        let (tx, rx) = mpsc::channel();
        let sink: Arc<dyn Sink> = Arc::new(Collector(tx));

        let mut session = start(
            Spawn {
                agent: claude(),
                bin: stub_path(),
                project_root: repo.path().to_path_buf(),
                project_hash: &hash,
                thread_id: &thread_id,
                mode: "spec",
                resume: None,
                floo_home: home.path().to_path_buf(),
                model: None,
                bypass: false,
            },
            sink.clone(),
        )
        .unwrap();

        send(&mut session, sink, "hello").unwrap();
        assert!(session.is_busy());

        let mut seen = vec![];
        while let Ok(event) = rx.recv_timeout(std::time::Duration::from_secs(30)) {
            let done = event == ExecutorEvent::Done;
            seen.push(event);
            if done {
                break;
            }
        }
        assert!(seen.iter().any(|e| matches!(e, ExecutorEvent::Text { .. })));
        assert!(seen.iter().any(|e| matches!(e, ExecutorEvent::ToolCall { .. })));
        assert_eq!(seen.last(), Some(&ExecutorEvent::Done));
        assert!(!session.is_busy(), "thread should be idle again after Done");

        // History survived the turn.
        let messages = store::read_thread(home.path(), &hash, &thread_id).unwrap();
        assert!(messages.iter().any(|m| m.role == "assistant"));
    }

    #[test]
    fn a_second_turn_is_rejected_while_the_first_is_in_flight() {
        let (home, repo, hash, thread_id) = fixture();
        let (tx, rx) = mpsc::channel();
        let sink: Arc<dyn Sink> = Arc::new(Collector(tx));

        let mut session = start(
            Spawn {
                agent: claude(),
                bin: stub_path(),
                project_root: repo.path().to_path_buf(),
                project_hash: &hash,
                thread_id: &thread_id,
                mode: "spec",
                resume: None,
                floo_home: home.path().to_path_buf(),
                model: None,
                bypass: false,
            },
            sink.clone(),
        )
        .unwrap();

        send(&mut session, sink.clone(), "first").unwrap();
        assert!(send(&mut session, sink, "second").is_err(), "mid-turn send must be rejected");

        while let Ok(event) = rx.recv_timeout(std::time::Duration::from_secs(30)) {
            if event == ExecutorEvent::Done {
                break;
            }
        }
        assert!(!session.is_busy());
    }

    #[test]
    fn a_crashing_executor_reports_crashed() {
        let (home, repo, hash, thread_id) = fixture();
        let (tx, rx) = mpsc::channel();
        let sink: Arc<dyn Sink> = Arc::new(Collector(tx));

        let session = start(
            Spawn {
                agent: claude(),
                bin: stub_path().with_file_name("fake-executor-crash.sh"),
                project_root: repo.path().to_path_buf(),
                project_hash: &hash,
                thread_id: &thread_id,
                mode: "spec",
                resume: None,
                floo_home: home.path().to_path_buf(),
                model: None,
                bypass: false,
            },
            sink,
        )
        .unwrap();


        let mut crashed = false;
        while let Ok(event) = rx.recv_timeout(std::time::Duration::from_secs(30)) {
            if matches!(event, ExecutorEvent::Crashed { .. }) {
                crashed = true;
                break;
            }
        }
        assert!(crashed, "stdout closing without Done must surface as Crashed");
        drop(session);
    }

    /// Claude's process is meant to outlive its turns, so a clean `Done` must
    /// not mask it dying afterwards — otherwise an idle session that gets
    /// OOM-killed would look fine until the user's next message vanished.
    #[test]
    fn a_persistent_executor_dying_after_a_clean_turn_still_crashes() {
        let (home, repo, hash, thread_id) = fixture();
        let (tx, rx) = mpsc::channel();
        let sink: Arc<dyn Sink> = Arc::new(Collector(tx));

        let mut session = start(
            Spawn {
                agent: claude(),
                bin: stub_path().with_file_name("fake-executor-oneshot.sh"),
                project_root: repo.path().to_path_buf(),
                project_hash: &hash,
                thread_id: &thread_id,
                mode: "go",
                resume: None,
                floo_home: home.path().to_path_buf(),
                model: None,
                bypass: false,
            },
            sink.clone(),
        )
        .unwrap();
        send(&mut session, sink, "hi").unwrap();

        let mut saw_done = false;
        let mut saw_crash = false;
        while let Ok(event) = rx.recv_timeout(std::time::Duration::from_secs(30)) {
            match event {
                ExecutorEvent::Done => saw_done = true,
                ExecutorEvent::Crashed { .. } => {
                    saw_crash = true;
                    break;
                }
                _ => {}
            }
        }
        assert!(saw_done, "the turn itself completed");
        assert!(saw_crash, "the process ending afterwards must still crash");
    }

    /// Task 5.7: a crash must leave the thread recoverable — back in spec mode,
    /// with the dead session forgotten, and every message still on disk.
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

        on_crash(home.path(), &hash, &thread_id).unwrap();

        let meta = store::list_threads(home.path(), &hash).unwrap().remove(0);
        assert_eq!(meta.current_mode, "spec", "a crash drops the thread's intent back to spec");
        // The handle survives on the crashed session's own record — it is the
        // `crashed` outcome, not a cleared field, that stops it being resumed.
        let records = store::read_sessions(home.path(), &hash, &thread_id).unwrap();
        assert_eq!(records[0].outcome.as_deref(), Some("crashed"));
        assert_eq!(records[0].provider_handle.as_deref(), Some("sess-1"));
        // Append-only storage means the crash can't cost history.
        let messages = store::read_thread(home.path(), &hash, &thread_id).unwrap();
        assert!(messages.iter().any(|m| m.content == "before the crash"));
    }

    #[test]
    fn terminating_a_session_does_not_report_a_crash() {
        let (home, repo, hash, thread_id) = fixture();
        let (tx, rx) = mpsc::channel();
        let sink: Arc<dyn Sink> = Arc::new(Collector(tx));

        let mut session = start(
            Spawn {
                agent: claude(),
                bin: stub_path(),
                project_root: repo.path().to_path_buf(),
                project_hash: &hash,
                thread_id: &thread_id,
                mode: "spec",
                resume: None,
                floo_home: home.path().to_path_buf(),
                model: None,
                bypass: false,
            },
            sink,
        )
        .unwrap();

        session.terminate();
        std::thread::sleep(std::time::Duration::from_millis(400));
        while let Ok(event) = rx.try_recv() {
            assert!(
                !matches!(event, ExecutorEvent::Crashed { .. }),
                "an intentional terminate must not look like a crash"
            );
        }
    }

    #[test]
    fn codex_turns_spawn_per_turn_and_stream_events() {
        let (home, repo, hash, thread_id) = fixture();
        let (tx, rx) = mpsc::channel();
        let sink: Arc<dyn Sink> = Arc::new(Collector(tx));

        let mut session = start(
            Spawn {
                agent: codex(),
                // The stub, never the real `codex` — a test must not spend an
                // API call, and the fake-executor exists precisely for this.
                bin: stub_path(),
                project_root: repo.path().to_path_buf(),
                project_hash: &hash,
                thread_id: &thread_id,
                mode: "spec",
                resume: None,
                floo_home: home.path().to_path_buf(),
                model: None,
                bypass: false,
            },
            sink.clone(),
        )
        .unwrap();
        send(&mut session, sink, "hello").unwrap();
        let mut seen = vec![];
        while let Ok(event) = rx.recv_timeout(std::time::Duration::from_secs(30)) {
            let done = event == ExecutorEvent::Done;
            seen.push(event);
            if done {
                break;
            }
        }
        assert!(seen.iter().any(|e| matches!(e, ExecutorEvent::ToolCall { .. })));
        assert!(seen.iter().any(|e| matches!(e, ExecutorEvent::Text { .. })));
        assert_eq!(seen.last(), Some(&ExecutorEvent::Done), "the turn must end cleanly");
        assert!(!session.is_busy());
    }

    /// Task 0.5: Codex re-spawns per turn, and that path used to persist via
    /// `store::floo_home()` — so every `cargo test` run leaked a project
    /// directory into the developer's real store. The session's own home is
    /// the only home a turn may write to.
    #[test]
    fn a_codex_turn_writes_only_into_its_own_floo_home() {
        fn project_dirs(home: &Path) -> usize {
            fs::read_dir(home.join("projects")).map(|d| d.flatten().count()).unwrap_or(0)
        }

        let real_home = store::floo_home();
        let before = project_dirs(&real_home);

        let (home, repo, hash, thread_id) = fixture();
        let (tx, rx) = mpsc::channel();
        let sink: Arc<dyn Sink> = Arc::new(Collector(tx));

        let mut session = start(
            Spawn {
                agent: codex(),
                bin: stub_path(),
                project_root: repo.path().to_path_buf(),
                project_hash: &hash,
                thread_id: &thread_id,
                mode: "spec",
                resume: None,
                floo_home: home.path().to_path_buf(),
                model: None,
                bypass: false,
            },
            sink.clone(),
        )
        .unwrap();
        send(&mut session, sink, "hello").unwrap();
        while let Ok(event) = rx.recv_timeout(std::time::Duration::from_secs(30)) {
            if event == ExecutorEvent::Done {
                break;
            }
        }

        // The turn did persist — into the fixture home, and nowhere else.
        let messages = store::read_thread(home.path(), &hash, &thread_id).unwrap();
        assert!(!messages.is_empty(), "the turn should have written to the fixture home");
        assert_eq!(
            project_dirs(&real_home),
            before,
            "a test session must not create project dirs in the real ~/.floo-network"
        );
    }

    /// Task 0.8: the durable log is capped; what the UI renders is not.
    #[test]
    fn a_huge_file_edit_persists_truncated_but_emits_whole() {
        let (home, _repo, hash, thread_id) = fixture();
        let after = "x".repeat(1024 * 1024);
        let event = ExecutorEvent::FileEdit {
            id: "1".into(),
            path: "big.txt".into(),
            before: String::new(),
            after: after.clone(),
        };

        let (tx, rx) = mpsc::channel();
        let sink: Arc<dyn Sink> = Arc::new(Collector(tx));
        persist(home.path(), &hash, &thread_id, "sess-1", "go", &event);
        sink.emit(&Envelope {
            session_id: "sess-1".into(),
            thread_id: thread_id.clone(),
            event: event.clone(),
        });

        let stored = store::read_thread(home.path(), &hash, &thread_id).unwrap();
        assert_eq!(stored.len(), 1);
        let ExecutorEvent::FileEdit { after: stored_after, .. } =
            serde_json::from_str::<ExecutorEvent>(&stored[0].content).unwrap()
        else {
            panic!("expected a FileEdit back out of the log");
        };
        assert!(stored_after.len() < after.len(), "the persisted copy must be capped");
        assert!(stored_after.contains("[truncated"), "and must say so");

        let ExecutorEvent::FileEdit { after: emitted_after, .. } = rx.recv().unwrap() else {
            panic!("expected a FileEdit on the sink");
        };
        assert_eq!(emitted_after, after, "the live event keeps the full payload");
    }

    /// Task 1.7: without an origin stamp the frontend has one global stream
    /// and no way to tell two sessions apart.
    #[test]
    fn every_emitted_event_carries_its_session_and_thread() {
        let (home, repo, hash, thread_id) = fixture();
        let (tx, rx) = mpsc::channel();
        let sink: Arc<dyn Sink> = Arc::new(Envelopes(tx));

        let mut session = start(
            Spawn {
                agent: claude(),
                bin: stub_path(),
                project_root: repo.path().to_path_buf(),
                project_hash: &hash,
                thread_id: &thread_id,
                mode: "spec",
                resume: None,
                floo_home: home.path().to_path_buf(),
                model: None,
                bypass: false,
            },
            sink.clone(),
        )
        .unwrap();
        let session_id = session.id.clone();
        assert_ne!(session_id, session.provider_handle, "Floo's id is not the provider's handle");

        send(&mut session, sink, "hello").unwrap();

        let mut seen = 0;
        while let Ok(envelope) = rx.recv_timeout(std::time::Duration::from_secs(30)) {
            assert_eq!(envelope.session_id, session_id);
            assert_eq!(envelope.thread_id, thread_id);
            seen += 1;
            if envelope.event == ExecutorEvent::Done {
                break;
            }
        }
        assert!(seen > 1, "the fixture turn emits several events");
    }

    /// Task 1.8: two sessions on one thread must stay distinguishable — this
    /// is the whole point of the envelope.
    #[test]
    fn two_sessions_on_one_thread_emit_under_distinct_ids() {
        let (home, repo, hash, thread_id) = fixture();
        let (tx, rx) = mpsc::channel();
        let sink: Arc<dyn Sink> = Arc::new(Envelopes(tx));

        let spawn = |mode: &'static str| Spawn {
            agent: claude(),
            bin: stub_path(),
            project_root: repo.path().to_path_buf(),
            project_hash: &hash,
            thread_id: &thread_id,
            mode,
            resume: None,
            floo_home: home.path().to_path_buf(),
            model: None,
            bypass: false,
        };
        let mut a = start(spawn("spec"), sink.clone()).unwrap();
        let mut b = start(spawn("go"), sink.clone()).unwrap();
        assert_ne!(a.id, b.id);

        send(&mut a, sink.clone(), "from a").unwrap();
        send(&mut b, sink, "from b").unwrap();

        let (mut from_a, mut from_b) = (0, 0);
        let (mut a_done, mut b_done) = (false, false);
        while !(a_done && b_done) {
            let Ok(envelope) = rx.recv_timeout(std::time::Duration::from_secs(30)) else {
                break;
            };
            let done = envelope.event == ExecutorEvent::Done;
            if envelope.session_id == a.id {
                from_a += 1;
                a_done |= done;
            } else if envelope.session_id == b.id {
                from_b += 1;
                b_done |= done;
            } else {
                panic!("an event arrived under neither session's id");
            }
        }
        assert!(a_done && b_done, "both sessions finished their turn");
        assert!(from_a > 0 && from_b > 0, "a view scoped to either session has events of its own");
    }

    /// Task 1.9 (writer half): what a session persists names that session.
    #[test]
    fn a_persisted_message_records_the_session_that_produced_it() {
        let (home, _repo, hash, thread_id) = fixture();
        persist(
            home.path(),
            &hash,
            &thread_id,
            "sess-1",
            "go",
            &ExecutorEvent::Text { text: "hi".into() },
        );
        let messages = store::read_thread(home.path(), &hash, &thread_id).unwrap();
        assert_eq!(messages[0].session_id.as_deref(), Some("sess-1"));
    }

    /// Task 2.12: the point of the session map — two agents, one thread,
    /// neither killing the other.
    #[test]
    fn two_agents_run_concurrently_on_one_thread() {
        let (home, repo, hash, thread_id) = fixture();
        let (tx, rx) = mpsc::channel();
        let sink: Arc<dyn Sink> = Arc::new(Envelopes(tx));

        let spawn = |agent| Spawn {
            agent,
            bin: stub_path(),
            project_root: repo.path().to_path_buf(),
            project_hash: &hash,
            thread_id: &thread_id,
            mode: "spec",
            resume: None,
            floo_home: home.path().to_path_buf(),
            model: None,
            bypass: false,
        };
        let mut claude = start(spawn(claude()), sink.clone()).unwrap();
        let mut codex = start(spawn(codex()), sink.clone()).unwrap();

        send(&mut claude, sink.clone(), "hi claude").unwrap();
        send(&mut codex, sink, "hi codex").unwrap();
        assert!(claude.is_busy() && codex.is_busy(), "each session has its own busy flag");

        let mut done: Vec<String> = vec![];
        while done.len() < 2 {
            let Ok(envelope) = rx.recv_timeout(std::time::Duration::from_secs(30)) else {
                break;
            };
            if envelope.event == ExecutorEvent::Done {
                done.push(envelope.session_id);
            }
        }
        done.sort();
        let mut expected = vec![claude.id.clone(), codex.id.clone()];
        expected.sort();
        assert_eq!(done, expected, "both agents finished a turn, under their own ids");
        assert!(!claude.is_busy() && !codex.is_busy());
    }

    /// Task 2.13: and across threads, with events routed to the right one.
    #[test]
    fn two_threads_run_concurrently_and_route_to_their_own_threads() {
        let (home, repo, hash, thread_a) = fixture();
        let thread_b = store::create_thread(home.path(), &hash, "b").unwrap().id;
        let (tx, rx) = mpsc::channel();
        let sink: Arc<dyn Sink> = Arc::new(Envelopes(tx));

        fn spawn<'a>(repo: &Path, home: &Path, hash: &'a str, thread_id: &'a str) -> Spawn<'a> {
            Spawn {
                agent: claude(),
                bin: stub_path(),
                project_root: repo.to_path_buf(),
                project_hash: hash,
                thread_id,
                mode: "spec",
                resume: None,
                floo_home: home.to_path_buf(),
                model: None,
                bypass: false,
            }
        }
        let mut a = start(spawn(repo.path(), home.path(), &hash, &thread_a), sink.clone()).unwrap();
        let mut b = start(spawn(repo.path(), home.path(), &hash, &thread_b), sink.clone()).unwrap();

        send(&mut a, sink.clone(), "to a").unwrap();
        send(&mut b, sink, "to b").unwrap();

        let mut finished = 0;
        while finished < 2 {
            let Ok(envelope) = rx.recv_timeout(std::time::Duration::from_secs(30)) else {
                break;
            };
            let expected = if envelope.session_id == a.id { &thread_a } else { &thread_b };
            assert_eq!(&envelope.thread_id, expected, "an event must name its own thread");
            if envelope.event == ExecutorEvent::Done {
                finished += 1;
            }
        }
        assert_eq!(finished, 2);
        // Each thread's history landed in its own log.
        for thread in [&thread_a, &thread_b] {
            let messages = store::read_thread(home.path(), &hash, thread).unwrap();
            assert!(!messages.is_empty(), "thread {thread} recorded its own turn");
        }
    }

    /// Task 2.17: the per-turn child used to be moved into the pump thread,
    /// where `terminate()` couldn't reach it — cancelling detached from a
    /// process that kept running.
    #[test]
    fn cancelling_a_per_turn_agent_kills_the_process() {
        let (home, repo, hash, thread_id) = fixture();
        let (tx, rx) = mpsc::channel();
        let sink: Arc<dyn Sink> = Arc::new(Collector(tx));
        let pidfile = repo.path().join("turn.pid");

        let mut session = start(
            Spawn {
                agent: codex(),
                bin: stub_path().with_file_name("fake-executor-hang.sh"),
                project_root: repo.path().to_path_buf(),
                project_hash: &hash,
                thread_id: &thread_id,
                mode: "spec",
                resume: None,
                floo_home: home.path().to_path_buf(),
                model: None,
                bypass: false,
            },
            sink.clone(),
        )
        .unwrap();
        // The turn message doubles as the stub's instruction on where to
        // report its PID.
        send(&mut session, sink, pidfile.to_string_lossy().as_ref()).unwrap();

        // Wait until the turn is genuinely under way.
        rx.recv_timeout(std::time::Duration::from_secs(30)).expect("the stub emitted its first line");
        let pid: i32 = fs::read_to_string(&pidfile).unwrap().trim().parse().unwrap();
        assert!(process_alive(pid), "the turn's process should be running before the cancel");

        session.terminate();
        assert!(!session.is_busy());

        let gone = (0..50).any(|_| {
            std::thread::sleep(std::time::Duration::from_millis(100));
            !process_alive(pid)
        });
        assert!(gone, "cancelling must kill the turn's process, not merely detach from it");
    }

    /// Task 2.18: the delete guard has to see every session on the thread. A
    /// busy *second* session used to be invisible to it.
    #[test]
    fn the_delete_guard_sees_any_busy_session_on_the_thread() {
        let (home, repo, hash, thread_id) = fixture();
        let other_thread = store::create_thread(home.path(), &hash, "other").unwrap().id;
        let (tx, rx) = mpsc::channel();
        let sink: Arc<dyn Sink> = Arc::new(Collector(tx));
        let harness = Harness::default();

        let spawn_into = |thread: &str, agent| {
            let session = start(
                Spawn {
                    agent,
                    bin: stub_path(),
                    project_root: repo.path().to_path_buf(),
                    project_hash: &hash,
                    thread_id: thread,
                    mode: "spec",
                    resume: None,
                    floo_home: home.path().to_path_buf(),
                    model: None,
                    bypass: false,
                },
                sink.clone(),
            )
            .unwrap();
            let id = session.id.clone();
            harness.sessions.lock().unwrap().insert(id.clone(), session);
            id
        };
        let idle = spawn_into(&thread_id, claude());
        let working = spawn_into(&thread_id, codex());
        spawn_into(&other_thread, claude());

        assert!(!harness.thread_is_busy(&thread_id), "nothing is mid-turn yet");

        {
            let mut sessions = harness.sessions.lock().unwrap();
            send(sessions.get_mut(&working).unwrap(), sink.clone(), "go").unwrap();
        }
        assert!(
            harness.thread_is_busy(&thread_id),
            "a busy session that isn't the most recent one still blocks a delete"
        );
        assert!(!harness.thread_is_busy(&other_thread), "and the guard stays scoped to its thread");
        assert!(!harness.sessions.lock().unwrap()[&idle].is_busy(), "busy is per session");

        while let Ok(event) = rx.recv_timeout(std::time::Duration::from_secs(30)) {
            if event == ExecutorEvent::Done {
                break;
            }
        }
        // Give the pump thread its moment to clear the flag after Done.
        assert!(
            (0..50).any(|_| {
                std::thread::sleep(std::time::Duration::from_millis(50));
                !harness.thread_is_busy(&thread_id)
            }),
            "the guard lifts once the turn finishes"
        );
    }

    /// D20: `Done` ends a turn, not the session. The record stays open and the
    /// same session takes the next turn — closing on `Done` would leave that
    /// turn appending under a session already marked ended.
    #[test]
    fn a_finished_turn_leaves_the_session_live_for_the_next_one() {
        let (home, repo, hash, thread_id) = fixture();
        let (tx, rx) = mpsc::channel();
        let sink: Arc<dyn Sink> = Arc::new(Collector(tx));

        let mut session = start(
            Spawn {
                agent: claude(),
                bin: stub_path(),
                project_root: repo.path().to_path_buf(),
                project_hash: &hash,
                thread_id: &thread_id,
                mode: "spec",
                resume: None,
                floo_home: home.path().to_path_buf(),
                model: None,
                bypass: false,
            },
            sink.clone(),
        )
        .unwrap();
        store::open_session(
            home.path(), &hash, &thread_id, &session.id, "claude", "spec", None, None, None,
        )
        .unwrap();

        let await_done = || {
            while let Ok(event) = rx.recv_timeout(std::time::Duration::from_secs(30)) {
                if event == ExecutorEvent::Done {
                    return;
                }
            }
            panic!("the turn never finished");
        };

        send(&mut session, sink.clone(), "first").unwrap();
        await_done();
        let records = store::read_sessions(home.path(), &hash, &thread_id).unwrap();
        assert_eq!(records[0].outcome, None, "a finished turn is not a finished session");

        // The proof: the same session takes another turn.
        send(&mut session, sink, "second").unwrap();
        await_done();
        assert!(!session.is_busy());

        store::close_session(home.path(), &hash, &thread_id, &session.id, "done", None).unwrap();
        let records = store::read_sessions(home.path(), &hash, &thread_id).unwrap();
        assert_eq!(records[0].outcome.as_deref(), Some("done"));
    }

    /// Task 5.10: two sessions in one project root means the uncommitted set
    /// belongs to no single one of them. Floo says "ambiguous" rather than
    /// splitting it on a heuristic and presenting the guess as evidence.
    #[test]
    fn attribution_is_ambiguous_while_two_sessions_share_a_project_root() {
        let (home, repo, hash, thread_id) = fixture();
        let other_project = store::add_project(home.path(), tempfile::tempdir().unwrap().path())
            .unwrap()
            .hash;
        let (tx, _rx) = mpsc::channel();
        let sink: Arc<dyn Sink> = Arc::new(Collector(tx));
        let harness = Harness::default();

        let mut spawn_into = |project_hash: &str| {
            let session = start(
                Spawn {
                    agent: claude(),
                    bin: stub_path(),
                    project_root: repo.path().to_path_buf(),
                    project_hash,
                    thread_id: &thread_id,
                    mode: "spec",
                    resume: None,
                    floo_home: home.path().to_path_buf(),
                    model: None,
                    bypass: false,
                },
                sink.clone(),
            )
            .unwrap();
            let id = session.id.clone();
            harness.sessions.lock().unwrap().insert(id.clone(), session);
            id
        };

        let first = spawn_into(&hash);
        assert_eq!(harness.sessions_in_project(&hash), 1, "one session: attribution is exact");

        spawn_into(&hash);
        assert_eq!(harness.sessions_in_project(&hash), 2, "two: it is not");

        // A session elsewhere doesn't muddy this project's attribution.
        spawn_into(&other_project);
        assert_eq!(harness.sessions_in_project(&hash), 2);
        assert_eq!(harness.sessions_in_project(&other_project), 1);

        // And once the second ends, the first is unambiguous again.
        harness.sessions.lock().unwrap().retain(|id, _| *id == first);
        assert_eq!(harness.sessions_in_project(&hash), 1);
    }

    /// `kill -0`: signal 0 tests for existence without delivering anything.
    fn process_alive(pid: i32) -> bool {
        Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }

    /// Multi-byte content must not be sliced mid-code-point by the cap.
    #[test]
    fn capping_never_splits_a_utf8_code_point() {
        let text = "é".repeat(PERSIST_CAP);
        let capped = cap(&text);
        assert!(capped.starts_with('é'));
        assert!(capped.contains("[truncated"));
    }
}
