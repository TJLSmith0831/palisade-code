//! FIM (fill-in-the-middle) completion sidecar.
//!
//! Spawns a bundled `llama-server` process, sends FIM prompts over HTTP, and
//! returns the completion text plus model latency for telemetry.

use std::collections::BTreeSet;
use std::io::{BufRead, BufReader, Read, Write};
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
use tauri::{Emitter, Manager};

use sha2::{Digest, Sha256};

use crate::store::Res;
use crate::locks::MutexExt;

const FIM_PREFIX: &str = "<|fim_prefix|>";
const FIM_SUFFIX: &str = "<|fim_suffix|>";
const FIM_MIDDLE: &str = "<|fim_middle|>";
/// Qwen's repo-level separator and end token. Both appear only as *stop*
/// sequences: the bundled model emits them, and a completion that runs on
/// past one is a completion that has started writing the next file.
const FIM_FILE_SEP: &str = "<|file_sep|>";
const FIM_END: &str = "<|endoftext|>";

const DEFAULT_CTX_SIZE: u32 = 2048;
const DEFAULT_N_GPU_LAYERS: u32 = 99;
const DEFAULT_N_PREDICT: u32 = 128;
/// n_predict used when the suffix is empty (cursor at true end-of-file).
/// See the comment in `CompletionServer::complete`.
const EOF_N_PREDICT: u32 = 32;
const DEFAULT_TEMPERATURE: f64 = 0.0;
// D4: repeat_penalty breaks the greedy-decoding repetition trap on the 0.8B
// model; top_p is a second guard against probability concentration. Both are
// mild, standard llama.cpp values. Temperature stays 0 for deterministic
// output (see decisions.md D4/D5).
const DEFAULT_REPEAT_PENALTY: f64 = 1.1;
const DEFAULT_TOP_P: f64 = 0.95;

/// Averaged characters per token for code-like text. Used to approximate the
/// 256/128 token budget without shipping a tokenizer in v1.
const CHARS_PER_TOKEN_ESTIMATE: usize = 4;
const MAX_PREFIX_CHARS: usize = 256 * CHARS_PER_TOKEN_ESTIMATE;
const MAX_SUFFIX_CHARS: usize = 128 * CHARS_PER_TOKEN_ESTIMATE;

/// D59: stock Qwen2.5-Coder-0.5B at Q5_K_M, replacing Qwen3.5-0.8B Q4_K_M.
/// Roughly double the pass@1, 27% smaller, and on an architecture where
/// llama.cpp prompt caching actually engages (10 tokens reprocessed per
/// keystroke against 241). Changing this constant is the whole swap: both
/// the bundled-resource path and the installed-model path derive from it.
const MODEL_FILE_NAME: &str = "Qwen2.5-Coder-0.5B-Q5_K_M.gguf";

/// Which entry of the role-keyed model manifest this build wants. Palisade
/// ships one model today; the manifest is keyed so adding a second is a new
/// key rather than a format change that strands every installed beta.
const MODEL_ROLE: &str = "fim";

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
    /// Requests where the model declined to suggest anything (D60).
    #[serde(default)]
    pub abstained: u64,
    /// Accepted completions still in the file 30s later.
    #[serde(default)]
    pub retained: u64,
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
        *self.port.lock_or_recover() = port;

        // The previous run's Drop may never have executed — a `tauri dev`
        // hard restart, a crash, a force quit. An audit found one of these
        // still holding a GPU-backed model 31 hours after its app had gone,
        // reparented to init with nothing left to reap it. The model path is
        // absolute and unique to this app, so it re-identifies the child
        // safely even if the PID has since been reused.
        let pid_path = sidecar_pid_path();
        crate::pidguard::reap_stale(&pid_path, &sidecar_reap_token(model));

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
            .map_err(|err| crate::PalisadeError::from(format!("failed to spawn completion sidecar: {err}")))?;
        crate::pidguard::record(&pid_path, child.id());

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

        *self.child.lock_or_recover() = Some(child);
        *self.reader_handle.lock_or_recover() = Some(reader);

        wait_for_health(port, Duration::from_secs(45))
            .map_err(|err| {
                self.terminate();
                err
            })?;

        Ok(())
    }

    pub fn is_alive(&self) -> bool {
        let mut child = self.child.lock_or_recover();
        match child.as_mut() {
            None => false,
            Some(c) => match c.try_wait() {
                Ok(None) => true,
                _ => false,
            },
        }
    }

    pub fn port(&self) -> u16 {
        *self.port.lock_or_recover()
    }

    /// Calls `GET /health` and returns once the endpoint responds 200 OK.
    pub fn health(&self) -> Res<()> {
        wait_for_health(self.port(), Duration::from_secs(30))
    }

    pub fn terminate(&self) {
        self.stopping.store(true, Ordering::SeqCst);

        if let Some(mut child) = self.child.lock_or_recover().take() {
            let _ = child.kill();
            let _ = child.wait();
        }

        if let Some(handle) = self.reader_handle.lock_or_recover().take() {
            let _ = handle.join();
        }

        crate::pidguard::clear(&sidecar_pid_path());
        self.stopping.store(false, Ordering::SeqCst);
    }

    /// Sends a FIM prompt and returns the completion text plus model latency.
    pub fn complete(&self, file_path: &str, prefix: &str, suffix: &str) -> Res<CompletionResponse> {
        let prompt = build_fim_prompt(file_path, prefix, suffix);
        // True end-of-file (nothing after the cursor) gives FIM no suffix to
        // anchor on. Measured on the bundled 0.8B model: this case
        // deterministically produces a runaway hallucination — reimporting
        // already-imported modules, inventing a second `main()` — that is
        // already wrong at the first token and just keeps going to fill the
        // budget. A smaller budget caps the damage to a line or two instead
        // of an 18-line fabricated block, without disabling completions at
        // EOF entirely (needed for e.g. finishing an open block at file end).
        let n_predict = if suffix.trim().is_empty() {
            EOF_N_PREDICT
        } else {
            DEFAULT_N_PREDICT
        };
        let body = request_body(&prompt, n_predict);

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
                        .map_err(|err| crate::PalisadeError::from(format!("failed to read completion response: {err}")))?;
                    return parse_completion_response(&text);
                }
                Err(ureq::Error::Status(503, resp)) => {
                    last_err = format!("server unavailable: {}", resp.status_text());
                    thread::sleep(Duration::from_millis(200));
                }
                Err(err) => {
                    return Err(format!("completion request failed: {err}").into());
                }
            }
        }

        Err(format!("completion sidecar timed out: {last_err}").into())
    }
}

