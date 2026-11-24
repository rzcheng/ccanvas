// The real browser for a focused web widget: a native child webview laid over
// the widget's body while it's in focus mode (the frontend half, which keeps it
// in place and hides it under menus, is src/lib/nativeView.ts).
//
// A native view is drawn on top of the whole page as a plain rectangle, so it
// can't follow the canvas's transforms; that's why it only exists in focus
// mode, where the widget sits still at 100%. There is at most one, the focused
// widget's: opening one for another widget closes the old one.
//
// Safety:
//   • The view shows arbitrary sites, so it gets no Tauri IPC: capabilities
//     are scoped to the main webview's label (capabilities/default.json), and
//     Tauri refuses custom commands from remote origins anyway.
//   • It only ever shows http(s) pages, and never the app's own origin (in
//     dev that's the Vite server, which Tauri would treat as trusted).
//   • New windows don't open: they come back to the canvas as a new widget.
//   • Every web widget shares one persistent profile, so logins stick, kept
//     apart from the app's own storage. Nothing but the URL ends up in the
//     canvas file.

use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{
    AppHandle, Emitter, EventTarget, LogicalPosition, LogicalSize, Manager, Rect, Url, Webview,
    WebviewUrl,
};

/// The profile every web widget shares (a WKWebsiteDataStore identifier on
/// macOS 14+; a data directory elsewhere).
#[cfg(target_os = "macos")]
const PROFILE_ID: [u8; 16] = *b"ccanvas web view";
#[cfg(not(target_os = "macos"))]
const PROFILE_DIR: &str = "web-profile";

/// A page that sends you back to the canvas: ⌘⇧↵ (Ctrl⇧↵) inside the page.
/// Keys pressed in a native view never reach the canvas, and the view has no
/// IPC, so the press is passed back as a navigation that's always refused.
const KEY_SCHEME: &str = "ccanvas-key";
const KEY_BRIDGE: &str = r#"addEventListener('keydown',function(e){
if(e.key==='Enter'&&e.shiftKey&&(e.metaKey||e.ctrlKey)){e.preventDefault();e.stopPropagation();location.href='ccanvas-key:exit-focus'}
},true);"#;

struct Live {
    /// the widget it belongs to
    id: String,
    view: Webview,
}

fn live() -> &'static Mutex<Option<Live>> {
    static L: OnceLock<Mutex<Option<Live>>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(None))
}

/// The last page each widget's view showed, for `native_view_close` (kept
/// even when a view is closed by another widget opening).
fn last_urls() -> &'static Mutex<HashMap<String, String>> {
    static U: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    U.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Clone, Serialize)]
struct Nav {
    id: String,
    url: String,
    loading: bool,
}

#[derive(Clone, Serialize)]
struct IdUrl {
    id: String,
    url: String,
}

/// Events go to the canvas only, never to the view itself.
fn to_canvas<S: Serialize + Clone>(app: &AppHandle, event: &str, payload: S) {
    let _ = app.emit_to(EventTarget::webview("main"), event, payload);
}

fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme()
        && a.host_str() == b.host_str()
        && a.port_or_known_default() == b.port_or_known_default()
}

/// What the view may show: http(s), and not the app itself.
fn allowed(url: &Url, app_url: Option<&Url>) -> bool {
    matches!(url.scheme(), "http" | "https") && !app_url.is_some_and(|a| same_origin(a, url))
}

fn app_url(app: &AppHandle) -> Option<Url> {
    app.get_webview("main").and_then(|w| w.url().ok())
}

fn rect(x: f64, y: f64, w: f64, h: f64) -> Rect {
    Rect {
        position: LogicalPosition::new(x, y).into(),
        size: LogicalSize::new(w.max(1.0), h.max(1.0)).into(),
    }
}

/// The live view, if it belongs to `id`.
fn view_of(id: &str) -> Option<Webview> {
    live()
        .lock()
        .unwrap()
        .as_ref()
        .filter(|l| l.id == id)
        .map(|l| l.view.clone())
}

fn remember(id: &str, url: &Url) {
    if matches!(url.scheme(), "http" | "https") {
        last_urls()
            .lock()
            .unwrap()
            .insert(id.to_string(), url.to_string());
    }
}

fn close_view(l: Live) {
    if let Ok(url) = l.view.url() {
        remember(&l.id, &url);
    }
    let _ = l.view.close();
}

