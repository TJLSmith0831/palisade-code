//! FIM (fill-in-the-middle) completion sidecar.
//!
//! Spawns a bundled `llama-server` process, sends FIM prompts over HTTP, and
//! returns the completion text plus model latency for telemetry.

use std::io::{BufRead, BufReader};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(test)]
use std::os::unix::fs::PermissionsExt;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
#[cfg(not(debug_assertions))]
use tauri::Manager;

use crate::store::Res;

const FIM_PREFIX: &str = "<|fim_prefix|>";
const FIM_SUFFIX: &str = "<|fim_suffix|>";
const FIM_MIDDLE: &str = "<|fim_middle|>";

const DEFAULT_CTX_SIZE: u32 = 2048;
const DEFAULT_N_GPU_LAYERS: u32 = 99;
const DEFAULT_N_PREDICT: u32 = 128;
const DEFAULT_TEMPERATURE: f64 = 0.0;

/// Averaged characters per token for code-like text. Used to approximate the
/// 256/128 token budget without shipping a tokenizer in v1.
const CHARS_PER_TOKEN_ESTIMATE: usize = 4;
const MAX_PREFIX_CHARS: usize = 256 * CHARS_PER_TOKEN_ESTIMATE;
const MAX_SUFFIX_CHARS: usize = 128 * CHARS_PER_TOKEN_ESTIMATE;

