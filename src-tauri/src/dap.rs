//! Debug Adapter Protocol client (breakpoints, stepping, stack, watches).
//!
//! Same shape as `lsp.rs`, and deliberately so: Palisade never bundles or
//! installs a debug adapter — it finds one on PATH and reports honestly when
//! there isn't one (D5/D6). Framing is DAP's own `Content-Length` stdio
//! envelope, which is byte-for-byte LSP's, so `lsp::frame`/`drain_messages`
//! are reused rather than reimplemented.
//!
//! What's here is the transport and correlation layer. It is generic over a
//! `Read`/`Write` pair so it can be driven end-to-end in tests by a fake
//! adapter, without a real debugger on the machine.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::store::Res;
use crate::locks::MutexExt;

/// How long a single DAP request may take before the caller gives up.
///
/// Generous: `launch` compiles and starts a program, and an `evaluate` on a
/// paused-but-busy target is not instant. The point is that a wedged adapter
/// eventually reports a wedged adapter rather than hanging the UI thread
/// forever with no explanation.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Everything that can come back on the wire.
enum Incoming {
    Response { request_seq: i64, success: bool, body: Value, message: Option<String> },
    Event { event: String, body: Value },
    /// A reverse request (`runInTerminal`, `startDebugging`). Acknowledged
    /// rather than ignored: an unanswered reverse request stalls adapters
    /// that wait on it.
    ReverseRequest { seq: i64, command: String, arguments: Value },
}

fn classify(body: &str) -> Option<Incoming> {
    let value: Value = serde_json::from_str(body).ok()?;
    match value.get("type").and_then(Value::as_str)? {
        "response" => Some(Incoming::Response {
            request_seq: value.get("request_seq").and_then(Value::as_i64)?,
            success: value.get("success").and_then(Value::as_bool).unwrap_or(false),
            body: value.get("body").cloned().unwrap_or(Value::Null),
            message: value.get("message").and_then(Value::as_str).map(str::to_string),
        }),
        "event" => Some(Incoming::Event {
            event: value.get("event").and_then(Value::as_str)?.to_string(),
            body: value.get("body").cloned().unwrap_or(Value::Null),
        }),
        "request" => Some(Incoming::ReverseRequest {
            seq: value.get("seq").and_then(Value::as_i64)?,
            command: value.get("command").and_then(Value::as_str)?.to_string(),
            arguments: value.get("arguments").cloned().unwrap_or(Value::Null),
        }),
        _ => None,
    }
}

type Waiters = Arc<Mutex<HashMap<i64, mpsc::Sender<Res<Value>>>>>;

/// A live connection to one debug adapter.
///
/// Owns the writer, the sequence counter, and the map of in-flight requests.
/// A background thread reads the adapter's stream, routing responses to their
/// waiting callers and events to the sink.
pub struct DapConnection {
    writer: Mutex<Box<dyn Write + Send>>,
    seq: AtomicI64,
    waiters: Waiters,
    reader: Mutex<Option<thread::JoinHandle<()>>>,
}

impl DapConnection {
    /// Starts reading `reader` and routing what it finds. `on_event` is called
    /// from the reader thread for every adapter event.
    pub fn new(
        reader: impl Read + Send + 'static,
        writer: impl Write + Send + 'static,
        on_event: impl Fn(&str, Value) + Send + 'static,
    ) -> Arc<Self> {
        let connection = Arc::new(DapConnection {
            writer: Mutex::new(Box::new(writer)),
            // DAP sequence numbers start at 1; 0 is not a valid seq.
            seq: AtomicI64::new(1),
            waiters: Arc::new(Mutex::new(HashMap::new())),
            reader: Mutex::new(None),
        });

        // Events are handed to a second thread rather than run inline on the
        // reader.
        //
        // The natural response to `stopped` is to go and fetch the call
        // stack, and a handler running on the reader thread could never get
        // an answer: the reply it waits for can only be delivered by the
        // thread it is blocking. Live, that left the debuggee paused at a
        // breakpoint forever with the UI none the wiser. A channel keeps the
        // reader free to read, and — because it is a queue — events still
        // reach the handler in the order the adapter sent them, so a
        // `continued` can never overtake the `stopped` before it.
        let (events_tx, events_rx) = mpsc::channel::<(String, Value)>();
        thread::spawn(move || {
            while let Ok((event, body)) = events_rx.recv() {
                on_event(&event, body);
            }
        });

        let pump_target = Arc::downgrade(&connection);
        let waiters = Arc::clone(&connection.waiters);
        let dispatch = events_tx.clone();
        let handle = thread::spawn(move || {
            pump(reader, &waiters, &dispatch, &pump_target);
            // The stream ended: the adapter exited, cleanly or otherwise.
            // Every caller still waiting has to be told, or they block until
            // their timeout with no idea why.
            let orphaned: Vec<_> = waiters.lock_or_recover().drain().collect();
            for (_, tx) in orphaned {
                let _ = tx.send(Err("debug adapter disconnected".into()));
            }
            let _ = dispatch.send(("__closed".to_string(), Value::Null));
        });
        *connection.reader.lock_or_recover() = Some(handle);
        connection
    }

    /// Sends one request and blocks until its response arrives.
    ///
    /// Correlation is by `request_seq`, never by arrival order: an adapter
    /// answers a slow `evaluate` after a fast `stackTrace` issued later, and
    /// events interleave freely with both.
    pub fn request(&self, command: &str, arguments: Value) -> Res<Value> {
        self.request_with_timeout(command, arguments, REQUEST_TIMEOUT)
    }

    pub fn request_with_timeout(
        &self,
        command: &str,
        arguments: Value,
        timeout: Duration,
    ) -> Res<Value> {
        let seq = self.seq.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = mpsc::channel();
        self.waiters.lock_or_recover().insert(seq, tx);

        let envelope = json!({
            "seq": seq,
            "type": "request",
            "command": command,
            "arguments": arguments,
        });
        if let Err(err) = self.write(&envelope) {
            self.waiters.lock_or_recover().remove(&seq);
            return Err(err);
        }

        match rx.recv_timeout(timeout) {
            Ok(result) => result,
            Err(_) => {
                // Drop the waiter so a late response is discarded rather than
                // delivered to a channel nobody is listening on.
                self.waiters.lock_or_recover().remove(&seq);
                Err(format!("debug adapter did not answer `{command}` within {timeout:?}").into())
            }
        }
    }

    /// Fire-and-forget: used only where DAP itself defines no response.
    pub fn notify(&self, command: &str, arguments: Value) -> Res<()> {
        let seq = self.seq.fetch_add(1, Ordering::SeqCst);
        self.write(&json!({
            "seq": seq,
            "type": "request",
            "command": command,
            "arguments": arguments,
        }))
    }

    fn write(&self, envelope: &Value) -> Res<()> {
        let body = serde_json::to_string(envelope).map_err(|err| crate::PalisadeError::from(format!("encode: {err}")))?;
        let mut writer = self.writer.lock_or_recover();
        writer
            .write_all(crate::lsp::frame(&body).as_bytes())
            .map_err(|err| crate::PalisadeError::from(format!("write to debug adapter: {err}")))?;
        writer.flush().map_err(|err| crate::PalisadeError::from(format!("flush debug adapter: {err}")))
    }

    /// Answers a reverse request. The adapter blocks on these.
    fn respond(&self, request_seq: i64, command: &str, success: bool, body: Value) -> Res<()> {
        let seq = self.seq.fetch_add(1, Ordering::SeqCst);
        self.write(&json!({
            "seq": seq,
            "type": "response",
            "request_seq": request_seq,
            "success": success,
            "command": command,
            "body": body,
        }))
    }
}

