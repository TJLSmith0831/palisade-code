//! Database viewer/editor: saved connections, schema introspection, paged
//! reads, and a conflict-checked transactional write path.
//!
//! Connection strings can embed a password, so they live under
//! `~/.palisade-code/projects/<hash>/db-connections.json` (mode 0600) —
//! structurally outside any target repo, the same reason the session store
//! lives there. Every function takes the palisade home explicitly so tests can
//! point at a tempdir, matching `store.rs`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub type Res<T> = Result<T, String>;

fn e(ctx: &str, err: impl std::fmt::Display) -> String {
    format!("{ctx}: {err}")
}

// ------------------------------------------------------------------ backends

/// Which concrete driver a connection URL selects.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Backend {
    #[default]
    Postgres,
    Sqlite,
}

/// Reads the driver off the URL scheme — the one thing `sqlx::Any` decides at
/// runtime, so Palisade has to agree with it before saving a connection.
pub fn backend_of(url: &str) -> Res<Backend> {
    let scheme = url.split("://").next().unwrap_or("").trim().to_lowercase();
    match scheme.as_str() {
        "postgres" | "postgresql" => Ok(Backend::Postgres),
        "sqlite" => Ok(Backend::Sqlite),
        "" => Err("connection string is missing a scheme (expected postgres:// or sqlite://)".into()),
        other => Err(format!(
            "unsupported database scheme '{other}' — this build speaks postgres:// and sqlite://"
        )),
    }
}

// --------------------------------------------------------------- connections

/// A connection's non-secret details. Discrete fields rather than a URL string:
/// a password embedded in a URL cannot be separated from the rest, which is why
/// DataGrip warns against its own URL-only mode and why Palisade stopped using
/// one (D21).
///
/// `tag = "backend"` keeps the discriminator the frontend already reads.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "backend", rename_all = "lowercase")]
pub enum Details {
    Postgres {
        host: String,
        port: u16,
        user: String,
        database: String,
    },
    /// A path and nothing else — SQLite has no secret, so these connections
    /// never touch the credential store (D22).
    Sqlite {
        path: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbConnection {
    pub id: String,
    pub name: String,
    #[serde(flatten)]
    pub details: Details,
    /// Resolved from the credential store on connect, never serialized — not to
    /// disk and not across IPC (D16, D21).
    #[serde(default, skip_serializing)]
    pub password: Option<String>,
}

impl Details {
    /// Stand-in for a record whose details cannot be read without opening the
    /// credential store. `with_secret` fills it in on connect.
    fn placeholder(backend: Backend) -> Self {
        match backend {
            Backend::Sqlite => Details::Sqlite { path: String::new() },
            Backend::Postgres => Details::Postgres {
                host: String::new(),
                port: 5432,
                user: String::new(),
                database: String::new(),
            },
        }
    }

    /// True when this carries nothing to connect with yet.
    pub fn is_placeholder(&self) -> bool {
        match self {
            Details::Sqlite { path } => path.is_empty(),
            Details::Postgres { host, .. } => host.is_empty(),
        }
    }

    pub fn backend(&self) -> Backend {
        match self {
            Details::Postgres { .. } => Backend::Postgres,
            Details::Sqlite { .. } => Backend::Sqlite,
        }
    }

    /// True when this connection has a secret worth storing. SQLite never does,
    /// which is what lets it skip the credential store entirely (D22).
    pub fn has_secret(&self) -> bool {
        matches!(self, Details::Postgres { .. })
    }
}

impl DbConnection {
    pub fn backend(&self) -> Backend {
        self.details.backend()
    }

    /// Assembles what sqlx connects with. Built only in memory, never stored
    /// (D21) — the password is re-inserted here and nowhere else.
    pub fn to_url(&self) -> String {
        match &self.details {
            Details::Sqlite { path } => format!("sqlite://{path}"),
            Details::Postgres { host, port, user, database } => {
                let auth = match self.password.as_deref().filter(|p| !p.is_empty()) {
                    Some(pw) => format!("{}:{}", encode(user), encode(pw)),
                    None => encode(user),
                };
                format!("postgres://{auth}@{host}:{port}/{}", encode(database))
            }
        }
    }

    /// A stable key for the pool map that cannot leak a password into it.
    pub(crate) fn pool_key(&self) -> String {
        match &self.details {
            Details::Sqlite { path } => format!("sqlite://{path}"),
            Details::Postgres { host, port, user, database } => {
                format!("postgres://{user}@{host}:{port}/{database}")
            }
        }
    }
}

/// Percent-encodes the characters that would otherwise end a URL component.
/// A password containing `@`, `/`, `:`, or `#` is ordinary and must survive.
fn encode(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for b in raw.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn decode(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(&raw[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Splits a connection string into fields plus its password — the paste
/// shortcut in the add form (D24), and how a pre-fields entry migrates (D9).
pub fn parse_url(url: &str) -> Res<(Details, Option<String>)> {
    let url = url.trim();
    let (scheme, rest) = url
        .split_once("://")
        .ok_or("connection string is missing a scheme (expected postgres:// or sqlite://)")?;
    match scheme.trim().to_lowercase().as_str() {
        "sqlite" => Ok((Details::Sqlite { path: rest.to_string() }, None)),
        "postgres" | "postgresql" => {
            // The last '@' separates userinfo from the host: a password may
            // legitimately contain one when it was never percent-encoded.
            let (userinfo, hostpart) = match rest.rsplit_once('@') {
                Some((u, h)) => (u, h),
                None => ("", rest),
            };
            let (user, password) = match userinfo.split_once(':') {
                Some((u, p)) => (decode(u), Some(decode(p))),
                None => (decode(userinfo), None),
            };
            let (hostport, database) = match hostpart.split_once('/') {
                Some((h, d)) => (h, decode(d.split('?').next().unwrap_or(d))),
                None => (hostpart, String::new()),
            };
            let (host, port) = match hostport.rsplit_once(':') {
                Some((h, p)) => (
                    h.to_string(),
                    p.parse::<u16>().map_err(|_| format!("'{p}' is not a valid port"))?,
                ),
                None => (hostport.to_string(), 5432),
            };
            if host.is_empty() {
                return Err("connection string is missing a host".into());
            }
            Ok((
                Details::Postgres { host, port, user, database },
                password.filter(|p| !p.is_empty()),
            ))
        }
        other => Err(format!(
            "unsupported database scheme '{other}' — this build speaks postgres:// and sqlite://"
        )),
    }
}

/// The on-disk record. Deliberately flat and tolerant rather than reusing
/// `Details`: a file can hold records written before the field split alongside
/// records written after it, and a strict enum would fail the whole read on the
/// first legacy entry. The strict type is the in-memory one.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredConnection {
    id: String,
    name: String,
    backend: Backend,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    user: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    database: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    /// Set only when the credential store refused the password (D8).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    password: Option<String>,
    /// A connection string written before the field split. Parsed and cleared
    /// on first connect (D23, task 5.6).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    url: Option<String>,
}

impl StoredConnection {
    /// The record's fields, or `None` when it still needs splitting from a URL.
    fn details(&self) -> Option<Details> {
        match self.backend {
            Backend::Sqlite => self.path.clone().map(|path| Details::Sqlite { path }),
            Backend::Postgres => Some(Details::Postgres {
                host: self.host.clone()?,
                port: self.port.unwrap_or(5432),
                user: self.user.clone().unwrap_or_default(),
                database: self.database.clone().unwrap_or_default(),
            }),
        }
    }

    fn from_parts(id: String, name: String, details: &Details, password: Option<String>) -> Self {
        let mut rec = StoredConnection {
            id,
            name,
            backend: details.backend(),
            password,
            ..Default::default()
        };
        match details {
            Details::Sqlite { path } => rec.path = Some(path.clone()),
            Details::Postgres { host, port, user, database } => {
                rec.host = Some(host.clone());
                rec.port = Some(*port);
                rec.user = Some(user.clone());
                rec.database = Some(database.clone());
            }
        }
        rec
    }
}

/// The OS credential store, when this target has one compiled in (D15).
/// `Err` means unavailable — locked, refused, or absent — which is a signal to
/// fall back to the file, not a failure (D8).
#[cfg(all(not(test), any(target_os = "macos", target_os = "windows")))]
mod vault {
    const SERVICE: &str = "palisade-code";

    fn entry(hash: &str, id: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(SERVICE, &format!("{hash}:{id}")).map_err(|err| err.to_string())
    }

    /// Idempotent on purpose. macOS rejects a write over an existing item with
    /// `errSecDuplicateItem` rather than updating it, and two `list_connections`
    /// calls can race during migration — the panel mounts and refreshes before
    /// the first has rewritten the file — so the loser must converge, not warn.
    pub fn set(hash: &str, id: &str, url: &str) -> Result<(), String> {
        let entry = entry(hash, id)?;
        match entry.set_password(url) {
            Ok(()) => Ok(()),
            Err(_) => {
                let _ = entry.delete_credential();
                entry.set_password(url).map_err(|err| err.to_string())
            }
        }
    }

    pub fn get(hash: &str, id: &str) -> Result<Option<String>, String> {
        match entry(hash, id)?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(err) => Err(err.to_string()),
        }
    }

    /// Deleting what is already gone is success — removal must not fail
    /// because a credential never made it into the store (D9).
    pub fn delete(hash: &str, id: &str) -> Result<(), String> {
        match entry(hash, id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(err.to_string()),
        }
    }
}

/// No credential store compiled in — every call reports unavailable so the
/// file fallback is the only path (D15).
#[cfg(all(not(test), not(any(target_os = "macos", target_os = "windows"))))]
mod vault {
    const NONE: &str = "no OS credential store on this platform";

    pub fn set(_: &str, _: &str, _: &str) -> Result<(), String> {
        Err(NONE.into())
    }
    pub fn get(_: &str, _: &str) -> Result<Option<String>, String> {
        Err(NONE.into())
    }
    pub fn delete(_: &str, _: &str) -> Result<(), String> {
        Ok(())
    }
}

/// In-memory stand-in. Tests must not touch the real keychain — it prompts,
/// needs an unlocked login session, and would leak between runs. The real
/// backends are exercised by running the app.
#[cfg(test)]
pub mod vault {
    use crate::locks::MutexExt;
    use std::collections::{HashMap, HashSet};
    use std::sync::Mutex;

    /// Unavailability is per project hash, not global: cargo runs tests in
    /// parallel, and a global flag would let one test's simulated outage break
    /// every other test sharing the process.
    fn store() -> &'static Mutex<(HashSet<String>, HashMap<String, String>)> {
        static S: std::sync::OnceLock<Mutex<(HashSet<String>, HashMap<String, String>)>> =
            std::sync::OnceLock::new();
        S.get_or_init(|| Mutex::new((HashSet::new(), HashMap::new())))
    }

    /// Simulates a locked, refused, or absent credential store for one project.
    pub fn set_unavailable(hash: &str) {
        store().lock_or_recover().0.insert(hash.to_string());
    }

    pub fn set_available(hash: &str) {
        store().lock_or_recover().0.remove(hash);
    }

    pub fn has(hash: &str, id: &str) -> bool {
        store().lock_or_recover().1.contains_key(&format!("{hash}:{id}"))
    }

    fn down(g: &(HashSet<String>, HashMap<String, String>), hash: &str) -> bool {
        g.0.contains(hash)
    }

    pub fn set(hash: &str, id: &str, url: &str) -> Result<(), String> {
        let mut g = store().lock_or_recover();
        if down(&g, hash) {
            return Err("credential store unavailable".into());
        }
        g.1.insert(format!("{hash}:{id}"), url.to_string());
        Ok(())
    }

    pub fn get(hash: &str, id: &str) -> Result<Option<String>, String> {
        let g = store().lock_or_recover();
        if down(&g, hash) {
            return Err("credential store unavailable".into());
        }
        Ok(g.1.get(&format!("{hash}:{id}")).cloned())
    }

    pub fn delete(hash: &str, id: &str) -> Result<(), String> {
        let mut g = store().lock_or_recover();
        if down(&g, hash) {
            return Err("credential store unavailable".into());
        }
        g.1.remove(&format!("{hash}:{id}"));
        Ok(())
    }
}

/// The message shown when a credential lands in the file instead of the
/// credential store. D8 forbids falling back silently — the user would
/// otherwise believe a secret is in the keychain when it is on disk.
fn degraded(name: &str, why: &str) -> String {
    format!(
        "Database connection \"{name}\": credential saved to a user-only file \
         instead of the OS credential store ({why})."
    )
}

fn connections_path(home: &Path, hash: &str) -> PathBuf {
    crate::store::project_dir(home, hash).join("db-connections.json")
}

/// Writes the whole list back at 0600. The mode is set before the bytes land,
/// so a credential is never briefly world-readable. Still 0600 even when the
/// credential lives in the OS store: the file names every connection.
fn save_stored(home: &Path, hash: &str, list: &[StoredConnection]) -> Res<()> {
    let path = connections_path(home, hash);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| e("create dir", err))?;
    }
    let body = serde_json::to_string_pretty(list).map_err(|err| e("serialize", err))?;
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&path)
            .map_err(|err| e(&format!("write {}", path.display()), err))?;
        f.write_all(body.as_bytes())
            .map_err(|err| e(&format!("write {}", path.display()), err))?;
    }
    #[cfg(not(unix))]
    std::fs::write(&path, body).map_err(|err| e(&format!("write {}", path.display()), err))?;
    Ok(())
}