const MODEL_FILE_NAME: &str = "Qwen3.5-0.8B.Q4_K_M.gguf";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionResponse {
    pub completion: String,
    pub model_latency_ms: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionSettings {
    pub enabled: bool,
    pub accept_keybinding: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionTelemetry {
    pub shown: u64,
    pub accepted: u64,
    pub dismissed: u64,
    pub typed_past: u64,
    pub ttft_p50: f64,
    pub ttft_p99: f64,
}

/// Manages the `llama-server` child process and its localhost HTTP port.
pub struct CompletionServer {
    child: Mutex<Option<Child>>,
    reader_handle: Mutex<Option<thread::JoinHandle<()>>>,
    stopping: Arc<AtomicBool>,
    port: Mutex<u16>,
}

impl CompletionServer {
    pub fn new() -> Self {
        Self {
            child: Mutex::new(None),
            reader_handle: Mutex::new(None),
            stopping: Arc::new(AtomicBool::new(false)),
            port: Mutex::new(0),
        }
    }

    /// Spawns the sidecar with the bundled model and waits until the HTTP
    /// health endpoint responds. Returns an error if the process exits or the
    /// health check times out.
    pub fn spawn(&self, binary: &Path, model: &Path) -> Res<()> {
        if self.is_alive() {
            return Ok(());
        }

        self.terminate();

        let port = find_free_port()?;
        *self.port.lock().unwrap() = port;

        let mut cmd = Command::new(binary);
        cmd.arg("--model")
            .arg(model)
            .arg("--ctx-size")
            .arg(DEFAULT_CTX_SIZE.to_string())
            .arg("--n-gpu-layers")
            .arg(DEFAULT_N_GPU_LAYERS.to_string())
            .arg("--host")
            .arg("127.0.0.1")
            .arg("--port")
            .arg(port.to_string())
            .arg("--no-ui")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = cmd
            .spawn()
            .map_err(|err| format!("failed to spawn completion sidecar: {err}"))?;

        let stopping = self.stopping.clone();

        // Drain stdout/stderr so the pipes don't fill and block the child.
        let stdout = child
            .stdout
            .take()
            .ok_or("completion sidecar stdout unavailable")?;
        let stderr = child
            .stderr
            .take()
            .ok_or("completion sidecar stderr unavailable")?;

        let reader = thread::spawn(move || {
            let out = BufReader::new(stdout);
            let err = BufReader::new(stderr);
            for line in out.lines().chain(err.lines()) {
                if stopping.load(Ordering::SeqCst) {
                    return;
                }
                if let Ok(line) = line {
                    // Keep logs in debug builds; production just wants the line
                    // available for tracing if needed.
                    let _ = line;
                }
            }
        });

        *self.child.lock().unwrap() = Some(child);
        *self.reader_handle.lock().unwrap() = Some(reader);

        wait_for_health(port, Duration::from_secs(45))
            .map_err(|err| {
                self.terminate();
                err
            })?;

        Ok(())
    }

    pub fn is_alive(&self) -> bool {
        let mut child = self.child.lock().unwrap();
        match child.as_mut() {
            None => false,
            Some(c) => match c.try_wait() {
                Ok(None) => true,
                _ => false,
            },
        }
    }

    pub fn port(&self) -> u16 {
        *self.port.lock().unwrap()
    }

    /// Calls `GET /health` and returns once the endpoint responds 200 OK.
    pub fn health(&self) -> Res<()> {
        wait_for_health(self.port(), Duration::from_secs(30))
    }

    pub fn terminate(&self) {
        self.stopping.store(true, Ordering::SeqCst);

        if let Some(mut child) = self.child.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }

        if let Some(handle) = self.reader_handle.lock().unwrap().take() {
            let _ = handle.join();
        }

        self.stopping.store(false, Ordering::SeqCst);
    }

    /// Sends a FIM prompt and returns the completion text plus model latency.
    pub fn complete(&self, prefix: &str, suffix: &str) -> Res<CompletionResponse> {
        let prompt = build_fim_prompt(prefix, suffix);
        let body = request_body(&prompt);

        let url = format!("http://127.0.0.1:{}/completion", self.port());

        // The model may still be loading after the health check turns green;
        // retry 503 "Loading model" a few times before giving up.
        let deadline = Instant::now() + Duration::from_secs(30);
        let mut last_err = String::new();

        while Instant::now() < deadline {
            match ureq::post(&url)
                .timeout(Duration::from_secs(10))
                .send_json(&body)
            {
                Ok(resp) => {
                    let text = resp
                        .into_string()
                        .map_err(|err| format!("failed to read completion response: {err}"))?;
                    return parse_completion_response(&text);
                }
                Err(ureq::Error::Status(503, resp)) => {
                    last_err = format!("server unavailable: {}", resp.status_text());
                    thread::sleep(Duration::from_millis(200));
                }
                Err(err) => {
                    return Err(format!("completion request failed: {err}"));
                }
            }
        }

        Err(format!("completion sidecar timed out: {last_err}"))
    }
}

impl Default for CompletionServer {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for CompletionServer {
    fn drop(&mut self) {
        self.terminate();
    }
}

pub fn build_fim_prompt(prefix: &str, suffix: &str) -> String {
    let trimmed_prefix = trim_prefix(prefix);
    let trimmed_suffix = trim_suffix(suffix);
    format!("{FIM_PREFIX}{trimmed_prefix}{FIM_SUFFIX}{trimmed_suffix}{FIM_MIDDLE}")
}

fn trim_prefix(prefix: &str) -> &str {
    if prefix.len() <= MAX_PREFIX_CHARS {
        prefix
    } else {
        &prefix[prefix.len() - MAX_PREFIX_CHARS..]
    }
}

fn trim_suffix(suffix: &str) -> &str {
    if suffix.len() <= MAX_SUFFIX_CHARS {
        suffix
    } else {
        &suffix[..MAX_SUFFIX_CHARS]
    }
}

fn request_body(prompt: &str) -> serde_json::Value {
    // Add stop sequences for common code patterns to prevent repetition
    let stop_tokens = vec![
        FIM_SUFFIX.to_string(),
        FIM_PREFIX.to_string(),
        "\n\n".to_string(), // Stop at double newlines (end of block)
        "]\n".to_string(), // Stop at end of list
    ];
    
    serde_json::json!({
        "prompt": prompt,
        "n_predict": DEFAULT_N_PREDICT,
        "temperature": DEFAULT_TEMPERATURE,
        "stop": stop_tokens,
    })
}

pub fn parse_completion_response(body: &str) -> Res<CompletionResponse> {
    let value: serde_json::Value =
        serde_json::from_str(body).map_err(|err| format!("invalid completion JSON: {err}"))?;

    let content = value
        .get("content")
        .and_then(|v| v.as_str())
        .ok_or("completion response missing 'content'")?
        .to_string();

    let model_latency_ms = value
        .get("timings")
        .and_then(|t| t.get("prompt_ms"))
        .and_then(|v| v.as_f64())
        .ok_or("completion response missing 'timings.prompt_ms'")?;

    Ok(CompletionResponse {
        completion: truncate_to_complete_lines(clean_completion(content)),
        model_latency_ms,
    })
}

/// Cleans up common FIM completion artifacts:
/// - Removes duplicate keywords at the start (e.g., "from from")
/// - Fixes excessive leading whitespace
/// - Preserves trailing newlines
fn clean_completion(completion: String) -> String {
    let has_trailing_newline = completion.ends_with('\n');
    let mut lines: Vec<String> = completion.lines().map(|s| s.to_string()).collect();
    
    if lines.is_empty() {
        return completion;
    }

    // Clean up the first line: remove duplicate keywords and excessive leading spaces
    if let Some(first_line) = lines.first_mut() {
        *first_line = clean_first_line(first_line);
    }

    // Clean up remaining lines: normalize indentation
    for line in lines.iter_mut().skip(1) {
        *line = line.trim_start().to_string();
    }

    // Join lines back together, preserving single newlines between lines
    let result = lines.join("\n");
    if has_trailing_newline {
        format!("{}\n", result)
    } else {
        result
    }
}

/// Removes duplicate keywords at the start of a line and normalizes spaces.
/// Example: "from    from fastmcp" -> "from fastmcp"
/// Example: "fromfrom fastmcp" -> "from fastmcp"
fn clean_first_line(line: &str) -> String {
    let trimmed = line.trim_start();
    
    // Common Python/TypeScript import keywords that might be duplicated
    let keywords = ["from", "import", "class", "def", "async", "const", "let", "var", "function"];
    
    for keyword in &keywords {
        // Check if the line starts with the keyword followed by optional whitespace, then the same keyword again
        // This handles both "from from" and "fromfrom" cases
        let pattern = format!("{}\\s*{}", keyword, keyword);
        if let Some(re) = regex::Regex::new(&pattern).ok() {
            if re.is_match(trimmed) {
                // Replace the duplicate with a single occurrence and normalize all whitespace
                let replacement = format!("{} ", keyword);
                let cleaned = re.replace(trimmed, replacement).to_string();
                // Normalize all whitespace to single spaces
                let words: Vec<&str> = cleaned.split_whitespace().collect();
                return words.join(" ");
            }
        }
    }
    
    // If no duplicate found, just trim excessive leading spaces (keep at most 1 space)
    let words: Vec<&str> = trimmed.split_whitespace().collect();
    if words.len() > 1 {
        words.join(" ")
    } else {
        trimmed.to_string()
    }
}

/// Truncates a completion to the last complete line if the model was cut
/// off mid-statement (no trailing newline). Single-line completions with
/// no newline are kept whole — showing a partial line is better than
/// showing nothing.
fn truncate_to_complete_lines(completion: String) -> String {
    if completion.ends_with('\n') || completion.is_empty() {
        return completion;
    }
    match completion.rfind('\n') {
        Some(idx) => completion[..=idx].to_string(),
        None => completion,
    }
}

/// Resolves the sidecar binary and bundled model paths.
///
/// Debug builds look next to `Cargo.toml` so `cargo tauri dev` works without
/// bundling. Release builds resolve the bundled `Resources/` directory or the
/// sibling `Resources` folder in a macOS app bundle.
pub fn resolve_sidecar_paths(app: &AppHandle) -> Res<(PathBuf, PathBuf)> {
    let _ = app;
    #[cfg(debug_assertions)]
    {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let binary = manifest_dir.join(sidecar_binary_name_with_target());
        let model = manifest_dir.join("resources").join("models").join(MODEL_FILE_NAME);
        return Ok((binary, model));
    }

    #[cfg(not(debug_assertions))]
    {
        // bundle.resources is `resources/models/`, which Tauri places at
        // `Contents/Resources/resources/models/` in the macOS app bundle.
        let model = app
            .path()
            .resolve(
                format!("resources/models/{MODEL_FILE_NAME}"),
                tauri::path::BaseDirectory::Resource,
            )
            .map_err(|err| format!("failed to resolve model resource: {err}"))?;

        // Sidecar binaries live next to the main executable on all platforms
        // when bundled via `externalBin`.
        let exe_dir = std::env::current_exe()
            .map_err(|err| format!("failed to get current exe: {err}"))?
            .parent()
            .ok_or("current exe has no parent directory")?
            .to_path_buf();
        let binary = exe_dir.join("llama-server");

        Ok((binary, model))
    }
}

fn sidecar_binary_name_with_target() -> String {
    let target = if cfg!(target_arch = "aarch64") {
        "aarch64-apple-darwin"
    } else if cfg!(target_arch = "x86_64") {
        "x86_64-apple-darwin"
    } else if cfg!(target_arch = "x86") {
        "i686-apple-darwin"
    } else {
        "unknown"
    };
    format!("llama-server-{target}")
}

fn find_free_port() -> Res<u16> {
    const START: u16 = 18080;
    const END: u16 = 18180;

    for port in START..=END {
        let addr = format!("127.0.0.1:{port}");
        match TcpListener::bind(&addr) {
            Ok(listener) => {
                if let Ok(local) = listener.local_addr() {
                    return Ok(local.port());
                }
            }
            Err(_) => continue,
        }
    }

    Err("no free localhost port in range 18080-18180".into())
}

fn wait_for_health(port: u16, timeout: Duration) -> Res<()> {
    let url = format!("http://127.0.0.1:{port}/health");
    let deadline = Instant::now() + timeout;

    while Instant::now() < deadline {
        match ureq::get(&url).timeout(Duration::from_secs(1)).call() {
            Ok(resp) => {
                if resp.status() == 200 {
                    return Ok(());
                }
            }
            Err(ureq::Error::Status(503, _)) => {}
            Err(_) => {}
        }
        thread::sleep(Duration::from_millis(250));
    }

    Err(format!("completion sidecar did not become healthy on port {port}"))
}

/// Persists the public completion telemetry counters to `~/.floo-network/completion-telemetry.json`.
pub fn flush_telemetry(telemetry: &CompletionTelemetry) -> Res<()> {
    let home = crate::store::floo_home();
    std::fs::create_dir_all(&home).map_err(|err| {
        format!("failed to create floo home dir {}: {err}", home.display())
    })?;
    let path = home.join("completion-telemetry.json");
    let json = serde_json::to_string_pretty(telemetry)
        .map_err(|err| format!("failed to serialize telemetry: {err}"))?;
    std::fs::write(&path, json).map_err(|err| {
        format!("failed to write telemetry to {}: {err}", path.display())
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fim_prompt_contains_control_tokens() {
        let prompt = build_fim_prompt("def f():", "\n    pass");
        assert!(prompt.starts_with(FIM_PREFIX), "{prompt}");
        assert!(prompt.contains(FIM_SUFFIX), "{prompt}");
        assert!(prompt.ends_with(FIM_MIDDLE), "{prompt}");
    }

    #[test]
    fn parse_completion_response_extracts_content_and_latency() {
        let body = r#"{"content":"        total += item['price']\n","timings":{"prompt_ms":38.343}}"#;
        let parsed = parse_completion_response(body).unwrap();
        assert_eq!(parsed.completion, "total += item['price']\n");
        assert!((parsed.model_latency_ms - 38.343).abs() < 0.001);
    }

    #[test]
    fn parse_completion_response_fails_when_content_missing() {
        let body = r#"{"timings":{"prompt_ms":38.343}}"#;
        assert!(parse_completion_response(body).is_err());
    }

    #[test]
    fn parse_completion_response_fails_when_timings_missing() {
        let body = r#"{"content":"hello"}"#;
        assert!(parse_completion_response(body).is_err());
    }

    #[test]
    fn parse_completion_response_trims_truncated_multi_line_content() {
        // Model hit n_predict mid-statement on the third line — no trailing
        // newline. The partial trailing line should be dropped.
        let body = r#"{"content":"    x = 1\n    y = 2\n    return x +","timings":{"prompt_ms":12.0}}"#;
        let parsed = parse_completion_response(body).unwrap();
        assert_eq!(parsed.completion, "x = 1\ny = 2\n");
    }

    #[test]
    fn prefix_and_suffix_are_trimmed_to_budget() {
        let big_prefix = "x".repeat(MAX_PREFIX_CHARS + 50);
        let big_suffix = "y".repeat(MAX_SUFFIX_CHARS + 50);
        let prompt = build_fim_prompt(&big_prefix, &big_suffix);

        let prefix_end = prompt.find(FIM_SUFFIX).unwrap();
        let suffix_start = FIM_PREFIX.len();
        assert_eq!(
            prefix_end - suffix_start,
            MAX_PREFIX_CHARS,
            "prefix should be trimmed"
        );

        let suffix_end = prompt.len() - FIM_MIDDLE.len();
        let suffix_start = prompt.find(FIM_SUFFIX).unwrap() + FIM_SUFFIX.len();
        assert_eq!(
            suffix_end - suffix_start,
            MAX_SUFFIX_CHARS,
            "suffix should be trimmed"
        );
    }

    #[test]
    fn request_body_includes_additional_stop_tokens() {
        let prompt = build_fim_prompt("def f():", "\n    pass");
        let body = request_body(&prompt);
        
        let stop = body.get("stop").and_then(|v| v.as_array()).unwrap();
        assert!(stop.iter().any(|s| s.as_str() == Some(FIM_SUFFIX)));
        assert!(stop.iter().any(|s| s.as_str() == Some(FIM_PREFIX)));
        assert!(stop.iter().any(|s| s.as_str() == Some("\n\n")));
        assert!(stop.iter().any(|s| s.as_str() == Some("]\n")));
    }

    const FAKE_SIDECAR_SCRIPT: &str = r#"#!/usr/bin/env python3
import argparse
import http.server
import json
import sys

parser = argparse.ArgumentParser()
parser.add_argument("--port", type=int)
parser.add_argument("--model")
args, _ = parser.parse_known_args()

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            self.send_response(200)
            self.send_header("Content-type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"status":"ok"}')
        else:
            self.send_error(404)
    def do_POST(self):
        if self.path == "/completion":
            length = int(self.headers.get("Content-Length", "0"))
            if length:
                self.rfile.read(length)
            self.send_response(200)
            self.send_header("Content-type", "application/json")
            self.end_headers()
            body = json.dumps({"content":"hello","timings":{"prompt_ms":12.34}})
            self.wfile.write(body.encode())
        else:
            self.send_error(404)
    def log_message(self, *a):
        pass

with http.server.HTTPServer(("127.0.0.1", args.port), Handler) as s:
    s.serve_forever()
"#;

    #[test]
    fn completion_server_spawns_fake_sidecar_and_completes() {
        let dir = tempfile::tempdir().unwrap();
        let binary = dir.path().join("fake-llama-server");
        std::fs::write(&binary, FAKE_SIDECAR_SCRIPT).unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();

        let model = dir.path().join("fake.gguf");
        std::fs::write(&model, b"").unwrap();

        let server = CompletionServer::default();
        server.spawn(&binary, &model).unwrap();
        let resp = server.complete("def ", ":\n    pass").unwrap();

        assert_eq!(resp.completion, "hello");
        assert!((resp.model_latency_ms - 12.34).abs() < 0.001);

        server.terminate();
        assert!(!server.is_alive());
    }

    #[test]
    fn completion_server_spawn_fails_when_binary_missing() {
        let dir = tempfile::tempdir().unwrap();
        let binary = dir.path().join("does-not-exist");
        let model = dir.path().join("fake.gguf");
        std::fs::write(&model, b"").unwrap();

        let server = CompletionServer::default();
        let result = server.spawn(&binary, &model);
        assert!(result.is_err(), "spawn should fail when binary is missing");
    }

    #[test]
    fn completion_server_handles_missing_model() {
        let dir = tempfile::tempdir().unwrap();
        let binary = dir.path().join("fake-llama-server");
        std::fs::write(&binary, FAKE_SIDECAR_SCRIPT).unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();

        // Model file does not exist.
        let model = dir.path().join("nonexistent.gguf");

        let server = CompletionServer::default();
        // The fake sidecar doesn't actually load the model, so spawn succeeds.
        // But in a real server, a missing model would cause the process to exit.
        // Here we just verify the API doesn't panic on a missing model path.
        // We expect spawn to succeed with the fake sidecar (it ignores the model),
        // but complete should work.
        server.spawn(&binary, &model).unwrap();
        let resp = server.complete("def ", ":\n    pass").unwrap();
        assert_eq!(resp.completion, "hello");
        server.terminate();
    }

    #[test]
    fn completion_server_complete_fails_when_not_spawned() {
        let server = CompletionServer::default();
        let result = server.complete("def ", ":\n    pass");
        assert!(result.is_err(), "complete should fail when server is not running");
    }

    #[test]
    fn clean_completion_removes_duplicate_from_keyword() {
        let input = "from    from fastmcp.client import Client as FastmcpClient".to_string();
        let cleaned = clean_completion(input);
        assert_eq!(cleaned, "from fastmcp.client import Client as FastmcpClient");
    }

    #[test]
    fn clean_completion_removes_duplicate_from_keyword_no_space() {
        let input = "fromfrom fastmcp.client import Client as FastmcpClient".to_string();
        let cleaned = clean_completion(input);
        assert_eq!(cleaned, "from fastmcp.client import Client as FastmcpClient");
    }

    #[test]
    fn clean_completion_removes_duplicate_import_keyword() {
        let input = "import import pandas as pd".to_string();
        let cleaned = clean_completion(input);
        assert_eq!(cleaned, "import pandas as pd");
    }

    #[test]
    fn clean_completion_removes_duplicate_import_keyword_no_space() {
        let input = "importimport pandas as pd".to_string();
        let cleaned = clean_completion(input);
        assert_eq!(cleaned, "import pandas as pd");
    }

    #[test]
    fn clean_completion_normalizes_indentation() {
        let input = "from fastmcp.client import Client\n    from fastmcp.client.transports import StdioTransport".to_string();
        let cleaned = clean_completion(input);
        assert_eq!(cleaned, "from fastmcp.client import Client\nfrom fastmcp.client.transports import StdioTransport");
    }

    #[test]
    fn clean_completion_handles_multiline_with_duplicates() {
        let input = "from    from fastmcp.client import Client\n    from fastmcp.client.transports import StdioTransport".to_string();
        let cleaned = clean_completion(input);
        assert_eq!(cleaned, "from fastmcp.client import Client\nfrom fastmcp.client.transports import StdioTransport");
    }

    #[test]
    fn clean_completion_handles_multiline_with_duplicates_no_space() {
        let input = "fromfrom fastmcp.client import Client\n    from fastmcp.client.transports import StdioTransport".to_string();
        let cleaned = clean_completion(input);
        assert_eq!(cleaned, "from fastmcp.client import Client\nfrom fastmcp.client.transports import StdioTransport");
    }

    #[test]
    fn clean_completion_preserves_normal_completion() {
        let input = "    total += item['price']\n".to_string();
        let cleaned = clean_completion(input);
        assert_eq!(cleaned, "total += item['price']\n");
    }

    #[test]
    fn clean_completion_handles_empty_input() {
        let input = "".to_string();
        let cleaned = clean_completion(input);
        assert_eq!(cleaned, "");
    }

    #[test]
    fn clean_completion_handles_exact_user_case() {
        let input = "fromfrom fastmcp.client import Client as FastmcpClient\nfrom fastmcp.client.transports import StdioTransport as FastmcpStdio".to_string();
        let cleaned = clean_completion(input);
        assert_eq!(cleaned, "from fastmcp.client import Client as FastmcpClient\nfrom fastmcp.client.transports import StdioTransport as FastmcpStdio");
    }

    // --- truncate_to_complete_lines -------------------------------------------

    #[test]
    fn truncate_keeps_completion_with_trailing_newline_unchanged() {
        let input = "    return x + y\n".to_string();
        let result = truncate_to_complete_lines(input);
        assert_eq!(result, "    return x + y\n");
    }

    #[test]
    fn truncate_cuts_mid_line_multi_line_completion_to_last_newline() {
        // Model hit n_predict mid-statement on the third line.
        let input = "    x = 1\n    y = 2\n    return x +".to_string();
        let result = truncate_to_complete_lines(input);
        assert_eq!(result, "    x = 1\n    y = 2\n");
    }

    #[test]
    fn truncate_keeps_single_line_completion_whole() {
        // No newline at all — truncating to nothing would be worse than
        // showing a partial line.
        let input = "return x +".to_string();
        let result = truncate_to_complete_lines(input);
        assert_eq!(result, "return x +");
    }

    #[test]
    fn truncate_returns_empty_string_unchanged() {
        let result = truncate_to_complete_lines("".to_string());
        assert_eq!(result, "");
    }
}
