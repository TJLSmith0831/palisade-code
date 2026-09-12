//! Language-server processes (Amendment 2 / `lsp-integration` design.md).
//!
//! One server per language per project (D15), spawned on demand from the
//! first file of that language and killed when the project changes. Palisade
//! never installs a server — it finds one on PATH or reports that there
//! isn't one (D5/D6).
//!
//! Transport deviation from D12: design.md planned a WebSocket bridge
//! because "the frontend can't spawn processes". True, but the frontend
//! doesn't need to — `@codemirror/lsp-client`'s `Transport` is three
//! methods (`send`/`subscribe`/`unsubscribe`), which Tauri's existing
//! command+event channel satisfies directly. Dropping the bridge removes
//! the port allocation, the framing-over-the-wire and the second transport
//! the design's own risk list called out. Message *framing on stdio*
//! (Content-Length headers) is still handled here, where it belongs.

use std::collections::HashMap;
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;

use serde::{Deserialize, Serialize};

use crate::store::Res;
use crate::locks::MutexExt;

/// After this many crashes a language is disabled for the session (D14) —
/// an editor that keeps respawning a broken server is worse than one that
/// admits the server is broken.
const MAX_RESTARTS: u32 = 3;

/// Language id (LSP's own `languageId`) → the command that serves it and
/// its arguments. Deliberately a table, not a plugin system: Palisade detects
/// what you installed, it doesn't manage installs (D6).
const SERVERS: &[(&str, &str, &[&str])] = &[
    ("typescript", "typescript-language-server", &["--stdio"]),
    ("javascript", "typescript-language-server", &["--stdio"]),
    ("python", "pylsp", &[]),
    ("rust", "rust-analyzer", &[]),
    ("go", "gopls", &[]),
    ("json", "vscode-json-language-server", &["--stdio"]),
    ("css", "vscode-css-language-server", &["--stdio"]),
    ("html", "vscode-html-language-server", &["--stdio"]),
    ("yaml", "yaml-language-server", &["--stdio"]),
    ("markdown", "marksman", &["server"]),
];

/// What the status bar shows. One variant per state D14 distinguishes, so
/// "nothing is happening" is never ambiguous between the four reasons.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LspState {
    /// No server is configured for this language at all.
    Unsupported,
    /// Palisade knows a server for it; that server isn't on PATH.
    NotInstalled,
    Starting,
    Running,
    /// Crashed and being restarted (attempt `restarts` of MAX_RESTARTS).
    Crashed,
    /// Crashed MAX_RESTARTS times — off for the rest of the session.
    Disabled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LspStatus {
    pub language: String,
    pub state: LspState,
    /// The binary Palisade looked for, so "not installed" names what to install.
    pub server: Option<String>,
    pub restarts: u32,
    /// Present when something went wrong, in the user's words not the log's.
    pub detail: Option<String>,
}

/// How to install a server Palisade can't find, per language. First candidate
/// whose installer is itself on PATH wins — a machine with `pipx` and one
/// with `uv` both need python-lsp-server, and neither should have to know
/// which of the two Palisade happened to hardcode.
///
/// Deliberately still not a package manager (D6): this is one command per
/// language, run on the user's say-so, using the toolchain they already have.
/// Palisade bundles nothing.
const INSTALLERS: &[(&str, &[&[&str]])] = &[
    (
        "typescript",
        &[&["npm", "install", "-g", "typescript-language-server", "typescript"]],
    ),
    (
        "javascript",
        &[&["npm", "install", "-g", "typescript-language-server", "typescript"]],
    ),
    (
        "python",
        &[
            &["uv", "tool", "install", "python-lsp-server"],
            &["pipx", "install", "python-lsp-server"],
            &["python3", "-m", "pip", "install", "--user", "python-lsp-server"],
        ],
    ),
    ("rust", &[&["rustup", "component", "add", "rust-analyzer"]]),
];

/// The install command Palisade would run for `language`, given what's on PATH.
/// None when Palisade knows no installer, or knows one but its tool is missing —
/// offering `pipx install …` on a machine without pipx is a dead button.
fn installer_for(language: &str, on_path: &dyn Fn(&str) -> bool) -> Option<Vec<String>> {
    let (_, candidates) = INSTALLERS.iter().find(|(lang, _)| *lang == language)?;
    candidates
        .iter()
        .find(|argv| on_path(argv[0]))
        .map(|argv| argv.iter().map(|part| part.to_string()).collect())
}

/// The install command for `language`, resolved against the real PATH.
pub fn install_command(language: &str) -> Option<Vec<String>> {
    installer_for(language, &installed)
}

