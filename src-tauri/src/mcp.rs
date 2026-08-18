//! MCP server configuration for the active project.
//!
//! `.mcp.json` in the project root is the store: portable, git-shareable, and
//! readable by `claude` run straight from a terminal. Palisade additionally
//! hands the same servers to whatever agent it starts, via `session/new`'s
//! `mcpServers` — `.mcp.json` is a Claude-shaped file, and passing the list
//! over ACP is what makes it reach Codex and every other agent without
//! Palisade learning a second config format per agent.
//!
//! Only Palisade-managed keys are ever rewritten; anything else already in the
//! file is preserved, the same contract `integrations.rs` keeps for `graphify`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use agent_client_protocol::schema::v1;
use serde::{Deserialize, Serialize};

/// Disabled servers are parked under this top-level key rather than flagged
/// in place. A `"disabled": true` field inside `mcpServers` is a convention
/// some clients honour and others ignore — an agent that ignores it would
/// load a server the UI shows as off, which makes the toggle a lie. Moving
/// the entry out of `mcpServers` is true for every reader of the file.
const DISABLED_KEY: &str = "disabledMcpServers";
const SERVERS_KEY: &str = "mcpServers";

/// One configured MCP server, in the shape the UI and `.mcp.json` share.
///
/// Stdio and HTTP/SSE servers differ only in which fields are populated:
/// `command` for stdio, `url` for the rest. That keeps one type across the
/// IPC boundary instead of a tagged union the frontend must narrow.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    pub name: String,
    /// `"stdio"`, `"http"`, or `"sse"`.
    pub transport: String,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// Sorted so a rewrite of an untouched server produces no diff.
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default)]
    pub enabled: bool,
}

fn config_path(project_root: &Path) -> PathBuf {
    project_root.join(".mcp.json")
}

fn read_doc(project_root: &Path) -> serde_json::Value {
    std::fs::read_to_string(config_path(project_root))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .filter(serde_json::Value::is_object)
        .unwrap_or_else(|| serde_json::json!({}))
}

fn string_map(value: Option<&serde_json::Value>) -> BTreeMap<String, String> {
    value
        .and_then(serde_json::Value::as_object)
        .map(|map| {
            map.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect()
        })
        .unwrap_or_default()
}

fn parse_entry(name: &str, entry: &serde_json::Value, enabled: bool) -> McpServer {
    let url = entry.get("url").and_then(|v| v.as_str()).unwrap_or("");
    // The file names the transport for remote servers; a plain command entry
    // is stdio, which is the transport every ACP agent must support.
    let transport = entry
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or(if url.is_empty() { "stdio" } else { "http" });
    McpServer {
        name: name.to_string(),
        transport: transport.to_string(),
        command: entry
            .get("command")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        args: entry
            .get("args")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default(),
        env: string_map(entry.get("env")),
        url: url.to_string(),
        headers: string_map(entry.get("headers")),
        enabled,
    }
}

fn to_entry(server: &McpServer) -> serde_json::Value {
    let mut entry = serde_json::Map::new();
    if server.transport == "stdio" {
        entry.insert("command".into(), server.command.clone().into());
        if !server.args.is_empty() {
            entry.insert("args".into(), server.args.clone().into());
        }
        if !server.env.is_empty() {
            entry.insert("env".into(), serde_json::json!(server.env));
        }
    } else {
        entry.insert("type".into(), server.transport.clone().into());
        entry.insert("url".into(), server.url.clone().into());
        if !server.headers.is_empty() {
            entry.insert("headers".into(), serde_json::json!(server.headers));
        }
    }
    serde_json::Value::Object(entry)
}

/// Every configured server, enabled first, each group alphabetical. A missing
/// or unparseable `.mcp.json` reads as "none configured" rather than an error:
/// the pane's job is to let the user fix the file, not to refuse to open.
pub fn list(project_root: &Path) -> Vec<McpServer> {
    let doc = read_doc(project_root);
    let mut servers: Vec<McpServer> = [(SERVERS_KEY, true), (DISABLED_KEY, false)]
        .iter()
        .flat_map(|(key, enabled)| {
            doc.get(*key)
                .and_then(serde_json::Value::as_object)
                .map(|map| {
                    map.iter()
                        .map(|(name, entry)| parse_entry(name, entry, *enabled))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default()
        })
        .collect();
    // A name can appear in both maps: `integrations.rs` re-adds `graphify` to
    // `mcpServers` on every project load, so disabling it leaves a stale copy
    // under the disabled key. Group by name so the duplicates are adjacent,
    // enabled first, and keep the copy the agent will actually start.
    servers.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| b.enabled.cmp(&a.enabled)));
    servers.dedup_by(|a, b| a.name == b.name);
    // Then the display order: enabled first, alphabetical within each group.
    servers.sort_by(|a, b| b.enabled.cmp(&a.enabled).then_with(|| a.name.cmp(&b.name)));
    servers
}