impl CompletionServer {
    /// Names a thread from its opening prompt, using the same bundled model
    /// the editor's inline completion runs on — no extra agent turn, no
    /// network, no cost.
    ///
    /// Short deadline and no retry, unlike `complete`: a title is cosmetic,
    /// and the caller falls back to trimming the prompt. Making the user's
    /// first turn wait on a cold sidecar to earn a nicer label is a bad
    /// trade, so a slow model simply loses the race.
    pub fn title(&self, prompt: &str) -> Res<String> {
        let url = format!("http://127.0.0.1:{}/completion", self.port());
        let resp = ureq::post(&url)
            .timeout(Duration::from_secs(4))
            .send_json(&title_request_body(prompt))
            .map_err(|err| crate::PalisadeError::from(format!("title request failed: {err}")))?;
        let text = resp
            .into_string()
            .map_err(|err| crate::PalisadeError::from(format!("failed to read title response: {err}")))?;
        let raw = serde_json::from_str::<serde_json::Value>(&text)
            .map_err(|err| crate::PalisadeError::from(format!("failed to parse title response: {err}")))?
            .get("content")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        clean_title(&raw).ok_or_else(|| crate::PalisadeError::from("model returned no usable title"))
    }

    /// A one-line commit subject for a diff, from the local model.
    ///
    /// Same shape as [`title`]: a small local model answering a summarisation
    /// question in a few hundred milliseconds, so the merge gate can offer a
    /// message the moment it opens instead of spending an agent turn on one.
    /// The agent-backed `draft_commit_message` stays as the better answer for
    /// anyone who asks for it.
    pub fn commit_subject(&self, diff: &str) -> Res<String> {
        let url = format!("http://127.0.0.1:{}/completion", self.port());
        let resp = ureq::post(&url)
            .timeout(Duration::from_secs(6))
            .send_json(&commit_request_body(diff))
            .map_err(|err| crate::PalisadeError::from(format!("commit-message request failed: {err}")))?;
        let text = resp
            .into_string()
            .map_err(|err| crate::PalisadeError::from(format!("failed to read commit-message response: {err}")))?;
        let raw = serde_json::from_str::<serde_json::Value>(&text)
            .map_err(|err| crate::PalisadeError::from(format!("failed to parse commit-message response: {err}")))?
            .get("content")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        clean_title(&raw).ok_or_else(|| crate::PalisadeError::from("model returned no usable subject"))
    }
}

/// The diff handed to the local model. Far smaller than the agent's cap: a
/// 0.5B model's context is short, and the head of a diff is what a subject
/// line describes anyway.
const LOCAL_DIFF_CAP: usize = 4000;

fn commit_request_body(diff: &str) -> serde_json::Value {
    let mut end = diff.len().min(LOCAL_DIFF_CAP);
    while end > 0 && !diff.is_char_boundary(end) {
        end -= 1;
    }
    serde_json::json!({
        "prompt": build_commit_prompt(&diff[..end]),
        "n_predict": 24,
        "temperature": DEFAULT_TEMPERATURE,
        "repeat_penalty": DEFAULT_REPEAT_PENALTY,
        "top_p": DEFAULT_TOP_P,
        "stop": ["\n", "Diff:", "Message:", FIM_END.to_string()],
    })
}

/// Few-shot for the same reason the title prompt is: asked bare for "a commit
/// message", a small model narrates the diff instead of naming it.
pub fn build_commit_prompt(diff: &str) -> String {
    format!(
        "Write a one-line git commit subject for the diff below. \
         Imperative mood, under 72 characters. Subject only, no quotes, no body.\n\n\
         Diff: +def retry(fn, attempts=3):\n\
         Message: Add retry helper\n\n\
         Diff: -timeout = 5\n+timeout = 30\n\
         Message: Raise request timeout to 30s\n\n\
         Diff: {}\n\
         Message:",
        diff.trim()
    )
}

/// An instruction-style prompt rather than FIM: this is a summarisation task,
/// not a code-hole to fill. Few-shot, because a 0.8B model asked bare for "a
/// title" tends to answer the request instead of naming it.
pub fn build_title_prompt(request: &str) -> String {
    // A long paste is a title's worst input and the model's slowest; the
    // first part carries the intent.
    let request: String = request.chars().take(600).collect();
    format!(
        "Write a short title (3-6 words) naming what the user asked for. \
         Title only, no quotes, no trailing period.\n\n\
         Request: the login page redirects to a 404 after signing in with google, \
         can you look into why that happens\n\
         Title: Fix Google sign-in redirect\n\n\
         Request: add a priority field to each todo item\n\
         Title: Add todo priority field\n\n\
         Request: {}\n\
         Title:",
        request.trim()
    )
}