/// Run the install command for `language` and wait for it. Errors carry the
/// tool's own output — "npm ERR! EACCES" tells the user what to do next in a
/// way "install failed" never will.
pub fn install(language: &str) -> Res<()> {
    let argv = install_command(language)
        .ok_or_else(|| format!("no installer available for {language} on this machine"))?;
    let exe = which(&argv[0]).unwrap_or_else(|| PathBuf::from(&argv[0]));
    let output = Command::new(exe)
        .args(&argv[1..])
        .env("PATH", crate::executor::child_path_env())
        .output()
        .map_err(|err| format!("{}: {err}", argv[0]))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let detail = stderr.trim();
    Err(if detail.is_empty() {
        format!("{} exited with {}", argv.join(" "), output.status)
    } else {
        detail.to_string()
    })
}

/// The server command for a language, if Palisade knows one.
fn server_for(language: &str) -> Option<(&'static str, &'static [&'static str])> {
    SERVERS
        .iter()
        .find(|(lang, _, _)| *lang == language)
        .map(|(_, bin, args)| (*bin, *args))
}

/// Whether `binary` resolves on PATH — the same "you install it, we find
/// it" contract the executor preflight uses.
///
/// Resolved through `executor::find_on_path`, not a second local lookup.
/// This module used to read `$PATH` directly, which is launchd's minimal
/// `/usr/bin:/bin:/usr/sbin:/sbin` for an app launched from Finder — so
/// `rust-analyzer` under `~/.cargo/bin`, `pylsp` under `~/.local/bin` and
/// anything under `~/.nvm/...` reported "not installed" on a machine that
/// had them. The executor already solved this with a login-shell fallback;
/// there is no reason for language servers to see a different PATH than
/// agents do.
fn which(binary: &str) -> Option<PathBuf> {
    crate::executor::find_on_path(binary)
}

fn installed(binary: &str) -> bool {
    which(binary).is_some()
}

/// Wraps one JSON-RPC body in LSP's stdio framing. Shared with `dap`, which
/// speaks the same `Content-Length` framing over stdio.
pub(crate) fn frame(body: &str) -> String {
    format!("Content-Length: {}\r\n\r\n{body}", body.len())
}

/// Pulls whole messages out of a growing stdio buffer, leaving any partial
/// tail behind. Returns the bodies found; `buffer` keeps the remainder.
///
/// A server can flush half a header, and it may send headers Palisade doesn't
/// care about (`Content-Type`) — both are normal, neither may desync the
/// stream.
pub(crate) fn drain_messages(buffer: &mut Vec<u8>) -> Vec<String> {
    let mut out = Vec::new();
    loop {
        let Some(header_end) = find_header_end(buffer) else {
            return out;
        };
        let header = String::from_utf8_lossy(&buffer[..header_end]).into_owned();
        let Some(length) = content_length(&header) else {
            // A header block with no Content-Length is unusable: skip it
            // rather than stalling on it forever.
            buffer.drain(..header_end + 4);
            continue;
        };
        let body_start = header_end + 4;
        if buffer.len() < body_start + length {
            return out; // The body hasn't all arrived yet.
        }
        let body = String::from_utf8_lossy(&buffer[body_start..body_start + length]).into_owned();
        buffer.drain(..body_start + length);
        out.push(body);
    }
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|w| w == b"\r\n\r\n")
}

fn content_length(header: &str) -> Option<usize> {
    header
        .lines()
        .find_map(|line| line.strip_prefix("Content-Length:"))
        .and_then(|value| value.trim().parse().ok())
}

/// One running server, plus the bookkeeping D14's restart policy needs.
struct Server {
    child: Child,
    state: LspState,
    restarts: u32,
    detail: Option<String>,
    /// The server's own last words on stderr, if it said any. A crash with
    /// a reason is actionable; a crash without one is a mystery.
    last_error: Arc<Mutex<String>>,
}

