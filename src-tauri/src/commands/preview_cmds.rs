//! The Preview pane's browser: a native child webview parked over a
//! placeholder the frontend measures — one per window *and project*, each with
//! its own cookies and storage, so signing in to one project's app never leaks
//! into another's (macOS 14+; older systems share one store).
//!
//! A real webview rather than an iframe, so pages that forbid framing load,
//! logins and popups work, and the page has its own history. It has no
//! capability entry (`capabilities/default.json` matches only `main` and
//! `project-*`), so a previewed page cannot call Palisade's IPC.

use crate::Res;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;
use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{Emitter, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

/// Where the previewed page is, for the toolbar. Emitted to the owning window.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewState {
    project_hash: String,
    url: String,
    loading: bool,
    title: Option<String>,
}

/// Every preview view of one window shares this prefix, so a reload of the
/// window's frontend can hide them all. `:` ends it because window labels are
/// made of letters, digits and `-` (`main`, `project-<hash>`): a `-` would let
/// window `main` claim the views of a window called `main-2`.
fn label_prefix(window_label: &str) -> String {
    format!("preview:{window_label}:")
}

fn preview_label(window_label: &str, project_hash: &str) -> String {
    format!("{}{project_hash}", label_prefix(window_label))
}

fn label_for(window: &tauri::Window, project_hash: &str) -> String {
    preview_label(window.label(), project_hash)
}

/// The WebKit data store a project's preview keeps its cookies and storage in:
/// stable across launches, distinct per project.
fn data_store_id(project_hash: &str) -> [u8; 16] {
    let digest = Sha256::digest(format!("palisade-preview:{project_hash}").as_bytes());
    let mut id = [0u8; 16];
    id.copy_from_slice(&digest[..16]);
    id
}

/// Only web pages: the frame must never become a way to load `file:` or the
/// app's own `tauri:` origin.
fn web_url(raw: &str) -> Res<Url> {
    let url = Url::parse(raw).map_err(|err| crate::PalisadeError::from(format!("not a URL: {err}")))?;
    match url.scheme() {
        "http" | "https" => Ok(url),
        other => Err(format!("preview only opens http(s) pages, not `{other}:`").into()),
    }
}

/// Only loopback addresses are probed: this command must never become a way
/// for a page to make the app fetch arbitrary hosts.
fn is_loopback(url: &Url) -> bool {
    match url.host_str() {
        Some(host) => {
            host == "localhost"
                || host.ends_with(".localhost")
                || matches!(host, "127.0.0.1" | "[::1]" | "0.0.0.0")
        }
        None => false,
    }
}

/// Whether anything is listening at `url`. A native webview shows a refused
/// connection as a blank white page and reports nothing, so the frontend asks
/// first — and keeps asking to know a dev server is still up.
///
/// A bare TCP connect, not a request: this runs every second or two per
/// server, and an HTTP GET would fill the user's dev-server log with our
/// polling. `None` is reachable; `Some(reason)` is not. Non-loopback URLs are
/// not probed and count as reachable.
#[tauri::command]
pub async fn preview_probe(url: String) -> Res<Option<String>> {
    let target = web_url(&url)?;
    if !is_loopback(&target) {
        return Ok(None);
    }
    let host = target.host_str().unwrap_or("localhost").trim_matches(|c| c == '[' || c == ']').to_string();
    let port = target.port_or_known_default().unwrap_or(80);
    tokio::task::spawn_blocking(move || {
        let addrs = (host.as_str(), port).to_socket_addrs().map_err(|err| crate::PalisadeError::from(format!("resolve {host}: {err}")))?;
        // `localhost` resolves to both ::1 and 127.0.0.1; a server may hold either.
        for addr in addrs {
            if TcpStream::connect_timeout(&addr, Duration::from_millis(1000)).is_ok() {
                return Ok(None);
            }
        }
        Ok(Some("connection refused".to_string()))
    })
    .await
    .map_err(crate::PalisadeError::from)?
}

fn place(webview: &tauri::Webview, bounds: &Bounds) -> Res<()> {
    webview
        .set_position(LogicalPosition::new(bounds.x, bounds.y))
        .and_then(|_| webview.set_size(LogicalSize::new(bounds.width, bounds.height)))
        .map_err(|err| crate::PalisadeError::from(format!("place preview: {err}")))
}