fn title_request_body(request: &str) -> serde_json::Value {
    serde_json::json!({
        "prompt": build_title_prompt(request),
        // A title is one short line: stop at the newline that ends it.
        "n_predict": 16,
        "temperature": DEFAULT_TEMPERATURE,
        "repeat_penalty": DEFAULT_REPEAT_PENALTY,
        "top_p": DEFAULT_TOP_P,
        "stop": ["\n", "Request:", "Title:", FIM_END.to_string()],
    })
}

/// Strips what a small model decorates a title with, and rejects the rest.
/// `None` when nothing usable came back — the caller keeps its own fallback
/// rather than showing the user a stray fragment.
pub fn clean_title(raw: &str) -> Option<String> {
    let line = raw.lines().find(|l| !l.trim().is_empty())?;
    let cleaned = line
        .trim()
        .trim_start_matches("Title:")
        .trim()
        .trim_matches(['"', '\'', '`', '*'])
        .trim_end_matches('.')
        .trim();
    // A model that echoed the instruction back, or produced a sentence, has
    // not produced a title.
    if cleaned.is_empty() || cleaned.chars().count() > 60 || cleaned.split_whitespace().count() > 10
    {
        return None;
    }
    let mut chars = cleaned.chars();
    let first = chars.next()?;
    Some(first.to_uppercase().collect::<String>() + chars.as_str())
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

/// `file_path` is accepted and deliberately unused in the prompt.
///
/// Prefixing the FIM prompt with Qwen's `<|file_sep|>{path}` header is the
/// obvious way to tell the model what language it is completing, and it was
/// tried: measured against the bundled Qwen3.5-0.8B on a Python function
/// body, the header made output *worse* — three repeated docstrings instead
/// of the coherent 15-line implementation the bare FIM prompt produced.
/// This checkpoint evidently wasn't trained with a lone separator ahead of
/// the prefix. Left here so the next person reads this instead of
/// re-deriving it; add it back only with a measurement that says otherwise.
pub fn build_fim_prompt(_file_path: &str, prefix: &str, suffix: &str) -> String {
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

fn request_body(prompt: &str, n_predict: u32) -> serde_json::Value {
    // Stop on the model's own control tokens only. `"\n\n"` used to be in
    // here to curb repetition, but a blank line is normal *inside* a
    // completion. Measured against the bundled model on a TypeScript
    // function body: with `"\n\n"` the suggestion was cut to 2 lines at the
    // first blank line; without it the same prompt returns the whole
    // 15-line block. Repetition is handled by `repeat_penalty` + n_predict.
    let stop_tokens = vec![
        FIM_SUFFIX.to_string(),
        FIM_PREFIX.to_string(),
        FIM_MIDDLE.to_string(),
        FIM_FILE_SEP.to_string(),
        FIM_END.to_string(),
    ];

    serde_json::json!({
        "prompt": prompt,
        "n_predict": n_predict,
        "temperature": DEFAULT_TEMPERATURE,
        "repeat_penalty": DEFAULT_REPEAT_PENALTY,
        "top_p": DEFAULT_TOP_P,
        "stop": stop_tokens,
    })
}

pub fn parse_completion_response(body: &str) -> Res<CompletionResponse> {
    let value: serde_json::Value =
        serde_json::from_str(body).map_err(|err| crate::PalisadeError::from(format!("invalid completion JSON: {err}")))?;

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
/// - Preserves indentation on all lines (D6: indent stripping caused
///   misaligned multi-line completions; Continue.dev does not strip it)
/// - Preserves trailing newlines
fn clean_completion(completion: String) -> String {
    let has_trailing_newline = completion.ends_with('\n');
    let mut lines: Vec<String> = completion.lines().map(|s| s.to_string()).collect();

    if lines.is_empty() {
        return completion;
    }

    // Clean up the first line: remove duplicate keywords. Indentation is
    // preserved (D6).
    if let Some(first_line) = lines.first_mut() {
        *first_line = clean_first_line(first_line);
    }

    // Lines 2+ pass through untouched — indentation is preserved (D6).
    // Join lines back together, preserving single newlines between lines
    let result = lines.join("\n");
    if has_trailing_newline {
        format!("{}\n", result)
    } else {
        result
    }
}

/// Removes duplicate keywords (e.g., "from from", "importimport") from the
/// first line of a completion while preserving indentation. D6: indentation
/// passes through untouched — only the keyword-dedup regex runs, no
/// whitespace normalization.
/// Example: "from    from fastmcp" -> "from fastmcp"
/// Example: "fromfrom fastmcp" -> "from fastmcp"
/// Example: "    from    from fastmcp" -> "    from fastmcp"
fn clean_first_line(line: &str) -> String {
    // Common Python/TypeScript import keywords that might be duplicated
    let keywords = ["from", "import", "class", "def", "async", "const", "let", "var", "function"];

    for keyword in &keywords {
        // Check if the line contains the keyword followed by optional
        // whitespace, then the same keyword again. This handles both
        // "from from" and "fromfrom" cases.
        let pattern = format!("{}\\s*{}", keyword, keyword);
        if let Some(re) = regex::Regex::new(&pattern).ok() {
            if re.is_match(line) {
                // Replace the duplicate with a single occurrence (no trailing
                // space — the original separator after the matched pattern is
                // preserved). Leading indentation is preserved because the
                // regex matches the keyword, not the leading whitespace.
                let replacement = format!("{}", keyword);
                return re.replace(line, replacement).to_string();
            }
        }
    }

    // No duplicate found — return the line unchanged (indent preserved, D6).
    line.to_string()
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
        // The model lives outside the `.app` (see `installed_model_dir`), so
        // it survives an update that replaces the whole bundle.
        let model = installed_model_dir(app)?.join(MODEL_FILE_NAME);

        // Sidecar binaries live next to the main executable on all platforms
        // when bundled via `externalBin`.
        let exe_dir = std::env::current_exe()
            .map_err(|err| crate::PalisadeError::from(format!("failed to get current exe: {err}")))?
            .parent()
            .ok_or("current exe has no parent directory")?
            .to_path_buf();
        let binary = exe_dir.join("llama-server");

        Ok((binary, model))
    }
}

/// Manifest entry describing the model an app version should be running.
///
/// Served as `models.json` so a new model ships by editing one JSON file —
/// no rebuild, no notarization, no reinstall.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelManifest {
    pub filename: String,
    pub sha256: String,
    pub url: String,
    #[serde(default)]
    pub size: u64,
    /// Guards against an old app pulling a model whose prompt format it
    /// cannot drive. Empty means "any version".
    #[serde(default)]
    pub min_app_version: String,
}

/// Where the update Worker serves `models.json`. The Worker holds the
/// Hugging Face credentials; the app never does.
const MODEL_MANIFEST_URL: Option<&str> =
    Some("https://palisade-updates.tjlsmith0831.workers.dev/models.json");

/// True when `have` is at or past `want`, comparing dotted numeric versions.
/// An empty `want` means no floor was set.
#[allow(dead_code)]
fn version_at_least(have: &str, want: &str) -> bool {
    if want.trim().is_empty() {
        return true;
    }
    let parts = |v: &str| -> Vec<u64> {
        v.split(['.', '-', '+'])
            .map(|piece| piece.parse::<u64>().unwrap_or(0))
            .collect()
    };
    let (have, want) = (parts(have), parts(want));
    for idx in 0..have.len().max(want.len()) {
        let h = have.get(idx).copied().unwrap_or(0);
        let w = want.get(idx).copied().unwrap_or(0);
        if h != w {
            return h > w;
        }
    }
    true
}

/// Writes through a `.part` sibling and renames on success.
///
/// A half-written model must never be visible at the real path: the whole
/// startup path keys off `model.exists()`, so a truncated file would read as
/// a working install forever.
#[allow(dead_code)]
fn install_atomically(target: &Path, write: impl FnOnce(&Path) -> Res<()>) -> Res<()> {
    let part = target.with_extension("part");
    let _ = std::fs::remove_file(&part);
    if let Err(err) = write(&part) {
        let _ = std::fs::remove_file(&part);
        return Err(err);
    }
    std::fs::rename(&part, target)
        .map_err(|err| crate::PalisadeError::from(format!("failed to install model at {}: {err}", target.display())))
}

/// Removes model files this build no longer uses from `dir`.
///
/// The ordering is the whole point. A model swap orphans the previous
/// `.gguf`, but deleting it before the replacement resolves would strand the
/// user with no model at all — so this is a no-op unless `keep` is already on
/// disk. `.part` files are abandoned downloads and go with it.
///
/// A fresh install never reaches this; only an upgrade does.
#[allow(dead_code)]
fn prune_stale_models(dir: &Path, keep: &str) -> Res<()> {
    if !dir.join(keep).is_file() {
        return Ok(());
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Ok(());
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name == keep {
            continue;
        }
        if !(name.ends_with(".gguf") || name.ends_with(".part")) {
            continue;
        }
        let path = entry.path();
        if path.is_file() {
            // Best-effort: a stale model left behind wastes disk, it does not
            // break the install, so a permissions failure must not fail startup.
            let _ = std::fs::remove_file(&path);
        }
    }
    Ok(())
}

/// Streams `reader` into `dest`, hashing as it goes, and fails if the digest
/// does not match `expected_sha256`.
#[allow(dead_code)]
fn write_verified(
    dest: &Path,
    reader: &mut impl Read,
    expected_sha256: &str,
    mut on_progress: impl FnMut(u64),
) -> Res<()> {
    let mut file = std::fs::File::create(dest)
        .map_err(|err| crate::PalisadeError::from(format!("failed to create {}: {err}", dest.display())))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    let mut written: u64 = 0;

    loop {
        let read = reader
            .read(&mut buf)
            .map_err(|err| crate::PalisadeError::from(format!("model download failed: {err}")))?;
        if read == 0 {
            break;
        }
        hasher.update(&buf[..read]);
        file.write_all(&buf[..read])
            .map_err(|err| crate::PalisadeError::from(format!("failed writing model: {err}")))?;
        written += read as u64;
        on_progress(written);
    }
    file.flush()
        .map_err(|err| crate::PalisadeError::from(format!("failed writing model: {err}")))?;

    let digest = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    if !digest.eq_ignore_ascii_case(expected_sha256.trim()) {
        return Err(format!(
            "model checksum mismatch: expected {expected_sha256}, got {digest}"
        ).into());
    }
    Ok(())
}

/// Picks this build's model out of a role-keyed manifest.
///
/// The manifest maps a role (`"fim"`) to its entry, so a second or third
/// model is an added key rather than a shape change that older installs
/// cannot parse.
#[allow(dead_code)]
fn select_model(manifest_json: &str, role: &str) -> Res<ModelManifest> {
    let manifests: std::collections::BTreeMap<String, ModelManifest> =
        serde_json::from_str(manifest_json)
            .map_err(|err| crate::PalisadeError::from(format!("model manifest is not valid JSON: {err}")))?;
    let count = manifests.len();
    manifests
        .into_iter()
        .find(|(key, _)| key == role)
        .map(|(_, entry)| entry)
        .ok_or_else(|| crate::PalisadeError::not_found(format!("model manifest has no \"{role}\" entry ({count} roles listed)")))
}

/// The installed model's home: `<app-data>/models/`.
///
/// Deliberately outside the `.app`: the updater replaces the whole bundle, so
/// a model inside it would be re-downloaded on every update and lost on every
/// install.
#[cfg(not(debug_assertions))]
fn installed_model_dir(app: &AppHandle) -> Res<PathBuf> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("models"))
        .map_err(|err| crate::PalisadeError::from(format!("failed to resolve app data dir: {err}")))
}

