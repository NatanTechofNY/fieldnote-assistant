// Thin native shell: one window that loads a hosted (or local) Fieldnote server.
//
// Which server it loads is decided at run time, in this order:
//   1. the FIELDNOTE_URL environment variable (handy from a terminal),
//   2. the URL saved from the in-app setup page,
//   3. otherwise the bundled setup page, which asks for one.
// "Server Settings…" (Cmd+,) in the app menu returns to the setup page.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tauri::menu::{Menu, MenuItem, MenuItemKind, PredefinedMenuItem};
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, State, Url, Webview, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

const CONFIG_FILE: &str = "server-url.txt";
const SETTINGS_MENU_ID: &str = "server-settings";

/// Origin (scheme://host:port) of the server the window may navigate to.
struct ServerOrigin(Arc<Mutex<Option<String>>>);

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join(CONFIG_FILE))
        .map_err(|e| e.to_string())
}

fn read_saved(app: &AppHandle) -> Option<String> {
    let raw = fs::read_to_string(config_path(app).ok()?).ok()?;
    let trimmed = raw.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// Accepts "https://host", "host" (assumed https), and plain http only for
/// loopback, LAN and `.local` hosts, which is all macOS lets a webview reach
/// over http anyway.
fn parse_server_url(raw: &str) -> Result<Url, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("Enter the address of your Fieldnote server.".into());
    }
    let candidate = if raw.contains("://") {
        raw.to_string()
    } else if raw.starts_with("localhost") || raw.starts_with("127.") || raw.starts_with("[::1]") {
        format!("http://{raw}")
    } else {
        format!("https://{raw}")
    };
    let url: Url = candidate
        .parse()
        .map_err(|_| "That doesn't look like a valid URL.".to_string())?;
    if url.host_str().is_none() {
        return Err("That doesn't look like a valid URL.".into());
    }
    match url.scheme() {
        "https" => Ok(url),
        "http" => {
            let local = match url.domain() {
                Some(d) => d == "localhost" || d.ends_with(".local") || !d.contains('.'),
                None => true, // an IP address
            };
            if local {
                Ok(url)
            } else {
                Err("Use https:// for a hosted server. Plain http only works for localhost and local-network addresses.".into())
            }
        }
        _ => Err("Only http:// and https:// addresses are supported.".into()),
    }
}

/// True only for the app's own bundled pages. This gates both navigation and the
/// setup commands, so it must not match look-alikes: on macOS that is exactly
/// `tauri://localhost`, and on Windows `http://tauri.localhost`. A bare
/// `http://tauri.localhost` is a real hostname on macOS and must not pass.
fn is_local_page(url: &Url) -> bool {
    if cfg!(windows) {
        url.scheme() == "http" && url.host_str() == Some("tauri.localhost")
    } else {
        url.scheme() == "tauri" && url.host_str() == Some("localhost")
    }
}

fn setup_page_url() -> Url {
    let base = if cfg!(windows) {
        "http://tauri.localhost/index.html"
    } else {
        "tauri://localhost/index.html"
    };
    base.parse().expect("static URL")
}

/// App commands are for the bundled setup page only. The hosted site must never
/// be able to read or rewrite the server setting, so refuse anything else.
fn ensure_setup_page(webview: &Webview) -> Result<(), String> {
    match webview.url() {
        Ok(url) if is_local_page(&url) => Ok(()),
        _ => Err("not allowed".into()),
    }
}

fn is_openable_externally(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https" | "mailto" | "tel")
}

#[tauri::command]
fn get_server_url(webview: Webview, app: AppHandle) -> Result<Option<String>, String> {
    ensure_setup_page(&webview)?;
    Ok(read_saved(&app))
}

