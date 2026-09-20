//! Per-agent plan usage (5h / week / month windows).
//!
//! One provider per agent family, each failing soft: a missing credential is
//! `not_signed_in`, anything else (`network`, `parse`, unknown agent) is
//! `unavailable` with a one-line reason. Nothing here ever logs a token.
//!
//! Results are cached 60s per agent id so a status bar can poll freely.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;

// ------------------------------------------------------------------ types

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    /// "5h" | "Week" | "Month"
    pub label: String,
    pub used_percent: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct UsageSnapshot {
    pub plan: Option<String>,
    pub windows: Vec<UsageWindow>,
    pub balance_usd: Option<f64>,
    /// Where the numbers came from, for the UI to show provenance.
    pub source: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum UsageError {
    NotSignedIn(String),
    Unavailable(String),
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum AgentUsage {
    #[serde(rename_all = "camelCase")]
    Ok {
        agent_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        plan: Option<String>,
        windows: Vec<UsageWindow>,
        #[serde(skip_serializing_if = "Option::is_none")]
        balance_usd: Option<f64>,
        fetched_at: String,
        source: String,
    },
    #[serde(rename_all = "camelCase")]
    NotSignedIn { agent_id: String, reason: String },
    #[serde(rename_all = "camelCase")]
    Unavailable { agent_id: String, reason: String },
}

pub trait UsageProvider {
    /// The agent family this provider speaks for. Part of the trait contract;
    /// dispatch goes through `provider_for`, so nothing in-tree calls it yet.
    #[allow(dead_code)]
    fn agent_id(&self) -> &str;
    fn fetch(&self) -> Result<UsageSnapshot, UsageError>;
}

// ------------------------------------------------------------------ entry

const CACHE_TTL: Duration = Duration::from_secs(60);

fn cache() -> &'static Mutex<HashMap<String, (Instant, AgentUsage)>> {
    static CACHE: OnceLock<Mutex<HashMap<String, (Instant, AgentUsage)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Usage for every agent id given (the preflight's installed agents).
/// Blocking — callers run it off the UI thread.
pub fn usage_for(agent_ids: &[String]) -> Vec<AgentUsage> {
    agent_ids.iter().map(|id| usage_one(id)).collect()
}

fn usage_one(agent_id: &str) -> AgentUsage {
    if let Ok(c) = cache().lock() {
        if let Some((at, hit)) = c.get(agent_id) {
            if at.elapsed() < CACHE_TTL {
                return hit.clone();
            }
        }
    }
    let result = match provider_for(agent_id) {
        Some(p) => to_usage(agent_id, p.fetch()),
        None => AgentUsage::Unavailable {
            agent_id: agent_id.to_string(),
            reason: "This agent does not expose plan usage".into(),
        },
    };
    if let Ok(mut c) = cache().lock() {
        c.insert(agent_id.to_string(), (Instant::now(), result.clone()));
    }
    result
}

fn to_usage(agent_id: &str, r: Result<UsageSnapshot, UsageError>) -> AgentUsage {
    match r {
        Ok(s) => AgentUsage::Ok {
            agent_id: agent_id.to_string(),
            plan: s.plan,
            windows: s.windows,
            balance_usd: s.balance_usd,
            fetched_at: chrono::Utc::now().to_rfc3339(),
            source: s.source,
        },
        Err(UsageError::NotSignedIn(reason)) => AgentUsage::NotSignedIn { agent_id: agent_id.to_string(), reason },
        Err(UsageError::Unavailable(reason)) => AgentUsage::Unavailable { agent_id: agent_id.to_string(), reason },
    }
}

/// Registry agent ids are not fixed strings (`claude-code`, `claude-acp`, …),
/// so match the family rather than an exact id.
fn provider_for(agent_id: &str) -> Option<Box<dyn UsageProvider>> {
    let id = agent_id.to_ascii_lowercase();
    if id.contains("claude") {
        Some(Box::new(ClaudeProvider))
    } else if id.contains("codex") {
        Some(Box::new(CodexProvider))
    } else if id.contains("opencode") {
        Some(Box::new(OpenCodeProvider))
    } else {
        None
    }
}

// ------------------------------------------------------------------ claude

/// Undocumented OAuth usage endpoint, the same one the open-source usage
/// monitors call.
const CLAUDE_USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_BETA_HEADER: &str = "oauth-2025-04-20";

// ponytail: undocumented endpoint, may drift; fails soft
struct ClaudeProvider;

impl UsageProvider for ClaudeProvider {
    fn agent_id(&self) -> &str {
        "claude"
    }

    fn fetch(&self) -> Result<UsageSnapshot, UsageError> {
        let creds = claude_credentials()?;
        let (token, plan) = parse_claude_credentials(&creds)?;
        let body = ureq::get(CLAUDE_USAGE_URL)
            .set("Authorization", &format!("Bearer {token}"))
            .set("anthropic-beta", CLAUDE_BETA_HEADER)
            .set("User-Agent", "palisade-code")
            .call()
            .map_err(|e| UsageError::Unavailable(format!("usage request failed: {}", scrub(&e.to_string()))))?
            .into_string()
            .map_err(|e| UsageError::Unavailable(format!("read usage response: {e}")))?;
        let mut snap = parse_claude_usage(&body)?;
        snap.plan = snap.plan.or(plan);
        Ok(snap)
    }
}

/// The raw credentials blob: Keychain on macOS, `~/.claude/.credentials.json`
/// elsewhere (and as a fallback). Never logged.
fn claude_credentials() -> Result<String, UsageError> {
    if cfg!(target_os = "macos") {
        let out = Command::new("security")
            .args(["find-generic-password", "-s", "Claude Code-credentials", "-w"])
            .output();
        if let Ok(out) = out {
            if out.status.success() {
                let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !s.is_empty() {
                    return Ok(s);
                }
            }
        }
    }
    let file = crate::executor::home().join(".claude").join(".credentials.json");
    std::fs::read_to_string(&file)
        .map_err(|_| UsageError::NotSignedIn("No Claude Code credentials found — sign in with `claude`".into()))
}

/// Returns (access token, subscription plan). The token is returned, never logged.
fn parse_claude_credentials(raw: &str) -> Result<(String, Option<String>), UsageError> {
    let v: Value = serde_json::from_str(raw)
        .map_err(|_| UsageError::Unavailable("credentials are not valid JSON".into()))?;
    let oauth = v.get("claudeAiOauth").unwrap_or(&v);
    let token = oauth
        .get("accessToken")
        .and_then(Value::as_str)
        .ok_or_else(|| UsageError::NotSignedIn("Claude Code credentials have no access token".into()))?;
    let plan = oauth.get("subscriptionType").and_then(Value::as_str).map(String::from);
    Ok((token.to_string(), plan))
}

fn parse_claude_usage(body: &str) -> Result<UsageSnapshot, UsageError> {
    let v: Value = serde_json::from_str(body)
        .map_err(|_| UsageError::Unavailable("usage response is not valid JSON".into()))?;
    let mut windows = vec![];
    for (keys, label) in [
        (["five_hour", "fiveHour"], "5h"),
        (["seven_day", "sevenDay"], "Week"),
        (["thirty_day", "thirtyDay"], "Month"),
    ] {
        let Some(w) = keys.iter().find_map(|k| v.get(k)) else { continue };
        let Some(pct) = ["utilization", "used_percent", "usedPercent"].iter().find_map(|k| w.get(k).and_then(Value::as_f64))
        else {
            continue;
        };
        windows.push(UsageWindow {
            label: label.into(),
            used_percent: pct,
            resets_at: ["resets_at", "resetsAt"].iter().find_map(|k| w.get(k).and_then(Value::as_str)).map(String::from),
        });
    }
    if windows.is_empty() {
        return Err(UsageError::Unavailable("usage response had no known windows".into()));
    }
    Ok(UsageSnapshot {
        plan: v.get("subscription_type").and_then(Value::as_str).map(String::from),
        windows,
        balance_usd: None,
        source: CLAUDE_USAGE_URL.into(),
    })
}

// ------------------------------------------------------------------ codex

/// Codex has no usage endpoint: `rate_limits` only rides along on turn events,
/// so read the last one the newest rollout log recorded. No network.
struct CodexProvider;

impl UsageProvider for CodexProvider {
    fn agent_id(&self) -> &str {
        "codex"
    }

    fn fetch(&self) -> Result<UsageSnapshot, UsageError> {
        let sessions = crate::executor::home().join(".codex").join("sessions");
        let newest = newest_rollout(&sessions)
            .ok_or_else(|| UsageError::NotSignedIn("No Codex sessions yet — run a Codex turn first".into()))?;
        let text = std::fs::read_to_string(&newest)
            .map_err(|e| UsageError::Unavailable(format!("read rollout log: {e}")))?;
        parse_codex_rollout(&text)
    }
}

fn newest_rollout(root: &PathBuf) -> Option<PathBuf> {
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    let mut stack = vec![root.clone()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if !(name.starts_with("rollout-") && name.ends_with(".jsonl")) {
                continue;
            }
            let Ok(modified) = entry.metadata().and_then(|m| m.modified()) else { continue };
            if best.as_ref().is_none_or(|(t, _)| modified > *t) {
                best = Some((modified, path));
            }
        }
    }
    best.map(|(_, p)| p)
}

/// Last line carrying a populated `rate_limits` object wins — later turns
/// often report `rate_limits: null`.
fn parse_codex_rollout(text: &str) -> Result<UsageSnapshot, UsageError> {
    let limits = text
        .lines()
        .rev()
        .filter(|l| l.contains("rate_limits"))
        .find_map(|l| {
            serde_json::from_str::<Value>(l)
                .ok()
                .and_then(|v| find_key(&v, "rate_limits").filter(|r| r.is_object()).cloned())
        })
        .ok_or_else(|| UsageError::Unavailable("No rate limits in the newest Codex rollout log".into()))?;

    let mut windows = vec![];
    for key in ["primary", "secondary"] {
        let Some(w) = limits.get(key) else { continue };
        let Some(pct) = w.get("used_percent").and_then(Value::as_f64) else { continue };
        let minutes = w.get("window_minutes").and_then(Value::as_u64).unwrap_or(0);
        let label = match minutes {
            0..=600 => "5h",
            601..=20160 => "Week",
            _ => "Month",
        };
        let resets_at = w
            .get("resets_in_seconds")
            .and_then(Value::as_i64)
            .map(|secs| (chrono::Utc::now() + chrono::Duration::seconds(secs)).to_rfc3339());
        windows.push(UsageWindow { label: label.into(), used_percent: pct, resets_at });
    }
    if windows.is_empty() {
        return Err(UsageError::Unavailable("Codex rate limits had no usable windows".into()));
    }
    Ok(UsageSnapshot {
        plan: limits.get("plan_type").and_then(Value::as_str).map(String::from),
        windows,
        balance_usd: None,
        source: "~/.codex/sessions rollout log".into(),
    })
}

fn find_key<'a>(v: &'a Value, key: &str) -> Option<&'a Value> {
    match v {
        Value::Object(map) => {
            if let Some(found) = map.get(key) {
                return Some(found);
            }
            map.values().find_map(|child| find_key(child, key))
        }
        Value::Array(items) => items.iter().find_map(|child| find_key(child, key)),
        _ => None,
    }
}