#[cfg(not(debug_assertions))]
fn emit_model_progress(app: &AppHandle, stage: &str, done: u64, total: u64) {
    let _ = app.emit(
        "model-install",
        serde_json::json!({ "stage": stage, "done": done, "total": total }),
    );
}

/// Puts the model on disk before the sidecar needs it.
///
/// Three sources, cheapest first: already installed, carried inside the
/// installer bundle, or downloaded from the manifest. Debug builds read the
/// model straight from the source tree, so this is a no-op there.
pub fn ensure_model_installed(app: &AppHandle) -> Res<()> {
    let _ = app;

    #[cfg(debug_assertions)]
    {
        Ok(())
    }

    #[cfg(not(debug_assertions))]
    {
        let dir = installed_model_dir(app)?;
        let target = dir.join(MODEL_FILE_NAME);
        if target.is_file() {
            prune_stale_models(&dir, MODEL_FILE_NAME)?;
            return Ok(());
        }
        std::fs::create_dir_all(&dir)
            .map_err(|err| crate::PalisadeError::from(format!("failed to create {}: {err}", dir.display())))?;

        // The installer build carries the model as a bundle resource. Copy it
        // out rather than moving it: removing a file from a signed `.app`
        // invalidates the bundle's code signature.
        let bundled = app.path().resolve(
            format!("resources/models/{MODEL_FILE_NAME}"),
            tauri::path::BaseDirectory::Resource,
        );
        if let Ok(bundled) = bundled {
            if bundled.is_file() {
                emit_model_progress(app, "copying", 0, 0);
                install_atomically(&target, |part| {
                    std::fs::copy(&bundled, part)
                        .map(|_| ())
                        .map_err(|err| crate::PalisadeError::from(format!("failed to copy bundled model: {err}")))
                })?;
                prune_stale_models(&dir, MODEL_FILE_NAME)?;
                emit_model_progress(app, "ready", 0, 0);
                return Ok(());
            }
        }

        download_model(app, &target)?;
        prune_stale_models(&dir, MODEL_FILE_NAME)
    }
}