fn pump(
    mut reader: impl Read,
    waiters: &Waiters,
    dispatch: &mpsc::Sender<(String, Value)>,
    connection: &std::sync::Weak<DapConnection>,
) {
    let mut buffer: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        let read = match reader.read(&mut chunk) {
            Ok(0) | Err(_) => return,
            Ok(n) => n,
        };
        buffer.extend_from_slice(&chunk[..read]);
        // A message can arrive split across reads, and two can arrive in one:
        // the framing decoder handles both, leaving any partial tail behind.
        for body in crate::lsp::drain_messages(&mut buffer) {
            let Some(incoming) = classify(&body) else { continue };
            match incoming {
                Incoming::Response { request_seq, success, body, message } => {
                    let waiter = waiters.lock_or_recover().remove(&request_seq);
                    // No waiter means the caller already timed out — dropping
                    // it is correct, and must not be mistaken for an event.
                    if let Some(tx) = waiter {
                        let _ = tx.send(match success {
                            true => Ok(body),
                            false => Err(message
                                .map(crate::PalisadeError::from)
                                .unwrap_or_else(|| crate::PalisadeError::from("request failed"))),
                        });
                    }
                }
                Incoming::Event { event, body } => {
                    let _ = dispatch.send((event, body));
                }
                Incoming::ReverseRequest { seq, command, arguments } => {
                    if let Some(connection) = connection.upgrade() {
                        // Palisade runs debuggees in its own terminal, so
                        // `runInTerminal` is declined rather than faked; every
                        // other reverse request is acknowledged so the adapter
                        // stops waiting on it.
                        let _ = connection.respond(seq, &command, true, Value::Null);
                    }
                    let _ = dispatch.send((format!("reverse:{command}"), arguments));
                }
            }
        }
    }
}

// ------------------------------------------------------------- breakpoints

/// A breakpoint the user set, as Palisade remembers it.
///
/// Persisted per project so it survives a restart of the app *and* of the
/// debug session — a breakpoint you have to re-place every launch is a
/// breakpoint you stop using.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Breakpoint {
    /// Project-relative path.
    pub path: String,
    /// 1-based line, as the user placed it.
    pub line: u32,
    /// Off without being forgotten.
    #[serde(default = "yes")]
    pub enabled: bool,
    /// Only break when this expression is true. `None` = always.
    #[serde(default)]
    pub condition: Option<String>,
    /// What the adapter said about it on the last `setBreakpoints`.
    /// `None` = never sent to an adapter yet, which is not the same as
    /// "rejected" and must not be rendered as one.
    #[serde(default)]
    pub verified: Option<bool>,
    /// Where the adapter actually bound it, when that differs from `line` —
    /// a breakpoint on a blank line or a comment slides to the next
    /// statement, and showing it where the user clicked would be a lie.
    #[serde(default)]
    pub actual_line: Option<u32>,
    /// Why the adapter refused or moved it.
    #[serde(default)]
    pub message: Option<String>,
}

fn yes() -> bool {
    true
}

impl Breakpoint {
    pub fn new(path: impl Into<String>, line: u32) -> Self {
        Breakpoint {
            path: path.into(),
            line,
            enabled: true,
            condition: None,
            verified: None,
            actual_line: None,
            message: None,
        }
    }

    /// Where this breakpoint really is: what the adapter bound, or where the
    /// user put it while nothing has said otherwise.
    pub fn effective_line(&self) -> u32 {
        self.actual_line.unwrap_or(self.line)
    }
}

/// Folds one `setBreakpoints` response back onto the breakpoints it answered.
///
/// DAP guarantees the response array is positionally aligned with the request
/// array, which is the only way to tell which answer belongs to which line —
/// the adapter may have moved several of them.
pub fn apply_set_breakpoints_response(sent: &mut [Breakpoint], body: &Value) {
    let answers = body.get("breakpoints").and_then(Value::as_array);
    let Some(answers) = answers else {
        // No array at all: say nothing rather than inventing verification.
        for breakpoint in sent.iter_mut() {
            breakpoint.verified = None;
        }
        return;
    };
    for (breakpoint, answer) in sent.iter_mut().zip(answers) {
        breakpoint.verified = Some(answer.get("verified").and_then(Value::as_bool).unwrap_or(false));
        let bound = answer.get("line").and_then(Value::as_i64).map(|l| l as u32);
        breakpoint.actual_line = match bound {
            Some(line) if line != breakpoint.line => Some(line),
            _ => None,
        };
        breakpoint.message =
            answer.get("message").and_then(Value::as_str).map(str::to_string);
    }
    // Fewer answers than requests: the unanswered ones are unknown, not
    // verified. Silence must never read as success.
    for breakpoint in sent.iter_mut().skip(answers.len()) {
        breakpoint.verified = None;
    }
}

/// The `setBreakpoints` arguments for one source file.
pub fn set_breakpoints_arguments(path: &str, breakpoints: &[Breakpoint]) -> Value {
    json!({
        "source": { "path": path },
        "breakpoints": breakpoints
            .iter()
            .filter(|b| b.enabled)
            .map(|b| match &b.condition {
                Some(condition) => json!({ "line": b.line, "condition": condition }),
                None => json!({ "line": b.line }),
            })
            .collect::<Vec<_>>(),
        // Required by adapters that support it; harmless to those that don't.
        "sourceModified": false,
    })
}

// ------------------------------------------------------------- session flow

/// What Palisade tells the adapter it can do.
///
/// Only what is actually implemented: an adapter that believes a claimed
/// capability will use it, and a claim we can't honour hangs the session.
/// `runInTerminal` in particular is declined — Palisade owns its terminals
/// and does not hand one to a debug adapter.
pub fn initialize_arguments() -> Value {
    json!({
        "clientID": "palisade",
        "clientName": "Palisade Code",
        "adapterID": "palisade",
        "locale": "en-US",
        "linesStartAt1": true,
        "columnsStartAt1": true,
        "pathFormat": "path",
        "supportsVariableType": true,
        "supportsVariablePaging": false,
        "supportsRunInTerminalRequest": false,
        "supportsMemoryReferences": false,
        "supportsProgressReporting": false,
    })
}

/// One file's worth of breakpoints and how the adapter answered.
pub type BoundFile = (String, Vec<Breakpoint>);

/// The configuration phase of a launch, in DAP's required order.
///
/// This runs *after* the adapter's `initialized` event and *before* the
/// program is let go: breakpoints sent earlier are silently dropped by many
/// adapters, and breakpoints sent later are missed because execution has
/// already run past them. Ordering is the whole point of this function.
pub fn configure(connection: &DapConnection, files: Vec<BoundFile>) -> Res<Vec<BoundFile>> {
    configure_with(connection, files, true)
}

pub fn configure_with(
    connection: &DapConnection,
    files: Vec<BoundFile>,
    supports_configuration_done: bool,
) -> Res<Vec<BoundFile>> {
    let mut bound = Vec::with_capacity(files.len());
    for (path, mut breakpoints) in files {
        match connection.request("setBreakpoints", set_breakpoints_arguments(&path, &breakpoints)) {
            Ok(body) => apply_set_breakpoints_response(&mut breakpoints, &body),
            // One unusable source (deleted, generated, outside the build)
            // must not abort the launch and lose every other breakpoint.
            // It is recorded as unverified, with the adapter's reason.
            Err(message) => {
                for breakpoint in breakpoints.iter_mut() {
                    breakpoint.verified = Some(false);
                    breakpoint.message = Some(message.message.clone());
                }
            }
        }
        bound.push((path, breakpoints));
    }
    if supports_configuration_done {
        connection.request("configurationDone", json!({}))?;
    }
    Ok(bound)
}

