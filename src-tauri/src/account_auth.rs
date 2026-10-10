//! Browser authorization with PKCE. Credentials remain in the native process.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex},
    time::{Duration, Instant},
};
use tauri_plugin_opener::OpenerExt;
use tauri::Manager;

pub use crate::account_session::{Identity, ISSUER, CLIENT_ID};
const TIMEOUT: Duration = Duration::from_secs(300);
/// The one callback rejection that ends the wait instead of waiting for a retry.
const DECLINED: &str = "Authorization declined";

#[derive(Default)]
pub struct PendingAuth(Mutex<Option<(String, Arc<AtomicBool>)>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    identity: Identity,
    access_token_expires_in: Option<u64>,
    refresh_token_issued: bool,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    token_type: String,
    expires_in: Option<u64>,
    refresh_token: Option<String>,
}

fn random_secret() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| "Could not create a secure sign-in request")?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn authorization_url(redirect: &str, state: &str, verifier: &str) -> String {
    let mut url = tauri::Url::parse(&format!("{ISSUER}/oauth/authorize")).unwrap();
    url.query_pairs_mut()
        .append_pair("client_id", CLIENT_ID)
        .append_pair("response_type", "code")
        .append_pair("redirect_uri", redirect)
        .append_pair("scope", "profile email offline_access")
        .append_pair("state", state)
        .append_pair("code_challenge", &challenge(verifier))
        .append_pair("code_challenge_method", "S256");
    url.into()
}

// A rejected request cannot consume the pending login. Query duplicates and
// issuer mismatch are rejected before a code can be exchanged.
fn callback_code(request: &str, redirect: &str, state: &str) -> Result<String, &'static str> {
    let line = request.lines().next().ok_or("Invalid request")?;
    let parts: Vec<_> = line.split_whitespace().collect();
    if parts.len() != 3 || parts[0] != "GET" || !parts[1].starts_with("/callback?") {
        return Err("Invalid callback path");
    }
    let base = tauri::Url::parse(redirect).map_err(|_| "Invalid callback")?;
    let url = base.join(parts[1]).map_err(|_| "Invalid callback")?;
    if url.origin() != base.origin() || url.path() != "/callback" {
        return Err("Invalid callback origin");
    }
    let mut query = std::collections::HashMap::new();
    for (key, value) in url.query_pairs() {
        if query.insert(key.into_owned(), value.into_owned()).is_some() {
            return Err("Duplicate callback parameter");
        }
    }
    let supplied = query.get("state").ok_or("Missing state")?;
    let matches = supplied.len() == state.len()
        && supplied.bytes().zip(state.bytes()).fold(0u8, |diff, (a, b)| diff | (a ^ b)) == 0;
    if !matches || query.get("iss").map(String::as_str) != Some(ISSUER) {
        return Err("Invalid callback state or issuer");
    }
    if query.contains_key("error") {
        return Err(DECLINED);
    }
    query.get("code").filter(|s| !s.is_empty() && s.len() <= 4096)
        .cloned().ok_or("Missing authorization code")
}

fn read_request(stream: &mut TcpStream) -> Result<String, String> {
    stream.set_read_timeout(Some(Duration::from_secs(2))).map_err(|_| "Callback unavailable")?;
    stream.set_write_timeout(Some(Duration::from_secs(2))).map_err(|_| "Callback unavailable")?;
    let mut bytes = Vec::new();
    let mut buf = [0u8; 1024];
    while bytes.len() < 8192 {
        let remaining = (8192 - bytes.len()).min(buf.len());
        let count = stream.read(&mut buf[..remaining]).map_err(|_| "Invalid browser callback")?;
        if count == 0 { break; }
        bytes.extend_from_slice(&buf[..count]);
        if bytes.windows(4).any(|w| w == b"\r\n\r\n") {
            return String::from_utf8(bytes).map_err(|_| "Invalid browser callback".into());
        }
    }
    Err("Invalid browser callback".into())
}

fn respond(stream: &mut TcpStream, accepted: bool) {
    let (status, body) = if accepted {
        ("200 OK", "Sign-in received. Return to Palisade to finish.")
    } else {
        ("400 Bad Request", "This sign-in request could not be accepted. Return to Palisade.")
    };
    let response = format!("HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Security-Policy: default-src 'none'; frame-ancestors 'none'\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n{body}", body.len());
    let _ = stream.write_all(response.as_bytes());
}