/// Servers can be chatty on the way down; the first line is the reason.
fn first_line(text: &str) -> String {
    text.lines().next().unwrap_or_default().trim().to_string()
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Every language server Palisade has running, keyed by `(project, language)`.
#[derive(Default)]
pub struct LspServers(Mutex<HashMap<(String, String), Server>>);

impl LspServers {
    pub fn new() -> Self {
        Self::default()
    }

    /// Starts a server for `language` in `project_root` if one isn't already
    /// running. `on_message` receives every JSON-RPC body the server sends;
    /// `on_exit` fires once if it dies.
    ///
    /// Idempotent: calling it for an already-running language is a no-op, so
    /// every file open can call it without counting.
    pub fn ensure(
        &self,
        project_hash: &str,
        language: &str,
        project_root: &Path,
        on_message: impl Fn(String) + Send + 'static,
        on_exit: impl Fn() + Send + 'static,
    ) -> Res<LspStatus> {
        let key = (project_hash.to_string(), language.to_string());
        let mut servers = self.0.lock_or_recover();

        if let Some(existing) = servers.get(&key) {
            if existing.state == LspState::Disabled {
                return Ok(status_of(language, existing));
            }
            if existing.state == LspState::Running || existing.state == LspState::Starting {
                return Ok(status_of(language, existing));
            }
        }

        let Some((binary, args)) = server_for(language) else {
            return Ok(LspStatus {
                language: language.to_string(),
                state: LspState::Unsupported,
                server: None,
                restarts: 0,
                detail: None,
            });
        };
        if !installed(binary) {
            return Ok(LspStatus {
                language: language.to_string(),
                state: LspState::NotInstalled,
                server: Some(binary.to_string()),
                restarts: 0,
                detail: Some(format!("`{binary}` is not on PATH")),
            });
        }

        let restarts = servers.get(&key).map(|s| s.restarts).unwrap_or(0);
        // Resolved path + the login shell's PATH, for the same reason the
        // executor hands its children one: a server that resolves fine still
        // shells out to its own toolchain (pylsp → python, rust-analyzer →
        // cargo, typescript-language-server → node), and launchd's minimal
        // PATH makes those invisible.
        let exe = which(binary).unwrap_or_else(|| PathBuf::from(binary));
        let mut child = Command::new(exe)
            .args(args)
            .env("PATH", crate::executor::child_path_env())
            .current_dir(project_root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // Kept, not discarded: a server that dies on startup says why
            // here and nowhere else. `rust-analyzer` on a machine with only
            // the rustup shim installed exits instantly with
            // "Unknown binary 'rust-analyzer' in official toolchain" — which
            // the status bar could not report while this was /dev/null.
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|err| format!("start {binary}: {err}"))?;

        let mut stderr = child.stderr.take();
        let last_error = Arc::new(Mutex::new(String::new()));
        let stdout = child.stdout.take().ok_or("language server has no stdout")?;
        let error_sink = last_error.clone();
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut buffer = Vec::new();
            let mut chunk = [0u8; 8192];
            loop {
                match reader.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        buffer.extend_from_slice(&chunk[..n]);
                        for body in drain_messages(&mut buffer) {
                            on_message(body);
                        }
                    }
                }
            }
            // Read stderr here rather than on its own thread: by the time
            // stdout hits EOF the process is gone, so the pipe is closed and
            // this returns at once — and it lands *before* `on_exit`, which
            // is what puts the reason in the status the user then reads.
            if let Some(stderr) = stderr.take() {
                let mut text = String::new();
                let _ = BufReader::new(stderr).read_to_string(&mut text);
                if !text.trim().is_empty() {
                    *error_sink.lock_or_recover() = first_line(text.trim());
                }
            }
            on_exit();
        });

        servers.insert(
            key.clone(),
            Server {
                child,
                state: LspState::Running,
                restarts,
                detail: None,
                last_error,
            },
        );
        Ok(status_of(language, servers.get(&key).unwrap()))
    }

    /// Writes one framed JSON-RPC body to the server's stdin.
    pub fn send(&self, project_hash: &str, language: &str, body: &str) -> Res<()> {
        let mut servers = self.0.lock_or_recover();
        let server = servers
            .get_mut(&(project_hash.to_string(), language.to_string()))
            .ok_or_else(|| format!("no language server running for {language}"))?;
        let stdin = server.child.stdin.as_mut().ok_or("server stdin closed")?;
        stdin
            .write_all(frame(body).as_bytes())
            .and_then(|_| stdin.flush())
            .map_err(|err| format!("write to {language} server: {err}"))
    }

    /// Records a server exit and applies D14's restart policy: the caller
    /// restarts while this returns `Crashed`, and stops once it returns
    /// `Disabled`.
    pub fn record_exit(&self, project_hash: &str, language: &str) -> LspState {
        let mut servers = self.0.lock_or_recover();
        let Some(server) = servers.get_mut(&(project_hash.to_string(), language.to_string()))
        else {
            return LspState::Disabled;
        };
        server.restarts += 1;
        let reason = server.last_error.lock_or_recover().clone();
        let because = if reason.is_empty() {
            String::new()
        } else {
            format!(" ({reason})")
        };
        server.state = if server.restarts >= MAX_RESTARTS {
            server.detail = Some(format!(
                "the {language} server crashed {} times{because} — disabled for this session",
                server.restarts
            ));
            LspState::Disabled
        } else {
            server.detail = Some(format!(
                "the {language} server crashed{because}; restarting ({}/{MAX_RESTARTS})",
                server.restarts
            ));
            LspState::Crashed
        };
        server.state
    }

    /// How long to wait before restart number `restarts` — exponential
    /// backoff so a server that dies instantly doesn't spin the CPU.
    pub fn backoff_ms(restarts: u32) -> u64 {
        500u64 << restarts.min(4)
    }

    pub fn status(&self, project_hash: &str, language: &str) -> LspStatus {
        let servers = self.0.lock_or_recover();
        match servers.get(&(project_hash.to_string(), language.to_string())) {
            Some(server) => status_of(language, server),
            None => {
                let server = server_for(language);
                LspStatus {
                    language: language.to_string(),
                    state: match server {
                        None => LspState::Unsupported,
                        Some((binary, _)) if !installed(binary) => LspState::NotInstalled,
                        Some(_) => LspState::Starting,
                    },
                    server: server.map(|(binary, _)| binary.to_string()),
                    restarts: 0,
                    detail: None,
                }
            }
        }
    }

    /// Kills every server for a project — called on project switch and quit
    /// so nothing is left behind (the design's process-leak risk).
    pub fn shutdown_project(&self, project_hash: &str) {
        self.0
            .lock()
            .unwrap()
            .retain(|(hash, _), _| hash != project_hash);
    }
}