// ----------------------------------------------------------- call stack

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StackFrame {
    /// The adapter's frame id — needed to scope a watch to this frame.
    pub id: i64,
    pub name: String,
    /// Project-relative when the frame is in the project, absolute when it
    /// isn't, `None` when the frame has no source at all.
    pub path: Option<String>,
    pub line: u32,
    pub column: u32,
    /// Not the user's code: a dependency, the standard library, or a frame
    /// with no source. Shown anyway — hiding frames makes a stack lie about
    /// how execution got here — but marked, so "step into" landing in
    /// library code is legible rather than baffling.
    pub is_library: bool,
}

pub fn parse_stack_trace(body: &Value, project_root: &std::path::Path) -> Vec<StackFrame> {
    let Some(frames) = body.get("stackFrames").and_then(Value::as_array) else {
        return vec![];
    };
    frames
        .iter()
        .map(|frame| {
            let source = frame.get("source").and_then(|s| s.get("path")).and_then(Value::as_str);
            let relative = source.and_then(|path| {
                std::path::Path::new(path)
                    .strip_prefix(project_root)
                    .ok()
                    .map(|rest| rest.to_string_lossy().into_owned())
            });
            StackFrame {
                id: frame.get("id").and_then(Value::as_i64).unwrap_or(-1),
                name: frame
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("<unnamed>")
                    .to_string(),
                path: relative.clone().or_else(|| source.map(str::to_string)),
                line: frame.get("line").and_then(Value::as_i64).unwrap_or(0) as u32,
                column: frame.get("column").and_then(Value::as_i64).unwrap_or(0) as u32,
                is_library: relative.is_none(),
            }
        })
        .collect()
}

// ------------------------------------------------------------- variables

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Variable {
    pub name: String,
    pub value: String,
    #[serde(rename = "type")]
    pub type_name: Option<String>,
    /// Non-zero when this value has children; the handle to fetch them.
    pub variables_reference: i64,
    pub expandable: bool,
}

pub fn parse_variables(body: &Value) -> Vec<Variable> {
    let Some(variables) = body.get("variables").and_then(Value::as_array) else {
        return vec![];
    };
    variables
        .iter()
        .map(|variable| {
            let reference =
                variable.get("variablesReference").and_then(Value::as_i64).unwrap_or(0);
            Variable {
                name: variable.get("name").and_then(Value::as_str).unwrap_or("").to_string(),
                value: variable.get("value").and_then(Value::as_str).unwrap_or("").to_string(),
                type_name: variable.get("type").and_then(Value::as_str).map(str::to_string),
                variables_reference: reference,
                expandable: reference > 0,
            }
        })
        .collect()
}

// ------------------------------------------------------ watch expressions

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Watch {
    pub expression: String,
    /// `None` when the expression couldn't be evaluated — never a stale
    /// value from a previous stop, which would be worse than no value.
    pub value: Option<String>,
    #[serde(rename = "type")]
    pub type_name: Option<String>,
    pub variables_reference: i64,
    pub expandable: bool,
    pub error: Option<String>,
}

/// A watch is always evaluated *in the selected frame*: without `frameId`
/// the adapter evaluates in global scope, where every local reads as
/// "not found".
pub fn evaluate_arguments(expression: &str, frame_id: Option<i64>) -> Value {
    let mut arguments = json!({ "expression": expression, "context": "watch" });
    if let Some(frame_id) = frame_id {
        arguments["frameId"] = json!(frame_id);
    }
    arguments
}

pub fn parse_evaluate(expression: &str, body: &Value) -> Watch {
    let reference = body.get("variablesReference").and_then(Value::as_i64).unwrap_or(0);
    Watch {
        expression: expression.to_string(),
        value: body.get("result").and_then(Value::as_str).map(str::to_string),
        type_name: body.get("type").and_then(Value::as_str).map(str::to_string),
        variables_reference: reference,
        expandable: reference > 0,
        error: None,
    }
}

/// A watch the adapter refused. The reason replaces the value rather than
/// sitting beside a stale one.
pub fn failed_evaluate(expression: &str, error: impl Into<String>) -> Watch {
    Watch {
        expression: expression.to_string(),
        value: None,
        type_name: None,
        variables_reference: 0,
        expandable: false,
        error: Some(error.into()),
    }
}

// ------------------------------------------------- launch configuration

/// Turns one of the project's `run` commands into a DAP launch configuration.
///
/// Deliberately derived from the `run` map in
/// `.palisade/project-settings.json` rather than a second config surface of
/// its own: that map is already the answer to "how is this project run", and
/// asking the user to write the same thing twice — once to run, once to
/// debug — is how launch.json ended up as a thing people dread.
///
/// `None` when there is nothing a debugger could attach to. An honest
/// refusal beats a config invented from a shell pipeline the adapter cannot
/// run — which is what the empty `{}` config did in practice: debugpy simply
/// never answered, and Start span for thirty seconds saying nothing.
pub fn launch_config(command: &str, language: &str) -> Option<Value> {
    let words = shell_words(command);
    let (interpreter, rest) = words.split_first()?;

    let (dap_type, is_interpreter) = match language {
        "python" => ("python", interpreter.contains("python")),
        "javascript" | "typescript" => ("pwa-node", interpreter.contains("node")),
        _ => return None,
    };
    if !is_interpreter {
        return None;
    }

    let mut config = json!({
        "request": "launch",
        "type": dap_type,
        // Palisade owns its terminals; the adapter's output comes back as
        // `output` events instead of being handed a terminal to drive.
        "console": "internalConsole",
        "cwd": ".",
    });

    // Interpreter flags (`-u`, `--`) come before the program; `-m name` names
    // a module and there is no program file at all.
    let mut index = 0;
    while index < rest.len() {
        let word = &rest[index];
        if word == "-m" {
            let module = rest.get(index + 1)?;
            config["module"] = json!(module);
            config["args"] = json!(rest[index + 2..]);
            return Some(config);
        }
        if word.starts_with('-') {
            index += 1;
            continue;
        }
        break;
    }

    let program = rest.get(index)?;
    // A shell operator means this is a pipeline, not a program.
    if program.starts_with('-') || program.contains('&') || program.contains('|') {
        return None;
    }
    config["program"] = json!(program);
    config["args"] = json!(rest[index + 1..]);
    Some(config)
}

/// Splits a command the way a shell would for the simple cases, and gives up
/// on anything with operators in it — those aren't a program to launch.
fn shell_words(command: &str) -> Vec<String> {
    if command.contains("&&") || command.contains("||") || command.contains('|') {
        return vec![];
    }
    command.split_whitespace().map(str::to_string).collect()
}

// ----------------------------------------------------------------- adapters

