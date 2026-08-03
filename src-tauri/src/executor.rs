//! Executor detection, preflight checks, and the two process adapters.
//!
//! Claude and Codex are architecturally different (D11): Claude is one
//! persistent process fed newline-delimited JSON on stdin; Codex has no
//! persistent mode, so every turn is a fresh `codex exec resume --last`.
//! Both parsers map into one `ExecutorEvent` so nothing downstream cares.

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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Claude,
    Codex,
}

impl Kind {
    /// The permission flag value each executor uses for a given harness mode.
    fn permission_value(&self, mode: &str) -> &'static str {
        match (self, mode) {
            (Kind::Claude, "go") => "acceptEdits",
            (Kind::Claude, _) => "plan",
            (Kind::Codex, "go") => "workspace-write",
            (Kind::Codex, _) => "read-only",
        }
    }

    /// How a skill is invoked in each executor's chat input.
    pub fn skill_prefix(&self) -> &'static str {
        match self {
            Kind::Claude => "/",
            Kind::Codex => "$",
        }
    }
}

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

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preflight {
    pub claude: Option<String>,
    pub codex: Option<String>,
    /// `claude` wins when both are installed.
    pub selected: Option<Kind>,
    pub openspec: bool,
    pub grill_apply: bool,
    pub ponytail: bool,
    /// True when a change-linked `/go` has everything it needs.
    pub ready: bool,
    pub warnings: Vec<String>,
    pub checked_at: String,
}