/// Reads the on-disk records as written, without resolving credentials.
fn read_stored(home: &Path, hash: &str) -> Res<Vec<StoredConnection>> {
    let path = connections_path(home, hash);
    match std::fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).map_err(|err| e(&format!("parse {}", path.display()), err)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(err) => Err(e(&format!("read {}", path.display()), err)),
    }
}

/// Every saved connection, from the file alone.
///
/// This does **not** read the credential store (D23). Listing renders names and
/// non-secret details, so opening the panel raises no OS authorization prompt —
/// the secret is fetched in `pool_for`, when a connection is actually opened.
/// A record still holding a pre-split `url` is parsed for display here but not
/// rewritten; migration happens on first connect (task 5.6).
pub fn list_connections(home: &Path, hash: &str) -> Res<(Vec<DbConnection>, Option<String>)> {
    let stored = read_stored(home, hash)?;
    let mut out = Vec::with_capacity(stored.len());
    let mut warning = None;

    for rec in &stored {
        let details = match rec.details() {
            Some(d) => d,
            // Not yet split: show what the URL says, without storing anything.
            None => match rec.url.as_deref().map(parse_url) {
                Some(Ok((details, _))) => details,
                // Neither fields nor a URL on disk: the connection string is in
                // the credential store, written by a build that kept the whole
                // URL there. It is recoverable, but only on connect — listing
                // must not read the store (D23) — so show the connection with
                // blank details rather than dropping it from the panel.
                _ => Details::placeholder(rec.backend),
            },
        };
        out.push(DbConnection {
            id: rec.id.clone(),
            name: rec.name.clone(),
            details,
            password: None,
        });
    }
    Ok((out, warning))
}

/// Resolves a connection's password, splitting a pre-fields record on the way
/// (task 5.6). Called on connect, never on list.
pub fn with_secret(home: &Path, hash: &str, conn: &DbConnection) -> Res<(DbConnection, Option<String>)> {
    let mut resolved = conn.clone();
    let mut warning = None;
    // SQLite has no secret (D22) — unless its details are still locked in the
    // credential store from an older layout, which needs recovering below.
    if !conn.details.has_secret() && !conn.details.is_placeholder() {
        return Ok((resolved, None));
    }

    let mut stored = read_stored(home, hash)?;
    let Some(i) = stored.iter().position(|r| r.id == conn.id) else {
        return Err(format!("no connection {}", conn.id));
    };

    // Details are missing entirely: a build that stored the whole connection
    // string in the credential store wrote this. Recover the URL from there and
    // split it into fields, so the connection repairs itself on first use.
    if conn.details.is_placeholder() && stored[i].url.is_none() {
        let recovered = vault::get(hash, &conn.id).map_err(|why| {
            format!("connection \"{}\": its details are in the credential store and it is unavailable ({why})", conn.name)
        })?;
        let url = recovered.ok_or_else(|| {
            format!(
                "connection \"{}\" has no stored details left — re-enter its connection details",
                conn.name
            )
        })?;
        stored[i].url = Some(url);
    }

    // A record written before the field split still carries its URL: split it
    // now, move the password into the store, and rewrite without either.
    if let Some(url) = stored[i].url.clone() {
        let (details, password) = parse_url(&url)?;
        let kept = match password.as_deref() {
            Some(pw) => match vault::set(hash, &conn.id, pw) {
                Ok(()) => None,
                Err(why) => {
                    warning = Some(degraded(&stored[i].name, &why));
                    password.clone()
                }
            },
            None => None,
        };
        stored[i] = StoredConnection::from_parts(
            stored[i].id.clone(),
            stored[i].name.clone(),
            &details,
            kept,
        );
        save_stored(home, hash, &stored)?;
        resolved.details = details;
        resolved.password = password;
        return Ok((resolved, warning));
    }

    // The file is carrying the password because the store refused it (D8).
    if let Some(pw) = stored[i].password.clone() {
        resolved.password = Some(pw);
        return Ok((resolved, None));
    }

    match vault::get(hash, &conn.id) {
        Ok(password) => resolved.password = password,
        Err(why) => {
            warning = Some(format!(
                "Database connection \"{}\": credential store unavailable ({why}).",
                conn.name
            ))
        }
    }
    Ok((resolved, warning))
}

/// Saves the password to the store, falling back to the file with a warning
/// when the store will not take it (D8). SQLite never gets here.
fn stow(hash: &str, id: &str, name: &str, details: &Details, password: Option<&str>) -> (StoredConnection, Option<String>) {
    let mut warning = None;
    let kept = match password.filter(|p| !p.is_empty()) {
        None => None,
        Some(pw) => match vault::set(hash, id, pw) {
            Ok(()) => None,
            Err(why) => {
                warning = Some(degraded(name, &why));
                Some(pw.to_string())
            }
        },
    };
    (
        StoredConnection::from_parts(id.to_string(), name.to_string(), details, kept),
        warning,
    )
}

pub fn add_connection(
    home: &Path,
    hash: &str,
    name: &str,
    details: Details,
    password: Option<&str>,
) -> Res<(DbConnection, Option<String>)> {
    let name = name.trim();
    if name.is_empty() {
        return Err("connection needs a name".into());
    }
    let id = ulid::Ulid::new().to_string();
    let (record, warning) = stow(hash, &id, name, &details, password);
    let mut list = read_stored(home, hash)?;
    list.push(record);
    save_stored(home, hash, &list)?;
    Ok((
        DbConnection {
            id,
            name: name.to_string(),
            details,
            password: password.map(str::to_string),
        },
        warning,
    ))
}

/// Removing a connection deletes its credential too — otherwise removal leaves
/// a secret in the store with no connection referring to it (D9).
pub fn remove_connection(home: &Path, hash: &str, id: &str) -> Res<()> {
    let mut list = read_stored(home, hash)?;
    list.retain(|c| c.id != id);
    save_stored(home, hash, &list)?;
    let _ = vault::delete(hash, id);
    Ok(())
}