fn wait_for_code(listener: TcpListener, redirect: &str, state: &str, cancel: &AtomicBool, timeout: Duration) -> Result<String, String> {
    let deadline = Instant::now() + timeout;
    listener.set_nonblocking(true).map_err(|_| "Callback unavailable")?;
    while Instant::now() < deadline {
        if cancel.load(Ordering::SeqCst) { return Err("Sign-in cancelled".into()); }
        match listener.accept() {
            Ok((mut stream, _)) => {
                let result = read_request(&mut stream).and_then(|request|
                    callback_code(&request, redirect, state).map_err(String::from));
                respond(&mut stream, result.is_ok());
                match result {
                    Ok(code) => return Ok(code),
                    Err(error) if error == DECLINED => return Err(error),
                    Err(_) => continue,
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock =>
                std::thread::sleep(Duration::from_millis(50)),
            Err(_) => return Err("Browser callback unavailable. Try signing in again.".into()),
        }
    }
    Err("Sign-in timed out. Try signing in again.".into())
}

fn read_json<T: serde::de::DeserializeOwned>(response: ureq::Response) -> Result<T, String> {
    let mut bytes = Vec::new();
    response.into_reader().take(65537).read_to_end(&mut bytes)
        .map_err(|_| "Could not read Clerk's response")?;
    if bytes.len() > 65536 { return Err("Clerk's response was too large".into()); }
    serde_json::from_slice(&bytes).map_err(|_| "Clerk returned an unexpected response".into())
}

fn exchange(code: &str, redirect: &str, verifier: &str) -> Result<(Connection, crate::account_session::Record), String> {
    // Disable redirects so authorization codes and bearer tokens stay on the
    // configured HTTPS issuer. Userinfo validates opaque and JWT access tokens.
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(20)).redirects(0).build();
    let token: TokenResponse = read_json(agent.post(&format!("{ISSUER}/oauth/token"))
        .send_form(&[("grant_type", "authorization_code"), ("client_id", CLIENT_ID),
            ("code", code), ("redirect_uri", redirect), ("code_verifier", verifier)])
        .map_err(|_| "Clerk could not finish sign-in. Try again.".to_string())?)?;
    if !token.token_type.eq_ignore_ascii_case("bearer") || token.access_token.is_empty() {
        return Err("Clerk returned an unsupported token".into());
    }
    let identity: Identity = read_json(agent.get(&format!("{ISSUER}/oauth/userinfo"))
        .set("Authorization", &format!("Bearer {}", token.access_token)).call()
        .map_err(|_| "Clerk could not verify this account. Try signing in again.".to_string())?)?;
    if identity.sub.is_empty() || identity.sub.len() > 256 {
        return Err("Clerk did not return an account identifier".into());
    }
    let refresh = token.refresh_token.filter(|value| !value.is_empty()).ok_or("Clerk did not issue offline access. Check the desktop client scopes.")?;
    let record = crate::account_session::Record {
        issuer: ISSUER.into(), client_id: CLIENT_ID.into(), identity: identity.clone(),
        refresh_token: refresh, verified_at: crate::account_session::now(),
        observed_at: crate::account_session::now(), authorization_expires_at: None,
    };
    Ok((Connection { identity, access_token_expires_in: token.expires_in, refresh_token_issued: true }, record))
}

#[tauri::command]
pub async fn account_begin_sign_in(app: tauri::AppHandle, pending: tauri::State<'_, PendingAuth>) -> Result<Connection, String> {
    check_configuration()?;
    if crate::ACCOUNT_RESTART.load(Ordering::SeqCst) { return Err("Account restart is pending".into()); }
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|_| "Could not open the browser callback")?;
    let redirect = format!("http://127.0.0.1:{}/callback", listener.local_addr().map_err(|_| "Callback unavailable")?.port());
    let state = random_secret()?;
    let verifier = random_secret()?;
    let url = authorization_url(&redirect, &state, &verifier);
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut active = pending.0.lock().map_err(|_| "Sign-in unavailable")?;
        if active.is_some() { return Err("A sign-in is already running".into()); }
        *active = Some((url.clone(), cancel.clone()));
    }
    let cancel_task = cancel.clone();
    let browser_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        browser_app.opener().open_url(url, None::<&str>).map_err(|_| "Could not open your browser".to_string())?;
        let code = wait_for_code(listener, &redirect, &state, &cancel_task, TIMEOUT)?;
        if cancel_task.load(Ordering::SeqCst) { return Err("Sign-in cancelled".into()); }
        let identity = exchange(&code, &redirect, &verifier)?;
        if cancel_task.load(Ordering::SeqCst) { return Err("Sign-in cancelled".into()); }
        Ok(identity)
    }).await.map_err(|_| "Sign-in could not finish".to_string()).and_then(|result| result);
    let mut active = pending.0.lock().map_err(|_| "Sign-in unavailable")?;
    if !active.as_ref().is_some_and(|(_, flag)| Arc::ptr_eq(flag, &cancel)) || cancel.load(Ordering::SeqCst) {
        return Err("Sign-in cancelled".into());
    }
    *active = None;
    let (connection, record) = result?;
    let _operation = crate::account_session::operations().lock().map_err(|_| "Account unavailable")?;
    if let Some(root) = crate::account_profile::root() {
        if root.file_name().and_then(|name| name.to_str()) != Some(&crate::account_profile::identity_key(ISSUER, &record.identity.sub)) {
            return Err("This window belongs to another account. Restart Palisade to switch accounts.".into());
        }
    }
    if crate::ACCOUNT_RESTART.load(Ordering::SeqCst) { return Err("Account restart is pending".into()); }
    crate::account_session::commit(record, true)?;
    if let Some(window) = app.get_window("main") { let _ = window.show(); let _ = window.set_focus(); }
    Ok(connection)
}

