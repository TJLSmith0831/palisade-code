//! Native credential storage and finite local permission. No token is exposed through IPC.
use serde::{Deserialize, Serialize};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;
pub const ISSUER: &str = "https://clerk.palisade-code.dev";
pub const CLIENT_ID: &str = "4UYQqtTciDiVQvni";
#[derive(Clone, Deserialize, Serialize)]
pub struct Identity {
    pub sub: String,
    pub email: Option<String>,
    pub name: Option<String>,
    pub picture: Option<String>,
}

pub const OFFLINE_SECONDS: i64 = 7 * 24 * 60 * 60;
#[derive(Clone, Serialize, Deserialize)]
pub struct Record {
    pub issuer: String,
    pub client_id: String,
    pub identity: Identity,
    pub refresh_token: String,
    pub verified_at: i64,
    pub observed_at: i64,
    pub authorization_expires_at: Option<i64>,
}
#[derive(Default)]
pub struct Session {
    pub loaded: bool,
    pub record: Option<Record>,
    pub online: bool,
    pub message: Option<String>,
    pub anchor: Option<(Instant, i64)>,
    pub last_refresh: Option<Instant>,
}
pub fn session() -> &'static Mutex<Session> {
    static STATE: OnceLock<Mutex<Session>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(Session::default()))
}
pub fn operations() -> &'static Mutex<()> {
    static LOCK: Mutex<()> = Mutex::new(());
    &LOCK
}
pub fn now() -> i64 { chrono::Utc::now().timestamp() }
pub fn deadline(record: &Record) -> i64 {
    record.authorization_expires_at.unwrap_or(i64::MAX).min(record.verified_at.saturating_add(OFFLINE_SECONDS))
}
pub fn permission(record: &Record, wall: i64, monotonic_wall: i64) -> &'static str {
    if wall < record.observed_at.saturating_sub(300) || wall < monotonic_wall.saturating_sub(300) {
        "clockChanged"
    } else if wall >= deadline(record) || monotonic_wall >= deadline(record) {
        "expired"
    } else { "allowed" }
}
fn namespace() -> String {
    crate::store::project_hash(&format!("{ISSUER}\n{CLIENT_ID}\n{}", crate::store::machine_home().display()))
}
fn tombstone() -> std::path::PathBuf { crate::store::machine_home().join("auth").join(namespace()).join("signed-out") }
#[cfg(any(target_os = "macos", target_os = "windows"))]
fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new("com.tjlsmith0831.palisade.auth.v1", &namespace())
        .map_err(|_| "OS credential storage is unavailable. Unlock it and retry.".into())
}
fn lock_storage() -> Result<(), String> {
    static LOCK: OnceLock<std::fs::File> = OnceLock::new();
    if LOCK.get().is_some() { return Ok(()); }
    let directory = tombstone().parent().unwrap().to_path_buf();
    std::fs::create_dir_all(&directory).map_err(|_| "Could not open native account storage")?;
    let file = std::fs::OpenOptions::new().create(true).truncate(false).read(true).write(true).open(directory.join("session.lock")).map_err(|_| "Could not lock account storage")?;
    file.try_lock().map_err(|_| "Another Palisade process is using this account store. Close it and retry.".to_string())?;
    LOCK.set(file).map_err(|_| "Account storage was already opened".into())
}
pub fn persist(record: &Record) -> Result<(), String> {
    if !valid_record(record) { return Err("Account data is invalid. Sign in again.".into()); }
    lock_storage()?;
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        let json = serde_json::to_string(record).map_err(|_| "Could not encode credentials")?;
        if json.len() > 65536 { return Err("Account data is too large. Sign in again.".into()); }
        entry()?.set_password(&json).map_err(|_| "Could not save credentials securely. Unlock your OS credential store and retry.".to_string())?;
        // Verify before counting this as a durable refresh; never delete the old
        // item to work around write failures during token rotation.
        if entry()?.get_password().map_err(|_| "Could not verify saved credentials")? != json {
            return Err("Credential storage did not confirm the saved session".into());
        }
        Ok(())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    { let _ = record; Err("Secure OS credential storage is not supported on this platform".into()) }
}
pub fn load() -> Result<Option<Record>, String> {
    lock_storage()?;
    if tombstone().exists() { return Ok(None); }
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        let raw = match entry()?.get_password() {
            Ok(raw) => raw,
            Err(keyring::Error::NoEntry) => return Ok(None),
            Err(_) => return Err("Unlock your OS credential store to restore your account".into()),
        };
        if raw.len() > 65536 { return Err("Stored account data is invalid. Sign in again.".into()); }
        let record: Record = serde_json::from_str(&raw).map_err(|_| "Stored account data is invalid. Sign in again.")?;
        if !valid_record(&record) {
            return Err("Stored account data does not match this application".into());
        }
        Ok(Some(record))
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    { Err("Secure OS credential storage is not supported on this platform".into()) }
}
fn valid_record(record: &Record) -> bool {
    record.issuer == ISSUER && record.client_id == CLIENT_ID
        && !record.identity.sub.is_empty() && record.identity.sub.len() <= 256
        && !record.refresh_token.is_empty() && record.refresh_token.len() <= 32768
        && record.verified_at > 0 && record.observed_at >= record.verified_at
}
pub fn commit(record: Record, online: bool) -> Result<(), String> {
    persist(&record)?;
    let marker = tombstone();
    if marker.exists() {
        std::fs::remove_file(&marker).map_err(|_| "Could not activate the saved account")?;
        std::fs::File::open(marker.parent().unwrap()).and_then(|file| file.sync_all()).map_err(|_| "Could not save account activation")?;
    }
    let mut state = session().lock().map_err(|_| "Account state unavailable")?;
    state.anchor = Some((Instant::now(), now()));
    state.record = Some(record);
    state.loaded = true;
    state.online = online;
    state.message = None;
    Ok(())
}
pub fn clear() -> Result<(), String> {
    lock_storage()?;
    // This non-secret marker prevents a failed keychain deletion or an old
    // process from restoring local permission after sign-out.
    let marker = tombstone();
    std::fs::create_dir_all(marker.parent().unwrap()).map_err(|_| "Could not record sign-out")?;
    std::fs::write(&marker, b"signed-out").map_err(|_| "Could not record sign-out")?;
    std::fs::File::open(&marker).and_then(|file| file.sync_all()).map_err(|_| "Could not save sign-out")?;
    std::fs::File::open(marker.parent().unwrap()).and_then(|file| file.sync_all()).map_err(|_| "Could not save sign-out")?;
    let mut state = session().lock().map_err(|_| "Account state unavailable")?;
    state.record = None;
    state.loaded = true;
    state.online = false;
    state.message = None;
    drop(state);
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    if let Ok(entry) = entry() { let _ = entry.delete_credential(); }
    Ok(())
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub state: String,
    pub identity: Option<Identity>,
    pub profile_key: Option<String>,
    pub offline_until: Option<i64>,
    pub message: Option<String>,
    pub workspace_ready: bool,
    pub legacy_available: bool,
}
pub fn status() -> Result<Status, String> {
    let mut state = session().lock().map_err(|_| "Account state unavailable")?;
    if !state.loaded {
        state.record = load()?;
        state.loaded = true;
        state.anchor = Some((Instant::now(), now()));
    }
    let Some(record) = state.record.clone() else {
        return Ok(Status { state: "signedOut".into(), identity: None, profile_key: None, offline_until: None, message: state.message.clone(), workspace_ready: false, legacy_available: false });
    };
    let wall = now();
    let monotonic = state.anchor.as_ref().map_or(wall, |(instant, at)| at.saturating_add(instant.elapsed().as_secs() as i64));
    let allowed = permission(&record, wall, monotonic);
    if wall > record.observed_at.saturating_add(60) {
        let mut observed = record.clone();
        observed.observed_at = wall;
        persist(&observed)?;
        state.record = Some(observed);
    }
    let key = crate::account_profile::identity_key(ISSUER, &record.identity.sub);
    Ok(Status {
        state: if allowed == "allowed" { if state.online { "online" } else { "offline" } } else { allowed }.into(),
        identity: Some(record.identity.clone()), offline_until: Some(deadline(&record)),
        workspace_ready: crate::account_profile::is_bound(&key),
        legacy_available: crate::account_profile::legacy_available(&key) && !crate::store::machine_home().join("profiles").join(&key).exists(),
        profile_key: Some(key), message: state.message.clone(),
    })
}
pub fn access_allowed() -> bool {
    let Ok(state) = session().try_lock() else { return false; };
    let Some(record) = state.record.as_ref() else { return false; };
    if tombstone().exists() { return false; }
    let wall = now();
    let monotonic = state.anchor.as_ref().map_or(wall, |(instant, at)| at.saturating_add(instant.elapsed().as_secs() as i64));
    permission(record, wall, monotonic) == "allowed" && crate::account_profile::is_bound(&crate::account_profile::identity_key(ISSUER, &record.identity.sub))
}
pub static WORK_ADMISSION: std::sync::RwLock<()> = std::sync::RwLock::new(());
pub fn admit_work() -> crate::Res<std::sync::RwLockReadGuard<'static, ()>> {
    let guard = WORK_ADMISSION.read().map_err(|_| "Account work admission unavailable")?;
    #[cfg(not(test))]
    if !access_allowed() || crate::ACCOUNT_RESTART.load(std::sync::atomic::Ordering::SeqCst) {
        return Err("Sign in before starting new work".into());
    }
    Ok(guard)
}