// ---------------------------------------------------------------- opencode

const OPENCODE_USAGE_URL: &str = "https://opencode.ai/zen/go/v1/usage";

struct OpenCodeProvider;

impl UsageProvider for OpenCodeProvider {
    fn agent_id(&self) -> &str {
        "opencode"
    }

    fn fetch(&self) -> Result<UsageSnapshot, UsageError> {
        let home = crate::executor::home();
        let raw = [
            home.join(".local/share/opencode/auth.json"),
            home.join(".config/opencode/auth.json"),
        ]
        .iter()
        .find_map(|p| std::fs::read_to_string(p).ok())
        .ok_or_else(|| UsageError::NotSignedIn("No OpenCode credentials found — run `opencode auth login`".into()))?;
        let token = parse_opencode_auth(&raw)?;
        let body = ureq::get(OPENCODE_USAGE_URL)
            .set("Authorization", &format!("Bearer {token}"))
            .set("User-Agent", "palisade-code")
            .call()
            .map_err(|e| UsageError::Unavailable(format!("usage request failed: {}", scrub(&e.to_string()))))?
            .into_string()
            .map_err(|e| UsageError::Unavailable(format!("read usage response: {e}")))?;
        parse_opencode_usage(&body)
    }
}

/// The auth file nests one entry per provider; take the OpenCode one's key.
fn parse_opencode_auth(raw: &str) -> Result<String, UsageError> {
    let v: Value = serde_json::from_str(raw)
        .map_err(|_| UsageError::Unavailable("OpenCode auth file is not valid JSON".into()))?;
    let entry = v.get("opencode").unwrap_or(&v);
    ["key", "access", "apiKey", "token"]
        .iter()
        .find_map(|k| find_key(entry, k).and_then(Value::as_str))
        .map(String::from)
        .ok_or_else(|| UsageError::NotSignedIn("OpenCode auth file has no API key".into()))
}