#[tauri::command]
pub fn account_cancel_sign_in(pending: tauri::State<'_, PendingAuth>) -> Result<(), String> {
    if let Some((_, flag)) = pending.0.lock().map_err(|_| "Sign-in unavailable")?.take() {
        flag.store(true, Ordering::SeqCst);
    }
    Ok(())
}

#[tauri::command]
pub fn account_reopen_sign_in(app: tauri::AppHandle, pending: tauri::State<'_, PendingAuth>) -> Result<(), String> {
    let active = pending.0.lock().map_err(|_| "Sign-in unavailable")?;
    let (url, _) = active.as_ref().ok_or("No sign-in is pending")?;
    app.opener().open_url(url.clone(), None::<&str>).map_err(|_| "Could not open your browser".into())
}

#[tauri::command]
pub fn account_open_browser_account(app: tauri::AppHandle) -> Result<(), String> {
    app.opener().open_url("https://accounts.palisade-code.dev/user", None::<&str>)
        .map_err(|_| "Could not open your browser".into())
}

pub fn revoke(refresh_token: &str) {
    // Sign-out always clears local permission, even when Clerk is unreachable.
    let _ = ureq::AgentBuilder::new().timeout(Duration::from_secs(2)).redirects(0).build()
        .post(&format!("{ISSUER}/oauth/token/revoke"))
        .send_form(&[("client_id", CLIENT_ID), ("token", refresh_token), ("token_type_hint", "refresh_token")]);
}

pub fn check_configuration() -> Result<(), String> {
    let issuer = tauri::Url::parse(ISSUER).map_err(|_| "Invalid auth configuration")?;
    if issuer.scheme() != "https" || issuer.host_str().is_none() || CLIENT_ID.is_empty() {
        return Err("Invalid auth configuration".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn account_status() -> Result<crate::account_session::Status, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let _operation = crate::account_session::operations().lock().map_err(|_| "Account unavailable")?;
        crate::account_session::status()
    }).await.map_err(|_| "Account status unavailable".to_string())?
}

