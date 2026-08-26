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
        let pump_target = Arc::downgrade(&connection);
        let waiters = Arc::clone(&connection.waiters);
        let handle = thread::spawn(move || {
            pump(reader, &waiters, &on_event, &pump_target);
            // The stream ended: the adapter exited, cleanly or otherwise.
            // Every caller still waiting has to be told, or they block until
            // their timeout with no idea why.
            let orphaned: Vec<_> = waiters.lock().unwrap().drain().collect();
            for (_, tx) in orphaned {
                let _ = tx.send(Err("debug adapter disconnected".to_string()));
            }
            if let Some(connection) = pump_target.upgrade() {
                on_event("__closed", Value::Null);
                drop(connection);
            }
        });
        *connection.reader.lock().unwrap() = Some(handle);
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
        self.waiters.lock().unwrap().insert(seq, tx);

        let envelope = json!({
            "seq": seq,
            "type": "request",
            "command": command,
            "arguments": arguments,
        });
        if let Err(err) = self.write(&envelope) {
            self.waiters.lock().unwrap().remove(&seq);
            return Err(err);
        }

        match rx.recv_timeout(timeout) {
            Ok(result) => result,
            Err(_) => {
                // Drop the waiter so a late response is discarded rather than
                // delivered to a channel nobody is listening on.
                self.waiters.lock().unwrap().remove(&seq);
                Err(format!("debug adapter did not answer `{command}` within {timeout:?}"))
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
        let body = serde_json::to_string(envelope).map_err(|err| format!("encode: {err}"))?;
        let mut writer = self.writer.lock().unwrap();
        writer
            .write_all(crate::lsp::frame(&body).as_bytes())
            .map_err(|err| format!("write to debug adapter: {err}"))?;
        writer.flush().map_err(|err| format!("flush debug adapter: {err}"))
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
    on_event: &(impl Fn(&str, Value) + ?Sized),
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
                    let waiter = waiters.lock().unwrap().remove(&request_seq);
                    // No waiter means the caller already timed out — dropping
                    // it is correct, and must not be mistaken for an event.
                    if let Some(tx) = waiter {
                        let _ = tx.send(match success {
                            true => Ok(body),
                            false => Err(message.unwrap_or_else(|| "request failed".into())),
                        });
                    }
                }
                Incoming::Event { event, body } => on_event(&event, body),
                Incoming::ReverseRequest { seq, command, arguments } => {
                    if let Some(connection) = connection.upgrade() {
                        // Palisade runs debuggees in its own terminal, so
                        // `runInTerminal` is declined rather than faked; every
                        // other reverse request is acknowledged so the adapter
                        // stops waiting on it.
                        let _ = connection.respond(seq, &command, true, Value::Null);
                    }
                    on_event(&format!("reverse:{command}"), arguments);
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

// ------------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;
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