/// Open (or move and show) the native view for widget `id` at a canvas-local
/// rect, in logical px. Async so it runs off the main thread (building a
/// webview waits on it).
#[tauri::command]
pub async fn native_view_open(
    app: AppHandle,
    id: String,
    url: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    let app_url = app_url(&app);
    let target = Url::parse(&url).map_err(|e| e.to_string())?;
    if !allowed(&target, app_url.as_ref()) {
        return Err("only http(s) pages open here".into());
    }
    let window = app.get_window("main").ok_or("no main window")?;

    // held throughout, so two opens can't race into two views
    let mut slot = live().lock().unwrap();
    if let Some(l) = slot.as_ref().filter(|l| l.id == id) {
        let _ = l.view.set_bounds(rect(x, y, w, h));
        let _ = l.view.show();
        return Ok(());
    }
    if let Some(old) = slot.take() {
        close_view(old);
    }
    last_urls().lock().unwrap().remove(&id);

    static SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let label = format!(
        "web-view-{}",
        SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );

    let (nav_app, nav_id) = (app.clone(), id.clone());
    let (win_app, win_id) = (app.clone(), id.clone());
    let (load_app, load_id) = (app.clone(), id.clone());
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(target))
        .on_navigation(move |u| {
            if u.scheme() == KEY_SCHEME {
                if u.path() == "exit-focus" {
                    to_canvas(
                        &nav_app,
                        "native-view:exit-focus",
                        IdUrl {
                            id: nav_id.clone(),
                            url: String::new(),
                        },
                    );
                }
                return false;
            }
            allowed(u, app_url.as_ref())
        })
        .on_new_window(move |u, _features| {
            if matches!(u.scheme(), "http" | "https") {
                to_canvas(
                    &win_app,
                    "native-view:new-window",
                    IdUrl {
                        id: win_id.clone(),
                        url: u.to_string(),
                    },
                );
            }
            NewWindowResponse::Deny
        })
        .on_page_load(move |_view, payload| {
            remember(&load_id, payload.url());
            to_canvas(
                &load_app,
                "native-view:nav",
                Nav {
                    id: load_id.clone(),
                    url: payload.url().to_string(),
                    loading: matches!(payload.event(), PageLoadEvent::Started),
                },
            );
        })
        .initialization_script(KEY_BRIDGE)
        .devtools(cfg!(debug_assertions));
    #[cfg(target_os = "macos")]
    let builder = builder.data_store_identifier(PROFILE_ID);
    #[cfg(not(target_os = "macos"))]
    let builder = match app.path().app_data_dir() {
        Ok(dir) => builder.data_directory(dir.join(PROFILE_DIR)),
        Err(_) => builder,
    };

    let view = window
        .add_child(
            builder,
            LogicalPosition::new(x, y),
            LogicalSize::new(w.max(1.0), h.max(1.0)),
        )
        .map_err(|e| e.to_string())?;
    *slot = Some(Live { id, view });
    Ok(())
}

/// Move/resize the view (canvas-local logical px).
#[tauri::command]
pub async fn native_view_bounds(id: String, x: f64, y: f64, w: f64, h: f64) {
    if let Some(v) = view_of(&id) {
        let _ = v.set_bounds(rect(x, y, w, h));
    }
}

/// Hide it (something in the page is over it, or the window is hidden) or show it again.
#[tauri::command]
pub async fn native_view_visible(id: String, visible: bool) {
    if let Some(v) = view_of(&id) {
        let _ = if visible { v.show() } else { v.hide() };
    }
}

/// Load a URL typed into the widget's address bar.
#[tauri::command]
pub async fn native_view_navigate(app: AppHandle, id: String, url: String) -> Result<(), String> {
    let target = Url::parse(&url).map_err(|e| e.to_string())?;
    if !allowed(&target, app_url(&app).as_ref()) {
        return Err("only http(s) pages open here".into());
    }
    if let Some(v) = view_of(&id) {
        v.navigate(target).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// The address bar's back / forward / reload.
#[tauri::command]
pub async fn native_view_go(id: String, action: String) {
    let Some(v) = view_of(&id) else {
        return;
    };
    let _ = match action.as_str() {
        "back" => v.eval("history.back()"),
        "forward" => v.eval("history.forward()"),
        "reload" => v.reload(),
        _ => Ok(()),
    };
}

/// Close widget `id`'s view (focus moved on) and return the last page it
/// showed, so the widget can keep it.
#[tauri::command]
pub async fn native_view_close(id: String) -> Option<String> {
    let taken = {
        let mut slot = live().lock().unwrap();
        if slot.as_ref().is_some_and(|l| l.id == id) {
            slot.take()
        } else {
            None
        }
    };
    if let Some(l) = taken {
        close_view(l);
    }
    last_urls().lock().unwrap().remove(&id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_web_pages_and_never_the_app() {
        let app = Url::parse("http://127.0.0.1:5173/").unwrap();
        let ok = |s: &str| allowed(&Url::parse(s).unwrap(), Some(&app));
        assert!(ok("https://example.com/login"));
        assert!(ok("http://localhost:3000/"));
        assert!(ok("http://127.0.0.1:8080/"));
        assert!(!ok("http://127.0.0.1:5173/"));
        assert!(!ok("http://127.0.0.1:5173/anything"));
        assert!(!ok("tauri://localhost/"));
        assert!(!ok("file:///etc/hosts"));
        assert!(!ok("javascript:alert(1)"));
    }
}