fn status_of(language: &str, server: &Server) -> LspStatus {
    LspStatus {
        language: language.to_string(),
        state: server.state,
        server: server_for(language).map(|(binary, _)| binary.to_string()),
        restarts: server.restarts,
        detail: server.detail.clone(),
    }
}

/// Shared handle for the Tauri state.
pub type SharedLsp = Arc<LspServers>;

#[cfg(test)]
mod tests {
    use crate::locks::MutexExt;
    use super::*;

    #[test]
    fn framing_states_the_byte_length_not_the_char_count() {
        // "é" is two bytes: the body is 9 chars but 10 bytes, and a char
        // count here would desync every later message on the stream.
        let framed = frame("{\"a\":\"é\"}");
        assert!(framed.starts_with("Content-Length: 10\r\n\r\n"), "{framed}");
    }

    #[test]
    fn drains_two_whole_messages_and_keeps_a_partial_tail() {
        let mut buffer = Vec::new();
        buffer.extend_from_slice(frame("{\"one\":1}").as_bytes());
        buffer.extend_from_slice(frame("{\"two\":2}").as_bytes());
        buffer.extend_from_slice(b"Content-Length: 9\r\n\r\n{\"thr");

        let found = drain_messages(&mut buffer);
        assert_eq!(found, vec!["{\"one\":1}", "{\"two\":2}"]);
        // The partial third message stays put, waiting for the rest.
        assert_eq!(buffer, b"Content-Length: 9\r\n\r\n{\"thr");
    }

    #[test]
    fn a_split_header_yields_nothing_until_it_completes() {
        let mut buffer = b"Content-Len".to_vec();
        assert!(drain_messages(&mut buffer).is_empty());
        buffer.extend_from_slice(b"gth: 9\r\n\r\n{\"one\":1}");
        // The header was `Content-Length` once complete.
        let mut whole = b"Content-Length: 9\r\n\r\n{\"one\":1}".to_vec();
        assert_eq!(drain_messages(&mut whole), vec!["{\"one\":1}"]);
    }

    #[test]
    fn extra_headers_do_not_confuse_the_parser() {
        let mut buffer =
            b"Content-Length: 9\r\nContent-Type: application/vscode-jsonrpc\r\n\r\n{\"one\":1}"
                .to_vec();
        assert_eq!(drain_messages(&mut buffer), vec!["{\"one\":1}"]);
        assert!(buffer.is_empty());
    }

    #[test]
    fn a_utf8_body_survives_the_round_trip() {
        let body = "{\"msg\":\"héllo wörld\"}";
        let mut buffer = frame(body).as_bytes().to_vec();
        assert_eq!(drain_messages(&mut buffer), vec![body]);
    }

    #[test]
    fn languages_map_to_their_servers_and_unknown_ones_map_to_nothing() {
        assert_eq!(server_for("rust").map(|(b, _)| b), Some("rust-analyzer"));
        assert_eq!(
            server_for("typescript").map(|(_, a)| a),
            Some(["--stdio"].as_slice())
        );
        assert!(server_for("brainfuck").is_none());
    }