/// Shows the preview at `bounds`, creating it on first use and navigating it
/// when `url` differs from what it already shows. Re-opening with the same
/// URL keeps the page (and its scroll, session, history) untouched.
#[tauri::command]
pub async fn preview_open(
    window: tauri::Window,
    app: tauri::AppHandle,
    project_hash: String,
    url: String,
    bounds: Bounds,
) -> Res<()> {
    let target = web_url(&url)?;
    let label = label_for(&window, &project_hash);

    if let Some(webview) = app.get_webview(&label) {
        place(&webview, &bounds)?;
        webview.show().map_err(|err| crate::PalisadeError::from(err.to_string()))?;
        let same = webview.url().map(|current| current == target).unwrap_or(false);
        if !same {
            webview.navigate(target).map_err(|err| crate::PalisadeError::from(err.to_string()))?;
        }
        return Ok(());
    }

    let owner = window.label().to_string();
    let load_app = app.clone();
    let title_app = app.clone();
    let title_owner = owner.clone();
    let load_project = project_hash.clone();
    let title_project = project_hash.clone();
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(target))
        .data_store_identifier(data_store_id(&project_hash))
        .on_navigation(|url| matches!(url.scheme(), "http" | "https" | "about"))
        // A popup (an OAuth window, `target=_blank`) opens in the same view:
        // one pane, one page, and nothing to lose track of.
        .on_new_window({
            let app = app.clone();
            let label = label.clone();
            move |url, _features| {
                // `navigate` skips `on_navigation`, so a popup asking for
                // `file:` or the app's own origin has to be refused here.
                if matches!(url.scheme(), "http" | "https") {
                    if let Some(webview) = app.get_webview(&label) {
                        let _ = webview.navigate(url);
                    }
                }
                NewWindowResponse::Deny
            }
        })
        .on_page_load(move |_, payload| {
            let _ = load_app.emit_to(
                &owner,
                "preview-state",
                PreviewState {
                    project_hash: load_project.clone(),
                    url: payload.url().to_string(),
                    loading: matches!(payload.event(), PageLoadEvent::Started),
                    title: None,
                },
            );
        })
        .on_document_title_changed(move |webview, title| {
            let _ = title_app.emit_to(
                &title_owner,
                "preview-state",
                PreviewState {
                    project_hash: title_project.clone(),
                    url: webview.url().map(|u| u.to_string()).unwrap_or_default(),
                    loading: false,
                    title: Some(title),
                },
            );
        });

    window
        .add_child(
            builder,
            LogicalPosition::new(bounds.x, bounds.y),
            LogicalSize::new(bounds.width, bounds.height),
        )
        .map(|_| ())
        .map_err(|err| crate::PalisadeError::from(format!("open preview: {err}")))
}

/// Follows the placeholder as it moves or resizes, and shows the view if an
/// overlay had hidden it.
#[tauri::command]
pub fn preview_bounds(window: tauri::Window, app: tauri::AppHandle, project_hash: String, bounds: Bounds) -> Res<()> {
    match app.get_webview(&label_for(&window, &project_hash)) {
        Some(webview) => {
            place(&webview, &bounds)?;
            webview.show().map_err(|err| crate::PalisadeError::from(err.to_string()))
        }
        None => Ok(()),
    }
}

/// Hides the view without discarding the page. A native view draws above every
/// HTML overlay, so the frontend hides it whenever something has to sit over
/// its area, and whenever the Preview tab is not the one showing.
#[tauri::command]
pub fn preview_hide(window: tauri::Window, app: tauri::AppHandle, project_hash: String) -> Res<()> {
    match app.get_webview(&label_for(&window, &project_hash)) {
        Some(webview) => webview.hide().map_err(|err| crate::PalisadeError::from(err.to_string())),
        None => Ok(()),
    }
}

/// Destroys the view. A hidden one is still a running page — its timers,
/// sockets and audio keep going — so closing the Preview tab must end it, not
/// just hide it.
#[tauri::command]
pub fn preview_close(window: tauri::Window, app: tauri::AppHandle, project_hash: String) -> Res<()> {
    match app.get_webview(&label_for(&window, &project_hash)) {
        Some(webview) => webview.close().map_err(|err| crate::PalisadeError::from(err.to_string())),
        None => Ok(()),
    }
}

#[tauri::command]
pub fn preview_reload(window: tauri::Window, app: tauri::AppHandle, project_hash: String) -> Res<()> {
    match app.get_webview(&label_for(&window, &project_hash)) {
        Some(webview) => webview.reload().map_err(|err| crate::PalisadeError::from(err.to_string())),
        None => Ok(()),
    }
}