#[tauri::command]
fn save_server_url(
    webview: Webview,
    app: AppHandle,
    origin: State<ServerOrigin>,
    url: String,
) -> Result<(), String> {
    ensure_setup_page(&webview)?;
    let parsed = parse_server_url(&url)?;

    let path = config_path(&app)?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    fs::write(&path, parsed.as_str()).map_err(|e| e.to_string())?;

    // Allow the new origin before navigating to it.
    *origin.0.lock().map_err(|e| e.to_string())? = Some(parsed.origin().ascii_serialization());
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "window not found".to_string())?;
    window.navigate(parsed).map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![get_server_url, save_server_url])
        .on_menu_event(|app, event| {
            if event.id().as_ref() == SETTINGS_MENU_ID {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.navigate(setup_page_url());
                }
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();

            let initial = std::env::var("FIELDNOTE_URL")
                .ok()
                .and_then(|v| parse_server_url(&v).ok())
                .or_else(|| read_saved(&handle).and_then(|v| parse_server_url(&v).ok()));

            let allowed = Arc::new(Mutex::new(
                initial.as_ref().map(|u| u.origin().ascii_serialization()),
            ));
            app.manage(ServerOrigin(allowed.clone()));

            // "Server Settings…" lives in the app menu, after About.
            let menu = Menu::default(&handle)?;
            let item = MenuItem::with_id(
                &handle,
                SETTINGS_MENU_ID,
                "Server Settings…",
                true,
                Some("CmdOrCtrl+,"),
            )?;
            if let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.into_iter().next() {
                app_menu.insert(&item, 2)?;
                app_menu.insert(&PredefinedMenuItem::separator(&handle)?, 3)?;
            }
            app.set_menu(menu)?;

            let target = match initial {
                Some(url) => WebviewUrl::External(url),
                None => WebviewUrl::App("index.html".into()),
            };

            let nav_handle = handle.clone();
            let nav_allowed = allowed.clone();

            // Navigation inside the configured server or the bundled setup page
            // stays in the window; every other link opens in the default browser,
            // so the shell can never be steered to an arbitrary site.
            WebviewWindowBuilder::new(app, "main", target)
                .title("Fieldnote")
                .inner_size(1280.0, 820.0)
                .min_inner_size(900.0, 600.0)
                .on_navigation(move |url| {
                    if is_local_page(url) || url.scheme() == "about" {
                        return true;
                    }
                    let same_origin = nav_allowed
                        .lock()
                        .map(|o| o.as_deref() == Some(url.origin().ascii_serialization().as_str()))
                        .unwrap_or(false);
                    if same_origin {
                        return true;
                    }
                    if is_openable_externally(url) {
                        let _ = nav_handle.opener().open_url(url.as_str(), None::<&str>);
                    }
                    false
                })
                .on_new_window(move |url, _features| {
                    if is_openable_externally(&url) {
                        let _ = handle.opener().open_url(url.as_str(), None::<&str>);
                    }
                    NewWindowResponse::Deny
                })
                .build()?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Fieldnote");
}

#[cfg(test)]
mod tests {
    use super::{is_local_page, parse_server_url, setup_page_url};

    #[test]
    #[cfg(not(windows))]
    fn only_the_bundled_origin_counts_as_a_local_page() {
        assert!(is_local_page(&setup_page_url()));
        for other in [
            "https://example.com/",
            "tauri://evil/",
            "http://tauri.localhost/",
            "http://tauri.localhost:4174/",
        ] {
            assert!(!is_local_page(&other.parse().unwrap()), "{other}");
        }
    }

    #[test]
    fn accepts_hosted_and_local_addresses() {
        assert_eq!(parse_server_url("my-app.up.railway.app").unwrap().scheme(), "https");
        assert_eq!(parse_server_url("localhost:4174").unwrap().as_str(), "http://localhost:4174/");
        assert!(parse_server_url("http://192.168.1.20:4174").is_ok());
        assert!(parse_server_url("http://my-mac.local:4174").is_ok());
    }

    #[test]
    fn rejects_plain_http_to_the_internet_and_odd_schemes() {
        assert!(parse_server_url("http://example.com").is_err());
        assert!(parse_server_url("file:///etc/passwd").is_err());
        assert!(parse_server_url("javascript:alert(1)").is_err());
        assert!(parse_server_url("   ").is_err());
    }
}