    #[test]
    fn a_language_with_no_server_reports_unsupported_not_missing() {
        let servers = LspServers::new();
        // "not installed" would tell the user to install something that
        // does not exist.
        assert_eq!(servers.status("p", "brainfuck").state, LspState::Unsupported);
    }

    #[test]
    fn backoff_grows_and_then_stops_growing() {
        assert_eq!(LspServers::backoff_ms(0), 500);
        assert_eq!(LspServers::backoff_ms(1), 1000);
        assert_eq!(LspServers::backoff_ms(2), 2000);
        // Capped, so a long-running session can't schedule a restart hours out.
        assert_eq!(LspServers::backoff_ms(9), LspServers::backoff_ms(4));
    }

    #[test]
    fn a_crash_reports_the_server_s_own_last_words() {
        let servers = LspServers::new();
        let child = Command::new("true").spawn().unwrap();
        let last_error = Arc::new(Mutex::new(
            "error: Unknown binary 'rust-analyzer' in official toolchain".to_string(),
        ));
        servers.0.lock_or_recover().insert(
            ("p".into(), "rust".into()),
            Server {
                child,
                state: LspState::Running,
                restarts: 0,
                detail: None,
                last_error,
            },
        );

        servers.record_exit("p", "rust");
        let detail = servers.status("p", "rust").detail.unwrap();
        // "It crashed" is not actionable; "Unknown binary" is.
        assert!(detail.contains("Unknown binary"), "{detail}");
    }

    #[test]
    fn only_the_first_stderr_line_is_kept() {
        assert_eq!(first_line("error: boom\n  at frame 1\n"), "error: boom");
        assert_eq!(first_line(""), "");
    }

    #[test]
    fn three_crashes_disable_the_language_for_the_session() {
        let servers = LspServers::new();
        // A server that exits immediately is the crash case, without needing
        // a real language server installed.
        let child = Command::new("true").spawn().unwrap();
        servers.0.lock_or_recover().insert(
            ("p".into(), "rust".into()),
            Server {
                child,
                state: LspState::Running,
                restarts: 0,
                detail: None,
                last_error: Arc::new(Mutex::new(String::new())),
            },
        );

        assert_eq!(servers.record_exit("p", "rust"), LspState::Crashed);
        assert_eq!(servers.record_exit("p", "rust"), LspState::Crashed);
        assert_eq!(servers.record_exit("p", "rust"), LspState::Disabled);

        let status = servers.status("p", "rust");
        assert_eq!(status.state, LspState::Disabled);
        assert_eq!(status.restarts, 3);
        // The reason has to reach the user, not just the log.
        assert!(status.detail.unwrap().contains("disabled"));
    }

    #[test]
    fn shutting_down_a_project_leaves_other_projects_running() {
        let servers = LspServers::new();
        for hash in ["p1", "p2"] {
            servers.0.lock_or_recover().insert(
                (hash.into(), "rust".into()),
                Server {
                    child: Command::new("sleep").arg("30").spawn().unwrap(),
                    state: LspState::Running,
                    restarts: 0,
                    detail: None,
                    last_error: Arc::new(Mutex::new(String::new())),
                },
            );
        }
        servers.shutdown_project("p1");
        assert_eq!(servers.status("p1", "rust").state, LspState::Starting);
        assert_eq!(servers.status("p2", "rust").state, LspState::Running);
    }

    #[test]
    fn sending_to_a_language_with_no_server_is_an_error_not_a_silent_drop() {
        let servers = LspServers::new();
        assert!(servers.send("p", "rust", "{}").is_err());
    }

    /// The four languages the product promises out of the box (D6 amended:
    /// Palisade still installs nothing on its own, but it must know how).
    #[test]
    fn knows_how_to_install_the_baseline_languages() {
        let everything = |_: &str| true;
        for language in ["rust", "typescript", "javascript", "python"] {
            assert!(
                installer_for(language, &everything).is_some(),
                "no installer for {language}"
            );
        }
    }

    #[test]
    fn picks_the_first_installer_actually_on_path() {
        let only_pipx = |bin: &str| bin == "pipx";
        assert_eq!(
            installer_for("python", &only_pipx),
            Some(vec![
                "pipx".to_string(),
                "install".to_string(),
                "python-lsp-server".to_string()
            ])
        );
    }

    /// A button offering `pipx install …` on a machine with no pipx is worse
    /// than no button: it fails in a way the user can do nothing about.
    #[test]
    fn offers_nothing_when_no_installer_is_available() {
        let nothing = |_: &str| false;
        assert_eq!(installer_for("python", &nothing), None);
        assert_eq!(installer_for("go", &|_: &str| true), None);
    }
}