#[tauri::command]
pub async fn account_refresh() -> Result<crate::account_session::Status, String> {
    tauri::async_runtime::spawn_blocking(refresh).await.map_err(|_| "Account refresh unavailable".to_string())?
}
fn refresh() -> Result<crate::account_session::Status, String> {
    use crate::account_session as session;
    let _operation = session::operations().lock().map_err(|_| "Account unavailable")?;
    session::status()?;
    {
        let mut state = session::session().lock().map_err(|_| "Account unavailable")?;
        if state.last_refresh.is_some_and(|instant| instant.elapsed() < Duration::from_secs(30)) { drop(state); return session::status(); }
        state.last_refresh = Some(Instant::now());
    }
    let stored = { session::session().lock().map_err(|_| "Account unavailable")?.record.clone() };
    let Some(record) = stored else { return session::status(); };
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(20)).redirects(0).build();
    let response = agent.post(&format!("{ISSUER}/oauth/token")).send_form(&[
        ("grant_type", "refresh_token"), ("client_id", CLIENT_ID), ("refresh_token", &record.refresh_token)]);
    let token: Result<TokenResponse, String> = match response {
        Ok(response) => read_json(response),
        Err(ureq::Error::Status(400, response)) => {
            #[derive(Deserialize)] struct OAuthError { error: String }
            if read_json::<OAuthError>(response).is_ok_and(|error| error.error == "invalid_grant") {
                session::clear()?;
                session::session().lock().map_err(|_| "Account unavailable")?.message = Some("Your authorization ended. Sign in again.".into());
                return session::status();
            }
            Err("Could not verify your account online".into())
        }
        Err(_) => Err("Could not reach Clerk. Your existing offline deadline is unchanged.".into()),
    };
    let result = token.and_then(|token| verify_refreshed_account(record, token, session::commit, |access| {
        match agent.get(&format!("{ISSUER}/oauth/userinfo"))
            .set("Authorization", &format!("Bearer {access}")).call() {
            Ok(response) => read_json(response),
            Err(ureq::Error::Status(401 | 403, _)) => {
                session::clear()?;
                Err("Your authorization ended. Sign in again.".into())
            }
            Err(_) => Err("Account verification failed. Your existing offline deadline is unchanged.".into()),
        }
    }));
    if let Err(error) = result {
        let mut state = session::session().lock().map_err(|_| "Account unavailable")?;
        state.online = false;
        state.message = Some(error);
    }
    session::status()
}

// Persist rotation before identity verification; only verified identity renews local permission.
fn verify_refreshed_account(
    mut record: crate::account_session::Record,
    token: TokenResponse,
    mut save: impl FnMut(crate::account_session::Record, bool) -> Result<(), String>,
    verify: impl FnOnce(&str) -> Result<Identity, String>,
) -> Result<(), String> {
    if !token.token_type.eq_ignore_ascii_case("bearer") || token.access_token.is_empty() { return Err("Unsupported auth response".into()); }
    if let Some(refresh) = token.refresh_token.filter(|value| !value.is_empty()) {
        record.refresh_token = refresh;
        save(record.clone(), false)?;
    }
    let identity = verify(&token.access_token)?;
    if identity.sub != record.identity.sub { return Err("Clerk returned a different account. Restart to switch profiles.".into()); }
    record.identity = identity;
    record.verified_at = crate::account_session::now();
    record.observed_at = record.verified_at;
    save(record, true)
}