pub fn rename_connection(home: &Path, hash: &str, id: &str, name: &str) -> Res<DbConnection> {
    let name = name.trim();
    if name.is_empty() {
        return Err("connection needs a name".into());
    }
    let mut list = read_stored(home, hash)?;
    let found = list
        .iter_mut()
        .find(|c| c.id == id)
        .ok_or_else(|| format!("no connection {id}"))?;
    found.name = name.to_string();
    save_stored(home, hash, &list)?;
    find_connection(home, hash, id)
}

/// The connection as listed — no secret. Callers that connect go through
/// `with_secret` (D23).
pub fn find_connection(home: &Path, hash: &str, id: &str) -> Res<DbConnection> {
    list_connections(home, hash)?
        .0
        .into_iter()
        .find(|c| c.id == id)
        .ok_or_else(|| format!("no connection {id}"))
}

// ------------------------------------------------------------------ timeout

/// How long any single database operation may run before Palisade stops
/// waiting. Fixed rather than configurable (D10).
const QUERY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Bounds one operation. Dropping the future returns the pool slot it held,
/// which is the resource this protects. It does **not** cancel the statement
/// server-side — a runaway query keeps burning database CPU until the server
/// ends it; `SET statement_timeout` is the named upgrade path (D10).
async fn bounded<T>(what: &str, op: impl std::future::Future<Output = Res<T>>) -> Res<T> {
    bounded_for(QUERY_TIMEOUT, what, op).await
}

/// The bound itself, with the duration injectable so a test can prove the
/// timeout path without waiting 30 seconds for it.
async fn bounded_for<T>(
    limit: std::time::Duration,
    what: &str,
    op: impl std::future::Future<Output = Res<T>>,
) -> Res<T> {
    match tokio::time::timeout(limit, op).await {
        Ok(result) => result,
        Err(_) => Err(format!(
            "{what} timed out after {}s — Palisade stopped waiting; the database may still be running it",
            limit.as_secs()
        )),
    }
}

// --------------------------------------------------------------- query history

/// One line of `db-audit.jsonl`: what ran against a database, when, and how it
/// went. A history for the person using the app, not compliance evidence
/// (D19) — it is appended after the operation and never blocks it (D6).
///
/// There is no `actor` field: the app is single-user and the OS account is the
/// actor. There is deliberately no `url` — the one field that embeds a
/// password, which logging would leak into a second file (D4).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub ts: String,
    /// `connection.add` | `connection.remove` | `connection.rename` | `query` | `edit`
    pub kind: String,
    pub connection_id: String,
    pub connection_name: String,
    pub backend: Backend,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub table: Option<String>,
    /// The statement verbatim. Sensitive by construction — this file is written
    /// 0600 for the same reason the connection file is (D4).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub statement: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rows_affected: Option<i64>,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl AuditEntry {
    /// Builds an entry from a connection, so the URL is structurally unable to
    /// reach the log — callers never assemble the identity fields themselves.
    pub fn new(kind: &str, conn: &DbConnection) -> Self {
        AuditEntry {
            ts: chrono::Utc::now().to_rfc3339(),
            kind: kind.to_string(),
            connection_id: conn.id.clone(),
            connection_name: conn.name.clone(),
            backend: conn.backend(),
            schema: None,
            table: None,
            statement: None,
            rows_affected: None,
            ok: true,
            error: None,
        }
    }

    pub fn statement(mut self, sql: &str) -> Self {
        self.statement = Some(sql.to_string());
        self
    }

    pub fn at(mut self, schema: Option<&str>, table: &str) -> Self {
        self.schema = schema.map(str::to_string);
        self.table = Some(table.to_string());
        self
    }

    /// Records the outcome, collapsing a `Res<T>` into ok/error plus whatever
    /// count the caller pulls out of the success value.
    pub fn outcome<T>(mut self, result: &Res<T>, rows: impl Fn(&T) -> Option<i64>) -> Self {
        match result {
            Ok(v) => {
                self.ok = true;
                self.rows_affected = rows(v);
            }
            Err(err) => {
                self.ok = false;
                self.error = Some(err.clone());
            }
        }
        self
    }
}

fn audit_path(home: &Path, hash: &str) -> PathBuf {
    crate::store::project_dir(home, hash).join("db-audit.jsonl")
}

/// Appends one line, 0600, fsynced — `store::append_verification`'s shape,
/// including closing a torn line left by a previous crash.
pub fn append_audit(home: &Path, hash: &str, entry: &AuditEntry) -> Res<()> {
    use std::io::Write;
    let path = audit_path(home, hash);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| e("create project dir", err))?;
    }
    let line = serde_json::to_string(entry).map_err(|err| e("serialize audit entry", err))?;

    let mut opts = std::fs::OpenOptions::new();
    opts.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // The statement text is as sensitive as the credential file's contents.
        opts.mode(0o600);
    }
    let mut file = opts
        .open(&path)
        .map_err(|err| e(&format!("open {}", path.display()), err))?;
    if !crate::store::ends_with_newline(&path)? {
        file.write_all(b"\n").map_err(|err| e("close torn line", err))?;
    }
    file.write_all(line.as_bytes()).map_err(|err| e("append audit entry", err))?;
    file.write_all(b"\n").map_err(|err| e("append newline", err))?;
    file.sync_all().map_err(|err| e("fsync audit log", err))?;
    Ok(())
}

/// Every recorded entry for a project, oldest first. Unparseable lines are
/// skipped rather than failing the read — a torn tail must not hide the
/// history before it.
pub fn read_audit(home: &Path, hash: &str) -> Res<Vec<AuditEntry>> {
    match std::fs::read_to_string(audit_path(home, hash)) {
        Ok(body) => Ok(body
            .lines()
            .filter(|l| !l.trim().is_empty())
            .filter_map(|l| serde_json::from_str(l).ok())
            .collect()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(err) => Err(e("read audit log", err)),
    }
}

// ----------------------------------------------------------- SQL text shapes

/// Quotes an identifier for the target backend. Both engines accept
/// double-quoted identifiers; an embedded quote is doubled.
pub fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// Positional bind marker — Postgres numbers them, SQLite does not.
pub fn placeholder(backend: Backend, index: usize) -> String {
    match backend {
        Backend::Postgres => format!("${index}"),
        Backend::Sqlite => "?".to_string(),
    }
}

/// Quotes a value for *display only* (the SQL preview). Execution always binds
/// parameters — this string is never sent to a database.
fn literal(value: Option<&String>) -> String {
    match value {
        None => "NULL".to_string(),
        Some(v) => format!("'{}'", v.replace('\'', "''")),
    }
}

/// Statement shapes that destroy or restructure data without a narrowing
/// condition. A text-shape check, not a planner: `WHERE 1=1` slips past, which
/// is an accepted gap (design.md — Risks).
pub fn is_destructive(sql: &str) -> bool {
    let stripped = strip_sql_noise(sql);
    for statement in stripped.split(';') {
        let s = statement.trim();
        if s.is_empty() {
            continue;
        }
        let head = s.split_whitespace().next().unwrap_or("").to_uppercase();
        let has_where = s
            .split_whitespace()
            .any(|w| w.trim_matches(|c: char| !c.is_alphanumeric()).eq_ignore_ascii_case("where"));
        let destructive = match head.as_str() {
            "DROP" | "TRUNCATE" | "ALTER" => true,
            "DELETE" | "UPDATE" => !has_where,
            _ => false,
        };
        if destructive {
            return true;
        }
    }
    false
}

/// Removes comments and string literals so keyword matching can't be fooled by
/// a `-- drop` comment or a `'delete'` value.
fn strip_sql_noise(sql: &str) -> String {
    let mut out = String::with_capacity(sql.len());
    let mut chars = sql.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '-' if chars.peek() == Some(&'-') => {
                for c in chars.by_ref() {
                    if c == '\n' {
                        out.push('\n');
                        break;
                    }
                }
            }
            '/' if chars.peek() == Some(&'*') => {
                chars.next();
                let mut prev = ' ';
                for c in chars.by_ref() {
                    if prev == '*' && c == '/' {
                        break;
                    }
                    prev = c;
                }
                out.push(' ');
            }
            '\'' => {
                out.push_str("''");
                while let Some(c) = chars.next() {
                    if c == '\'' {
                        if chars.peek() == Some(&'\'') {
                            chars.next();
                            continue;
                        }
                        break;
                    }
                }
            }
            _ => out.push(c),
        }
    }
    out
}

// ------------------------------------------------------------- update builder

/// One row's pending edits: the values it was fetched with, plus the columns
/// the user changed. All values are the grid's text form (see `fetch_page`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowEdit {
    /// Every column value as originally fetched — the conflict fingerprint.
    pub original: BTreeMap<String, Option<String>>,
    /// Only the columns the user changed.
    pub changes: BTreeMap<String, Option<String>>,
}

/// A ready-to-run `UPDATE`: parameterised SQL plus its binds, and the same
/// statement rendered with literals for the preview the user signs off on.
#[derive(Debug, Clone, PartialEq)]
pub struct Update {
    pub sql: String,
    pub binds: Vec<Option<String>>,
    pub preview: String,
}

