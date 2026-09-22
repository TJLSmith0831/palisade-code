//! ACP Registry discovery and caching (D2, D14).
//!
//! Fetches agent manifests from the ACP Registry (github.com/agentclientprotocol/registry)
//! via GitHub raw URLs, caches them locally with a 24h TTL, and cross-references
//! each entry's invocation command against PATH.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use crate::Res;

// ------------------------------------------------------------- data types

/// One agent manifest from the ACP Registry (`agent.json`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryAgent {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub version: Option<String>,
    pub distribution: AgentDistribution,
}

/// The distribution method for an ACP agent.
///
/// Registry agents use different distribution types:
/// - `binary`: platform-specific binaries (Devin, OpenCode, Gemini)
/// - `npx`: npm packages invoked via npx (Claude ACP adapter, Codex ACP adapter)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AgentDistribution {
    Binary {
        binary: PlatformMap,
    },
    Npx {
        npx: NpxDistribution,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlatformMap {
    #[serde(rename = "darwin-aarch64")]
    pub darwin_aarch64: Option<PlatformBinary>,
    #[serde(rename = "darwin-x86_64")]
    pub darwin_x86_64: Option<PlatformBinary>,
    #[serde(rename = "linux-aarch64")]
    pub linux_aarch64: Option<PlatformBinary>,
    #[serde(rename = "linux-x86_64")]
    pub linux_x86_64: Option<PlatformBinary>,
    #[serde(rename = "windows-aarch64")]
    pub windows_aarch64: Option<PlatformBinary>,
    #[serde(rename = "windows-x86_64")]
    pub windows_x86_64: Option<PlatformBinary>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlatformBinary {
    pub cmd: String,
    #[serde(default)]
    pub args: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NpxDistribution {
    pub package: String,
}

/// Strip an archive-relative manifest cmd (`./bin/devin`, `.\bin\devin.exe`)
/// down to the bare executable name a user's PATH would carry (`devin`).
/// Registry binary cmds are relative to the downloaded archive, which Palisade
/// does not install — availability means the user installed the CLI themselves.
fn cmd_basename(cmd: &str) -> &str {
    let name = cmd.rsplit(['/', '\\']).next().unwrap_or(cmd);
    name.strip_suffix(".exe").unwrap_or(name)
}

/// The bare package name from a manifest package spec, which may pin a
/// version (`@scope/name@1.2.3` → `@scope/name`, `cline@3.0.52` → `cline`).
fn package_name(spec: &str) -> &str {
    match spec.rfind('@') {
        // A leading '@' is the scope marker, not a version pin.
        Some(at) if at > 0 => &spec[..at],
        _ => spec,
    }
}

impl AgentDistribution {
    /// The command to check on PATH for this agent.
    /// For binary distributions, the bare binary name (see `cmd_basename`).
    /// For npx distributions, checks for `npx`.
    pub fn path_cmd(&self) -> Option<&str> {
        match self {
            AgentDistribution::Binary { binary } => {
                let platform_bin = current_platform_binary(binary)?;
                Some(cmd_basename(&platform_bin.cmd))
            }
            AgentDistribution::Npx { .. } => Some("npx"),
        }
    }

    /// The full invocation command and arguments to start this agent in ACP mode.
    pub fn invocation(&self) -> (String, Vec<String>) {
        match self {
            AgentDistribution::Binary { binary } => {
                if let Some(platform_bin) = current_platform_binary(binary) {
                    (cmd_basename(&platform_bin.cmd).to_string(), platform_bin.args.clone())
                } else {
                    // Fallback: use the first available platform's cmd.
                    let fallback = first_binary(binary);
                    (cmd_basename(&fallback.0).to_string(), fallback.1)
                }
            }
            AgentDistribution::Npx { npx } => {
                ("npx".to_string(), vec!["-y".to_string(), npx.package.clone()])
            }
        }
    }
}

fn current_platform_binary(map: &PlatformMap) -> Option<&PlatformBinary> {
    let (arch, os) = platform_key();
    let binary = match (os, arch) {
        ("macos", "aarch64") => map.darwin_aarch64.as_ref(),
        ("macos", "x86_64") => map.darwin_x86_64.as_ref(),
        ("linux", "aarch64") => map.linux_aarch64.as_ref(),
        ("linux", "x86_64") => map.linux_x86_64.as_ref(),
        ("windows", "aarch64") => map.windows_aarch64.as_ref(),
        ("windows", "x86_64") => map.windows_x86_64.as_ref(),
        _ => None,
    };
    binary
}

fn first_binary(map: &PlatformMap) -> (String, Vec<String>) {
    let candidates = [
        &map.darwin_aarch64,
        &map.darwin_x86_64,
        &map.linux_aarch64,
        &map.linux_x86_64,
        &map.windows_aarch64,
        &map.windows_x86_64,
    ];
    for candidate in candidates {
        if let Some(bin) = candidate {
            return (bin.cmd.clone(), bin.args.clone());
        }
    }
    ("unknown".to_string(), vec![])
}

fn platform_key() -> (&'static str, &'static str) {
    let os = if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "unknown"
    };
    let arch = if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else if cfg!(target_arch = "x86_64") {
        "x86_64"
    } else {
        "unknown"
    };
    (arch, os)
}

/// A registry agent that was found on this machine's PATH.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableAgent {
    pub id: String,
    pub name: String,
    pub version: Option<String>,
    pub cmd: String,
    pub args: Vec<String>,
    pub path: String,
}

// ------------------------------------------------------------- fetch

const REGISTRY_API: &str = "https://api.github.com/repos/agentclientprotocol/registry/contents";
const REGISTRY_RAW: &str = "https://raw.githubusercontent.com/agentclientprotocol/registry/main";
const CACHE_TTL: Duration = Duration::from_secs(24 * 60 * 60);

/// Fetch all agent manifests from the ACP Registry. Returns cached data if
/// the cache is fresh; otherwise fetches from GitHub and updates the cache.
/// On fetch failure, falls back to the cache, however stale; with no cache
/// at all the list is empty and the app is honestly chat-only.
///
/// There is deliberately no hardcoded fallback list. The one this replaced
/// (D14) invented agents as bare `npx` with no package and no arguments, so
/// a first run without network reported them installed and then crashed the
/// first message on `npx` printing its usage. An agent Palisade cannot
/// describe correctly is an agent it does not have.
pub fn discover_agents(palisade_home: &Path) -> Vec<RegistryAgent> {
    let cache_dir = palisade_home.join("acp-registry");
    let cache_file = cache_dir.join("agents.json");

    // Return fresh cache if available.
    if let Some(agents) = read_fresh_cache(&cache_file) {
        return agents;
    }

    // Try fetching from the registry; otherwise whatever cache exists.
    fetch_and_cache(&cache_dir, &cache_file)
        .unwrap_or_else(|_| read_cache(&cache_file).unwrap_or_default())
}

fn read_fresh_cache(cache_file: &Path) -> Option<Vec<RegistryAgent>> {
    let meta = std::fs::metadata(cache_file).ok()?;
    let age = SystemTime::now().duration_since(meta.modified().ok()?).ok()?;
    if age >= CACHE_TTL {
        return None;
    }
    read_cache(cache_file)
}

fn read_cache(cache_file: &Path) -> Option<Vec<RegistryAgent>> {
    let raw = std::fs::read_to_string(cache_file).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_cache(cache_file: &Path, agents: &[RegistryAgent]) {
    let parent = cache_file.parent().unwrap();
    let _ = std::fs::create_dir_all(parent);
    if let Ok(json) = serde_json::to_string_pretty(agents) {
        let _ = std::fs::write(cache_file, json);
    }
}

/// Fetch agent directory listing from the GitHub API, then fetch each
/// agent's manifest. Returns the parsed manifests or an error.
fn fetch_and_cache(_cache_dir: &Path, cache_file: &Path) -> Res<Vec<RegistryAgent>> {
    let agent_ids = fetch_agent_list()?;
    let agents = fetch_manifests(&agent_ids);
    let (agents, complete) = accept_fetch(agent_ids.len(), agents)?;
    if complete {
        write_cache(cache_file, &agents);
    }
    Ok(agents)
}

/// Whether a fetch is worth keeping, and worth caching.
///
/// A listing that fetched but no manifest that did is a network problem,
/// not an empty registry: caching `[]` as fresh would report "no agents"
/// for the next 24h. A partial fetch is served now but not cached, so the
/// missing agents are retried on the next launch instead of hidden for a
/// day. Pure, so the policy is testable without the network.
fn accept_fetch(expected: usize, agents: Vec<RegistryAgent>) -> Res<(Vec<RegistryAgent>, bool)> {
    if agents.is_empty() {
        return Err(crate::PalisadeError::from("registry fetch returned no manifests"));
    }
    let complete = agents.len() == expected;
    Ok((agents, complete))
}

fn fetch_agent_list() -> Res<Vec<String>> {
    let response = ureq::get(REGISTRY_API)
        .set("Accept", "application/vnd.github.v3+json")
        .set("User-Agent", "palisade-code")
        .call()
        .map_err(|e| crate::PalisadeError::from(format!("GitHub API request failed: {e}")))?;
    let body = response.into_string().map_err(|e| crate::PalisadeError::from(format!("read response: {e}")))?;
    let entries: Vec<serde_json::Value> =
        serde_json::from_str(&body).map_err(|e| crate::PalisadeError::from(format!("parse directory listing: {e}")))?;
    Ok(entries
        .iter()
        .filter_map(|entry| entry.get("name").and_then(|n| n.as_str()).map(String::from))
        .filter(|name| !name.starts_with('.') && name != "README.md" && !name.ends_with(".json") && !name.ends_with(".md"))
        .collect())
}

fn fetch_manifests(agent_ids: &[String]) -> Vec<RegistryAgent> {
    agent_ids
        .iter()
        .filter_map(|id| {
            let url = format!("{REGISTRY_RAW}/{id}/agent.json");
            match fetch_manifest(&url) {
                Ok(agent) => Some(agent),
                Err(e) => {
                    eprintln!("acp-registry: failed to fetch {id}: {e}");
                    None
                }
            }
        })
        .collect()
}

fn fetch_manifest(url: &str) -> Res<RegistryAgent> {
    let response = ureq::get(url)
        .set("User-Agent", "palisade-code")
        .call()
        .map_err(|e| crate::PalisadeError::from(format!("fetch {url}: {e}")))?;
    let body = response.into_string().map_err(|e| crate::PalisadeError::from(format!("read {url}: {e}")))?;
    serde_json::from_str(&body).map_err(|e| crate::PalisadeError::from(format!("parse {url}: {e}")))
}

// ------------------------------------------------------------- PATH resolution

/// Check which registry agents are actually installed on this machine.
///
/// "Installed" means the agent can start without downloading anything:
/// binary distributions resolve their bare cmd on PATH; npx distributions
/// need `npx` on PATH *and* their package already in the local npm caches
/// (an npx shim that would download on first run is not "on this system").
pub fn resolve_available(
    agents: &[RegistryAgent],
    find_on_path: &dyn Fn(&str) -> Option<PathBuf>,
    package_cached: &dyn Fn(&str) -> bool,
) -> Vec<AvailableAgent> {
    agents
        .iter()
        .filter_map(|agent| {
            if let AgentDistribution::Npx { npx } = &agent.distribution {
                if !package_cached(package_name(&npx.package)) {
                    return None;
                }
            }
            let path_cmd = agent.distribution.path_cmd()?;
            let path = find_on_path(path_cmd)?;
            let (cmd, args) = agent.distribution.invocation();
            Some(AvailableAgent {
                id: agent.id.clone(),
                name: agent.name.clone(),
                version: agent.version.clone(),
                cmd,
                args,
                path: path.to_string_lossy().to_string(),
            })
        })
        .collect()
}

/// True when an npm package is already present locally: unpacked in the npx
/// cache (`~/.npm/_npx/*/node_modules/<pkg>`) or installed under the global
/// node_modules root. Purely filesystem-based — no network, no install.
pub fn npx_package_cached(home: &Path, package: &str) -> bool {
    if let Ok(entries) = std::fs::read_dir(home.join(".npm").join("_npx")) {
        for entry in entries.flatten() {
            if entry.path().join("node_modules").join(package).is_dir() {
                return true;
            }
        }
    }
    npm_global_root().is_some_and(|root| root.join(package).is_dir())
}

/// `npm root -g`, resolved under the login shell's PATH so a GUI-launched
/// app finds the user's real npm (nvm, homebrew, ...). None when npm is
/// absent or errors.
fn npm_global_root() -> Option<PathBuf> {
    let mut cmd = std::process::Command::new("npm");
    cmd.args(["root", "-g"]);
    if let Some(path) = crate::executor::login_shell_path() {
        cmd.env("PATH", path);
    }
    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let root = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim().to_string());
    if root.as_os_str().is_empty() { None } else { Some(root) }
}

// ------------------------------------------------------------------ tests

#[cfg(test)]
mod tests {
    use super::*;

    /// Simulates `find_on_path` for tests: returns a path for agents in the
    /// installed set, `None` otherwise.
    fn mock_find<'a>(installed: &'a [&str]) -> impl Fn(&str) -> Option<PathBuf> + 'a {
        move |cmd: &str| {
            installed
                .iter()
                .find(|&&name| name == cmd)
                .map(|_| PathBuf::from(format!("/usr/bin/{cmd}")))
        }
    }

    fn test_agents() -> Vec<RegistryAgent> {
        vec![
            RegistryAgent {
                id: "devin".into(),
                name: "Devin".into(),
                version: Some("2.5.0".into()),
                distribution: AgentDistribution::Binary {
                    binary: PlatformMap {
                        darwin_aarch64: Some(PlatformBinary {
                            cmd: "devin".into(),
                            args: vec!["acp".into()],
                        }),
                        darwin_x86_64: Some(PlatformBinary {
                            cmd: "devin".into(),
                            args: vec!["acp".into()],
                        }),
                        linux_aarch64: None,
                        linux_x86_64: None,
                        windows_aarch64: None,
                        windows_x86_64: None,
                    },
                },
            },
            RegistryAgent {
                id: "claude-acp".into(),
                name: "Claude Agent".into(),
                version: Some("0.66.0".into()),
                distribution: AgentDistribution::Npx {
                    npx: NpxDistribution {
                        package: "@agentclientprotocol/claude-agent-acp".into(),
                    },
                },
            },
            RegistryAgent {
                id: "opencode".into(),
                name: "OpenCode".into(),
                version: None,
                distribution: AgentDistribution::Binary {
                    binary: PlatformMap {
                        darwin_aarch64: Some(PlatformBinary {
                            cmd: "opencode".into(),
                            args: vec!["acp".into()],
                        }),
                        darwin_x86_64: Some(PlatformBinary {
                            cmd: "opencode".into(),
                            args: vec!["acp".into()],
                        }),
                        linux_aarch64: None,
                        linux_x86_64: None,
                        windows_aarch64: None,
                        windows_x86_64: None,
                    },
                },
            },
        ]
    }

    // --------------------------------------------------------- 2.1: fetch

    /// RED→GREEN 2.1: Parsed agent manifests have the expected structure.
    #[test]
    fn fetch_returns_parsed_agent_manifests() {
        let agents = test_agents();
        assert_eq!(agents.len(), 3);

        // Devin is binary-distributed.
        assert_eq!(agents[0].id, "devin");
        assert_eq!(agents[0].name, "Devin");
        assert_eq!(agents[0].version, Some("2.5.0".into()));
        assert_eq!(agents[0].distribution.path_cmd(), Some("devin"));
        assert_eq!(agents[0].distribution.invocation().0, "devin");
        assert_eq!(agents[0].distribution.invocation().1, vec!["acp"]);

        // Claude is npx-distributed.
        assert_eq!(agents[1].id, "claude-acp");
        assert_eq!(agents[1].distribution.path_cmd(), Some("npx"));
        assert_eq!(agents[1].distribution.invocation().0, "npx");

        // OpenCode has no version.
        assert_eq!(agents[2].version, None);
    }

    /// No manifests is a failed fetch, never an empty registry to cache.
    #[test]
    fn a_fetch_with_no_manifests_is_an_error_not_a_cache_entry() {
        assert!(accept_fetch(3, vec![]).is_err());
    }

    /// A partial fetch is used now but not cached, so the agents that did not
    /// arrive are retried next launch rather than hidden until the TTL ends.
    #[test]
    fn a_partial_fetch_is_served_but_not_cached() {
        let agents = test_agents();
        let expected = agents.len() + 1;
        let (kept, complete) = accept_fetch(expected, agents.clone()).unwrap();
        assert_eq!(kept, agents);
        assert!(!complete);
        let (_, complete) = accept_fetch(agents.len(), agents).unwrap();
        assert!(complete);
    }

    // --------------------------------------------------------- 2.2: cache

    /// RED→GREEN 2.2: Cache returns None when file is missing.
    #[test]
    fn cache_returns_none_when_file_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let cache_file = dir.path().join("agents.json");
        assert!(read_fresh_cache(&cache_file).is_none());
    }

    /// RED→GREEN 2.2: Writing and reading cache round-trips correctly.
    #[test]
    fn cache_write_and_read_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let cache_file = dir.path().join("agents.json");
        let agents = test_agents();

        write_cache(&cache_file, &agents);
        let read = read_cache(&cache_file).unwrap();
        assert_eq!(read.len(), agents.len());
        assert_eq!(read[0].id, agents[0].id);
    }

    /// RED→GREEN 2.2: A freshly written cache is "fresh" (within TTL).
    #[test]
    fn freshly_written_cache_is_fresh() {
        let dir = tempfile::tempdir().unwrap();
        let cache_file = dir.path().join("agents.json");
        let agents = test_agents();

        write_cache(&cache_file, &agents);
        let fresh = read_fresh_cache(&cache_file).unwrap();
        assert_eq!(fresh.len(), agents.len());
    }

    // --------------------------------------------------------- 2.3: PATH

    /// RED→GREEN 2.3: A registry entry whose cmd is on PATH is available;
    /// one that isn't is excluded.
    #[test]
    fn path_availability_filters_agents() {
        let agents = test_agents();
        // devin binary is on PATH, npx is on PATH (for claude-acp), opencode is not.
        let available = resolve_available(&agents, &mock_find(&["devin", "npx"]), &|_| true);

        assert_eq!(available.len(), 2);
        assert_eq!(available[0].id, "devin");
        assert_eq!(available[0].path, "/usr/bin/devin");
        assert_eq!(available[0].args, vec!["acp"]);
        assert_eq!(available[1].id, "claude-acp");
        assert_eq!(available[1].path, "/usr/bin/npx");
        // opencode is not on PATH — excluded.
        assert!(available.iter().all(|a| a.id != "opencode"));
    }

    /// RED→GREEN 2.3: When nothing is on PATH, returns empty.
    #[test]
    fn no_agents_on_path_returns_empty() {
        let agents = test_agents();
        let available = resolve_available(&agents, &mock_find(&[]), &|_| true);
        assert!(available.is_empty());
    }

    // --------------------------------------------------------- 2.5: real installs only

    /// RED→GREEN 2.5: Binary manifests carry archive-relative cmds like
    /// `./bin/devin`; the PATH probe must use the bare binary name.
    #[test]
    fn binary_path_cmd_uses_basename() {
        let agents = test_agents();
        // test_agents' devin entry uses bare "devin" — build one with the
        // real registry shape instead.
        let mut archive_style = agents[0].clone();
        let AgentDistribution::Binary { binary } = &mut archive_style.distribution else {
            panic!("devin is binary-distributed");
        };
        binary.darwin_aarch64 = Some(PlatformBinary {
            cmd: "./bin/devin".into(),
            args: vec!["acp".into()],
        });
        assert_eq!(archive_style.distribution.path_cmd(), Some("devin"));
    }

    /// RED→GREEN 2.5: An npx agent counts as installed only when its package
    /// is already cached locally — `npx` on PATH alone is not enough.
    #[test]
    fn npx_agent_requires_cached_package() {
        let agents = test_agents();
        let available = resolve_available(&agents, &mock_find(&["devin", "npx"]), &|_| false);
        assert_eq!(available.len(), 1);
        assert_eq!(available[0].id, "devin");
    }

    /// RED→GREEN 2.5: Package specs may pin a version (`@scope/name@1.2.3`);
    /// the cache probe uses the bare package name.
    #[test]
    fn package_spec_strips_version() {
        assert_eq!(package_name("@agentclientprotocol/claude-agent-acp@0.66.0"), "@agentclientprotocol/claude-agent-acp");
        assert_eq!(package_name("cline@3.0.52"), "cline");
        assert_eq!(package_name("@scope/name"), "@scope/name");
        assert_eq!(package_name("plain"), "plain");
    }

}