#[tauri::command]
pub async fn account_prepare_workspace(app: tauri::AppHandle, import_legacy: bool) -> Result<crate::account_session::Status, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = crate::account_session::operations().lock().map_err(|_| "Account unavailable")?;
        let status = crate::account_session::status()?;
        if !matches!(status.state, crate::account_session::AccountState::Online | crate::account_session::AccountState::Offline) { return Err("Sign in before opening a profile".into()); }
        let key = status.profile_key.ok_or("Account identity unavailable")?;
        if crate::account_profile::is_bound(&key) { return crate::account_session::status(); }
        let root = crate::account_profile::prepare(&crate::store::machine_home(), &key, import_legacy)?;
        crate::reconcile_stale_chain_runs_on_startup(&root).map_err(|_| "Could not recover the profile's interrupted runs")?;
        crate::account_profile::bind(&key, root.clone())?;
        let status = crate::account_session::status()?;
        crate::install_completion_in_background(&app);
        Ok(status)
    }).await.map_err(|_| "Profile setup unavailable".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};

    #[test]
    fn pkce_and_callback_enforce_oauth_binding() {
        assert_eq!(challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
        let state = random_secret().unwrap();
        assert_eq!(state.len(), 43);
        assert_ne!(state, random_secret().unwrap());
        let redirect = "http://127.0.0.1:12345/callback";
        let request = format!("GET /callback?code=abc&state={state}&iss={ISSUER} HTTP/1.1\r\nHost: 127.0.0.1:12345\r\n\r\n");
        assert_eq!(callback_code(&request, redirect, &state).unwrap(), "abc");
        for invalid in [request.replace(&state, "wrong"), request.replace("/callback?", "/other?"),
            request.replace(ISSUER, "https://attacker.example"), request.replace("code=abc", "code=abc&code=other"),
            request.replace("GET", "POST"), request.replace(&format!("&iss={ISSUER}"), "")] {
            assert!(callback_code(&invalid, redirect, &state).is_err());
        }
        let url = tauri::Url::parse(&authorization_url(redirect, &state, &state)).unwrap();
        let query: std::collections::HashMap<_, _> = url.query_pairs().collect();
        assert_eq!(query["redirect_uri"], redirect);
        assert_eq!(query["code_challenge_method"], "S256");
        assert_eq!(query["client_id"], CLIENT_ID);
    }

    #[test]
    fn listener_rejects_bad_state_accepts_once_and_stops_on_cancel_or_timeout() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let redirect = format!("http://{addr}/callback");
        let worker = std::thread::spawn(move || wait_for_code(listener, &redirect, "state", &AtomicBool::new(false), Duration::from_secs(10)));
        for (state, expected) in [("wrong", "400"), ("state", "200")] {
            let mut stream = TcpStream::connect(addr).unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
            stream.write_all(format!("GET /callback?code=abc&state={state}&iss={ISSUER} HTTP/1.1\r\nHost: {addr}\r\n\r\n").as_bytes()).unwrap();
            // Read the framed HTTP response rather than requiring a particular
            // platform's TCP close behavior from the one-shot listener.
            let mut reader = BufReader::new(stream);
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            assert!(line.starts_with(&format!("HTTP/1.1 {expected}")));
            let mut length = None;
            loop {
                line.clear();
                assert!(reader.read_line(&mut line).unwrap() > 0);
                if line == "\r\n" { break; }
                if let Some(value) = line.strip_prefix("Content-Length: ") {
                    length = Some(value.trim().parse::<usize>().unwrap());
                }
            }
            let mut body = vec![0; length.unwrap()];
            reader.read_exact(&mut body).unwrap();
            assert!(!String::from_utf8(body).unwrap().contains("code=abc"));
        }
        assert_eq!(worker.join().unwrap().unwrap(), "abc");
        assert!(TcpStream::connect(addr).is_err());
        for (cancel, timeout) in [(true, Duration::from_secs(3)), (false, Duration::ZERO)] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            assert!(wait_for_code(listener, "http://127.0.0.1/callback", "state", &AtomicBool::new(cancel), timeout).is_err());
        }
    }
    #[test]
    fn rotation_survives_verification_failure_without_renewing_and_storage_failure_stops_verification() {
        let record = crate::account_session::Record { issuer: ISSUER.into(), client_id: CLIENT_ID.into(), identity: Identity { sub: "user_a".into(), email: None, name: None, picture: None }, refresh_token: "old".into(), verified_at: 1000, observed_at: 1000, authorization_expires_at: None };
        let token = || TokenResponse { access_token: "access".into(), token_type: "Bearer".into(), expires_in: Some(86400), refresh_token: Some("rotated".into()) };
        let mut saved = Vec::new();
        let result = verify_refreshed_account(record.clone(), token(), |next, online| { saved.push((next, online)); Ok(()) }, |_| Err("offline".into()));
        assert!(result.is_err(), "failed identity verification must not count as online authentication");
        assert_eq!(saved.len(), 1, "only rotation may be saved on verification failure");
        assert_eq!(saved[0].0.refresh_token, "rotated", "the usable rotated credential must survive");
        assert_eq!(crate::account_session::deadline(&saved[0].0), crate::account_session::deadline(&record), "rotation must not extend offline permission");
        assert!(!saved[0].1, "rotation alone is not verified online status");
        let verified = std::cell::Cell::new(false);
        assert!(verify_refreshed_account(record.clone(), token(), |_, _| Err("locked store".into()), |_| { verified.set(true); Ok(record.identity.clone()) }).is_err());
        assert!(!verified.get(), "storage failure must stop renewal before identity verification");
        assert!(verify_refreshed_account(record.clone(), token(), |_, _| Ok(()), |_| Ok(Identity { sub: "user_b".into(), ..record.identity.clone() })).is_err(), "refresh must refuse another account's identity");
    }

}