/// Fetches the model manifest and installs the model it names.
#[cfg(not(debug_assertions))]
fn download_model(app: &AppHandle, target: &Path) -> Res<()> {
    let manifest_url = MODEL_MANIFEST_URL
        .ok_or("no model manifest configured, so the model cannot be downloaded")?;

    let body = ureq::get(manifest_url)
        .call()
        .map_err(|err| crate::PalisadeError::from(format!("failed to fetch model manifest: {err}")))?
        .into_string()
        .map_err(|err| crate::PalisadeError::from(format!("failed to read model manifest: {err}")))?;
    let manifest = select_model(&body, MODEL_ROLE)?;

    let app_version = env!("CARGO_PKG_VERSION");
    if !version_at_least(app_version, &manifest.min_app_version) {
        return Err(format!(
            "model {} needs Palisade {} or newer (running {app_version})",
            manifest.filename, manifest.min_app_version
        ).into());
    }

    emit_model_progress(app, "downloading", 0, manifest.size);
    let response = ureq::get(&manifest.url)
        .call()
        .map_err(|err| crate::PalisadeError::from(format!("failed to download model: {err}")))?;
    let mut reader = response.into_reader();

    // Emit at most once per 8MB — a per-chunk event would flood the webview.
    let mut next_report: u64 = 0;
    install_atomically(target, |part| {
        write_verified(part, &mut reader, &manifest.sha256, |done| {
            if done >= next_report {
                emit_model_progress(app, "downloading", done, manifest.size);
                next_report = done + (8 << 20);
            }
        })
    })?;

    emit_model_progress(app, "ready", manifest.size, manifest.size);
    Ok(())
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

/// Where the sidecar's PID is recorded between runs. App-global rather than
/// per-project, because there is one model server for the whole app.
///
/// ponytail: assumes one Palisade instance, like every other pidguard user.
/// Two instances would each reap the other's sidecar on spawn. Fixing that
/// means keying the file by instance, which is only worth doing if running
/// two copies at once becomes a supported thing.
pub(crate) fn sidecar_pid_path() -> PathBuf {
    crate::store::palisade_home().join(".completion-sidecar.pid")
}

/// What has to appear in a process's command line before it is recognised as
/// our sidecar. The absolute model path — `llama-server` alone would match
/// any llama.cpp server the user happens to be running.
pub(crate) fn sidecar_reap_token(model: &Path) -> String {
    model.display().to_string()
}

/// Ports already handed out but not yet bound by the child that asked for
/// them. The probe listener below has to be dropped before `llama-server`
/// can bind, so a port is unowned for a moment; without this, a second
/// caller in that window probes the same port successfully and both
/// children race for it.
///
/// ponytail: in-process only — a second Palisade instance (or the test
/// suite running beside a dev app) can still be handed a port this process
/// just released. Closing that needs spawn to retry on the next port when
/// the child fails to come up healthy.
static CLAIMED_PORTS: Mutex<BTreeSet<u16>> = Mutex::new(BTreeSet::new());

fn find_free_port() -> Res<u16> {
    const START: u16 = 18080;
    const END: u16 = 18180;

    let mut claimed = CLAIMED_PORTS.lock_or_recover();
    for port in START..=END {
        if claimed.contains(&port) {
            continue;
        }
        let addr = format!("127.0.0.1:{port}");
        match TcpListener::bind(&addr) {
            Ok(listener) => {
                if let Ok(local) = listener.local_addr() {
                    claimed.insert(local.port());
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

    Err(format!("completion sidecar did not become healthy on port {port}").into())
}

/// Persists the public completion telemetry counters to `~/.palisade-code/completion-telemetry.json`.
pub fn flush_telemetry(telemetry: &CompletionTelemetry) -> Res<()> {
    let home = crate::store::palisade_home();
    std::fs::create_dir_all(&home).map_err(|err| {
        format!("failed to create palisade home dir {}: {err}", home.display())
    })?;
    let path = home.join("completion-telemetry.json");
    let json = serde_json::to_string_pretty(telemetry)
        .map_err(|err| crate::PalisadeError::from(format!("failed to serialize telemetry: {err}")))?;
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
        let prompt = build_fim_prompt("", "def f():", "\n    pass");
        assert!(prompt.starts_with(FIM_PREFIX), "{prompt}");
        assert!(prompt.contains(FIM_SUFFIX), "{prompt}");
        assert!(prompt.ends_with(FIM_MIDDLE), "{prompt}");
    }

    #[test]
    fn the_file_path_stays_out_of_the_prompt() {
        // Measured: a `<|file_sep|>` header degraded this checkpoint's
        // output. The path is accepted for the day a model wants it.
        let prompt = build_fim_prompt("src/main.rs", "fn add(", ") {}");
        assert!(!prompt.contains("src/main.rs"), "{prompt}");
        assert!(prompt.starts_with(FIM_PREFIX), "{prompt}");
    }

    #[test]
    fn a_blank_line_no_longer_stops_the_completion() {
        // "\n\n" as a stop token cut every multi-line suggestion off at the
        // first blank line — the exact point a block completion gets useful.
        let body = request_body("prompt", DEFAULT_N_PREDICT);
        let stops: Vec<String> = body["stop"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect();
        assert!(!stops.contains(&"\n\n".to_string()), "{stops:?}");
        assert!(stops.contains(&FIM_SUFFIX.to_string()));
        assert!(stops.contains(&FIM_END.to_string()));
    }

    #[test]
    fn parse_completion_response_extracts_content_and_latency() {
        let body = r#"{"content":"        total += item['price']\n","timings":{"prompt_ms":38.343}}"#;
        let parsed = parse_completion_response(body).unwrap();
        // D6: first-line indentation is preserved.
        assert_eq!(parsed.completion, "        total += item['price']\n");
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
        // newline. The partial trailing line should be dropped. Indentation
        // is preserved on all lines (D6).
        let body = r#"{"content":"    x = 1\n    y = 2\n    return x +","timings":{"prompt_ms":12.0}}"#;
        let parsed = parse_completion_response(body).unwrap();
        assert_eq!(parsed.completion, "    x = 1\n    y = 2\n");
    }

    #[test]
    fn prefix_and_suffix_are_trimmed_to_budget() {
        let big_prefix = "x".repeat(MAX_PREFIX_CHARS + 50);
        let big_suffix = "y".repeat(MAX_SUFFIX_CHARS + 50);
        let prompt = build_fim_prompt("", &big_prefix, &big_suffix);

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
    fn request_body_stops_on_control_tokens_only() {
        let prompt = build_fim_prompt("f.py", "def f():", "\n    pass");
        let body = request_body(&prompt, DEFAULT_N_PREDICT);

        let stop = body.get("stop").and_then(|v| v.as_array()).unwrap();
        assert!(stop.iter().any(|s| s.as_str() == Some(FIM_SUFFIX)));
        assert!(stop.iter().any(|s| s.as_str() == Some(FIM_PREFIX)));
        assert!(stop.iter().any(|s| s.as_str() == Some(FIM_END)));
        // Text stop tokens truncated real completions: a blank line is
        // normal inside a function body, and "]\n" ends any list literal.
        assert!(!stop.iter().any(|s| s.as_str() == Some("\n\n")));
        assert!(!stop.iter().any(|s| s.as_str() == Some("]\n")));
    }

    #[test]
    fn request_body_includes_sampling_params_to_break_repetition_traps() {
        // D4: repeat_penalty (1.1) + top_p (0.95), temperature stays 0.0.
        let prompt = build_fim_prompt("f.py", "def f():", "\n    pass");
        let body = request_body(&prompt, DEFAULT_N_PREDICT);

        assert_eq!(
            body.get("repeat_penalty").and_then(|v| v.as_f64()),
            Some(1.1),
            "repeat_penalty must be 1.1 to break greedy-decoding repetition traps"
        );
        assert_eq!(
            body.get("top_p").and_then(|v| v.as_f64()),
            Some(0.95),
            "top_p must be 0.95 as a second guard against probability concentration"
        );
        assert_eq!(
            body.get("temperature").and_then(|v| v.as_f64()),
            Some(0.0),
            "temperature stays 0.0 for deterministic output"
        );
    }

    #[test]
    fn request_body_honors_a_caller_supplied_n_predict() {
        // Empty suffix (true end-of-file): measured on the bundled 0.8B
        // model, this deterministically produces a runaway hallucinated
        // block that eats the full n_predict budget from the first token.
        // `complete()` requests a smaller budget in that case; verify
        // request_body actually carries it through rather than defaulting.
        let prompt = build_fim_prompt("f.py", "def f():\n    pass\n", "");
        let body = request_body(&prompt, EOF_N_PREDICT);

        assert_eq!(
            body.get("n_predict").and_then(|v| v.as_u64()),
            Some(EOF_N_PREDICT as u64)
        );
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
        let resp = server.complete("test.py", "def ", ":\n    pass").unwrap();

        assert_eq!(resp.completion, "hello");
        assert!((resp.model_latency_ms - 12.34).abs() < 0.001);

        server.terminate();
        assert!(!server.is_alive());
    }

    // Found dogfooding: the suite failed intermittently only while the dev
    // app was running, because its sidecar owns 18080 — the first port this
    // probes. The probe listener is dropped before the number is returned,
    // so two callers in a row are handed the same port and the second child
    // never gets to bind it.
    #[test]
    fn two_callers_are_not_handed_the_same_port() {
        let a = find_free_port().unwrap();
        let b = find_free_port().unwrap();
        assert_ne!(a, b, "a port handed out once must not be offered again");
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
        let resp = server.complete("test.py", "def ", ":\n    pass").unwrap();
        assert_eq!(resp.completion, "hello");
        server.terminate();
    }

    #[test]
    fn completion_server_complete_fails_when_not_spawned() {
        let server = CompletionServer::default();
        let result = server.complete("test.py", "def ", ":\n    pass");
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
    fn clean_completion_preserves_indentation_on_lines_after_first() {
        // D6: indentation on lines 2+ must be preserved, not stripped.
        // The old behavior (trim_start on lines 2+) caused the misaligned
        // multi-line completions in the bug report.
        let input = "from fastmcp.client import Client\n    from fastmcp.client.transports import StdioTransport".to_string();
        let cleaned = clean_completion(input);
        assert_eq!(
            cleaned,
            "from fastmcp.client import Client\n    from fastmcp.client.transports import StdioTransport"
        );
    }

    #[test]
    fn clean_completion_handles_multiline_with_duplicates() {
        // D6: indentation on lines 2+ is preserved; only the duplicate
        // keyword on line 1 is deduplicated.
        let input = "from    from fastmcp.client import Client\n    from fastmcp.client.transports import StdioTransport".to_string();
        let cleaned = clean_completion(input);
        assert_eq!(cleaned, "from fastmcp.client import Client\n    from fastmcp.client.transports import StdioTransport");
    }

    #[test]
    fn clean_completion_handles_multiline_with_duplicates_no_space() {
        // D6: indentation on lines 2+ is preserved; only the duplicate
        // keyword on line 1 is deduplicated.
        let input = "fromfrom fastmcp.client import Client\n    from fastmcp.client.transports import StdioTransport".to_string();
        let cleaned = clean_completion(input);
        assert_eq!(cleaned, "from fastmcp.client import Client\n    from fastmcp.client.transports import StdioTransport");
    }

    #[test]
    fn clean_completion_preserves_normal_completion() {
        // D6: first-line indentation is preserved, not stripped.
        let input = "    total += item['price']\n".to_string();
        let cleaned = clean_completion(input);
        assert_eq!(cleaned, "    total += item['price']\n");
    }

    #[test]
    fn clean_first_line_preserves_leading_whitespace_without_duplicate_keyword() {
        // D6: when no duplicate keyword is found, leading whitespace passes
        // through untouched. The old code collapsed it via
        // split_whitespace().join(" ").
        assert_eq!(
            clean_first_line("    total += item['price']"),
            "    total += item['price']"
        );
        assert_eq!(
            clean_first_line("\treturn x + y"),
            "\treturn x + y"
        );
    }

    #[test]
    fn clean_first_line_preserves_indent_while_deduplicating_keyword() {
        // D6: keyword dedup still works, but leading indentation is preserved.
        let result = clean_first_line("    from    from fastmcp.client import Client");
        assert_eq!(result, "    from fastmcp.client import Client");
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

    // ------------------------------------------------------- thread titles

    /// Small models decorate: quotes, a leading label, a trailing period.
    #[test]
    fn clean_title_strips_what_a_small_model_wraps_a_title_in() {
        assert_eq!(clean_title(" \"Fix login redirect\" "), Some("Fix login redirect".into()));
        assert_eq!(clean_title("Title: add todo priority"), Some("Add todo priority".into()));
        assert_eq!(clean_title("**Fix the parser**"), Some("Fix the parser".into()));
        assert_eq!(clean_title("Fix login redirect."), Some("Fix login redirect".into()));
    }

    /// A model that answered the request instead of naming it has not
    /// produced a title — better to fall back than to show a sentence.
    #[test]
    fn clean_title_rejects_a_sentence_or_an_empty_answer() {
        assert_eq!(clean_title(""), None);
        assert_eq!(clean_title("   \n  "), None);
        assert_eq!(
            clean_title(
                "Sure, I can help you with that — first I would look at the routing config"
            ),
            None
        );
    }

    #[test]
    fn clean_title_takes_only_the_first_line() {
        assert_eq!(clean_title("Fix login redirect\nRequest: something else"), Some("Fix login redirect".into()));
    }

    /// A pasted stack trace must not become the prompt: it is slow to
    /// tokenize and the intent is in the first part anyway.
    #[test]
    fn build_title_prompt_caps_a_long_paste() {
        let prompt = build_title_prompt(&"x".repeat(5000));

        assert!(prompt.len() < 1500, "prompt was {} chars", prompt.len());
        assert!(prompt.ends_with("Title:"));
    }

    #[test]
    fn title_request_stops_at_the_end_of_one_line() {
        let body = title_request_body("add a priority field");
        let stop = body.get("stop").and_then(|v| v.as_array()).unwrap();

        assert!(stop.iter().any(|s| s.as_str() == Some("\n")));
        assert_eq!(body.get("n_predict").and_then(|v| v.as_u64()), Some(16));
    }

    #[test]
    fn version_floor_compares_numerically() {
        assert!(version_at_least("0.2.0", ""));
        assert!(version_at_least("0.2.0", "0.2.0"));
        assert!(version_at_least("0.10.0", "0.9.0"));
        assert!(version_at_least("1.0", "0.9.9"));
        assert!(!version_at_least("0.1.9", "0.2.0"));
    }

    #[test]
    fn install_atomically_never_leaves_a_partial_file() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("model.gguf");

        let failed = install_atomically(&target, |part| {
            std::fs::write(part, b"half a model").unwrap();
            Err("network died".into())
        });

        assert!(failed.is_err());
        assert!(!target.exists(), "a failed install must not publish the file");
        assert!(
            !target.with_extension("part").exists(),
            "the scratch file must be cleaned up"
        );

        install_atomically(&target, |part| {
            std::fs::write(part, b"whole model").map_err(|e| crate::PalisadeError::from(e.to_string()))
        })
        .unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"whole model");
    }

    #[test]
    fn write_verified_rejects_a_checksum_mismatch() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("out.bin");
        // sha256("palisade")
        let good = "a4b7b9f4a0d0bd0e0e3fe0d0b0d3bfa2f4e0c2f1b9d8a7c6e5d4c3b2a1908070";

        let mut bytes = &b"palisade"[..];
        let err = write_verified(&dest, &mut bytes, good, |_| {}).unwrap_err();
        assert!(err.contains("checksum mismatch"), "got: {err}");

        // Round-trip the digest the function itself computes, so the happy
        // path is covered without hardcoding a hash.
        let digest = err.rsplit("got ").next().unwrap().to_string();
        let mut bytes = &b"palisade"[..];
        write_verified(&dest, &mut bytes, &digest, |_| {}).unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"palisade");
    }

    #[test]
    fn write_verified_reports_progress_as_it_streams() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("out.bin");
        let mut seen = Vec::new();
        let mut bytes = &b"abc"[..];
        let _ = write_verified(&dest, &mut bytes, "deadbeef", |done| seen.push(done));
        assert_eq!(seen, vec![3]);
    }

    #[test]
    fn select_model_picks_this_builds_role() {
        let json = r#"{
            "fim": {"filename": "fim.gguf", "sha256": "aa", "url": "https://x/fim", "size": 7, "minAppVersion": "0.2.0"},
            "chat": {"filename": "chat.gguf", "sha256": "bb", "url": "https://x/chat", "size": 9}
        }"#;

        let picked = select_model(json, "fim").unwrap();
        assert_eq!(picked.filename, "fim.gguf");
        assert_eq!(picked.size, 7);
        assert_eq!(picked.min_app_version, "0.2.0");

        // A role this build does not ship must not silently fall back to
        // whatever happens to be first in the map.
        let other = select_model(json, "chat").unwrap();
        assert_eq!(other.filename, "chat.gguf");
        assert_eq!(other.min_app_version, "", "missing floor means no floor");
    }

    #[test]
    fn select_model_reports_a_missing_role_rather_than_guessing() {
        let json = r#"{"chat": {"filename": "c.gguf", "sha256": "bb", "url": "https://x/c"}}"#;
        let err = select_model(json, "fim").unwrap_err();
        assert!(err.contains("fim"), "got: {err}");
        assert!(err.contains("1 roles listed"), "got: {err}");
    }

    // --- Upgrade path: the 0.8B file is orphaned by the model swap (D61). ---
    //
    // A fresh install never exercises this, so it is tested directly. The
    // invariant that matters is the ordering: nothing is deleted until the
    // model we are keeping is actually on disk.

    #[test]
    fn prune_removes_the_orphaned_previous_model() {
        let dir = tempfile::tempdir().unwrap();
        let keep = dir.path().join("Qwen2.5-Coder-0.5B-Q5_K_M.gguf");
        let old = dir.path().join("Qwen3.5-0.8B.Q4_K_M.gguf");
        std::fs::write(&keep, b"new").unwrap();
        std::fs::write(&old, b"old").unwrap();

        prune_stale_models(dir.path(), "Qwen2.5-Coder-0.5B-Q5_K_M.gguf").unwrap();

        assert!(keep.is_file(), "the current model must survive");
        assert!(!old.exists(), "the orphaned model should be gone");
    }

    #[test]
    fn prune_refuses_to_delete_anything_when_the_kept_model_is_absent() {
        // The failure this guards: a download that errors out must not leave
        // the user with no model at all.
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("Qwen3.5-0.8B.Q4_K_M.gguf");
        std::fs::write(&old, b"old").unwrap();

        prune_stale_models(dir.path(), "Qwen2.5-Coder-0.5B-Q5_K_M.gguf").unwrap();

        assert!(old.is_file(), "the old model is the only one left; keep it");
    }

    #[test]
    fn prune_sweeps_abandoned_part_files() {
        let dir = tempfile::tempdir().unwrap();
        let keep = dir.path().join("keep.gguf");
        std::fs::write(&keep, b"new").unwrap();
        let part = dir.path().join("Qwen3.5-0.8B.Q4_K_M.part");
        std::fs::write(&part, b"half").unwrap();

        prune_stale_models(dir.path(), "keep.gguf").unwrap();

        assert!(!part.exists(), "an interrupted download leaves .part behind");
        assert!(keep.is_file());
    }

    #[test]
    fn prune_leaves_files_it_does_not_own_alone() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("keep.gguf"), b"new").unwrap();
        let notes = dir.path().join("README.txt");
        std::fs::write(&notes, b"hi").unwrap();

        prune_stale_models(dir.path(), "keep.gguf").unwrap();

        assert!(notes.is_file(), "only .gguf and .part are ours to delete");
    }

    #[test]
    fn prune_is_a_no_op_on_a_directory_that_does_not_exist() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("never-created");
        assert!(prune_stale_models(&missing, "keep.gguf").is_ok());
    }
}