/// Builds the `UPDATE` for one edited row.
///
/// `WHERE` matches the primary key **and** every other originally fetched
/// value (D10), compared as text so any column type participates: a zero-row
/// result then means the row changed underneath the user, not that the row is
/// gone. Casts are explicit because the grid round-trips everything as text.
pub fn build_update(
    backend: Backend,
    table_ref: &str,
    columns: &[ColumnInfo],
    edit: &RowEdit,
) -> Res<Update> {
    if edit.changes.is_empty() {
        return Err("no changes for this row".into());
    }
    let pk: Vec<&ColumnInfo> = columns.iter().filter(|c| c.primary_key).collect();
    if pk.is_empty() {
        return Err(format!(
            "{table_ref} has no primary key among the fetched columns, so its rows can't be updated safely"
        ));
    }
    let type_of = |name: &str| columns.iter().find(|c| c.name == name).map(|c| c.data_type.clone());

    let mut binds: Vec<Option<String>> = Vec::new();
    let mut set = Vec::new();
    let mut set_preview = Vec::new();
    for (col, value) in &edit.changes {
        if type_of(col).is_none() {
            return Err(format!("unknown column {col}"));
        }
        binds.push(value.clone());
        let bound = cast(backend, &placeholder(backend, binds.len()), type_of(col).as_deref());
        set.push(format!("{} = {bound}", quote_ident(col)));
        set_preview.push(format!(
            "{} = {}",
            quote_ident(col),
            cast(backend, &literal(value.as_ref()), type_of(col).as_deref())
        ));
    }

    let mut wheres = Vec::new();
    let mut where_preview = Vec::new();
    // Primary key first so the preview reads the way the user thinks about the
    // row, then the rest of the fingerprint.
    let ordered = pk
        .iter()
        .map(|c| c.name.clone())
        .chain(columns.iter().filter(|c| !c.primary_key).map(|c| c.name.clone()));
    for col in ordered {
        let Some(original) = edit.original.get(&col) else {
            return Err(format!("row is missing original value for {col}"));
        };
        binds.push(original.clone());
        let ph = placeholder(backend, binds.len());
        wheres.push(text_match(backend, &col, &ph));
        where_preview.push(text_match(backend, &col, &literal(original.as_ref())));
    }

    let render = |set: &[String], wheres: &[String]| {
        format!("UPDATE {table_ref} SET {} WHERE {}", set.join(", "), wheres.join(" AND "))
    };
    Ok(Update {
        sql: render(&set, &wheres),
        binds,
        preview: render(&set_preview, &where_preview),
    })
}

/// NULL-safe text comparison. Postgres spells it `IS NOT DISTINCT FROM`;
/// SQLite spells it `IS`. Both make a NULL original match a NULL current value
/// instead of dropping the row from the match.
fn text_match(backend: Backend, column: &str, value: &str) -> String {
    let col = format!("CAST({} AS TEXT)", quote_ident(column));
    match backend {
        Backend::Postgres => format!("{col} IS NOT DISTINCT FROM {value}"),
        Backend::Sqlite => format!("{col} IS {value}"),
    }
}

/// Postgres refuses to assign text to a typed column, so every bind is cast
/// back to the column's own type. SQLite is dynamically typed and needs none.
fn cast(backend: Backend, value: &str, data_type: Option<&str>) -> String {
    match (backend, data_type) {
        (Backend::Postgres, Some(t)) => format!("CAST({value} AS {t})"),
        _ => value.to_string(),
    }
}

// ------------------------------------------------------------------ metadata

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
    pub primary_key: bool,
}

// ------------------------------------------------------------------- runtime