// ponytail: response shape is only loosely documented; tolerant key matching, fails soft
fn parse_opencode_usage(body: &str) -> Result<UsageSnapshot, UsageError> {
    let v: Value = serde_json::from_str(body)
        .map_err(|_| UsageError::Unavailable("usage response is not valid JSON".into()))?;
    let mut windows = vec![];
    for (keys, label) in [
        (["five_hour", "fiveHour", "5h"], "5h"),
        (["week", "weekly", "seven_day"], "Week"),
        (["month", "monthly", "thirty_day"], "Month"),
    ] {
        let Some(w) = keys.iter().find_map(|k| find_key(&v, k)) else { continue };
        let Some(pct) = ["used_percent", "usedPercent", "utilization", "percent"]
            .iter()
            .find_map(|k| w.get(k).and_then(Value::as_f64))
        else {
            continue;
        };
        windows.push(UsageWindow {
            label: label.into(),
            used_percent: pct,
            resets_at: ["resets_at", "resetsAt"].iter().find_map(|k| w.get(k).and_then(Value::as_str)).map(String::from),
        });
    }
    if windows.is_empty() {
        return Err(UsageError::Unavailable("usage response had no known windows".into()));
    }
    Ok(UsageSnapshot {
        plan: find_key(&v, "plan").and_then(Value::as_str).map(String::from),
        windows,
        // Pay-as-you-go accounts carry no balance; only report one if present.
        balance_usd: ["balance_usd", "balanceUsd", "balance"].iter().find_map(|k| find_key(&v, k).and_then(Value::as_f64)),
        source: OPENCODE_USAGE_URL.into(),
    })
}