pub fn command_allowed(command: &str) -> bool {
    if matches!(command, "account_begin_sign_in" | "account_cancel_sign_in" | "account_reopen_sign_in" | "account_open_browser_account" | "account_status" | "account_refresh" | "account_prepare_workspace" | "account_request_restart" | "account_stop_work" | "account_confirm_restart" | "account_cancel_restart" | "sync_window_dirty" | "request_quit" | "confirm_quit_window" | "cancel_quit" | "sync_native_menu" | "enable_rounded_corners" | "enable_modern_window_style" | "reposition_traffic_lights") { return true; }
    if crate::account_profile::root().is_none() { return false; }
    if access_allowed() && !crate::ACCOUNT_RESTART.load(std::sync::atomic::Ordering::SeqCst) { return true; }
    matches!(command, "write_file_content" | "stop_executor" | "cancel_chain_run" | "terminal_kill" | "terminal_kill_project" | "terminal_resize" | "close_notebook_kernel" | "interrupt_notebook_kernel" | "debug_stop" | "lsp_shutdown" | "preview_close" | "preview_hide" | "read_file_content" | "read_thread" | "executor_status" | "session_contexts" | "list_sessions" | "terminal_list" | "debug_status")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn workspace_ipc_is_denied_before_profile_binding() {
        for command in ["list_projects", "read_thread", "send_message", "write_file_content", "terminal_spawn", "db_run_query", "run_chain"] {
            assert!(!command_allowed(command), "{command} bypassed the pre-auth gate");
        }
        assert!(command_allowed("account_status"));
        assert!(command_allowed("account_open_browser_account"));
        assert!(command_allowed("request_quit"));
    }
    #[test]
    fn offline_permission_is_finite_and_does_not_renew_on_restart_or_clock_rollback() {
        let mut record = Record { issuer: "issuer".into(), client_id: "client".into(), identity: Identity { sub: "user".into(), email: None, name: None, picture: None }, refresh_token: "test-only".into(), verified_at: 1000, observed_at: 1000, authorization_expires_at: None };
        assert!(!valid_record(&record));
        record.issuer = ISSUER.into(); record.client_id = CLIENT_ID.into();
        assert!(valid_record(&record));
        assert_eq!(permission(&record, 1000 + OFFLINE_SECONDS - 1, 1000), "allowed");
        assert_eq!(permission(&record, 1000 + OFFLINE_SECONDS, 1000), "expired");
        assert_eq!(permission(&record, 699, 1000), "clockChanged");
        record.observed_at = 2000;
        assert_eq!(deadline(&record), 1000 + OFFLINE_SECONDS);
        assert_eq!(permission(&record, 1000, 1000), "clockChanged");
        record.authorization_expires_at = Some(3000);
        assert_eq!(permission(&record, 3000, 1000), "expired");
        assert_eq!(permission(&record, 2000, 3000), "clockChanged");
    }
}