/// D15: fixed page size. Not a setting until someone wants a different number.
pub const PAGE_SIZE: i64 = 200;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableInfo {
    pub schema: Option<String>,
    pub name: String,
    /// `"table"` or `"view"` — D16 stops there.
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sort {
    pub column: String,
    pub descending: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Filter {
    pub column: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub columns: Vec<ColumnInfo>,
    /// Every value as text, `None` for SQL NULL — the grid needs those two
    /// apart, and text is the one representation both backends can produce for
    /// any column type through `sqlx::Any`.
    pub rows: Vec<Vec<Option<String>>>,
    pub page: i64,
    pub page_size: i64,
    pub has_more: bool,
    /// False when no primary key is among the fetched columns (D9).
    pub editable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Option<String>>>,
    /// Set for statements that return a count rather than rows.
    pub rows_affected: Option<i64>,
}

fn pools() -> &'static std::sync::Mutex<std::collections::HashMap<String, sqlx::AnyPool>> {
    static POOLS: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<String, sqlx::AnyPool>>,
    > = std::sync::OnceLock::new();
    POOLS.get_or_init(Default::default)
}

/// One pool per connection URL, created on first use and kept for the life of
/// the app — reconnecting per query would make every keystroke in a filter box
/// a fresh handshake.
pub async fn pool_for(conn: &DbConnection) -> Res<sqlx::AnyPool> {
    let key = conn.pool_key();
    if let Some(pool) = pools().lock().ok().and_then(|p| p.get(&key).cloned()) {
        return Ok(pool);
    }
    sqlx::any::install_default_drivers();
    // The one place a password is read (D23): listing connections never gets
    // here, so opening the panel raises no OS authorization prompt.
    let pool = sqlx::any::AnyPoolOptions::new()
        .max_connections(4)
        .connect(&conn.to_url())
        .await
        .map_err(|err| e(&format!("connect to {}", conn.name), err))?;
    if let Ok(mut map) = pools().lock() {
        map.insert(key, pool.clone());
    }
    Ok(pool)
}

/// Drops the cached pool so the next use reconnects — what a removed connection
/// needs, and the only way changed details take effect.
pub fn forget_pool(conn: &DbConnection) {
    if let Ok(mut map) = pools().lock() {
        map.remove(&conn.pool_key());
    }
}

fn table_ref(schema: Option<&str>, name: &str) -> String {
    match schema {
        Some(s) if !s.is_empty() => format!("{}.{}", quote_ident(s), quote_ident(name)),
        _ => quote_ident(name),
    }
}

/// Reads one column of one row as text. Values come back as text wherever
/// Palisade writes the query (`fetch_page` casts everything), so the fallbacks
/// only matter for user-written SQL selecting a type `sqlx::Any` can't decode.
fn cell(row: &sqlx::any::AnyRow, i: usize) -> Option<String> {
    use sqlx::{Row, ValueRef};
    if row.try_get_raw(i).map(|v| v.is_null()).unwrap_or(false) {
        return None;
    }
    row.try_get::<String, _>(i)
        .ok()
        .or_else(|| row.try_get::<i64, _>(i).ok().map(|v| v.to_string()))
        .or_else(|| row.try_get::<f64, _>(i).ok().map(|v| v.to_string()))
        .or_else(|| row.try_get::<bool, _>(i).ok().map(|v| v.to_string()))
        // ponytail: one honest placeholder beats a per-type decoder table;
        // add decoding when a real column type shows up unreadable.
        .or_else(|| Some("<unreadable value>".to_string()))
}

fn rows_of(rows: &[sqlx::any::AnyRow]) -> Vec<Vec<Option<String>>> {
    use sqlx::Row;
    rows.iter()
        .map(|r| (0..r.len()).map(|i| cell(r, i)).collect())
        .collect()
}

/// Tables and views, both backends, under one shape (D16).
pub async fn list_tables(conn: &DbConnection) -> Res<Vec<TableInfo>> {
    bounded("listing tables", list_tables_inner(conn)).await
}

async fn list_tables_inner(conn: &DbConnection) -> Res<Vec<TableInfo>> {
    let pool = pool_for(conn).await?;
    let sql = match conn.backend() {
        Backend::Postgres => {
            "SELECT table_schema::text, table_name::text, \
             CASE WHEN table_type = 'VIEW' THEN 'view' ELSE 'table' END \
             FROM information_schema.tables \
             WHERE table_schema NOT IN ('pg_catalog', 'information_schema') \
             ORDER BY table_schema, table_name"
        }
        Backend::Sqlite => {
            "SELECT NULL, name, type FROM sqlite_master \
             WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' \
             ORDER BY name"
        }
    };
    let rows = sqlx::query(sql)
        .fetch_all(&pool)
        .await
        .map_err(|err| e("list tables", err))?;
    Ok(rows_of(&rows)
        .into_iter()
        .map(|r| TableInfo {
            schema: r.first().cloned().flatten(),
            name: r.get(1).cloned().flatten().unwrap_or_default(),
            kind: r.get(2).cloned().flatten().unwrap_or_else(|| "table".into()),
        })
        .collect())
}

/// Column names, their own type, and whether they're part of the primary key.
/// The type is what a text bind gets cast back to on write (Postgres) and what
/// decides whether the grid is editable at all (D9).
pub async fn columns_of(conn: &DbConnection, schema: Option<&str>, table: &str) -> Res<Vec<ColumnInfo>> {
    bounded("reading columns", columns_of_inner(conn, schema, table)).await
}

async fn columns_of_inner(conn: &DbConnection, schema: Option<&str>, table: &str) -> Res<Vec<ColumnInfo>> {
    let pool = pool_for(conn).await?;
    let rows = match conn.backend() {
        Backend::Postgres => {
            sqlx::query(
                "SELECT c.column_name::text, c.udt_name::text, (pk.attname IS NOT NULL)::text \
                 FROM information_schema.columns c \
                 LEFT JOIN ( \
                   SELECT a.attname FROM pg_index i \
                   JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) \
                   WHERE i.indrelid = format('%I.%I', $1::text, $2::text)::regclass AND i.indisprimary \
                 ) pk ON pk.attname = c.column_name \
                 WHERE c.table_schema = $1 AND c.table_name = $2 \
                 ORDER BY c.ordinal_position",
            )
            .bind(schema.unwrap_or("public"))
            .bind(table)
            .fetch_all(&pool)
            .await
        }
        Backend::Sqlite => {
            sqlx::query(
                "SELECT name, type, CAST(pk AS TEXT) FROM pragma_table_info(?) ORDER BY cid",
            )
            .bind(table)
            .fetch_all(&pool)
            .await
        }
    }
    .map_err(|err| e(&format!("describe {table}"), err))?;

    let columns: Vec<ColumnInfo> = rows_of(&rows)
        .into_iter()
        .map(|r| ColumnInfo {
            name: r.first().cloned().flatten().unwrap_or_default(),
            data_type: r.get(1).cloned().flatten().unwrap_or_default(),
            primary_key: matches!(r.get(2).cloned().flatten().as_deref(), Some("true") | Some("t"))
                || r.get(2)
                    .cloned()
                    .flatten()
                    .and_then(|v| v.parse::<i64>().ok())
                    .is_some_and(|v| v > 0),
        })
        .collect();
    if columns.is_empty() {
        return Err(format!("no such table: {table}"));
    }
    Ok(columns)
}

/// One page of a table. Every value is cast to text in SQL so any column type
/// survives `sqlx::Any`, and NULL stays `None` rather than collapsing into an
/// empty string.
pub async fn fetch_page(
    conn: &DbConnection,
    schema: Option<&str>,
    table: &str,
    page: i64,
    sort: Option<&Sort>,
    filter: Option<&Filter>,
) -> Res<Page> {
    bounded("reading rows", fetch_page_inner(conn, schema, table, page, sort, filter)).await
}

async fn fetch_page_inner(
    conn: &DbConnection,
    schema: Option<&str>,
    table: &str,
    page: i64,
    sort: Option<&Sort>,
    filter: Option<&Filter>,
) -> Res<Page> {
    let pool = pool_for(conn).await?;
    let columns = columns_of(conn, schema, table).await?;
    let known = |name: &str| columns.iter().any(|c| c.name == name);

    let projection = columns
        .iter()
        .map(|c| format!("CAST({0} AS TEXT) AS {0}", quote_ident(&c.name)))
        .collect::<Vec<_>>()
        .join(", ");

    let mut sql = format!("SELECT {projection} FROM {}", table_ref(schema, table));
    let mut binds: Vec<String> = Vec::new();
    if let Some(f) = filter.filter(|f| !f.value.is_empty()) {
        if !known(&f.column) {
            return Err(format!("no column {} on {table}", f.column));
        }
        binds.push(format!("%{}%", f.value));
        sql.push_str(&format!(
            " WHERE CAST({} AS TEXT) LIKE {}",
            quote_ident(&f.column),
            placeholder(conn.backend(), binds.len())
        ));
    }
    if let Some(s) = sort {
        if !known(&s.column) {
            return Err(format!("no column {} on {table}", s.column));
        }
        // Qualified with the table, not bare: the projection above aliases
        // `CAST(col AS TEXT)` back to `col`, and a bare ORDER BY name binds to
        // that output alias — so an INTEGER column sorted as text
        // (10, 11, ... 19, 2, 20). Naming the table forces the real column and
        // the database's own type ordering.
        sql.push_str(&format!(
            " ORDER BY {}.{} {}",
            table_ref(schema, table),
            quote_ident(&s.column),
            if s.descending { "DESC" } else { "ASC" }
        ));
    }
    let page = page.max(0);
    // One extra row is the whole pagination story: it answers "is there a next
    // page" without a second COUNT(*) over the table.
    sql.push_str(&format!(
        " LIMIT {} OFFSET {}",
        PAGE_SIZE + 1,
        page * PAGE_SIZE
    ));

    let mut q = sqlx::query(&sql);
    for b in &binds {
        q = q.bind(b.clone());
    }
    let rows = q.fetch_all(&pool).await.map_err(|err| e(&format!("read {table}"), err))?;
    let mut rows = rows_of(&rows);
    let has_more = rows.len() as i64 > PAGE_SIZE;
    rows.truncate(PAGE_SIZE as usize);

    Ok(Page {
        editable: columns.iter().any(|c| c.primary_key),
        columns,
        rows,
        page,
        page_size: PAGE_SIZE,
        has_more,
    })
}

/// Runs user-written SQL. Statements that return rows are fetched; everything
/// else reports an affected-row count.
pub async fn run_query(conn: &DbConnection, sql: &str) -> Res<QueryResult> {
    bounded("query", run_query_inner(conn, sql)).await
}

async fn run_query_inner(conn: &DbConnection, sql: &str) -> Res<QueryResult> {
    use sqlx::{Column, Executor, Row};
    let pool = pool_for(conn).await?;
    let head = sql
        .trim_start()
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_uppercase();
    // ponytail: first-keyword split, not a parser. A statement that returns
    // rows but isn't spelled this way just reports a count instead.
    let returns_rows = matches!(
        head.as_str(),
        "SELECT" | "WITH" | "VALUES" | "SHOW" | "EXPLAIN" | "PRAGMA" | "TABLE"
    );
    if returns_rows {
        let rows = pool.fetch_all(sql).await.map_err(|err| e("query", err))?;
        let columns = rows
            .first()
            .map(|r| r.columns().iter().map(|c| c.name().to_string()).collect())
            .unwrap_or_default();
        Ok(QueryResult { columns, rows: rows_of(&rows), rows_affected: None })
    } else {
        let done = pool.execute(sql).await.map_err(|err| e("query", err))?;
        Ok(QueryResult {
            columns: Vec::new(),
            rows: Vec::new(),
            rows_affected: Some(done.rows_affected() as i64),
        })
    }
}

async fn updates_for(
    conn: &DbConnection,
    schema: Option<&str>,
    table: &str,
    edits: &[RowEdit],
) -> Res<Vec<Update>> {
    let columns = columns_of(conn, schema, table).await?;
    let table_ref = table_ref(schema, table);
    edits
        .iter()
        .map(|edit| build_update(conn.backend(), &table_ref, &columns, edit))
        .collect()
}

/// The exact statements `apply_edits` would run, before any of them run.
pub async fn preview_edits(
    conn: &DbConnection,
    schema: Option<&str>,
    table: &str,
    edits: &[RowEdit],
) -> Res<Vec<String>> {
    Ok(updates_for(conn, schema, table, edits)
        .await?
        .into_iter()
        .map(|u| u.preview + ";")
        .collect())
}

/// Applies every pending edit inside one transaction (D11). A statement that
/// touches no row means the row changed since it was fetched (D10) — that is a
/// conflict, and it rolls the whole batch back rather than half-writing it.
pub async fn apply_edits(
    conn: &DbConnection,
    schema: Option<&str>,
    table: &str,
    edits: &[RowEdit],
) -> Res<i64> {
    bounded("applying edits", apply_edits_inner(conn, schema, table, edits)).await
}

async fn apply_edits_inner(
    conn: &DbConnection,
    schema: Option<&str>,
    table: &str,
    edits: &[RowEdit],
) -> Res<i64> {
    let updates = updates_for(conn, schema, table, edits).await?;
    let pool = pool_for(conn).await?;
    let mut tx = pool.begin().await.map_err(|err| e("begin transaction", err))?;
    let mut applied = 0i64;
    for (update, edit) in updates.iter().zip(edits) {
        let mut q = sqlx::query(&update.sql);
        for b in &update.binds {
            q = q.bind(b.clone());
        }
        let done = match q.execute(&mut *tx).await {
            Ok(done) => done,
            // Dropping `tx` unsent rolls the batch back.
            Err(err) => return Err(e("apply edits", err)),
        };
        if done.rows_affected() != 1 {
            return Err(format!(
                "conflict: {} changed in the database since it was loaded, so nothing was applied",
                describe_row(edit)
            ));
        }
        applied += 1;
    }
    tx.commit().await.map_err(|err| e("commit", err))?;
    Ok(applied)
}

/// Names the row a conflict is about, in the user's own terms.
fn describe_row(edit: &RowEdit) -> String {
    let shown: Vec<String> = edit
        .original
        .iter()
        .take(2)
        .map(|(k, v)| format!("{k}={}", v.clone().unwrap_or_else(|| "NULL".into())))
        .collect();
    format!("the row where {}", shown.join(", "))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pg_at(host: &str, port: u16, user: &str, db: &str) -> Details {
        Details::Postgres {
            host: host.into(),
            port,
            user: user.into(),
            database: db.into(),
        }
    }

    fn pg(host: &str, user: &str, db: &str) -> Details {
        Details::Postgres {
            host: host.into(),
            port: 5432,
            user: user.into(),
            database: db.into(),
        }
    }

    fn cols() -> Vec<ColumnInfo> {
        vec![
            ColumnInfo { name: "id".into(), data_type: "int4".into(), primary_key: true },
            ColumnInfo { name: "name".into(), data_type: "text".into(), primary_key: false },
            ColumnInfo { name: "note".into(), data_type: "text".into(), primary_key: false },
        ]
    }

    fn edit() -> RowEdit {
        RowEdit {
            original: BTreeMap::from([
                ("id".to_string(), Some("7".to_string())),
                ("name".to_string(), Some("ada".to_string())),
                ("note".to_string(), None),
            ]),
            changes: BTreeMap::from([("name".to_string(), Some("Ada".to_string()))]),
        }
    }

    #[test]
    fn backend_comes_from_the_url_scheme() {
        assert_eq!(backend_of("postgres://localhost/x"), Ok(Backend::Postgres));
        assert_eq!(backend_of("postgresql://localhost/x"), Ok(Backend::Postgres));
        assert_eq!(backend_of("sqlite://file.db"), Ok(Backend::Sqlite));
        assert!(backend_of("mysql://localhost/x").is_err());
        assert!(backend_of("just-a-path.db").is_err());
    }

    #[test]
    fn connections_round_trip_and_are_not_world_readable() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        let h = "round-trip";
        assert_eq!(list_connections(home, h).unwrap().0, Vec::new());

        let (dev, warning) =
            add_connection(home, h, "dev", pg("localhost", "ada", "dev"), Some("hunter2")).unwrap();
        assert_eq!(warning, None, "a working credential store warns about nothing");
        let (stg, _) = add_connection(
            home,
            h,
            "staging",
            Details::Sqlite { path: "stg.db".into() },
            None,
        )
        .unwrap();
        let (all, _) = list_connections(home, h).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].name, "dev");
        assert_eq!(all[0].password, None, "listing must not resolve secrets (D23)");
        assert_eq!(all[1].backend(), Backend::Sqlite);

        // The password is fetched only when connecting.
        let (opened, _) = with_secret(home, h, &all[0]).unwrap();
        assert_eq!(opened.password.as_deref(), Some("hunter2"));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let path = connections_path(home, h);
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "the file still names every connection");
            let body = std::fs::read_to_string(&path).unwrap();
            assert!(!body.contains("hunter2"), "password must not be in the file: {body}");
            assert!(body.contains("localhost"), "non-secret details stay readable");
        }

        rename_connection(home, h, &dev.id, "development").unwrap();
        assert_eq!(list_connections(home, h).unwrap().0[0].name, "development");

        remove_connection(home, h, &stg.id).unwrap();
        assert_eq!(list_connections(home, h).unwrap().0.len(), 1);
    }

    /// D16: the credential must not reach the frontend, and `DbConnection` is
    /// what crosses IPC.
    #[test]
    fn a_serialized_connection_never_carries_the_url() {
        let conn = DbConnection {
            id: "01".into(),
            name: "dev".into(),
            details: pg("localhost", "ada", "dev"),
            password: Some("hunter2".into()),
        };
        let json = serde_json::to_string(&conn).unwrap();
        assert!(!json.contains("hunter2"), "credential crossed IPC: {json}");
        assert!(!json.contains("url"), "url field crossed IPC: {json}");
        assert!(json.contains("\"name\":\"dev\""));
    }

    /// D8: no credential store means the file carries the secret and the user
    /// is told — never silently, never a refusal to save.
    #[test]
    fn no_credential_store_falls_back_to_the_file_with_a_warning() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        let h = "no-store";
        vault::set_unavailable(h);

        let (conn, warning) =
            add_connection(home, h, "dev", pg("localhost", "ada", "dev"), Some("hunter2")).unwrap();
        assert!(warning.unwrap().contains("instead of the OS credential store"));

        let body = std::fs::read_to_string(connections_path(home, h)).unwrap();
        assert!(body.contains("hunter2"), "fallback must persist the password");

        let (all, _) = list_connections(home, h).unwrap();
        assert_eq!(all.len(), 1, "the connection is still usable");
        assert_eq!(all[0].id, conn.id);
        let (opened, _) = with_secret(home, h, &all[0]).unwrap();
        assert_eq!(opened.password.as_deref(), Some("hunter2"), "resolves from the file");
    }

    /// D9/D23: a pre-fields entry splits on first *connect*, not on list.
    #[test]
    fn a_legacy_url_connection_splits_on_connect() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        let h = "migrate";
        // Exactly what a version before the field split wrote.
        let legacy = vec![StoredConnection {
            id: "01ABC".into(),
            name: "dev".into(),
            backend: Backend::Postgres,
            url: Some("postgres://ada:hunter2@db.internal:6543/app".into()),
            ..Default::default()
        }];
        save_stored(home, h, &legacy).unwrap();

        // Listing shows the parsed details and touches nothing.
        let (all, warning) = list_connections(home, h).unwrap();
        assert_eq!(warning, None);
        assert_eq!(all[0].details, pg_at("db.internal", 6543, "ada", "app"));
        assert!(
            std::fs::read_to_string(connections_path(home, h)).unwrap().contains("hunter2"),
            "listing must not rewrite the file (D23)"
        );

        // Connecting splits it: password to the store, URL gone from the file.
        let (opened, warning) = with_secret(home, h, &all[0]).unwrap();
        assert_eq!(warning, None);
        assert_eq!(opened.password.as_deref(), Some("hunter2"));
        let body = std::fs::read_to_string(connections_path(home, h)).unwrap();
        assert!(!body.contains("hunter2"), "password must leave the file: {body}");
        assert!(!body.contains("postgres://"), "the url must be gone: {body}");
        assert!(body.contains("db.internal"), "details stay readable");
        assert!(vault::has(h, "01ABC"));

        // Idempotent.
        let (again, _) = with_secret(home, h, &list_connections(home, h).unwrap().0[0]).unwrap();
        assert_eq!(again.password.as_deref(), Some("hunter2"));
    }

    /// D9: removal must not leave a credential no connection refers to.
    #[test]
    fn removing_a_connection_deletes_its_credential() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        let h = "removal";
        let (conn, _) =
            add_connection(home, h, "dev", pg("localhost", "ada", "dev"), Some("pw")).unwrap();
        assert!(vault::has(h, &conn.id));

        remove_connection(home, h, &conn.id).unwrap();
        assert!(!vault::has(h, &conn.id), "credential outlived its connection");
        assert_eq!(list_connections(home, h).unwrap().0.len(), 0);
    }

    #[test]
    fn a_broken_connection_string_is_never_saved() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(parse_url("mysql://x/y").is_err());
        assert!(add_connection(
            tmp.path(),
            "broken",
            "",
            Details::Sqlite { path: "x.db".into() },
            None
        )
        .is_err());
        assert_eq!(list_connections(tmp.path(), "broken").unwrap().0, Vec::new());
    }

    #[test]
    fn update_matches_primary_key_and_every_original_value() {
        let u = build_update(Backend::Postgres, &quote_ident("users"), &cols(), &edit()).unwrap();
        assert_eq!(
            u.sql,
            "UPDATE \"users\" SET \"name\" = CAST($1 AS text) WHERE \
             CAST(\"id\" AS TEXT) IS NOT DISTINCT FROM $2 AND \
             CAST(\"name\" AS TEXT) IS NOT DISTINCT FROM $3 AND \
             CAST(\"note\" AS TEXT) IS NOT DISTINCT FROM $4"
        );
        assert_eq!(
            u.binds,
            vec![Some("Ada".into()), Some("7".into()), Some("ada".into()), None]
        );
    }

    #[test]
    fn preview_shows_the_same_statement_with_literals() {
        let u = build_update(Backend::Postgres, &quote_ident("users"), &cols(), &edit()).unwrap();
        assert!(u.preview.contains("SET \"name\" = CAST('Ada' AS text)"));
        assert!(u.preview.contains("CAST(\"note\" AS TEXT) IS NOT DISTINCT FROM NULL"));
        assert!(!u.preview.contains('$'));
    }

    #[test]
    fn sqlite_uses_anonymous_placeholders_and_is_null_matching() {
        let u = build_update(Backend::Sqlite, &quote_ident("users"), &cols(), &edit()).unwrap();
        assert!(u.sql.starts_with("UPDATE \"users\" SET \"name\" = ? WHERE"));
        assert!(u.sql.contains("CAST(\"note\" AS TEXT) IS ?"));
        assert_eq!(u.binds.len(), 4);
    }

    #[test]
    fn a_quote_in_a_value_cannot_break_out_of_the_preview() {
        let mut edit = edit();
        edit.changes.insert("name".into(), Some("O'Hara'; DROP TABLE users--".into()));
        let u = build_update(Backend::Sqlite, &quote_ident("users"), &cols(), &edit).unwrap();
        assert!(u.preview.contains("'O''Hara''; DROP TABLE users--'"));
    }

    #[test]
    fn a_table_with_no_primary_key_cannot_be_updated() {
        let cols = vec![ColumnInfo { name: "a".into(), data_type: "text".into(), primary_key: false }];
        let edit = RowEdit {
            original: BTreeMap::from([("a".to_string(), Some("x".to_string()))]),
            changes: BTreeMap::from([("a".to_string(), Some("y".to_string()))]),
        };
        assert!(build_update(Backend::Sqlite, &quote_ident("t"), &cols, &edit).is_err());
    }

    // ------------------------------------------------------ against a real DB
    //
    // SQLite is the engine these run against: it's one of the two backends the
    // change ships (D6) and needs no server, so the read, write, conflict and
    // rollback paths are exercised for real rather than mocked.

    async fn fixture(dir: &Path) -> DbConnection {
        let conn = DbConnection {
            id: "t".into(),
            name: "test".into(),
            details: Details::Sqlite {
                path: format!("{}?mode=rwc", dir.join("t.db").display()),
            },
            password: None,
        };
        let pool = pool_for(&conn).await.unwrap();
        for sql in [
            "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, note TEXT)",
            "INSERT INTO users VALUES (1, 'ada', NULL), (2, 'grace', ''), (3, 'alan', 'x')",
            "CREATE VIEW recent AS SELECT * FROM users WHERE id > 1",
            "CREATE TABLE keyless (a TEXT)",
            "INSERT INTO keyless VALUES ('only')",
        ] {
            sqlx::query(sql).execute(&pool).await.unwrap();
        }
        conn
    }

    fn row_edit(id: &str, name: &str, note: Option<&str>, new_name: Option<&str>) -> RowEdit {
        RowEdit {
            original: BTreeMap::from([
                ("id".to_string(), Some(id.to_string())),
                ("name".to_string(), Some(name.to_string())),
                ("note".to_string(), note.map(str::to_string)),
            ]),
            changes: BTreeMap::from([("name".to_string(), new_name.map(str::to_string))]),
        }
    }

    #[tokio::test]
    async fn lists_tables_and_views_but_not_engine_internals() {
        let tmp = tempfile::tempdir().unwrap();
        let conn = fixture(tmp.path()).await;
        let tables = list_tables(&conn).await.unwrap();
        let names: Vec<(&str, &str)> = tables.iter().map(|t| (t.name.as_str(), t.kind.as_str())).collect();
        assert!(names.contains(&("users", "table")));
        assert!(names.contains(&("recent", "view")));
        assert!(!names.iter().any(|(n, _)| n.starts_with("sqlite_")));
    }

    #[tokio::test]
    async fn a_page_keeps_null_and_empty_string_apart() {
        let tmp = tempfile::tempdir().unwrap();
        let conn = fixture(tmp.path()).await;
        let page = fetch_page(&conn, None, "users", 0, None, None).await.unwrap();
        assert!(page.editable, "users has a primary key");
        assert_eq!(page.rows.len(), 3);
        assert_eq!(page.rows[0][2], None, "NULL stays None");
        assert_eq!(page.rows[1][2], Some(String::new()), "empty string stays empty string");
        assert!(!page.has_more);
    }

    #[tokio::test]
    async fn a_table_without_a_primary_key_comes_back_read_only() {
        let tmp = tempfile::tempdir().unwrap();
        let conn = fixture(tmp.path()).await;
        let page = fetch_page(&conn, None, "keyless", 0, None, None).await.unwrap();
        assert!(!page.editable);

        let err = apply_edits(
            &conn,
            None,
            "keyless",
            &[RowEdit {
                original: BTreeMap::from([("a".to_string(), Some("only".to_string()))]),
                changes: BTreeMap::from([("a".to_string(), Some("nope".to_string()))]),
            }],
        )
        .await
        .unwrap_err();
        assert!(err.contains("no primary key"), "{err}");
    }

    #[tokio::test]
    async fn a_numeric_column_sorts_numerically_not_as_text() {
        // Regression: rows come back as `CAST(col AS TEXT) AS col`, so a bare
        // `ORDER BY col` sorted the cast, giving 10, 11, ... 19, 2, 20, 3.
        let tmp = tempfile::tempdir().unwrap();
        let conn = fixture(tmp.path()).await;
        let pool = pool_for(&conn).await.unwrap();
        for id in [10, 20, 30, 4] {
            sqlx::query("INSERT INTO users VALUES (?, 'x', NULL)")
                .bind(id)
                .execute(&pool)
                .await
                .unwrap();
        }
        let page = fetch_page(
            &conn,
            None,
            "users",
            0,
            Some(&Sort { column: "id".into(), descending: false }),
            None,
        )
        .await
        .unwrap();
        let ids: Vec<String> =
            page.rows.iter().map(|r| r[0].clone().unwrap()).collect();
        assert_eq!(ids, ["1", "2", "3", "4", "10", "20", "30"]);
    }

    #[tokio::test]
    async fn sorting_and_filtering_narrow_the_page() {
        let tmp = tempfile::tempdir().unwrap();
        let conn = fixture(tmp.path()).await;
        let sorted = fetch_page(
            &conn,
            None,
            "users",
            0,
            Some(&Sort { column: "name".into(), descending: false }),
            None,
        )
        .await
        .unwrap();
        assert_eq!(sorted.rows[0][1], Some("ada".into()));
        assert_eq!(sorted.rows[2][1], Some("grace".into()));

        let filtered = fetch_page(
            &conn,
            None,
            "users",
            0,
            None,
            Some(&Filter { column: "name".into(), value: "a".into() }),
        )
        .await
        .unwrap();
        assert_eq!(filtered.rows.len(), 3, "every name contains an 'a'");

        let narrower = fetch_page(
            &conn,
            None,
            "users",
            0,
            None,
            Some(&Filter { column: "name".into(), value: "an".into() }),
        )
        .await
        .unwrap();
        assert_eq!(narrower.rows.len(), 1, "only alan contains 'an'");

        assert!(fetch_page(
            &conn,
            None,
            "users",
            0,
            Some(&Sort { column: "nope".into(), descending: false }),
            None
        )
        .await
        .is_err());
    }

    #[tokio::test]
    async fn pages_stop_at_the_page_size_and_report_more() {
        let tmp = tempfile::tempdir().unwrap();
        let conn = fixture(tmp.path()).await;
        let pool = pool_for(&conn).await.unwrap();
        sqlx::query(&format!(
            "INSERT INTO users (name) WITH RECURSIVE c(x) AS \
             (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < {}) SELECT 'bulk' FROM c",
            PAGE_SIZE + 5
        ))
        .execute(&pool)
        .await
        .unwrap();

        let first = fetch_page(&conn, None, "users", 0, None, None).await.unwrap();
        assert_eq!(first.rows.len() as i64, PAGE_SIZE);
        assert!(first.has_more);
        let second = fetch_page(&conn, None, "users", 1, None, None).await.unwrap();
        assert_eq!(second.rows.len() as i64, PAGE_SIZE + 8 - PAGE_SIZE);
        assert!(!second.has_more);
    }

    #[tokio::test]
    async fn preview_shows_the_statements_apply_will_run() {
        let tmp = tempfile::tempdir().unwrap();
        let conn = fixture(tmp.path()).await;
        let preview = preview_edits(&conn, None, "users", &[row_edit("1", "ada", None, Some("Ada"))])
            .await
            .unwrap();
        assert_eq!(preview.len(), 1);
        assert!(preview[0].starts_with("UPDATE \"users\" SET \"name\" = 'Ada' WHERE"));
        assert!(preview[0].ends_with(';'));
    }

    #[tokio::test]
    async fn applying_edits_writes_them_together() {
        let tmp = tempfile::tempdir().unwrap();
        let conn = fixture(tmp.path()).await;
        let applied = apply_edits(
            &conn,
            None,
            "users",
            &[
                row_edit("1", "ada", None, Some("Ada")),
                row_edit("2", "grace", Some(""), None),
            ],
        )
        .await
        .unwrap();
        assert_eq!(applied, 2);

        let page = fetch_page(&conn, None, "users", 0, None, None).await.unwrap();
        assert_eq!(page.rows[0][1], Some("Ada".into()));
        assert_eq!(page.rows[1][1], None, "an explicit NULL edit lands as NULL");
    }

    #[tokio::test]
    async fn a_row_changed_elsewhere_is_a_conflict_and_nothing_is_written() {
        let tmp = tempfile::tempdir().unwrap();
        let conn = fixture(tmp.path()).await;
        let pool = pool_for(&conn).await.unwrap();
        // Someone else edits row 2 after the grid loaded it.
        sqlx::query("UPDATE users SET name = 'Grace' WHERE id = 2")
            .execute(&pool)
            .await
            .unwrap();

        let err = apply_edits(
            &conn,
            None,
            "users",
            &[
                row_edit("1", "ada", None, Some("Ada")),
                row_edit("2", "grace", Some(""), Some("GRACE")),
            ],
        )
        .await
        .unwrap_err();
        assert!(err.contains("conflict"), "{err}");
        assert!(err.contains("id=2"), "the conflicting row is named: {err}");

        let page = fetch_page(&conn, None, "users", 0, None, None).await.unwrap();
        assert_eq!(page.rows[0][1], Some("ada".into()), "the good edit rolled back too");
        assert_eq!(page.rows[1][1], Some("Grace".into()), "the other writer's value survived");
    }

    #[tokio::test]
    async fn queries_return_rows_or_a_count_or_an_error() {
        let tmp = tempfile::tempdir().unwrap();
        let conn = fixture(tmp.path()).await;

        let read = run_query(&conn, "SELECT id, name FROM users ORDER BY id").await.unwrap();
        assert_eq!(read.columns, vec!["id", "name"]);
        assert_eq!(read.rows.len(), 3);
        assert_eq!(read.rows_affected, None);

        let write = run_query(&conn, "UPDATE users SET note = 'seen' WHERE id > 1").await.unwrap();
        assert_eq!(write.rows_affected, Some(2));
        assert!(write.rows.is_empty());

        let err = run_query(&conn, "SELECT * FROM nope").await.unwrap_err();
        assert!(err.contains("nope"), "the database's own message survives: {err}");
    }

    #[test]
    fn destructive_shapes_are_the_ones_that_get_gated() {
        for sql in [
            "DELETE FROM users",
            "delete from users;",
            "UPDATE users SET a = 1",
            "DROP TABLE users",
            "TRUNCATE users",
            "ALTER TABLE users ADD COLUMN x int",
            "SELECT 1; DELETE FROM users",
        ] {
            assert!(is_destructive(sql), "expected gated: {sql}");
        }
        for sql in [
            "SELECT * FROM users",
            "DELETE FROM users WHERE id = 1",
            "UPDATE users SET a = 1 WHERE id = 2",
            "INSERT INTO users (a) VALUES (1)",
            "SELECT 'delete from users' AS s",
            "SELECT 1 -- drop table users",
        ] {
            assert!(!is_destructive(sql), "expected ungated: {sql}");
        }
    }

    // ------------------------------------------------------- query history

    fn conn_for_audit() -> DbConnection {
        DbConnection {
            id: "01AUDIT".into(),
            name: "prod".into(),
            details: pg("db.internal", "ada", "prod"),
            password: Some("hunter2".into()),
        }
    }

    /// D4: the log must never become a second place the credential lives.
    #[test]
    fn an_audit_entry_never_carries_the_connection_url() {
        let tmp = tempfile::tempdir().unwrap();
        let conn = conn_for_audit();
        let entry = AuditEntry::new("query", &conn)
            .statement("select * from users where email = 'a@b.c'")
            .outcome(&Ok::<i64, String>(3), |r: &i64| Some(*r));
        append_audit(tmp.path(), "h", &entry).unwrap();

        let body = std::fs::read_to_string(audit_path(tmp.path(), "h")).unwrap();
        assert!(!body.contains("hunter2"), "credential reached the log: {body}");
        assert!(!body.contains("ada"), "user reached the log: {body}");
        assert!(body.contains("prod"), "the connection is still identifiable");
        assert!(body.contains("a@b.c"), "statement text is kept verbatim (D4)");
    }

    #[test]
    fn entries_append_in_order_and_survive_a_torn_line() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        let conn = conn_for_audit();

        append_audit(home, "h", &AuditEntry::new("connection.add", &conn)).unwrap();
        append_audit(
            home,
            "h",
            &AuditEntry::new("edit", &conn)
                .at(Some("public"), "users")
                .outcome(&Ok::<i64, String>(2), |r: &i64| Some(*r)),
        )
        .unwrap();

        // A crash mid-write leaves no trailing newline; the next append must
        // not glue two records together.
        {
            use std::io::Write;
            let mut f = std::fs::OpenOptions::new()
                .append(true)
                .open(audit_path(home, "h"))
                .unwrap();
            f.write_all(b"{\"ts\":\"broken").unwrap();
        }
        append_audit(home, "h", &AuditEntry::new("query", &conn).statement("select 1")).unwrap();

        let all = read_audit(home, "h").unwrap();
        assert_eq!(all.len(), 3, "the torn line is skipped, the rest survive");
        assert_eq!(all[0].kind, "connection.add");
        assert_eq!(all[1].kind, "edit");
        assert_eq!(all[1].table.as_deref(), Some("users"));
        assert_eq!(all[1].rows_affected, Some(2));
        assert_eq!(all[2].statement.as_deref(), Some("select 1"));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(audit_path(home, "h")).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "statement text is as sensitive as the credential file");
        }
    }

    /// D6 (amended): a failure is recorded as one, not swallowed into `ok`.
    #[test]
    fn a_failed_operation_is_recorded_as_failed() {
        let tmp = tempfile::tempdir().unwrap();
        let conn = conn_for_audit();
        let failed: Res<i64> = Err("relation \"nope\" does not exist".into());
        append_audit(
            tmp.path(),
            "h",
            &AuditEntry::new("query", &conn)
                .statement("select * from nope")
                .outcome(&failed, |r: &i64| Some(*r)),
        )
        .unwrap();

        let all = read_audit(tmp.path(), "h").unwrap();
        assert!(!all[0].ok);
        assert!(all[0].error.as_deref().unwrap().contains("does not exist"));
        assert_eq!(all[0].rows_affected, None);
    }

    #[test]
    fn no_history_file_reads_as_empty_not_an_error() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(read_audit(tmp.path(), "never-used").unwrap().len(), 0);
    }

    // ------------------------------------------------------------ timeout

    /// D10: the bound reports a timeout distinctly from a query error, and the
    /// abandoned work does not poison what runs next.
    #[tokio::test]
    async fn a_slow_operation_times_out_and_the_next_one_still_runs() {
        // Stands in for a statement the server is still chewing on. The real
        // 30s bound is not something a test should wait for, so the duration
        // is injected — the code path under test is the shipped one.
        let hung = async {
            tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
            Ok::<i64, String>(1)
        };
        let err = bounded_for(std::time::Duration::from_millis(50), "query", hung)
            .await
            .expect_err("a hung operation must not report success");
        assert!(err.contains("timed out"), "a timeout must not read as a query error");
        assert!(err.contains("query"), "the message names the operation");

        // And the shipped bound is the one D10 specifies.
        assert_eq!(QUERY_TIMEOUT.as_secs(), 30);

        // The helper passes a fast operation straight through.
        let ok = bounded("query", async { Ok::<i64, String>(7) }).await.unwrap();
        assert_eq!(ok, 7);
    }

    /// The bound must not truncate ordinary work.
    #[tokio::test]
    async fn a_fast_operation_is_unaffected_by_the_bound() {
        let out = bounded("reading rows", async {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            Ok::<&str, String>("done")
        })
        .await;
        assert_eq!(out.unwrap(), "done");
    }

    // -------------------------------------------------- connection details

    /// D24: the paste shortcut must survive a round trip, including the
    /// characters that would otherwise end a URL component.
    #[test]
    fn a_pasted_url_splits_into_fields_and_rebuilds() {
        let (details, password) = parse_url("postgres://ada:p%40ss%2Fword@db.internal:6543/app").unwrap();
        assert_eq!(details, pg_at("db.internal", 6543, "ada", "app"));
        assert_eq!(password.as_deref(), Some("p@ss/word"), "percent-encoding decoded");

        let conn = DbConnection {
            id: "1".into(),
            name: "n".into(),
            details,
            password,
        };
        let (again, pw) = parse_url(&conn.to_url()).unwrap();
        assert_eq!(again, conn.details, "details survive the round trip");
        assert_eq!(pw.as_deref(), Some("p@ss/word"), "so does an awkward password");
    }

    #[test]
    fn url_parsing_covers_the_shapes_users_actually_paste() {
        // No port: Postgres' default.
        let (d, _) = parse_url("postgres://localhost/dev").unwrap();
        assert_eq!(d, pg_at("localhost", 5432, "", "dev"));
        // The `postgresql://` spelling.
        assert_eq!(parse_url("postgresql://h/d").unwrap().0.backend(), Backend::Postgres);
        // SQLite is a path and carries no secret.
        let (d, pw) = parse_url("sqlite:///tmp/app.db").unwrap();
        assert_eq!(d, Details::Sqlite { path: "/tmp/app.db".into() });
        assert_eq!(pw, None);
        assert!(!d.has_secret());
        // Rejections stay explicit.
        assert!(parse_url("mysql://h/d").unwrap_err().contains("unsupported"));
        assert!(parse_url("localhost/dev").unwrap_err().contains("scheme"));
        assert!(parse_url("postgres://h:notaport/d").unwrap_err().contains("valid port"));
    }

    /// D22: a SQLite connection has no secret, so it must never reach the
    /// credential store — which is what removes the OS prompt for it entirely.
    #[test]
    fn a_sqlite_connection_never_touches_the_credential_store() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        let h = "sqlite-only";
        // Any vault access at all would fail here.
        vault::set_unavailable(h);

        let (conn, warning) = add_connection(
            home,
            h,
            "local",
            Details::Sqlite { path: "app.db".into() },
            None,
        )
        .unwrap();
        assert_eq!(warning, None, "no store access means nothing to warn about");

        let (all, warning) = list_connections(home, h).unwrap();
        assert_eq!(warning, None);
        assert_eq!(all.len(), 1);

        let (opened, warning) = with_secret(home, h, &all[0]).unwrap();
        assert_eq!(warning, None);
        assert_eq!(opened.password, None);
        assert_eq!(opened.to_url(), "sqlite://app.db");
        assert!(!vault::has(h, &conn.id));
    }

    /// D23: the whole point of the field split — listing reads no secrets, so
    /// opening the panel raises no OS prompt.
    #[test]
    fn listing_connections_reads_no_secrets() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        let h = "listing";
        add_connection(home, h, "dev", pg("localhost", "ada", "dev"), Some("hunter2")).unwrap();

        // A store that errors on every access proves listing never calls it.
        vault::set_unavailable(h);
        let (all, warning) = list_connections(home, h).unwrap();
        assert_eq!(warning, None, "listing must not report a store failure it never caused");
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].name, "dev");
        assert_eq!(all[0].password, None);
        match &all[0].details {
            Details::Postgres { host, user, .. } => {
                assert_eq!(host, "localhost");
                assert_eq!(user, "ada", "non-secret details are listable");
            }
            other => panic!("wrong backend: {other:?}"),
        }
    }

    /// The pool key must not become a place the password lives.
    #[test]
    fn the_pool_key_carries_no_password() {
        let conn = DbConnection {
            id: "1".into(),
            name: "n".into(),
            details: pg("localhost", "ada", "dev"),
            password: Some("hunter2".into()),
        };
        assert!(!conn.pool_key().contains("hunter2"));
        assert!(conn.to_url().contains("hunter2"), "but the live URL still connects");
    }

    /// A record written by a build that kept the whole connection string in the
    /// credential store: no fields and no url on disk. It must stay listed and
    /// repair itself on connect, not vanish from the panel.
    #[test]
    fn a_connection_whose_details_live_in_the_vault_recovers_on_connect() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        let h = "vault-only";
        save_stored(
            home,
            h,
            &[StoredConnection {
                id: "01OLD".into(),
                name: "demo".into(),
                backend: Backend::Sqlite,
                ..Default::default()
            }],
        )
        .unwrap();
        vault::set(h, "01OLD", "sqlite:///tmp/demo.db").unwrap();

        // Listed, not dropped — and still without reading the store.
        let (all, _) = list_connections(home, h).unwrap();
        assert_eq!(all.len(), 1, "the connection must not disappear from the panel");
        assert_eq!(all[0].name, "demo");
        assert!(all[0].details.is_placeholder());

        // Connecting recovers and splits it.
        let (opened, warning) = with_secret(home, h, &all[0]).unwrap();
        assert_eq!(warning, None);
        assert_eq!(opened.details, Details::Sqlite { path: "/tmp/demo.db".into() });
        assert_eq!(opened.to_url(), "sqlite:///tmp/demo.db");

        // Repaired on disk, so the next listing needs no recovery.
        let (all, _) = list_connections(home, h).unwrap();
        assert!(!all[0].details.is_placeholder());
        assert_eq!(all[0].details, Details::Sqlite { path: "/tmp/demo.db".into() });
    }

    /// A record with nothing recoverable anywhere must say so, not fail blankly.
    #[test]
    fn an_unrecoverable_connection_explains_itself() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        let h = "lost";
        save_stored(
            home,
            h,
            &[StoredConnection {
                id: "01GONE".into(),
                name: "orphan".into(),
                backend: Backend::Postgres,
                ..Default::default()
            }],
        )
        .unwrap();

        let (all, _) = list_connections(home, h).unwrap();
        assert_eq!(all.len(), 1, "still listed so the user can see and remove it");
        let err = with_secret(home, h, &all[0]).unwrap_err();
        assert!(err.contains("re-enter"), "must tell the user what to do: {err}");
        assert!(err.contains("orphan"), "and which connection: {err}");
    }
}