fn write_doc(project_root: &Path, doc: &serde_json::Value) -> Result<(), String> {
    let text = serde_json::to_string_pretty(doc).map_err(|e| e.to_string())?;
    std::fs::write(config_path(project_root), format!("{text}\n")).map_err(|e| e.to_string())
}

/// Remove `name` from both the enabled and disabled maps, and prune either
/// map if it is now empty — so removing the last server leaves a clean file
/// rather than a litter of empty objects.
fn detach(doc: &mut serde_json::Value, name: &str) {
    for key in [SERVERS_KEY, DISABLED_KEY] {
        let now_empty = match doc.get_mut(key).and_then(serde_json::Value::as_object_mut) {
            Some(map) => {
                map.remove(name);
                map.is_empty()
            }
            None => false,
        };
        if now_empty {
            if let Some(map) = doc.as_object_mut() {
                map.remove(key);
            }
        }
    }
}

/// Add or replace a server. Upsert by name, which is the key `.mcp.json`
/// itself uses — installing the same registry entry twice updates it rather
/// than producing a duplicate.
pub fn save(project_root: &Path, server: &McpServer) -> Result<(), String> {
    if server.name.trim().is_empty() {
        return Err("an MCP server needs a name".into());
    }
    let mut doc = read_doc(project_root);
    detach(&mut doc, &server.name);
    let key = if server.enabled { SERVERS_KEY } else { DISABLED_KEY };
    doc.as_object_mut()
        .ok_or("`.mcp.json` root is not an object")?
        .entry(key)
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or_else(|| format!("`.mcp.json`'s `{key}` is not an object"))?
        .insert(server.name.clone(), to_entry(server));
    write_doc(project_root, &doc)
}

/// Delete a server outright.
pub fn remove(project_root: &Path, name: &str) -> Result<(), String> {
    let mut doc = read_doc(project_root);
    detach(&mut doc, name);
    write_doc(project_root, &doc)
}

/// Flip a server between the enabled and disabled maps, carrying its config
/// across unchanged. A no-op if the server isn't configured.
pub fn set_enabled(project_root: &Path, name: &str, enabled: bool) -> Result<(), String> {
    let Some(mut server) = list(project_root).into_iter().find(|s| s.name == name) else {
        return Ok(());
    };
    server.enabled = enabled;
    save(project_root, &server)
}

/// The enabled servers, in the shape `session/new` wants.
///
/// Stdio is the only transport every ACP agent must support; http and sse are
/// gated on the agent's advertised `mcpCapabilities`, so those are filtered by
/// what this agent said it can do rather than sent blindly.
pub fn for_session(
    project_root: &Path,
    http: bool,
    sse: bool,
) -> Vec<v1::McpServer> {
    fn headers(map: BTreeMap<String, String>) -> Vec<v1::HttpHeader> {
        map.into_iter()
            .map(|(name, value)| v1::HttpHeader::new(name, value))
            .collect()
    }

    list(project_root)
        .into_iter()
        .filter(|s| s.enabled)
        .filter_map(|s| match s.transport.as_str() {
            "stdio" => Some(v1::McpServer::Stdio(
                v1::McpServerStdio::new(s.name, PathBuf::from(s.command))
                    .args(s.args)
                    .env(
                        s.env
                            .into_iter()
                            .map(|(name, value)| v1::EnvVariable::new(name, value))
                            .collect::<Vec<_>>(),
                    ),
            )),
            "http" if http => Some(v1::McpServer::Http(
                v1::McpServerHttp::new(s.name, s.url).headers(headers(s.headers)),
            )),
            "sse" if sse => Some(v1::McpServer::Sse(
                v1::McpServerSse::new(s.name, s.url).headers(headers(s.headers)),
            )),
            _ => None,
        })
        .collect()
}

// ------------------------------------------------------------ registry

const REGISTRY_API: &str = "https://registry.modelcontextprotocol.io/v0/servers";