/// Language → the adapter binary Palisade looks for and how to run it.
///
/// A table, not a plugin system, and the same contract as language servers:
/// you install the debugger your toolchain already ships, Palisade finds it.
/// `lldb-dap` comes with LLVM/Xcode, `debugpy` with a pip install, `dlv` with
/// the Go toolchain, `js-debug` with VS Code's JS debugger package.
const ADAPTERS: &[(&str, &str, &[&str])] = &[
    ("rust", "lldb-dap", &[]),
    ("c", "lldb-dap", &[]),
    ("cpp", "lldb-dap", &[]),
    ("python", "debugpy-adapter", &[]),
    ("go", "dlv", &["dap"]),
    ("javascript", "js-debug-adapter", &[]),
    ("typescript", "js-debug-adapter", &[]),
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterInfo {
    pub language: String,
    /// The binary Palisade looked for, so "not installed" names what to get.
    pub command: String,
    pub args: Vec<String>,
    pub installed: bool,
}

/// What Palisade would run to debug `language`, and whether it is there.
pub fn adapter_for(language: &str, on_path: &dyn Fn(&str) -> bool) -> Option<AdapterInfo> {
    let (_, command, args) = ADAPTERS.iter().find(|(lang, _, _)| *lang == language)?;
    Some(AdapterInfo {
        language: language.to_string(),
        command: command.to_string(),
        args: args.iter().map(|a| a.to_string()).collect(),
        installed: on_path(command),
    })
}

/// Resolved against the real PATH — the login-shell one, so an adapter under
/// `~/.cargo/bin` or `~/.local/bin` is found in an app launched from Finder.
pub fn adapter(language: &str) -> Option<AdapterInfo> {
    adapter_for(language, &|binary| crate::executor::find_on_path(binary).is_some())
}

// ----------------------------------------------------------- live session

/// Where a stopped program is, and everything the UI shows about it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoppedState {
    pub thread_id: i64,
    /// "breakpoint", "step", "exception", "pause" — the adapter's own word.
    pub reason: String,
    pub description: Option<String>,
    pub frames: Vec<StackFrame>,
}

/// One running debug session: an adapter process plus its connection.
pub struct DebugSession {
    pub id: String,
    pub project_hash: String,
    pub project_root: std::path::PathBuf,
    pub language: String,
    connection: Arc<DapConnection>,
    child: Mutex<Option<std::process::Child>>,
    /// The adapter's declared capabilities, from the `initialize` response.
    /// Consulted rather than assumed: sending `configurationDone` to an
    /// adapter that never declared it hangs some of them.
    capabilities: Mutex<Value>,
    /// Where the program is stopped, if it is.
    stopped: Mutex<Option<StoppedState>>,
}

impl DebugSession {
    /// Spawns `adapter` and completes the `initialize` handshake.
    ///
    /// Returns as soon as the adapter has answered `initialize` — the caller
    /// then sends `launch`/`attach`, waits for the `initialized` event, and
    /// calls `configure`. That order is DAP's, not ours.
    pub fn start(
        id: String,
        project_hash: String,
        project_root: std::path::PathBuf,
        language: String,
        adapter: &AdapterInfo,
        on_event: impl Fn(&str, Value) + Send + 'static,
    ) -> Res<Arc<Self>> {
        if !adapter.installed {
            return Err(format!(
                "no debug adapter for {language}: `{}` is not on PATH",
                adapter.command
            ).into());
        }
        let executable = crate::executor::find_on_path(&adapter.command)
            .unwrap_or_else(|| std::path::PathBuf::from(&adapter.command));
        let mut child = std::process::Command::new(executable)
            .args(&adapter.args)
            .current_dir(&project_root)
            .env("PATH", crate::executor::child_path_env())
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|err| crate::PalisadeError::from(format!("start {}: {err}", adapter.command)))?;

        let stdout = child.stdout.take().ok_or("debug adapter has no stdout")?;
        let stdin = child.stdin.take().ok_or("debug adapter has no stdin")?;
        // The adapter's own last words. A crash with a reason is actionable;
        // a crash without one is a mystery, so stderr is forwarded as output.
        if let Some(stderr) = child.stderr.take() {
            thread::spawn(move || {
                use std::io::BufRead;
                for line in std::io::BufReader::new(stderr).lines().map_while(Result::ok) {
                    eprintln!("[dap] {line}");
                }
            });
        }

        let connection = DapConnection::new(stdout, stdin, on_event);
        let session = Arc::new(DebugSession {
            id,
            project_hash,
            project_root,
            language,
            connection,
            child: Mutex::new(Some(child)),
            capabilities: Mutex::new(Value::Null),
            stopped: Mutex::new(None),
        });