/// `-1` back, `1` forward.
#[tauri::command]
pub fn preview_history(window: tauri::Window, app: tauri::AppHandle, project_hash: String, delta: i32) -> Res<()> {
    match app.get_webview(&label_for(&window, &project_hash)) {
        Some(webview) => webview
            .eval(format!("history.go({})", delta.clamp(-1, 1)))
            .map_err(|err| crate::PalisadeError::from(err.to_string())),
        None => Ok(()),
    }
}

/// A window's frontend is (re)loading, so nothing on it is showing the
/// Preview tab any more — but the native view outlives the page that placed
/// it, and would float over whatever loads next. Registered app-wide.
pub fn hide_preview_on_reload(webview: &tauri::Webview, payload: &tauri::webview::PageLoadPayload<'_>) {
    if payload.event() != PageLoadEvent::Started || webview.label().starts_with("preview:") {
        return;
    }
    let prefix = label_prefix(webview.label());
    for (label, view) in webview.app_handle().webviews() {
        if label.starts_with(&prefix) {
            let _ = view.hide();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(raw: &str) -> Url {
        Url::parse(raw).unwrap()
    }

    #[test]
    fn only_loopback_hosts_are_probed() {
        for ok in ["http://localhost:3000/", "http://127.0.0.1:1/", "http://[::1]:8080/", "http://0.0.0.0:80/", "http://app.localhost/"] {
            assert!(is_loopback(&url(ok)), "{ok} should be probed");
        }
        for no in ["https://example.com/", "http://192.168.1.5:3000/", "http://localhost.evil.com/", "http://10.0.0.1/"] {
            assert!(!is_loopback(&url(no)), "{no} must not be probed");
        }
    }

    #[test]
    fn each_project_gets_its_own_view_and_its_own_store() {
        assert_ne!(preview_label("main", "aaa"), preview_label("main", "bbb"));
        assert_ne!(preview_label("main", "aaa"), preview_label("project-x", "aaa"));
        assert_ne!(data_store_id("aaa"), data_store_id("bbb"));
        assert_eq!(data_store_id("aaa"), data_store_id("aaa"), "the store must survive a relaunch");
    }

    #[test]
    fn a_windows_views_share_a_prefix_no_other_window_matches() {
        let prefix = label_prefix("main");
        assert!(preview_label("main", "abc").starts_with(&prefix));
        assert!(!preview_label("main-2", "abc").starts_with(&prefix), "`main` must not claim `main-2`'s views");
    }

    #[test]
    fn preview_only_opens_web_pages() {
        assert!(web_url("http://localhost:3000").is_ok());
        assert!(web_url("https://example.com").is_ok());
        assert!(web_url("file:///etc/passwd").is_err());
        assert!(web_url("tauri://localhost").is_err());
        assert!(web_url("javascript:alert(1)").is_err());
    }

    #[tokio::test]
    async fn a_closed_port_is_unreachable_and_an_open_one_is_not() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let up = preview_probe(format!("http://127.0.0.1:{port}/")).await.unwrap();
        assert_eq!(up, None, "a listening port is reachable");

        // Bind and immediately drop to get a port nothing is listening on.
        let dead = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let down = preview_probe(format!("http://127.0.0.1:{dead}/")).await.unwrap();
        assert!(down.is_some(), "a refused connection must be reported");
    }

    #[tokio::test]
    async fn probing_sends_no_request_for_the_server_to_log() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        listener.set_nonblocking(true).unwrap();
        preview_probe(format!("http://127.0.0.1:{port}/")).await.unwrap();
        // Accept whatever connected, and check that it wrote nothing.
        let (mut stream, _) = loop {
            match listener.accept() {
                Ok(conn) => break conn,
                Err(_) => std::thread::sleep(Duration::from_millis(10)),
            }
        };
        stream.set_read_timeout(Some(Duration::from_millis(200))).unwrap();
        let mut buf = [0u8; 16];
        use std::io::Read;
        let n = stream.read(&mut buf).unwrap_or(0);
        assert_eq!(n, 0, "the probe must not send an HTTP request the server would log");
    }

    #[tokio::test]
    async fn a_non_loopback_url_is_never_fetched() {
        // Would fail or hang if it were probed; it must not even try.
        assert_eq!(preview_probe("http://192.0.2.1:9/".into()).await.unwrap(), None);
    }
}