/// One browsable server from the official MCP registry, already reduced to
/// what a single install needs. `installable` is false when the entry offers
/// no transport Palisade can turn into a `.mcp.json` entry — those are shown
/// with a link to their repository instead of an Install button, rather than
/// silently omitted or, worse, "installed" into something that won't start.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryEntry {
    pub name: String,
    pub title: String,
    pub description: String,
    pub version: String,
    pub repository: String,
    pub installable: bool,
    /// The `.mcp.json` entry this would install, when installable.
    pub server: Option<McpServer>,
}

/// A `.mcp.json`-safe key: lowercase, runs of anything else collapsed to one
/// dash. `"inference.sh"` → `"inference-sh"`.
fn slug(text: &str) -> String {
    let mut out = String::new();
    for ch in text.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_matches('-').to_string()
}

/// The name a registry entry installs under.
///
/// The registry's human `title` wins, because it is what the user clicked in
/// the Browse list — installing "inference.sh" and finding "mcp" in the list
/// is disorienting. It also avoids a collision that the path segment alone
/// walks straight into: dozens of publishers end their name in `/mcp`
/// (`ac.inference.sh/mcp`), and since `.mcp.json` keys by name, the second
/// such install would silently overwrite the first.
fn install_name(server: &serde_json::Value, full_name: &str) -> String {
    let from_title = server
        .get("title")
        .and_then(|v| v.as_str())
        .map(slug)
        .filter(|s| !s.is_empty());
    from_title.unwrap_or_else(|| slug(full_name.rsplit('/').next().unwrap_or(full_name)))
}

/// Turn a registry `packages[]` entry into a launchable stdio command.
///
/// Only runtimes that are themselves a package runner are handled: `npx` and
/// `uvx` fetch on demand, so "install" really is just writing the config.
/// Anything else (a binary to download, a docker image to pull) needs a step
/// Palisade isn't taking on the user's behalf.
/// Whether the registry declared `name` as a `--flag` rather than positional.
fn package_arg_is_named(package: &serde_json::Value, name: &str) -> bool {
    package
        .get("packageArguments")
        .and_then(|v| v.as_array())
        .and_then(|args| {
            args.iter()
                .find(|a| a.get("name").and_then(|n| n.as_str()) == Some(name))
        })
        .and_then(|a| a.get("type"))
        .and_then(|v| v.as_str())
        != Some("positional")
}

fn package_to_server(display: &str, package: &serde_json::Value) -> Option<McpServer> {
    let identifier = package.get("identifier").and_then(|v| v.as_str())?;
    let version = package.get("version").and_then(|v| v.as_str());
    let registry_type = package
        .get("registryType")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let hint = package.get("runtimeHint").and_then(|v| v.as_str());

    // Required arguments the registry says the server needs. They are emitted
    // as `<name>` placeholders rather than guessed: the form shows the user
    // exactly what must be filled, the same contract as the seeded env vars.
    // Dropping them produced a server that started and then failed on its
    // first call with nothing to explain why.
    let declared: Vec<String> = package
        .get("packageArguments")
        .and_then(|v| v.as_array())
        .map(|args| {
            args.iter()
                .filter(|a| a.get("isRequired").and_then(serde_json::Value::as_bool) == Some(true))
                .filter_map(|a| a.get("name").and_then(|n| n.as_str()))
                .flat_map(|name| {
                    let placeholder = format!("<{name}>");
                    match package_arg_is_named(package, name) {
                        true => vec![format!("--{name}"), placeholder],
                        false => vec![placeholder],
                    }
                })
                .collect()
        })
        .unwrap_or_default();

    let (command, args) = match (hint, registry_type) {
        (Some("npx"), _) | (None, "npm") => (
            "npx",
            vec![
                "-y".to_string(),
                match version {
                    Some(v) => format!("{identifier}@{v}"),
                    None => identifier.to_string(),
                },
            ],
        ),
        (Some("uvx"), _) | (None, "pypi") => ("uvx", vec![identifier.to_string()]),
        _ => return None,
    };
    let args = args.into_iter().chain(declared).collect();

    // Required env vars are seeded empty so the pane can show the user exactly
    // what the server needs before it will start. A secret is never guessed at.
    let env = package
        .get("environmentVariables")
        .and_then(|v| v.as_array())
        .map(|vars| {
            vars.iter()
                .filter(|v| v.get("isRequired").and_then(serde_json::Value::as_bool) == Some(true))
                .filter_map(|v| v.get("name").and_then(|n| n.as_str()))
                .map(|name| (name.to_string(), String::new()))
                .collect()
        })
        .unwrap_or_default();

    Some(McpServer {
        name: display.to_string(),
        transport: "stdio".into(),
        command: command.into(),
        args,
        env,
        url: String::new(),
        headers: BTreeMap::new(),
        enabled: true,
    })
}