        let capabilities = session.connection.request("initialize", initialize_arguments())?;
        *session.capabilities.lock_or_recover() = capabilities;
        Ok(session)
    }

    pub fn request(&self, command: &str, arguments: Value) -> Res<Value> {
        self.connection.request(command, arguments)
    }

    fn supports(&self, capability: &str) -> bool {
        self.capabilities
            .lock()
            .unwrap()
            .get(capability)
            .and_then(Value::as_bool)
            .unwrap_or(false)
    }

    /// Sends every file's breakpoints, then `configurationDone` if supported.
    pub fn configure(&self, files: Vec<BoundFile>) -> Res<Vec<BoundFile>> {
        configure_with(&self.connection, files, self.supports("supportsConfigurationDoneRequest"))
    }

    /// Re-sends one file's breakpoints while the program is running — how a
    /// breakpoint added mid-session takes effect.
    pub fn set_breakpoints(&self, path: &str, mut breakpoints: Vec<Breakpoint>) -> Res<Vec<Breakpoint>> {
        let body = self
            .connection
            .request("setBreakpoints", set_breakpoints_arguments(path, &breakpoints))?;
        apply_set_breakpoints_response(&mut breakpoints, &body);
        Ok(breakpoints)
    }

    /// Records where the program stopped and pulls its call stack.
    ///
    /// A stack-trace failure is not fatal: the stop itself is real and worth
    /// showing, with an empty stack, rather than swallowing the whole event.
    pub fn on_stopped(&self, body: &Value) -> StoppedState {
        let thread_id = body.get("threadId").and_then(Value::as_i64).unwrap_or(0);
        let frames = self
            .connection
            .request("stackTrace", json!({"threadId": thread_id, "startFrame": 0, "levels": 64}))
            .map(|body| parse_stack_trace(&body, &self.project_root))
            .unwrap_or_default();
        let state = StoppedState {
            thread_id,
            reason: body
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_string(),
            description: body
                .get("description")
                .or_else(|| body.get("text"))
                .and_then(Value::as_str)
                .map(str::to_string),
            frames,
        };
        *self.stopped.lock_or_recover() = Some(state.clone());
        state
    }

    /// Running again: the stack and frame ids from the last stop are now
    /// invalid, and holding them would let a watch evaluate against a frame
    /// that no longer exists.
    pub fn on_continued(&self) {
        *self.stopped.lock_or_recover() = None;
    }

    pub fn stopped(&self) -> Option<StoppedState> {
        self.stopped.lock_or_recover().clone()
    }

    /// The frame a watch evaluates in: the caller's choice, else the topmost
    /// frame of the current stop, else none (and the adapter uses globals).
    pub fn frame_for(&self, requested: Option<i64>) -> Option<i64> {
        requested.or_else(|| {
            self.stopped.lock_or_recover().as_ref().and_then(|s| s.frames.first().map(|f| f.id))
        })
    }

    pub fn evaluate(&self, expression: &str, frame_id: Option<i64>) -> Watch {
        let frame = self.frame_for(frame_id);
        match self.connection.request("evaluate", evaluate_arguments(expression, frame)) {
            Ok(body) => parse_evaluate(expression, &body),
            Err(message) => failed_evaluate(expression, message),
        }
    }

    /// Ends the session: asks the adapter to detach, then makes sure the
    /// process is actually gone.
    ///
    /// Best-effort by design — a wedged adapter must not be able to stop the
    /// user from closing the debugger, so a failed `disconnect` falls through
    /// to a kill rather than surfacing as an error the user can't act on.
    pub fn stop(&self) {
        let _ = self.connection.request_with_timeout(
            "disconnect",
            json!({"terminateDebuggee": true}),
            Duration::from_secs(3),
        );
        if let Some(mut child) = self.child.lock_or_recover().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl Drop for DebugSession {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.lock_or_recover().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

// ------------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use crate::locks::MutexExt;
    use super::*;
    use std::path::Path;
    use std::io::BufRead;
    use std::net::{TcpListener, TcpStream};
    use std::sync::mpsc::Receiver;

    /// A stand-in debug adapter on a loopback socket.
    ///
    /// Real adapters speak this exact framing over stdio; a socket gives the
    /// same bidirectional stream without needing lldb-dap installed to run
    /// the suite. The test drives it by hand, which is the only way to
    /// reproduce out-of-order responses, interleaved events and a mid-request
    /// disconnect deterministically.
    struct FakeAdapter {
        stream: TcpStream,
        reader: std::io::BufReader<TcpStream>,
    }

    impl FakeAdapter {
        fn pair(
            on_event: impl Fn(&str, Value) + Send + 'static,
        ) -> (Arc<DapConnection>, FakeAdapter) {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let client = TcpStream::connect(address).unwrap();
            let (server, _) = listener.accept().unwrap();
            server.set_nodelay(true).unwrap();
            client.set_nodelay(true).unwrap();

            let connection = DapConnection::new(
                client.try_clone().unwrap(),
                client.try_clone().unwrap(),
                on_event,
            );
            let adapter = FakeAdapter {
                reader: std::io::BufReader::new(server.try_clone().unwrap()),
                stream: server,
            };
            (connection, adapter)
        }

        /// Reads one framed message the client sent.
        fn next_request(&mut self) -> Value {
            let mut length = 0usize;
            loop {
                let mut header = String::new();
                self.reader.read_line(&mut header).unwrap();
                if header == "\r\n" {
                    break;
                }
                if let Some(value) = header.strip_prefix("Content-Length:") {
                    length = value.trim().parse().unwrap();
                }
            }
            let mut body = vec![0u8; length];
            std::io::Read::read_exact(&mut self.reader, &mut body).unwrap();
            serde_json::from_slice(&body).unwrap()
        }

        fn send_raw(&mut self, body: &str) {
            self.stream.write_all(crate::lsp::frame(body).as_bytes()).unwrap();
            self.stream.flush().unwrap();
        }

        fn send(&mut self, value: Value) {
            self.send_raw(&serde_json::to_string(&value).unwrap());
        }

        fn respond(&mut self, request: &Value, body: Value) {
            self.send(json!({
                "seq": 900,
                "type": "response",
                "request_seq": request["seq"],
                "success": true,
                "command": request["command"],
                "body": body,
            }));
        }

        fn hang_up(self) {
            drop(self.stream);
            drop(self.reader);
        }
    }

    fn event_channel() -> (impl Fn(&str, Value) + Send + 'static, Receiver<(String, Value)>) {
        let (tx, rx) = mpsc::channel();
        (
            move |event: &str, body: Value| {
                let _ = tx.send((event.to_string(), body));
            },
            rx,
        )
    }

    fn next_event(rx: &Receiver<(String, Value)>) -> (String, Value) {
        rx.recv_timeout(Duration::from_secs(5)).expect("no event arrived")
    }

    // ------------------------------------------------------- request/response

    #[test]
    fn a_request_is_framed_with_an_increasing_seq() {
        let (sink, _events) = event_channel();
        let (connection, mut adapter) = FakeAdapter::pair(sink);

        let worker = {
            let connection = Arc::clone(&connection);
            thread::spawn(move || connection.request("initialize", json!({"adapterID": "x"})))
        };
        let first = adapter.next_request();
        assert_eq!(first["type"], "request");
        assert_eq!(first["command"], "initialize");
        assert_eq!(first["arguments"]["adapterID"], "x");
        let first_seq = first["seq"].as_i64().unwrap();
        assert!(first_seq >= 1, "DAP seq starts at 1, got {first_seq}");
        adapter.respond(&first, json!({"supportsConfigurationDoneRequest": true}));
        let body = worker.join().unwrap().unwrap();
        assert_eq!(body["supportsConfigurationDoneRequest"], true);

        let worker = {
            let connection = Arc::clone(&connection);
            thread::spawn(move || connection.request("threads", json!({})))
        };
        let second = adapter.next_request();
        assert_eq!(second["seq"].as_i64().unwrap(), first_seq + 1);
        adapter.respond(&second, json!({"threads": []}));
        worker.join().unwrap().unwrap();
    }

    #[test]
    fn a_failed_request_carries_the_adapters_own_message() {
        let (sink, _events) = event_channel();
        let (connection, mut adapter) = FakeAdapter::pair(sink);
        let worker = {
            let connection = Arc::clone(&connection);
            thread::spawn(move || connection.request("evaluate", json!({"expression": "nope"})))
        };
        let request = adapter.next_request();
        adapter.send(json!({
            "seq": 5,
            "type": "response",
            "request_seq": request["seq"],
            "success": false,
            "command": "evaluate",
            "message": "can't evaluate: no such variable",
        }));
        let err = worker.join().unwrap().unwrap_err();
        assert!(err.contains("no such variable"), "unhelpful error: {err}");
    }

    #[test]
    fn responses_that_arrive_out_of_order_resolve_the_right_requests() {
        // The async case: a slow `evaluate` answered after a fast
        // `stackTrace` issued later. Correlation is by request_seq, never by
        // arrival order — matching on order would hand each caller the other
        // one's answer.
        let (sink, _events) = event_channel();
        let (connection, mut adapter) = FakeAdapter::pair(sink);

        let slow = {
            let connection = Arc::clone(&connection);
            thread::spawn(move || connection.request("evaluate", json!({"expression": "slow"})))
        };
        let slow_request = adapter.next_request();
        let fast = {
            let connection = Arc::clone(&connection);
            thread::spawn(move || connection.request("stackTrace", json!({"threadId": 1})))
        };
        let fast_request = adapter.next_request();

        adapter.respond(&fast_request, json!({"totalFrames": 2}));
        adapter.respond(&slow_request, json!({"result": "42"}));

        assert_eq!(fast.join().unwrap().unwrap()["totalFrames"], 2);
        assert_eq!(slow.join().unwrap().unwrap()["result"], "42");
    }

    #[test]
    fn an_event_between_a_request_and_its_response_does_not_break_correlation() {
        // Exactly what a breakpoint in async code looks like: the target hits
        // it (a `stopped` event) while a request is still in flight.
        let (sink, events) = event_channel();
        let (connection, mut adapter) = FakeAdapter::pair(sink);

        let worker = {
            let connection = Arc::clone(&connection);
            thread::spawn(move || connection.request("continue", json!({"threadId": 1})))
        };
        let request = adapter.next_request();
        adapter.send(json!({
            "seq": 7,
            "type": "event",
            "event": "stopped",
            "body": {"reason": "breakpoint", "threadId": 1},
        }));
        adapter.respond(&request, json!({"allThreadsContinued": true}));

        assert_eq!(worker.join().unwrap().unwrap()["allThreadsContinued"], true);
        let (name, body) = next_event(&events);
        assert_eq!(name, "stopped");
        assert_eq!(body["reason"], "breakpoint");
    }

    #[test]
    fn events_are_delivered_to_the_sink_and_never_treated_as_responses() {
        let (sink, events) = event_channel();
        let (_connection, mut adapter) = FakeAdapter::pair(sink);
        // `output` carries no request_seq at all; misreading it as a response
        // would panic on the missing field or resolve a random waiter.
        adapter.send(json!({
            "seq": 1,
            "type": "event",
            "event": "output",
            "body": {"category": "stdout", "output": "hello\n"},
        }));
        let (name, body) = next_event(&events);
        assert_eq!(name, "output");
        assert_eq!(body["output"], "hello\n");
    }

    #[test]
    fn a_request_issued_from_an_event_handler_does_not_deadlock() {
        // Dogfood regression, and the one that actually mattered: hitting a
        // breakpoint emits `stopped`, and the only useful response to that is
        // to go and fetch the call stack. If events are dispatched on the
        // same thread that reads the socket, that request can never be
        // answered — the reader is blocked waiting for a reply only it could
        // deliver. Live, the program sat paused forever and the UI never
        // heard about it.
        let (tx, rx) = mpsc::channel::<Res<Value>>();
        let holder: Arc<Mutex<Option<Arc<DapConnection>>>> = Arc::new(Mutex::new(None));
        let for_handler = Arc::clone(&holder);

        let (connection, mut adapter) = FakeAdapter::pair(move |event, _body| {
            if event != "stopped" {
                return;
            }
            let connection = for_handler.lock_or_recover().clone().expect("connection");
            let _ = tx.send(connection.request_with_timeout(
                "stackTrace",
                json!({"threadId": 1}),
                Duration::from_secs(3),
            ));
        });
        *holder.lock_or_recover() = Some(Arc::clone(&connection));

        adapter.send(json!({
            "seq": 1,
            "type": "event",
            "event": "stopped",
            "body": {"reason": "breakpoint", "threadId": 1},
        }));

        // The handler's request has to reach the adapter while the reader
        // keeps reading.
        let request = adapter.next_request();
        assert_eq!(request["command"], "stackTrace");
        adapter.respond(&request, json!({"stackFrames": [{"id": 7, "name": "subtotal"}]}));

        let answer = rx
            .recv_timeout(Duration::from_secs(5))
            .expect("the event handler's request never completed — the reader thread is blocked")
            .expect("request failed");
        assert_eq!(answer["stackFrames"][0]["name"], "subtotal");
    }

    #[test]
    fn events_still_arrive_in_order_when_a_handler_is_slow() {
        // Dispatching events off the reader thread must not reorder them: a
        // `continued` overtaking the `stopped` before it would leave the UI
        // showing a stack for a program that is running.
        let (sink, events) = event_channel();
        let (_connection, mut adapter) = FakeAdapter::pair(sink);
        for name in ["stopped", "continued", "terminated"] {
            adapter.send(json!({"seq": 1, "type": "event", "event": name, "body": {}}));
        }
        assert_eq!(next_event(&events).0, "stopped");
        assert_eq!(next_event(&events).0, "continued");
        assert_eq!(next_event(&events).0, "terminated");
    }

    // ---------------------------------------------------------------- framing

    #[test]
    fn a_message_split_across_reads_is_reassembled() {
        let (sink, events) = event_channel();
        let (_connection, mut adapter) = FakeAdapter::pair(sink);
        let body = r#"{"seq":1,"type":"event","event":"initialized","body":{}}"#;
        let framed = crate::lsp::frame(body);
        let bytes = framed.as_bytes();
        // Header in one write, body in another — normal for a chatty adapter.
        adapter.stream.write_all(&bytes[..20]).unwrap();
        adapter.stream.flush().unwrap();
        thread::sleep(Duration::from_millis(50));
        adapter.stream.write_all(&bytes[20..]).unwrap();
        adapter.stream.flush().unwrap();

        assert_eq!(next_event(&events).0, "initialized");
    }

    #[test]
    fn two_messages_in_one_read_are_both_handled() {
        let (sink, events) = event_channel();
        let (_connection, mut adapter) = FakeAdapter::pair(sink);
        let one = crate::lsp::frame(r#"{"seq":1,"type":"event","event":"first","body":{}}"#);
        let two = crate::lsp::frame(r#"{"seq":2,"type":"event","event":"second","body":{}}"#);
        adapter.stream.write_all(format!("{one}{two}").as_bytes()).unwrap();
        adapter.stream.flush().unwrap();

        assert_eq!(next_event(&events).0, "first");
        assert_eq!(next_event(&events).0, "second");
    }

    #[test]
    fn malformed_json_does_not_desync_the_stream() {
        let (sink, events) = event_channel();
        let (_connection, mut adapter) = FakeAdapter::pair(sink);
        adapter.send_raw("{not json at all");
        adapter.send(json!({"seq": 2, "type": "event", "event": "recovered", "body": {}}));
        assert_eq!(next_event(&events).0, "recovered");
    }

    // ------------------------------------------------------- failure modes

    #[test]
    fn an_adapter_that_dies_mid_request_fails_the_request_instead_of_hanging() {
        let (sink, _events) = event_channel();
        let (connection, mut adapter) = FakeAdapter::pair(sink);
        let worker = {
            let connection = Arc::clone(&connection);
            thread::spawn(move || connection.request("launch", json!({})))
        };
        adapter.next_request();
        adapter.hang_up();

        let err = worker.join().unwrap().unwrap_err();
        assert!(err.contains("disconnected"), "unhelpful disconnect error: {err}");
    }

    #[test]
    fn a_closed_adapter_is_announced_so_the_ui_can_leave_debug_mode() {
        let (sink, events) = event_channel();
        let (_connection, adapter) = FakeAdapter::pair(sink);
        adapter.hang_up();
        assert_eq!(next_event(&events).0, "__closed");
    }

    #[test]
    fn a_request_that_is_never_answered_times_out_and_a_late_reply_is_harmless() {
        let (sink, _events) = event_channel();
        let (connection, mut adapter) = FakeAdapter::pair(sink);
        let worker = {
            let connection = Arc::clone(&connection);
            thread::spawn(move || {
                connection.request_with_timeout(
                    "stackTrace",
                    json!({}),
                    Duration::from_millis(150),
                )
            })
        };
        let request = adapter.next_request();
        let err = worker.join().unwrap().unwrap_err();
        assert!(err.contains("stackTrace"), "timeout should name the request: {err}");

        // The adapter finally answers. Nobody is listening; this must not
        // panic on a dropped channel or resolve some later request.
        adapter.respond(&request, json!({"stackFrames": []}));
        let follow_up = {
            let connection = Arc::clone(&connection);
            thread::spawn(move || connection.request("threads", json!({})))
        };
        let next = adapter.next_request();
        adapter.respond(&next, json!({"threads": [{"id": 1, "name": "main"}]}));
        assert_eq!(follow_up.join().unwrap().unwrap()["threads"][0]["name"], "main");
    }

    #[test]
    fn a_reverse_request_is_answered_so_the_adapter_stops_waiting() {
        let (sink, events) = event_channel();
        let (_connection, mut adapter) = FakeAdapter::pair(sink);
        adapter.send(json!({
            "seq": 11,
            "type": "request",
            "command": "runInTerminal",
            "arguments": {"args": ["./prog"]},
        }));
        let reply = adapter.next_request();
        assert_eq!(reply["type"], "response");
        assert_eq!(reply["request_seq"], 11);
        assert_eq!(next_event(&events).0, "reverse:runInTerminal");
    }


    // ------------------------------------------------------- handshake order

    #[test]
    fn the_handshake_sets_breakpoints_between_initialized_and_configuration_done() {
        // The classic DAP mistake: sending setBreakpoints before the
        // `initialized` event, where adapters silently drop them, or after
        // configurationDone, where the program is already running past them.
        let (sink, _events) = event_channel();
        let (connection, mut adapter) = FakeAdapter::pair(sink);

        let files = vec![(
            "/p/src/lib.rs".to_string(),
            vec![Breakpoint::new("src/lib.rs", 9)],
        )];
        let worker = {
            let connection = Arc::clone(&connection);
            thread::spawn(move || configure(&connection, files))
        };

        let set = adapter.next_request();
        assert_eq!(set["command"], "setBreakpoints");
        assert_eq!(set["arguments"]["source"]["path"], "/p/src/lib.rs");
        adapter.respond(&set, json!({"breakpoints": [{"verified": true, "line": 9}]}));

        let done = adapter.next_request();
        assert_eq!(done["command"], "configurationDone");
        adapter.respond(&done, json!({}));

        let bound = worker.join().unwrap().unwrap();
        assert_eq!(bound[0].1[0].verified, Some(true));
    }

    #[test]
    fn configuration_continues_even_when_one_file_is_rejected() {
        // One bad path (a deleted file, a breakpoint in a generated source)
        // must not abort the whole launch and lose every other breakpoint.
        let (sink, _events) = event_channel();
        let (connection, mut adapter) = FakeAdapter::pair(sink);
        let files = vec![
            ("/p/gone.rs".to_string(), vec![Breakpoint::new("gone.rs", 1)]),
            ("/p/ok.rs".to_string(), vec![Breakpoint::new("ok.rs", 2)]),
        ];
        let worker = {
            let connection = Arc::clone(&connection);
            thread::spawn(move || configure(&connection, files))
        };

        let first = adapter.next_request();
        adapter.send(json!({
            "seq": 40,
            "type": "response",
            "request_seq": first["seq"],
            "success": false,
            "command": "setBreakpoints",
            "message": "no such source",
        }));
        let second = adapter.next_request();
        adapter.respond(&second, json!({"breakpoints": [{"verified": true, "line": 2}]}));
        let done = adapter.next_request();
        adapter.respond(&done, json!({}));

        let bound = worker.join().unwrap().unwrap();
        assert_eq!(bound[0].1[0].verified, Some(false), "a rejected file is not verified");
        assert!(bound[0].1[0].message.is_some(), "and says why");
        assert_eq!(bound[1].1[0].verified, Some(true), "the good file still bound");
    }

    #[test]
    fn configuration_done_is_skipped_when_the_adapter_does_not_support_it() {
        let (sink, _events) = event_channel();
        let (connection, mut adapter) = FakeAdapter::pair(sink);
        let worker = {
            let connection = Arc::clone(&connection);
            thread::spawn(move || {
                configure_with(&connection, vec![], /* supports_configuration_done */ false)
            })
        };
        // Nothing but the (absent) breakpoints: no configurationDone at all.
        // Sending it to an adapter that never declared support hangs some.
        let probe = {
            let connection = Arc::clone(&connection);
            thread::spawn(move || connection.request("threads", json!({})))
        };
        let request = adapter.next_request();
        assert_eq!(request["command"], "threads", "configurationDone must not have been sent");
        adapter.respond(&request, json!({"threads": []}));
        probe.join().unwrap().unwrap();
        worker.join().unwrap().unwrap();
    }

    // ------------------------------------------------------- initialize args

    #[test]
    fn initialize_claims_only_capabilities_palisade_actually_implements() {
        let arguments = initialize_arguments();
        assert_eq!(arguments["adapterID"], "palisade");
        assert_eq!(arguments["linesStartAt1"], true);
        assert_eq!(arguments["columnsStartAt1"], true);
        assert_eq!(arguments["pathFormat"], "path");
        assert_eq!(arguments["supportsVariableType"], true);
        // Claiming runInTerminal would make adapters route the debuggee into
        // a terminal Palisade would then have to own. It declines instead.
        assert_eq!(arguments["supportsRunInTerminalRequest"], false);
    }

    // ----------------------------------------------------------- call stack

    fn stack_body() -> Value {
        json!({"stackFrames": [
            {
                "id": 1000,
                "name": "compute",
                "line": 12,
                "column": 5,
                "source": {"path": "/p/src/lib.rs", "name": "lib.rs"},
            },
            {
                "id": 1001,
                "name": "core::iter::next",
                "line": 88,
                "column": 1,
                "source": {"path": "/rustup/lib/core/iter.rs", "name": "iter.rs"},
            },
            {
                "id": 1002,
                "name": "<unknown>",
                "line": 0,
                "column": 0,
            },
        ]})
    }

    #[test]
    fn a_stack_frame_in_the_project_is_openable_and_relative() {
        let frames = parse_stack_trace(&stack_body(), Path::new("/p"));
        assert_eq!(frames[0].name, "compute");
        assert_eq!(frames[0].path.as_deref(), Some("src/lib.rs"));
        assert_eq!(frames[0].line, 12);
        assert_eq!(frames[0].column, 5);
        assert!(!frames[0].is_library, "a project file is not library code");
    }

    #[test]
    fn a_frame_outside_the_project_is_marked_as_library_code() {
        // Stepping into a dependency: still shown (hiding it makes a stack
        // lie about how you got here), but marked, and its path stays
        // absolute because it is not the project's to open relatively.
        let frames = parse_stack_trace(&stack_body(), Path::new("/p"));
        assert!(frames[1].is_library);
        assert_eq!(frames[1].path.as_deref(), Some("/rustup/lib/core/iter.rs"));
    }

    #[test]
    fn a_frame_with_no_source_is_kept_rather_than_dropped() {
        // Optimised-out and JIT frames have no source. Dropping them would
        // silently renumber the stack and hide real recursion.
        let frames = parse_stack_trace(&stack_body(), Path::new("/p"));
        assert_eq!(frames.len(), 3);
        assert_eq!(frames[2].path, None);
        assert!(frames[2].is_library, "a frame with no source is not the user's code");
    }

    #[test]
    fn an_empty_stack_is_empty_not_an_error() {
        assert!(parse_stack_trace(&json!({"stackFrames": []}), Path::new("/p")).is_empty());
        assert!(parse_stack_trace(&json!({}), Path::new("/p")).is_empty());
    }

    // ------------------------------------------------------------ variables

    #[test]
    fn variables_carry_their_value_type_and_whether_they_expand() {
        let body = json!({"variables": [
            {"name": "count", "value": "3", "type": "i32", "variablesReference": 0},
            {"name": "items", "value": "Vec(2)", "type": "Vec<i32>", "variablesReference": 42},
        ]});
        let variables = parse_variables(&body);
        assert_eq!(variables[0].name, "count");
        assert_eq!(variables[0].value, "3");
        assert_eq!(variables[0].type_name.as_deref(), Some("i32"));
        assert!(!variables[0].expandable, "a scalar has no children to expand");
        assert!(variables[1].expandable);
        assert_eq!(variables[1].variables_reference, 42);
    }

    #[test]
    fn a_variables_response_with_no_array_is_empty_not_a_panic() {
        assert!(parse_variables(&json!({})).is_empty());
    }

    // ----------------------------------------------------- watch expressions

    #[test]
    fn a_watch_is_evaluated_in_the_selected_frame() {
        // Without frameId the adapter evaluates in the global scope, where a
        // local is "not found" — the single most confusing watch bug.
        let arguments = evaluate_arguments("count * 2", Some(1000));
        assert_eq!(arguments["expression"], "count * 2");
        assert_eq!(arguments["frameId"], 1000);
        assert_eq!(arguments["context"], "watch");
    }

    #[test]
    fn a_watch_with_no_frame_omits_frame_id_rather_than_sending_null() {
        let arguments = evaluate_arguments("1 + 1", None);
        assert!(arguments.get("frameId").is_none());
    }

    #[test]
    fn a_watch_result_reports_its_value_and_whether_it_expands() {
        let watch = parse_evaluate(
            "items",
            &json!({"result": "Vec(2)", "type": "Vec<i32>", "variablesReference": 7}),
        );
        assert_eq!(watch.expression, "items");
        assert_eq!(watch.value.as_deref(), Some("Vec(2)"));
        assert_eq!(watch.type_name.as_deref(), Some("Vec<i32>"));
        assert!(watch.expandable);
        assert_eq!(watch.error, None);
    }

    #[test]
    fn a_watch_that_cannot_be_evaluated_shows_the_reason_not_a_stale_value() {
        let watch = failed_evaluate("gone", "no symbol named 'gone'");
        assert_eq!(watch.value, None);
        assert_eq!(watch.error.as_deref(), Some("no symbol named 'gone'"));
    }

    // --------------------------------------------------------- breakpoints

    #[test]
    fn a_verified_breakpoint_reports_verified() {
        let mut sent = vec![Breakpoint::new("src/lib.rs", 10)];
        apply_set_breakpoints_response(
            &mut sent,
            &json!({"breakpoints": [{"verified": true, "line": 10}]}),
        );
        assert_eq!(sent[0].verified, Some(true));
        assert_eq!(sent[0].actual_line, None);
        assert_eq!(sent[0].effective_line(), 10);
    }

    #[test]
    fn a_breakpoint_the_adapter_moved_reports_where_it_really_is() {
        // Placed on a blank line or a comment: the adapter slides it to the
        // next statement. Drawing it where the user clicked would be a lie
        // about where execution will stop.
        let mut sent = vec![Breakpoint::new("src/lib.rs", 7)];
        apply_set_breakpoints_response(
            &mut sent,
            &json!({"breakpoints": [{"verified": true, "line": 9}]}),
        );
        assert_eq!(sent[0].line, 7, "the user's own line is not overwritten");
        assert_eq!(sent[0].actual_line, Some(9));
        assert_eq!(sent[0].effective_line(), 9);
    }

    #[test]
    fn an_invalid_breakpoint_location_is_reported_unverified_with_its_reason() {
        let mut sent = vec![Breakpoint::new("src/lib.rs", 9999)];
        apply_set_breakpoints_response(
            &mut sent,
            &json!({"breakpoints": [{"verified": false, "message": "no code at line 9999"}]}),
        );
        assert_eq!(sent[0].verified, Some(false));
        assert_eq!(sent[0].message.as_deref(), Some("no code at line 9999"));
    }

    #[test]
    fn each_answer_lands_on_its_own_breakpoint() {
        // DAP aligns the response array with the request array positionally.
        // Matching by line instead would misattribute every moved breakpoint.
        let mut sent = vec![
            Breakpoint::new("src/lib.rs", 3),
            Breakpoint::new("src/lib.rs", 7),
            Breakpoint::new("src/lib.rs", 11),
        ];
        apply_set_breakpoints_response(
            &mut sent,
            &json!({"breakpoints": [
                {"verified": true, "line": 3},
                {"verified": false, "message": "unreachable"},
                {"verified": true, "line": 12},
            ]}),
        );
        assert_eq!(sent[0].verified, Some(true));
        assert_eq!(sent[1].verified, Some(false));
        assert_eq!(sent[1].message.as_deref(), Some("unreachable"));
        assert_eq!(sent[2].actual_line, Some(12));
    }

    #[test]
    fn a_short_or_missing_answer_leaves_breakpoints_unknown_not_verified() {
        let mut sent = vec![Breakpoint::new("a.rs", 1), Breakpoint::new("a.rs", 2)];
        apply_set_breakpoints_response(
            &mut sent,
            &json!({"breakpoints": [{"verified": true, "line": 1}]}),
        );
        assert_eq!(sent[0].verified, Some(true));
        assert_eq!(sent[1].verified, None, "silence must not read as verified");

        let mut sent = vec![Breakpoint::new("a.rs", 1)];
        apply_set_breakpoints_response(&mut sent, &json!({}));
        assert_eq!(sent[0].verified, None);
    }

    #[test]
    fn disabled_breakpoints_are_not_sent_to_the_adapter() {
        let breakpoints = vec![
            Breakpoint::new("a.rs", 1),
            Breakpoint { enabled: false, ..Breakpoint::new("a.rs", 5) },
        ];
        let arguments = set_breakpoints_arguments("/p/a.rs", &breakpoints);
        let lines = arguments["breakpoints"].as_array().unwrap();
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0]["line"], 1);
        assert_eq!(arguments["source"]["path"], "/p/a.rs");
    }

    #[test]
    fn a_conditional_breakpoint_sends_its_condition() {
        let breakpoints =
            vec![Breakpoint { condition: Some("i > 10".into()), ..Breakpoint::new("a.rs", 4) }];
        let arguments = set_breakpoints_arguments("/p/a.rs", &breakpoints);
        assert_eq!(arguments["breakpoints"][0]["condition"], "i > 10");
    }

    #[test]
    fn clearing_every_breakpoint_in_a_file_sends_an_empty_array_not_nothing() {
        // DAP's setBreakpoints replaces the whole file's set: omitting the
        // array would leave the old breakpoints armed in the target.
        let arguments = set_breakpoints_arguments("/p/a.rs", &[]);
        assert_eq!(arguments["breakpoints"].as_array().unwrap().len(), 0);
    }

    // ------------------------------------------------- launch configuration

    #[test]
    fn a_python_run_command_becomes_a_python_launch_config() {
        // Dogfood regression: the Start button sent `{}`. debugpy never
        // answers a launch with no program, so the button span 30 seconds
        // and then gave up — no session, no error, no explanation.
        let config = launch_config("python3 app.py", "python").unwrap();
        assert_eq!(config["request"], "launch");
        assert_eq!(config["type"], "python");
        assert_eq!(config["program"], "app.py");
        assert_eq!(config["console"], "internalConsole");
        assert_eq!(config["cwd"], ".");
    }

    #[test]
    fn a_run_commands_arguments_are_carried_into_the_launch() {
        let config = launch_config("python3 -u app.py --verbose out.csv", "python").unwrap();
        assert_eq!(config["program"], "app.py");
        assert_eq!(config["args"], json!(["--verbose", "out.csv"]));
    }

    #[test]
    fn a_module_run_command_launches_the_module_not_a_file() {
        // `python -m pytest` has no program file at all.
        let config = launch_config("python3 -m pytest -q", "python").unwrap();
        assert_eq!(config["module"], "pytest");
        assert!(config.get("program").is_none());
        assert_eq!(config["args"], json!(["-q"]));
    }

    #[test]
    fn a_node_run_command_becomes_a_node_launch_config() {
        let config = launch_config("node server.js --port 3000", "javascript").unwrap();
        assert_eq!(config["type"], "pwa-node");
        assert_eq!(config["program"], "server.js");
        assert_eq!(config["args"], json!(["--port", "3000"]));
    }

    #[test]
    fn a_run_command_with_no_debuggable_program_is_declined_not_guessed() {
        // Better an honest "nothing to debug here" than a launch config
        // invented from a shell pipeline the adapter can't run.
        assert!(launch_config("make build && ./run.sh", "python").is_none());
        assert!(launch_config("", "python").is_none());
        assert!(launch_config("python3", "python").is_none(), "no script named");
    }

    #[test]
    fn a_language_the_config_builder_does_not_know_is_declined() {
        assert!(launch_config("cobc -x main.cob", "cobol").is_none());
    }

    // ------------------------------------------------------------ adapters

    #[test]
    fn a_known_language_names_the_adapter_it_wants() {
        let found = adapter_for("rust", &|_| true).unwrap();
        assert_eq!(found.command, "lldb-dap");
        assert!(found.installed);

        let go = adapter_for("go", &|_| true).unwrap();
        assert_eq!(go.args, vec!["dap"]);
    }

    #[test]
    fn a_missing_adapter_is_reported_as_missing_and_still_names_what_to_install() {
        let found = adapter_for("python", &|_| false).unwrap();
        assert!(!found.installed);
        assert_eq!(found.command, "debugpy-adapter");
    }

    #[test]
    fn a_language_with_no_known_adapter_says_so_rather_than_guessing() {
        assert!(adapter_for("cobol", &|_| true).is_none());
    }
}