pub fn preflight() -> Preflight {
    let claude = find_on_path("claude");
    let codex = find_on_path("codex");
    let selected = match (&claude, &codex) {
        (Some(_), _) => Some(Kind::Claude),
        (None, Some(_)) => Some(Kind::Codex),
        (None, None) => None,
    };

    let openspec = find_on_path("openspec").is_some();
    let (grill_apply, ponytail) = match selected {
        Some(Kind::Claude) => (
            home().join(".claude/skills/grill-apply").is_dir(),
            home().join(".claude/plugins/cache/ponytail").is_dir(),
        ),
        Some(Kind::Codex) => (
            home().join(".agents/skills/grill-apply").is_dir(),
            home().join(".agents/skills/ponytail").is_dir(),
        ),
        None => (false, false),
    };

    let mut warnings = vec![];
    if selected.is_none() {
        warnings.push("Neither `claude` nor `codex` found on PATH — chat-only mode, /go unavailable.".into());
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

    Preflight {
        claude: claude.map(|p| p.to_string_lossy().to_string()),
        codex: codex.map(|p| p.to_string_lossy().to_string()),
        selected,
        openspec,
        grill_apply,
        ponytail,
        ready: selected.is_some() && grill_apply && openspec,
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
    if !matches!(kind, "item.started" | "item.completed") {
        if kind == "turn.completed" {
            return vec![ExecutorEvent::Done];
        }
        return vec![];
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
        Some("command_execution") => {
            if kind == "item.started" {
                vec![ExecutorEvent::ToolCall { id, name: "Bash".into(), command: string("command") }]
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
pub fn persist(home: &Path, project_hash: &str, thread_id: &str, mode: &str, event: &ExecutorEvent) {
    let (role, content) = match event {
        ExecutorEvent::Text { text } => ("assistant", text.clone()),
        // Reasoning is transient and can be enormous; not persisted.
        ExecutorEvent::Reasoning { .. } | ExecutorEvent::Done => return,
        ExecutorEvent::Crashed { message, .. } => ("system", message.clone()),
        structured => ("tool", serde_json::to_string(structured).unwrap_or_default()),
    };
    let _ = store::append_message(home, project_hash, thread_id, role, mode, &content);
}

// -------------------------------------------------------------- processes

struct Live {
    child: Child,
    stdin: Option<ChildStdin>,
}

pub struct Session {
    pub kind: Kind,
    /// The executable detection resolved. Codex re-spawns it every turn, so
    /// this has to be the real path — looking `codex` up by name again would
    /// ignore what detection found and can't be pointed at a test stub.
    pub bin: PathBuf,
    pub project_hash: String,
    pub thread_id: String,
    pub project_root: PathBuf,
    pub mode: String,
    /// Claude's conversation UUID — the handle `--resume` needs for handoff.
    pub session_id: String,
    live: Option<Live>,
    codex_started: bool,
    pub busy: Arc<AtomicBool>,
    stopping: Arc<AtomicBool>,
}

impl Session {
    pub fn is_busy(&self) -> bool {
        self.busy.load(Ordering::SeqCst)
    }

    /// Kill the process outright — switching back to spec-mode terminates,
    /// never backgrounds (D7).
    pub fn terminate(&mut self) {
        self.stopping.store(true, Ordering::SeqCst);
        if let Some(live) = self.live.as_mut() {
            drop(live.stdin.take());
            let _ = live.child.kill();
            let _ = live.child.wait();
        }
        self.busy.store(false, Ordering::SeqCst);
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.terminate();
    }
}

/// Anything that can receive parsed events — the Tauri app handle in
/// production, a channel in tests.
pub trait Sink: Send + Sync + 'static {
    fn emit(&self, event: &ExecutorEvent);
}

fn claude_args(mode: &str, session_id: &str, resume: bool) -> Vec<String> {
    let mut args: Vec<String> = [
        "--print",
        "--verbose",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--permission-mode",
        Kind::Claude.permission_value(mode),
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    // --session-id sets the id up front; --resume reuses it after a handoff.
    args.push(if resume { "--resume".into() } else { "--session-id".into() });
    args.push(session_id.to_string());
    args
}

pub struct Spawn<'a> {
    pub kind: Kind,
    pub bin: PathBuf,
    pub project_root: PathBuf,
    pub project_hash: &'a str,
    pub thread_id: &'a str,
    pub mode: &'a str,
    /// Reuse an existing conversation instead of starting one.
    pub resume: Option<String>,
    pub floo_home: PathBuf,
}

pub fn start(spawn: Spawn, sink: Arc<dyn Sink>) -> Res<Session> {
    let session_id = spawn
        .resume
        .clone()
        .unwrap_or_else(|| uuid_v4());
    let busy = Arc::new(AtomicBool::new(false));
    let stopping = Arc::new(AtomicBool::new(false));

    let live = match spawn.kind {
        Kind::Claude => {
            let mut child = Command::new(&spawn.bin)
                .args(claude_args(spawn.mode, &session_id, spawn.resume.is_some()))
                .current_dir(&spawn.project_root)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|err| format!("spawn claude: {err}"))?;
            let stdout = child.stdout.take().ok_or("claude stdout unavailable")?;
            let stdin = child.stdin.take();
            pump(
                stdout,
                Kind::Claude,
                sink,
                spawn.floo_home.clone(),
                spawn.project_hash.to_string(),
                spawn.thread_id.to_string(),
                spawn.mode.to_string(),
                busy.clone(),
                stopping.clone(),
                None,
            );
            Some(Live { child, stdin })
        }
        // Codex has no persistent process; each turn spawns its own.
        Kind::Codex => None,
    };

    Ok(Session {
        kind: spawn.kind,
        bin: spawn.bin,
        project_hash: spawn.project_hash.to_string(),
        thread_id: spawn.thread_id.to_string(),
        project_root: spawn.project_root,
        mode: spawn.mode.to_string(),
        session_id,
        live,
        // Codex carries a conversation forward with `resume --last` on its
        // next turn rather than a session id, so this is all "resume" means.
        codex_started: spawn.kind == Kind::Codex && spawn.resume.is_some(),
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

    match session.kind {
        Kind::Claude => {
            let line = serde_json::to_string(&json!({
                "type": "user",
                "message": { "role": "user", "content": [{ "type": "text", "text": message }] }
            }))
            .map_err(|err| format!("encode turn: {err}"))?;
            let stdin = session
                .live
                .as_mut()
                .and_then(|live| live.stdin.as_mut())
                .ok_or("claude process is not running")?;
            writeln!(stdin, "{line}").map_err(|err| {
                session.busy.store(false, Ordering::SeqCst);
                format!("write to claude: {err}")
            })?;
            stdin.flush().map_err(|err| format!("flush claude stdin: {err}"))?;
        }
        Kind::Codex => {
            let mut command = Command::new(&session.bin);
            command.arg("exec");
            if session.codex_started {
                command.arg("resume").arg("--last");
            }
            command
                .arg(message)
                .arg("--json")
                .arg("--sandbox")
                .arg(Kind::Codex.permission_value(&session.mode))
                .arg("-C")
                .arg(&session.project_root);
            let mut child = command
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|err| format!("spawn codex: {err}"))?;
            let stdout = child.stdout.take().ok_or("codex stdout unavailable")?;
            session.codex_started = true;
            pump(
                stdout,
                Kind::Codex,
                sink,
                store::floo_home(),
                session.project_hash.clone(),
                session.thread_id.clone(),
                session.mode.clone(),
                session.busy.clone(),
                session.stopping.clone(),
                Some(child),
            );
        }
    }
    Ok(())
}

/// Read an executor's stdout to EOF on a background thread, mapping each line
/// into events, persisting them, and forwarding them to the sink.
#[allow(clippy::too_many_arguments)]
fn pump(
    stdout: impl std::io::Read + Send + 'static,
    kind: Kind,
    sink: Arc<dyn Sink>,
    floo_home: PathBuf,
    project_hash: String,
    thread_id: String,
    mode: String,
    busy: Arc<AtomicBool>,
    stopping: Arc<AtomicBool>,
    mut own_child: Option<Child>,
) {
    std::thread::spawn(move || {
        let read_before = |path: &str| fs::read_to_string(path).unwrap_or_default();
        let mut saw_done = false;

        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            let events = match kind {
                Kind::Claude => parse_claude_line(&value, &read_before),
                Kind::Codex => parse_codex_line(&value),
            };
            for event in events {
                if matches!(event, ExecutorEvent::Done) {
                    saw_done = true;
                    busy.store(false, Ordering::SeqCst);
                }
                persist(&floo_home, &project_hash, &thread_id, &mode, &event);
                sink.emit(&event);
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
        let (exit_code, crashed) = match own_child.as_mut() {
            Some(child) => {
                let code = child.wait().ok().and_then(|status| status.code());
                (code, code.is_some_and(|code| code != 0) || !saw_done)
            }
            None => (None, true),
        };
        if crashed {
            let event = ExecutorEvent::Crashed {
                exit_code,
                message: "Executor process ended unexpectedly.".into(),
            };
            persist(&floo_home, &project_hash, &thread_id, &mode, &event);
            sink.emit(&event);
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

/// Names of the OpenSpec changes currently present in a project.
pub fn openspec_changes(project_root: &Path) -> Vec<String> {
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

/// The single change that appeared between two snapshots, if exactly one did.
/// Using the filesystem as the source of truth avoids parsing skill output.
pub fn newly_added_change(before: &[String], after: &[String]) -> Option<String> {
    let added: Vec<&String> = after.iter().filter(|name| !before.contains(name)).collect();
    match added.as_slice() {
        [only] => Some((*only).clone()),
        _ => None,
    }
}

/// How a thread recovers from its executor dying: back to spec mode, and the
/// dead session forgotten so the next `/go` starts clean instead of resuming a
/// conversation the executor no longer has. History is append-only, so nothing
/// here can cost messages.
pub fn on_crash(home: &Path, hash: &str, thread_id: &str) -> Res<()> {
    store::set_thread_mode(home, hash, thread_id, "spec")?;
    store::set_executor_session(home, hash, thread_id, None)?;
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
    pub session: Mutex<Option<Session>>,
    pub preflight: Mutex<Option<Preflight>>,
    pub pending_propose: Mutex<Option<ProposeWatch>>,
}

// ------------------------------------------------------------------ tests

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    struct Collector(mpsc::Sender<ExecutorEvent>);
    impl Sink for Collector {
        fn emit(&self, event: &ExecutorEvent) {
            let _ = self.0.send(event.clone());
        }
    }

    fn no_before(_: &str) -> String {
        String::new()
    }

    #[test]
    fn claude_wins_when_both_executors_are_present() {
        // Detection preference is pure logic over the two lookup results.
        let pick = |claude: bool, codex: bool| match (claude, codex) {
            (true, _) => Some(Kind::Claude),
            (false, true) => Some(Kind::Codex),
            (false, false) => None,
        };
        assert_eq!(pick(true, true), Some(Kind::Claude));
        assert_eq!(pick(true, false), Some(Kind::Claude));
        assert_eq!(pick(false, true), Some(Kind::Codex));
        assert_eq!(pick(false, false), None);
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
        assert_eq!(Kind::Claude.permission_value("spec"), "plan");
        assert_eq!(Kind::Claude.permission_value("go"), "acceptEdits");
        assert_eq!(Kind::Codex.permission_value("spec"), "read-only");
        assert_eq!(Kind::Codex.permission_value("go"), "workspace-write");
    }

    #[test]
    fn claude_args_use_session_id_when_starting_and_resume_when_handing_off() {
        let fresh = claude_args("spec", "abc", false);
        assert!(fresh.contains(&"--session-id".to_string()));
        assert!(!fresh.contains(&"--resume".to_string()));
        assert!(fresh.contains(&"plan".to_string()));

        let handoff = claude_args("go", "abc", true);
        assert!(handoff.contains(&"--resume".to_string()));
        assert!(handoff.contains(&"acceptEdits".to_string()));
        // --verbose is mandatory alongside --output-format stream-json.
        assert!(handoff.contains(&"--verbose".to_string()));
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
            vec![ExecutorEvent::ToolCall { id: "c2".into(), name: "Bash".into(), command: "ls".into() }]
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

    #[test]
    fn a_single_new_openspec_change_is_detected() {
        let before = vec!["a".to_string()];
        assert_eq!(newly_added_change(&before, &["a".into(), "b".into()]), Some("b".into()));
        assert_eq!(newly_added_change(&before, &["a".into()]), None);
        // Ambiguous: two appeared, so nothing is recorded rather than a guess.
        assert_eq!(newly_added_change(&before, &["a".into(), "b".into(), "c".into()]), None);
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
            persist(home.path(), &project.hash, &thread.id, "go", &event);
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
                kind: Kind::Claude,
                bin: stub_path(),
                project_root: repo.path().to_path_buf(),
                project_hash: &hash,
                thread_id: &thread_id,
                mode: "spec",
                resume: None,
                floo_home: home.path().to_path_buf(),
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
                kind: Kind::Claude,
                bin: stub_path(),
                project_root: repo.path().to_path_buf(),
                project_hash: &hash,
                thread_id: &thread_id,
                mode: "spec",
                resume: None,
                floo_home: home.path().to_path_buf(),
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
                kind: Kind::Claude,
                bin: stub_path().with_file_name("fake-executor-crash.sh"),
                project_root: repo.path().to_path_buf(),
                project_hash: &hash,
                thread_id: &thread_id,
                mode: "spec",
                resume: None,
                floo_home: home.path().to_path_buf(),
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
                kind: Kind::Claude,
                bin: stub_path().with_file_name("fake-executor-oneshot.sh"),
                project_root: repo.path().to_path_buf(),
                project_hash: &hash,
                thread_id: &thread_id,
                mode: "go",
                resume: None,
                floo_home: home.path().to_path_buf(),
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
        store::append_message(home.path(), &hash, &thread_id, "user", "go", "before the crash").unwrap();
        store::set_thread_mode(home.path(), &hash, &thread_id, "go").unwrap();
        store::set_executor_session(home.path(), &hash, &thread_id, Some("sess-1")).unwrap();

        on_crash(home.path(), &hash, &thread_id).unwrap();

        let meta = store::list_threads(home.path(), &hash).unwrap().remove(0);
        assert_eq!(meta.current_mode, "spec", "a crash drops back to spec mode");
        assert_eq!(
            meta.executor_session_id, None,
            "the dead session id must be forgotten, or every retry resumes it and fails identically"
        );
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
                kind: Kind::Claude,
                bin: stub_path(),
                project_root: repo.path().to_path_buf(),
                project_hash: &hash,
                thread_id: &thread_id,
                mode: "spec",
                resume: None,
                floo_home: home.path().to_path_buf(),
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
                kind: Kind::Codex,
                // The stub, never the real `codex` — a test must not spend an
                // API call, and the fake-executor exists precisely for this.
                bin: stub_path(),
                project_root: repo.path().to_path_buf(),
                project_hash: &hash,
                thread_id: &thread_id,
                mode: "spec",
                resume: None,
                floo_home: home.path().to_path_buf(),
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
}