fn remote_to_server(display: &str, remote: &serde_json::Value) -> Option<McpServer> {
    let url = remote.get("url").and_then(|v| v.as_str())?;
    let transport = match remote.get("type").and_then(|v| v.as_str()) {
        Some("sse") => "sse",
        _ => "http",
    };
    Some(McpServer {
        name: display.to_string(),
        transport: transport.into(),
        command: String::new(),
        args: vec![],
        env: BTreeMap::new(),
        url: url.to_string(),
        headers: BTreeMap::new(),
        enabled: true,
    })
}

/// Reduce one registry record to a `RegistryEntry`. Split out from the HTTP
/// call so the mapping is testable without the network.
pub fn parse_registry_entry(record: &serde_json::Value) -> Option<RegistryEntry> {
    let server = record.get("server").unwrap_or(record);
    let name = server.get("name").and_then(|v| v.as_str())?;
    let display = install_name(server, name);
    let is_stdio = |p: &&serde_json::Value| {
        p.get("transport")
            .and_then(|t| t.get("type"))
            .and_then(|v| v.as_str())
            .is_none_or(|t| t == "stdio")
    };
    let installable = server
        .get("packages")
        .and_then(|v| v.as_array())
        .and_then(|packages| {
            // Stdio first — the same package is often published for stdio and
            // sse, and the sse publication carries args (a port) that make no
            // sense on the stdio command line.
            packages
                .iter()
                .filter(is_stdio)
                .find_map(|p| package_to_server(&display, p))
                .or_else(|| packages.iter().find_map(|p| package_to_server(&display, p)))
        })
        .or_else(|| {
            server
                .get("remotes")
                .and_then(|v| v.as_array())
                .and_then(|remotes| remotes.iter().find_map(|r| remote_to_server(&display, r)))
        });
    Some(RegistryEntry {
        name: name.to_string(),
        title: server
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or(&display)
            .to_string(),
        description: server
            .get("description")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        version: server
            .get("version")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        repository: server
            .get("repository")
            .and_then(|r| r.get("url"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        installable: installable.is_some(),
        server: installable,
    })
}

/// Whether a registry record is the one worth offering.
///
/// The registry stores every published version, so an unfiltered search shows
/// the same server once per release (`ac.inference.sh/mcp` came back four
/// times). `isLatest` picks the current one and `status` drops entries the
/// registry has retired. Records with no registry metadata are kept: only the
/// official registry stamps `_meta`, and dropping the rest would empty the
/// list against any mirror that doesn't.
fn is_current(record: &serde_json::Value) -> bool {
    let Some(meta) = record
        .get("_meta")
        .and_then(|m| m.get("io.modelcontextprotocol.registry/official"))
    else {
        return true;
    };
    let latest = meta
        .get("isLatest")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(true);
    let live = meta
        .get("status")
        .and_then(|v| v.as_str())
        .is_none_or(|status| status == "active");
    latest && live
}

/// Search the official MCP registry. An empty query browses the newest
/// entries, which is what the pane shows before the user types anything.
pub fn search_registry(query: &str, limit: u32) -> Result<Vec<RegistryEntry>, String> {
    let limit = limit.clamp(1, 100).to_string();
    let mut request = ureq::get(REGISTRY_API)
        .set("User-Agent", "palisade-code")
        .query("limit", &limit);
    if !query.trim().is_empty() {
        request = request.query("search", query.trim());
    }
    let body = request
        .call()
        .map_err(|e| format!("MCP registry request failed: {e}"))?
        .into_string()
        .map_err(|e| format!("read MCP registry response: {e}"))?;
    let doc: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("parse MCP registry response: {e}"))?;
    Ok(doc
        .get("servers")
        .and_then(|v| v.as_array())
        .map(|records| {
            records
                .iter()
                .filter(|record| is_current(record))
                .filter_map(parse_registry_entry)
                .collect()
        })
        .unwrap_or_default())
}

// ------------------------------------------------------------------ tests

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn stdio(name: &str) -> McpServer {
        McpServer {
            name: name.into(),
            transport: "stdio".into(),
            command: "npx".into(),
            args: vec!["-y".into(), "some-server".into()],
            env: BTreeMap::new(),
            url: String::new(),
            headers: BTreeMap::new(),
            enabled: true,
        }
    }

    #[test]
    fn a_missing_config_lists_nothing_rather_than_failing() {
        let root = TempDir::new().unwrap();
        assert!(list(root.path()).is_empty());
    }

    #[test]
    fn a_corrupt_config_lists_nothing_rather_than_failing() {
        let root = TempDir::new().unwrap();
        std::fs::write(root.path().join(".mcp.json"), "{not json").unwrap();
        assert!(list(root.path()).is_empty());
    }

    #[test]
    fn saving_round_trips_a_stdio_server() {
        let root = TempDir::new().unwrap();
        save(root.path(), &stdio("fs")).unwrap();
        assert_eq!(list(root.path()), vec![stdio("fs")]);
    }

    #[test]
    fn saving_writes_the_standard_mcp_json_shape() {
        let root = TempDir::new().unwrap();
        save(root.path(), &stdio("fs")).unwrap();
        let raw = std::fs::read_to_string(root.path().join(".mcp.json")).unwrap();
        let doc: serde_json::Value = serde_json::from_str(&raw).unwrap();
        // Exactly what `claude` expects when run from a terminal — the whole
        // point of using the file as the store rather than private settings.
        assert_eq!(doc["mcpServers"]["fs"]["command"], "npx");
        assert_eq!(doc["mcpServers"]["fs"]["args"][1], "some-server");
    }

    #[test]
    fn saving_preserves_servers_palisade_did_not_write() {
        let root = TempDir::new().unwrap();
        std::fs::write(
            root.path().join(".mcp.json"),
            r#"{"mcpServers":{"graphify":{"command":"graphify-mcp"}},"otherTool":{"keep":1}}"#,
        )
        .unwrap();
        save(root.path(), &stdio("fs")).unwrap();
        let raw = std::fs::read_to_string(root.path().join(".mcp.json")).unwrap();
        let doc: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(doc["mcpServers"]["graphify"]["command"], "graphify-mcp");
        assert_eq!(doc["otherTool"]["keep"], 1);
    }

    #[test]
    fn saving_the_same_name_twice_updates_instead_of_duplicating() {
        let root = TempDir::new().unwrap();
        save(root.path(), &stdio("fs")).unwrap();
        let mut updated = stdio("fs");
        updated.args = vec!["--new".into()];
        save(root.path(), &updated).unwrap();
        assert_eq!(list(root.path()), vec![updated]);
    }

    #[test]
    fn disabling_moves_the_server_out_of_mcp_servers_entirely() {
        let root = TempDir::new().unwrap();
        save(root.path(), &stdio("fs")).unwrap();
        set_enabled(root.path(), "fs", false).unwrap();

        let raw = std::fs::read_to_string(root.path().join(".mcp.json")).unwrap();
        let doc: serde_json::Value = serde_json::from_str(&raw).unwrap();
        // An agent reading this file directly must not start a server the UI
        // shows as off — so it cannot still be under `mcpServers`.
        assert!(doc.get("mcpServers").is_none());
        assert_eq!(doc["disabledMcpServers"]["fs"]["command"], "npx");

        let listed = list(root.path());
        assert_eq!(listed.len(), 1);
        assert!(!listed[0].enabled);
        // Its configuration survived the round trip.
        assert_eq!(listed[0].args, vec!["-y".to_string(), "some-server".into()]);
    }

    #[test]
    fn re_enabling_restores_it() {
        let root = TempDir::new().unwrap();
        save(root.path(), &stdio("fs")).unwrap();
        set_enabled(root.path(), "fs", false).unwrap();
        set_enabled(root.path(), "fs", true).unwrap();
        assert_eq!(list(root.path()), vec![stdio("fs")]);
    }

    #[test]
    fn toggling_an_unknown_server_is_a_no_op() {
        let root = TempDir::new().unwrap();
        save(root.path(), &stdio("fs")).unwrap();
        set_enabled(root.path(), "nope", false).unwrap();
        assert_eq!(list(root.path()), vec![stdio("fs")]);
    }

    #[test]
    fn removing_deletes_the_server_and_leaves_no_empty_maps() {
        let root = TempDir::new().unwrap();
        save(root.path(), &stdio("fs")).unwrap();
        remove(root.path(), "fs").unwrap();
        assert!(list(root.path()).is_empty());
        let raw = std::fs::read_to_string(root.path().join(".mcp.json")).unwrap();
        let doc: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert!(doc.get("mcpServers").is_none());
    }

    #[test]
    fn an_http_server_round_trips_with_its_type() {
        let root = TempDir::new().unwrap();
        let remote = McpServer {
            name: "remote".into(),
            transport: "http".into(),
            command: String::new(),
            args: vec![],
            env: BTreeMap::new(),
            url: "https://example.test/mcp".into(),
            headers: BTreeMap::from([("Authorization".to_string(), "Bearer x".to_string())]),
            enabled: true,
        };
        save(root.path(), &remote).unwrap();
        assert_eq!(list(root.path()), vec![remote]);
    }

    #[test]
    fn a_bare_command_entry_reads_as_stdio() {
        let root = TempDir::new().unwrap();
        std::fs::write(
            root.path().join(".mcp.json"),
            r#"{"mcpServers":{"g":{"command":"graphify-mcp"}}}"#,
        )
        .unwrap();
        assert_eq!(list(root.path())[0].transport, "stdio");
    }

    #[test]
    fn a_server_in_both_maps_reads_as_enabled() {
        // `integrations.rs` writes `graphify` straight into `mcpServers` on
        // every project load. Disabling it here parks a copy under the
        // disabled key, and the next load puts the original back — so the
        // same name can legitimately appear in both. The enabled copy is the
        // one the agent will actually start, so that is the truth to show.
        let root = TempDir::new().unwrap();
        std::fs::write(
            root.path().join(".mcp.json"),
            r#"{"mcpServers":{"graphify":{"command":"graphify-mcp"}},
                "disabledMcpServers":{"graphify":{"command":"stale"}}}"#,
        )
        .unwrap();
        let listed = list(root.path());
        assert_eq!(listed.len(), 1);
        assert!(listed[0].enabled);
        assert_eq!(listed[0].command, "graphify-mcp");
    }

    #[test]
    fn listing_puts_enabled_servers_first_then_sorts_by_name() {
        let root = TempDir::new().unwrap();
        save(root.path(), &stdio("zeta")).unwrap();
        save(root.path(), &stdio("alpha")).unwrap();
        save(root.path(), &stdio("beta")).unwrap();
        set_enabled(root.path(), "alpha", false).unwrap();
        let names: Vec<_> = list(root.path()).into_iter().map(|s| s.name).collect();
        assert_eq!(names, vec!["beta", "zeta", "alpha"]);
    }

    // ------------------------------------------------- session hand-off

    #[test]
    fn only_enabled_servers_reach_the_session() {
        let root = TempDir::new().unwrap();
        save(root.path(), &stdio("on")).unwrap();
        save(root.path(), &stdio("off")).unwrap();
        set_enabled(root.path(), "off", false).unwrap();
        let sent = for_session(root.path(), true, true);
        assert_eq!(sent.len(), 1);
        assert!(matches!(&sent[0], v1::McpServer::Stdio(s) if s.name == "on"));
    }

    #[test]
    fn remote_servers_are_withheld_from_agents_that_cannot_take_them() {
        let root = TempDir::new().unwrap();
        save(root.path(), &stdio("local")).unwrap();
        let remote = McpServer {
            name: "remote".into(),
            transport: "http".into(),
            command: String::new(),
            args: vec![],
            env: BTreeMap::new(),
            url: "https://example.test/mcp".into(),
            headers: BTreeMap::new(),
            enabled: true,
        };
        save(root.path(), &remote).unwrap();

        // Stdio is mandatory for every agent; http is capability-gated, and
        // sending it to an agent that said it can't is a guaranteed error.
        assert_eq!(for_session(root.path(), false, false).len(), 1);
        assert_eq!(for_session(root.path(), true, false).len(), 2);
    }

    // -------------------------------------------------------- registry

    #[test]
    fn an_npm_registry_entry_becomes_an_npx_command() {
        let record = serde_json::json!({
            "server": {
                "name": "io.github.owner/filesystem",
                "description": "Files",
                "version": "1.2.3",
                "repository": { "url": "https://github.com/owner/filesystem" },
                "packages": [{
                    "registryType": "npm",
                    "identifier": "@scope/mcp-filesystem",
                    "version": "0.4.0",
                    "runtimeHint": "npx",
                    "transport": { "type": "stdio" }
                }]
            }
        });
        let entry = parse_registry_entry(&record).unwrap();
        assert!(entry.installable);
        let server = entry.server.unwrap();
        assert_eq!(server.command, "npx");
        assert_eq!(server.args, vec!["-y", "@scope/mcp-filesystem@0.4.0"]);
    }

    #[test]
    fn required_env_vars_are_seeded_empty_for_the_user_to_fill() {
        let record = serde_json::json!({
            "server": {
                "name": "io.github.owner/thing",
                "packages": [{
                    "registryType": "npm",
                    "identifier": "thing",
                    "runtimeHint": "npx",
                    "environmentVariables": [
                        { "name": "API_KEY", "isRequired": true, "isSecret": true },
                        { "name": "OPTIONAL_TUNING" }
                    ]
                }]
            }
        });
        let server = parse_registry_entry(&record).unwrap().server.unwrap();
        // Required only: an optional var written as an empty string would
        // override the server's own default with nothing.
        assert_eq!(server.env.keys().collect::<Vec<_>>(), vec!["API_KEY"]);
        assert_eq!(server.env["API_KEY"], "");
    }

    #[test]
    fn required_package_arguments_are_carried_into_the_command() {
        // The registry declares these and they are not optional: without
        // `--allowed-directories` the filesystem server starts and then fails
        // on the first call, which is precisely the silent breakage the
        // prefilled form is meant to prevent.
        let record = serde_json::json!({
            "server": {
                "name": "io.github.bytedance/mcp-server-filesystem",
                "packages": [{
                    "registryType": "npm",
                    "identifier": "@agent-infra/mcp-server-filesystem",
                    "transport": { "type": "stdio" },
                    "packageArguments": [
                        { "type": "named", "name": "allowed-directories", "isRequired": true },
                        { "type": "named", "name": "verbose" }
                    ]
                }]
            }
        });
        let server = parse_registry_entry(&record).unwrap().server.unwrap();
        assert_eq!(
            server.args,
            vec![
                "-y",
                "@agent-infra/mcp-server-filesystem",
                "--allowed-directories",
                "<allowed-directories>"
            ]
        );
    }

    #[test]
    fn a_required_positional_argument_becomes_a_placeholder() {
        let record = serde_json::json!({
            "server": {
                "name": "io.github.o/p",
                "packages": [{
                    "registryType": "npm", "identifier": "p", "runtimeHint": "npx",
                    "packageArguments": [
                        { "type": "positional", "name": "root", "isRequired": true }
                    ]
                }]
            }
        });
        let server = parse_registry_entry(&record).unwrap().server.unwrap();
        assert_eq!(server.args, vec!["-y", "p", "<root>"]);
    }

    #[test]
    fn a_stdio_package_wins_over_a_remote_one() {
        // This entry publishes the same package twice, stdio first and sse
        // second. Stdio is the transport every ACP agent must support.
        let record = serde_json::json!({
            "server": {
                "name": "io.github.o/p",
                "packages": [
                    { "registryType": "npm", "identifier": "p",
                      "transport": { "type": "sse", "url": "http://127.0.0.1:8089/sse" } },
                    { "registryType": "npm", "identifier": "p",
                      "transport": { "type": "stdio" } }
                ]
            }
        });
        let server = parse_registry_entry(&record).unwrap().server.unwrap();
        assert_eq!(server.transport, "stdio");
    }

    #[test]
    fn a_pypi_entry_becomes_a_uvx_command() {
        let record = serde_json::json!({
            "server": {
                "name": "io.github.owner/py",
                "packages": [{ "registryType": "pypi", "identifier": "mcp-py" }]
            }
        });
        let server = parse_registry_entry(&record).unwrap().server.unwrap();
        assert_eq!(server.command, "uvx");
        assert_eq!(server.args, vec!["mcp-py"]);
    }

    #[test]
    fn a_remote_only_entry_becomes_an_http_server() {
        let record = serde_json::json!({
            "server": {
                "name": "ai.example/hosted",
                "remotes": [{ "type": "streamable-http", "url": "https://example.test/mcp" }]
            }
        });
        let server = parse_registry_entry(&record).unwrap().server.unwrap();
        assert_eq!(server.transport, "http");
        assert_eq!(server.url, "https://example.test/mcp");
    }

    #[test]
    fn an_sse_remote_keeps_its_transport() {
        let record = serde_json::json!({
            "server": {
                "name": "ai.example/hosted",
                "remotes": [{ "type": "sse", "url": "https://example.test/sse" }]
            }
        });
        assert_eq!(
            parse_registry_entry(&record).unwrap().server.unwrap().transport,
            "sse"
        );
    }

    #[test]
    fn an_entry_palisade_cannot_launch_is_listed_but_not_installable() {
        // A docker image needs a pull Palisade is not going to run for the
        // user; showing it as installable would produce a server that never
        // starts, which is worse than an honest "see the repository".
        let record = serde_json::json!({
            "server": {
                "name": "io.github.owner/dockerized",
                "repository": { "url": "https://github.com/owner/dockerized" },
                "packages": [{ "registryType": "oci", "identifier": "owner/img" }]
            }
        });
        let entry = parse_registry_entry(&record).unwrap();
        assert!(!entry.installable);
        assert!(entry.server.is_none());
        assert_eq!(entry.repository, "https://github.com/owner/dockerized");
    }

    #[test]
    fn a_generic_trailing_segment_does_not_become_the_server_name() {
        // Many publishers name the path segment "mcp" (ac.inference.sh/mcp,
        // and dozens like it). Taking the last segment named every one of
        // them "mcp" — and since `.mcp.json` keys by name, installing a
        // second one silently overwrote the first.
        let record = serde_json::json!({
            "server": {
                "name": "ac.inference.sh/mcp",
                "title": "inference.sh",
                "remotes": [{ "type": "streamable-http", "url": "https://api.inference.sh/mcp" }]
            }
        });
        let server = parse_registry_entry(&record).unwrap().server.unwrap();
        assert_eq!(server.name, "inference-sh");
    }

    #[test]
    fn a_titled_entry_installs_under_the_name_the_user_saw() {
        let record = serde_json::json!({
            "server": {
                "name": "io.github.owner/thing",
                "title": "Pre-Trip Compliance Scanner",
                "packages": [{ "registryType": "npm", "identifier": "t", "runtimeHint": "npx" }]
            }
        });
        let server = parse_registry_entry(&record).unwrap().server.unwrap();
        assert_eq!(server.name, "pre-trip-compliance-scanner");
    }

    #[test]
    fn an_untitled_entry_falls_back_to_its_path_segment() {
        let record = serde_json::json!({
            "server": {
                "name": "io.github.owner/filesystem",
                "packages": [{ "registryType": "npm", "identifier": "f", "runtimeHint": "npx" }]
            }
        });
        let server = parse_registry_entry(&record).unwrap().server.unwrap();
        assert_eq!(server.name, "filesystem");
    }

    #[test]
    fn only_the_latest_version_of_a_server_is_offered() {
        // The registry returns every published version of a server, so an
        // unfiltered list shows the same entry four times over.
        let record = |version: &str, latest: bool| {
            serde_json::json!({
                "server": { "name": "ac.inference.sh/mcp", "version": version },
                "_meta": { "io.modelcontextprotocol.registry/official":
                    { "isLatest": latest, "status": "active" } }
            })
        };
        assert!(!is_current(&record("1.0.0", false)));
        assert!(is_current(&record("2.0.1", true)));
    }

    #[test]
    fn a_deleted_registry_entry_is_withheld() {
        let record = serde_json::json!({
            "server": { "name": "ac.gone/mcp" },
            "_meta": { "io.modelcontextprotocol.registry/official":
                { "isLatest": true, "status": "deleted" } }
        });
        assert!(!is_current(&record));
    }

    #[test]
    fn a_record_without_registry_metadata_is_kept() {
        // Only the official registry stamps _meta. Dropping anything without
        // it would empty the list against any mirror that does not.
        assert!(is_current(&serde_json::json!({ "server": { "name": "x/y" } })));
    }

    #[test]
    fn a_nameless_registry_record_is_skipped() {
        assert!(parse_registry_entry(&serde_json::json!({ "server": {} })).is_none());
    }

    #[test]
    fn installing_a_registry_entry_lands_in_the_config() {
        let root = TempDir::new().unwrap();
        let record = serde_json::json!({
            "server": {
                "name": "io.github.owner/filesystem",
                "packages": [{
                    "registryType": "npm", "identifier": "mcp-fs", "runtimeHint": "npx"
                }]
            }
        });
        let server = parse_registry_entry(&record).unwrap().server.unwrap();
        save(root.path(), &server).unwrap();
        assert_eq!(list(root.path())[0].name, "filesystem");
        assert!(list(root.path())[0].enabled);
    }
}

#[cfg(test)]
mod live {
    /// Hits the real registry, so it is not part of the default run — an
    /// offline machine or a registry outage must not fail the suite. Run it
    /// with `cargo test -- --ignored` when the API shape is in question.
    #[test]
    #[ignore = "network"]
    fn the_official_registry_returns_installable_entries() {
        let entries = super::search_registry("filesystem", 20).unwrap();
        assert!(!entries.is_empty(), "registry returned nothing");
        assert!(
            entries.iter().any(|e| e.installable),
            "no entry in the first page could be installed from config alone"
        );
    }
}