/// Belt and braces: a transport error string must never carry a token.
fn scrub(msg: &str) -> String {
    msg.split_whitespace()
        .map(|w| if w.len() > 40 { "…" } else { w })
        .collect::<Vec<_>>()
        .join(" ")
}

// ------------------------------------------------------------------ tests

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_rollout_last_populated_rate_limits_wins() {
        let text = concat!(
            r#"{"type":"event","payload":{"rate_limits":{"primary":{"used_percent":11.0,"window_minutes":300,"resets_in_seconds":60}}}}"#,
            "\n",
            r#"{"type":"event","payload":{"rate_limits":{"primary":{"used_percent":42.5,"window_minutes":300,"resets_in_seconds":3600},"secondary":{"used_percent":7.25,"window_minutes":10080,"resets_in_seconds":100}}}}"#,
            "\n",
            r#"{"type":"event","payload":{"rate_limits":null}}"#,
            "\n",
        );
        let snap = parse_codex_rollout(text).unwrap();
        assert_eq!(snap.windows.len(), 2);
        assert_eq!(snap.windows[0].label, "5h");
        assert_eq!(snap.windows[0].used_percent, 42.5);
        assert_eq!(snap.windows[1].label, "Week");
        assert!(snap.windows[0].resets_at.is_some());
    }

    #[test]
    fn codex_rollout_without_rate_limits_is_unavailable() {
        let err = parse_codex_rollout("{\"type\":\"message\"}\n").unwrap_err();
        assert!(matches!(err, UsageError::Unavailable(_)));
    }

    #[test]
    fn claude_usage_body_maps_windows() {
        let body = r#"{"five_hour":{"utilization":33,"resets_at":"2026-09-18T12:00:00Z"},
                       "seven_day":{"utilization":8.5,"resets_at":"2026-09-24T12:00:00Z"},
                       "subscription_type":"max"}"#;
        let snap = parse_claude_usage(body).unwrap();
        assert_eq!(snap.windows.len(), 2);
        assert_eq!(snap.windows[0].label, "5h");
        assert_eq!(snap.windows[0].used_percent, 33.0);
        assert_eq!(snap.windows[1].resets_at.as_deref(), Some("2026-09-24T12:00:00Z"));
        assert_eq!(snap.plan.as_deref(), Some("max"));
    }

    #[test]
    fn claude_credentials_yield_token_and_plan() {
        let raw = r#"{"claudeAiOauth":{"accessToken":"tok","subscriptionType":"pro"}}"#;
        let (token, plan) = parse_claude_credentials(raw).unwrap();
        assert_eq!(token, "tok");
        assert_eq!(plan.as_deref(), Some("pro"));
    }

    #[test]
    fn claude_credentials_without_token_are_not_signed_in() {
        let err = parse_claude_credentials(r#"{"claudeAiOauth":{}}"#).unwrap_err();
        assert!(matches!(err, UsageError::NotSignedIn(_)));
    }

    #[test]
    fn opencode_usage_body_maps_windows_and_balance() {
        let body = r#"{"plan":"go","five_hour":{"used_percent":12},
                       "week":{"used_percent":40,"resets_at":"2026-09-25T00:00:00Z"},
                       "month":{"used_percent":55},"balance_usd":4.5}"#;
        let snap = parse_opencode_usage(body).unwrap();
        assert_eq!(snap.windows.len(), 3);
        assert_eq!(snap.windows[2].label, "Month");
        assert_eq!(snap.balance_usd, Some(4.5));
        assert_eq!(snap.plan.as_deref(), Some("go"));
    }

    #[test]
    fn opencode_usage_without_balance_reports_none() {
        let snap = parse_opencode_usage(r#"{"five_hour":{"used_percent":1}}"#).unwrap();
        assert_eq!(snap.balance_usd, None);
        assert_eq!(snap.windows.len(), 1);
    }

    #[test]
    fn unknown_agent_has_no_provider() {
        assert!(provider_for("gemini").is_none());
        assert_eq!(provider_for("claude-acp").map(|p| p.agent_id().to_string()), Some("claude".into()));
        assert_eq!(provider_for("codex-acp").map(|p| p.agent_id().to_string()), Some("codex".into()));
    }

    #[test]
    fn serializes_to_the_frontend_contract() {
        let ok = AgentUsage::Ok {
            agent_id: "claude-acp".into(),
            plan: None,
            windows: vec![UsageWindow { label: "5h".into(), used_percent: 10.0, resets_at: None }],
            balance_usd: None,
            fetched_at: "now".into(),
            source: "s".into(),
        };
        let json = serde_json::to_value(&ok).unwrap();
        assert_eq!(json["state"], "ok");
        assert_eq!(json["agentId"], "claude-acp");
        assert_eq!(json["windows"][0]["usedPercent"], 10.0);
        assert!(json.get("plan").is_none());

        let no = AgentUsage::NotSignedIn { agent_id: "x".into(), reason: "r".into() };
        assert_eq!(serde_json::to_value(&no).unwrap()["state"], "not_signed_in");
    }
}
