//! Test-only automation for driving the real app from a script.
//!
//! An SSH session on a Mac can neither see nor touch the GUI (no screen
//! capture, no input injection), and WKWebView has no remote protocol like
//! Chromium's CDP, so nothing outside the app can check what a window really
//! does there. These socket commands close that gap for end-to-end checks:
//!
//! - `e2e.windows`   every window as the OS reports it (visible, focused,
//!                   frame in logical pixels, attached webviews)
//! - `e2e.eval`      run a script inside one webview and return its value
//! - `e2e.window`    act on a window the way the window manager would
//!                   (`close` asks first, exactly like the title-bar button)
//! - `e2e.menu_key`  press a menu shortcut such as Cmd+Q (macOS)
//! - `e2e.terminate` what the app menu's Quit item does (macOS)
//! - `e2e.dialog`    list or answer the native sheet a confirm() opened (macOS)
//! - `e2e.snapshot`  write a PNG of one webview's page (macOS)
//!
//! Compiled only with `--features e2e`, and answered only under `--profile`,
//! so a shipped build never carries a way to run script from the socket.

use std::time::Duration;

use dashmap::DashMap;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tokio::sync::oneshot;

use crate::socket::SocketResponse;

/// Longest a single e2e call may wait. Stays under the socket client's own
/// deadline so a stuck page reports a timeout instead of a dropped connection.
const MAX_WAIT: Duration = Duration::from_secs(25);

pub fn handles(cmd: &str) -> bool {
    cmd.starts_with("e2e.")
}

pub async fn dispatch(
    app: &AppHandle,
    pending: &DashMap<usize, oneshot::Sender<SocketResponse>>,
    id: usize,
    cmd: &str,
    args: &Value,
) -> SocketResponse {
    if !crate::test_profile::is_active() {
        return failure(id, "e2e commands are only answered under --profile".to_string());
    }
    let result = match cmd {
        "e2e.eval" => return eval(app, pending, id, args).await,
        "e2e.windows" => windows(app).await,
        "e2e.window" => window_action(app, args).await,
        "e2e.menu_key" => menu_key(app, args).await,
        "e2e.terminate" => terminate(app, args),
        "e2e.dialog" => dialog(app, args).await,
        "e2e.snapshot" => snapshot(app, args).await,
        _ => Err(format!("unknown e2e command {cmd}")),
    };
    match result {
        Ok(value) => SocketResponse {
            id,
            result: Some(value),
            error: None,
        },
        Err(error) => failure(id, error),
    }
}

fn failure(id: usize, error: String) -> SocketResponse {
    SocketResponse {
        id,
        result: None,
        error: Some(error),
    }
}

fn required_str<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    args.get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("missing string argument {key:?}"))
}

fn wait_limit(args: &Value, default_ms: u64) -> Duration {
    let requested = args
        .get("timeout_ms")
        .and_then(Value::as_u64)
        .unwrap_or(default_ms);
    Duration::from_millis(requested).min(MAX_WAIT)
}

/// Window getters hop to the main thread and block until it answers. A main
/// thread that is itself stuck must surface as a timeout, not a hung socket.
async fn off_main<T, F>(limit: Duration, work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    match tokio::time::timeout(limit, tokio::task::spawn_blocking(work)).await {
        Ok(Ok(result)) => result,
        Ok(Err(error)) => Err(format!("e2e worker failed: {error}")),
        Err(_) => Err(format!(
            "main thread did not answer within {} ms",
            limit.as_millis()
        )),
    }
}

async fn windows(app: &AppHandle) -> Result<Value, String> {
    let app = app.clone();
    off_main(MAX_WAIT, move || {
        let mut rows: Vec<Value> = app
            .windows()
            .into_iter()
            .map(|(label, window)| {
                let scale = window.scale_factor().unwrap_or(1.0);
                let position = window
                    .outer_position()
                    .ok()
                    .map(|position| position.to_logical::<f64>(scale));
                let size = window
                    .outer_size()
                    .ok()
                    .map(|size| size.to_logical::<f64>(scale));
                let webviews: Vec<String> = window
                    .webviews()
                    .iter()
                    .map(|webview| webview.label().to_string())
                    .collect();
                json!({
                    "label": label,
                    "title": window.title().ok(),
                    "visible": window.is_visible().ok(),
                    "focused": window.is_focused().ok(),
                    "minimized": window.is_minimized().ok(),
                    "maximized": window.is_maximized().ok(),
                    "decorated": window.is_decorated().ok(),
                    "x": position.map(|position| position.x),
                    "y": position.map(|position| position.y),
                    "width": size.map(|size| size.width),
                    "height": size.map(|size| size.height),
                    "scale": scale,
                    "webviews": webviews,
                })
            })
            .collect();
        rows.sort_by(|a, b| a["label"].as_str().cmp(&b["label"].as_str()));
        Ok(Value::Array(rows))
    })
    .await
}

/// The page answers through `socket_response`, the same command the frontend
/// uses for every forwarded socket request, so the reply rides the existing
/// pending-request table instead of a second channel.
fn eval_wrapper(id: usize, script: &str) -> String {
    format!(
        r#"(async () => {{
  const __e2eId = {id};
  let result = null;
  let error = null;
  try {{
    result = await (async () => {{
{script}
    }})();
    if (result === undefined) result = null;
    JSON.stringify(result);
  }} catch (caught) {{
    result = null;
    error = String((caught && caught.stack) || caught);
  }}
  await window.__TAURI_INTERNALS__.invoke("socket_response", {{ id: __e2eId, result, error }});
}})();"#
    )
}

async fn eval(
    app: &AppHandle,
    pending: &DashMap<usize, oneshot::Sender<SocketResponse>>,
    id: usize,
    args: &Value,
) -> SocketResponse {
    let label = args.get("label").and_then(Value::as_str).unwrap_or("main");
    let script = match required_str(args, "script") {
        Ok(script) => script,
        Err(error) => return failure(id, error),
    };
    let Some(webview) = app.get_webview(label) else {
        return failure(id, format!("no webview labelled {label:?}"));
    };
    let (tx, rx) = oneshot::channel();
    pending.insert(id, tx);
    if let Err(error) = webview.eval(eval_wrapper(id, script)) {
        pending.remove(&id);
        return failure(id, format!("eval failed in {label}: {error}"));
    }
    crate::socket::await_frontend_response(pending, id, rx, wait_limit(args, 10_000)).await
}

async fn window_action(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let label = required_str(args, "label")?.to_string();
    let action = required_str(args, "action")?.to_string();
    let app = app.clone();
    off_main(MAX_WAIT, move || {
        // `get_window`, not `get_webview_window`: a window showing a web pane
        // hosts two webviews and no longer reads as a WebviewWindow.
        let window = app
            .get_window(&label)
            .ok_or_else(|| format!("no window labelled {label:?}"))?;
        let outcome = match action.as_str() {
            // Emits CloseRequested first, like the title-bar close button.
            "close" => window.close(),
            "destroy" => window.destroy(),
            "show" => window.show(),
            "hide" => window.hide(),
            "focus" => window.set_focus(),
            "minimize" => window.minimize(),
            "unminimize" => window.unminimize(),
            other => return Err(format!("unknown window action {other:?}")),
        };
        outcome
            .map(|()| json!({ "label": label, "action": action }))
            .map_err(|error| format!("{action} {label}: {error}"))
    })
    .await
}

/// Delay before an action that ends the process, so the socket reply leaves
/// first and the caller can tell "accepted" from "connection dropped".
fn deferred(args: &Value) -> Duration {
    Duration::from_millis(args.get("defer_ms").and_then(Value::as_u64).unwrap_or(0).min(5_000))
}

#[cfg(target_os = "macos")]
fn run_on_main<T, F>(app: &AppHandle, work: F) -> oneshot::Receiver<T>
where
    T: Send + 'static,
    F: FnOnce(objc2::MainThreadMarker) -> T + Send + 'static,
{
    let (tx, rx) = oneshot::channel();
    // Posted from a worker thread, so it always runs as a queued event rather
    // than inline inside whatever the main thread is doing.
    let _ = app.run_on_main_thread(move || {
        if let Some(mtm) = objc2::MainThreadMarker::new() {
            let _ = tx.send(work(mtm));
        }
    });
    rx
}

/// Send `selector` to `target` from the next run-loop pass.
///
/// A closure posted with `run_on_main_thread` runs inside tao's event handler,
/// which holds tao's handler lock. An AppKit action that re-enters tao from
/// there deadlocks the app: `terminate:` reaches `applicationWillTerminate`,
/// whose exit event waits on that same lock (sampled on the Mac mini,
/// 2026-09-17). A real Cmd+Q never runs inside the handler, so the tests must
/// not either.
#[cfg(target_os = "macos")]
fn perform_later(
    target: &objc2::runtime::AnyObject,
    selector: objc2::runtime::Sel,
    argument: Option<&objc2::runtime::AnyObject>,
) {
    // SAFETY: performSelector:withObject:afterDelay: is an NSObject method;
    // both selectors used here take exactly one object argument.
    unsafe {
        let _: () = objc2::msg_send![
            target,
            performSelector: selector,
            withObject: argument,
            afterDelay: 0.0f64
        ];
    }
}

#[cfg(target_os = "macos")]
async fn from_main<T: Send + 'static>(rx: oneshot::Receiver<T>) -> Result<T, String> {
    match tokio::time::timeout(MAX_WAIT, rx).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(_)) => Err("main thread dropped the e2e request".to_string()),
        Err(_) => Err("main thread did not answer the e2e request".to_string()),
    }
}

#[cfg(target_os = "macos")]
fn virtual_key_code(key: &str) -> u16 {
    // kVK_ANSI_* for the shortcuts the tests press. The menu matches on the
    // characters, so an unknown key still works with code 0.
    match key {
        "a" => 0,
        "q" => 12,
        "w" => 13,
        "t" => 17,
        "o" => 31,
        "p" => 35,
        "n" => 45,
        "m" => 46,
        "," => 43,
        _ => 0,
    }
}

#[cfg(target_os = "macos")]
async fn menu_key(app: &AppHandle, args: &Value) -> Result<Value, String> {
    use objc2_app_kit::{NSApplication, NSEvent, NSEventModifierFlags, NSEventType};
    use objc2_foundation::{NSPoint, NSString};

    let key = required_str(args, "key")?.to_lowercase();
    let mut flags = NSEventModifierFlags::empty();
    for modifier in args
        .get("modifiers")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        flags |= match modifier {
            "cmd" | "command" => NSEventModifierFlags::Command,
            "shift" => NSEventModifierFlags::Shift,
            "alt" | "option" => NSEventModifierFlags::Option,
            "ctrl" | "control" => NSEventModifierFlags::Control,
            other => return Err(format!("unknown modifier {other:?}")),
        };
    }
    let press = move |mtm: objc2::MainThreadMarker| -> Result<(), String> {
        let application = NSApplication::sharedApplication(mtm);
        let menu = application
            .mainMenu()
            .ok_or_else(|| "the app has no main menu".to_string())?;
        let characters = NSString::from_str(&key);
        let event = NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(
            NSEventType::KeyDown,
            NSPoint::new(0.0, 0.0),
            flags,
            0.0,
            0,
            None,
            &characters,
            &characters,
            false,
            virtual_key_code(&key),
        )
        .ok_or_else(|| "could not build the key event".to_string())?;
        perform_later(&menu, objc2::sel!(performKeyEquivalent:), Some(&event));
        Ok(())
    };
    let delay = deferred(args);
    if !delay.is_zero() {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(delay).await;
            let _ = run_on_main(&app, press);
        });
        return Ok(json!({ "scheduled": true, "defer_ms": delay.as_millis() as u64 }));
    }
    from_main(run_on_main(app, press)).await??;
    Ok(json!({ "scheduled": true }))
}

#[cfg(not(target_os = "macos"))]
async fn menu_key(_app: &AppHandle, _args: &Value) -> Result<Value, String> {
    Err("e2e.menu_key is only implemented on macOS".to_string())
}

#[cfg(target_os = "macos")]
fn terminate(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let delay = deferred(args).max(Duration::from_millis(200));
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(delay).await;
        let _ = run_on_main(&app, |mtm| {
            // The selector behind the app menu's Quit item, sent the way the
            // menu sends it: from the run loop, not from inside tao.
            let application = objc2_app_kit::NSApplication::sharedApplication(mtm);
            perform_later(&application, objc2::sel!(terminate:), None);
        });
    });
    Ok(json!({ "scheduled": true }))
}

#[cfg(not(target_os = "macos"))]
fn terminate(_app: &AppHandle, _args: &Value) -> Result<Value, String> {
    Err("e2e.terminate is only implemented on macOS".to_string())
}

/// Every button title reachable under `view`, depth first.
#[cfg(target_os = "macos")]
fn collect_buttons(
    view: &objc2_app_kit::NSView,
    found: &mut Vec<objc2::rc::Retained<objc2_app_kit::NSButton>>,
) {
    use objc2::rc::Retained;
    use objc2::runtime::NSObjectProtocol;
    use objc2::{ClassType, Message};
    use objc2_app_kit::{NSButton, NSView};

    if view.isKindOfClass(NSButton::class()) {
        // SAFETY: the class check above makes the cast valid.
        let button = unsafe { Retained::<NSView>::cast_unchecked::<NSButton>(view.retain()) };
        found.push(button);
    }
    for child in view.subviews().iter() {
        collect_buttons(&child, found);
    }
}

#[cfg(target_os = "macos")]
async fn dialog(app: &AppHandle, args: &Value) -> Result<Value, String> {
    use objc2_app_kit::NSApplication;

    let click = args
        .get("click")
        .and_then(Value::as_str)
        .map(str::to_string);
    let inspect = move |mtm: objc2::MainThreadMarker| -> Result<Value, String> {
        let application = NSApplication::sharedApplication(mtm);
        let mut dialogs = Vec::new();
        if let Some(modal) = application.modalWindow() {
            dialogs.push(modal);
        }
        for window in application.windows().iter() {
            if let Some(sheet) = window.attachedSheet() {
                dialogs.push(sheet);
            }
        }
        let mut listing = Vec::new();
        let mut clicked = None;
        for dialog in &dialogs {
            let Some(content) = dialog.contentView() else {
                continue;
            };
            let mut buttons = Vec::new();
            collect_buttons(&content, &mut buttons);
            let titles: Vec<String> = buttons
                .iter()
                .map(|button| button.title().to_string())
                .collect();
            if clicked.is_none() {
                if let Some(wanted) = click.as_deref() {
                    if let Some(button) = buttons
                        .iter()
                        .find(|button| button.title().to_string() == wanted)
                    {
                        // SAFETY: performClick with no sender is the documented
                        // way to press a button programmatically.
                        unsafe { button.performClick(None) };
                        clicked = Some(wanted.to_string());
                    }
                }
            }
            listing.push(json!({ "buttons": titles }));
        }
        if let Some(wanted) = click.as_deref() {
            if clicked.is_none() {
                return Err(format!(
                    "no open dialog has a button titled {wanted:?} (open: {})",
                    Value::Array(listing)
                ));
            }
        }
        Ok(json!({ "dialogs": listing, "clicked": clicked }))
    };
    from_main(run_on_main(app, inspect)).await?
}

#[cfg(not(target_os = "macos"))]
async fn dialog(_app: &AppHandle, _args: &Value) -> Result<Value, String> {
    Err("e2e.dialog is only implemented on macOS".to_string())
}

#[cfg(target_os = "macos")]
async fn snapshot(app: &AppHandle, args: &Value) -> Result<Value, String> {
    use block2::RcBlock;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
    use objc2_foundation::{NSDictionary, NSError};
    use objc2_web_kit::WKWebView;

    let label = args
        .get("label")
        .and_then(Value::as_str)
        .unwrap_or("main")
        .to_string();
    let path = std::path::PathBuf::from(required_str(args, "path")?);
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("no webview labelled {label:?}"))?;
    let (tx, rx) = oneshot::channel::<Result<Vec<u8>, String>>();
    let tx = std::sync::Arc::new(std::sync::Mutex::new(Some(tx)));
    webview
        .with_webview(move |platform| {
            let finish = tx.clone();
            let handler = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
                let outcome = if image.is_null() {
                    // SAFETY: WebKit passes either a valid NSError or null.
                    let reason = unsafe { error.as_ref() }
                        .map(|error| error.localizedDescription().to_string())
                        .unwrap_or_else(|| "no image".to_string());
                    Err(format!("snapshot failed: {reason}"))
                } else {
                    // SAFETY: non-null and valid for the duration of the callback.
                    let image = unsafe { &*image };
                    image
                        .TIFFRepresentation()
                        .and_then(|tiff| NSBitmapImageRep::imageRepWithData(&tiff))
                        .and_then(|bitmap| unsafe {
                            bitmap.representationUsingType_properties(
                                NSBitmapImageFileType::PNG,
                                &NSDictionary::new(),
                            )
                        })
                        .map(|png| png.to_vec())
                        .ok_or_else(|| "could not encode the snapshot as PNG".to_string())
                };
                if let Some(sender) = finish.lock().ok().and_then(|mut slot| slot.take()) {
                    let _ = sender.send(outcome);
                }
            });
            // SAFETY: on macOS `inner()` is the page's WKWebView, used here on
            // the main thread where `with_webview` runs its closure.
            let view = unsafe { &*(platform.inner() as *const WKWebView) };
            unsafe { view.takeSnapshotWithConfiguration_completionHandler(None, &handler) };
        })
        .map_err(|error| format!("with_webview {label}: {error}"))?;
    let png = match tokio::time::timeout(MAX_WAIT, rx).await {
        Ok(Ok(result)) => result?,
        Ok(Err(_)) => return Err("snapshot callback never ran".to_string()),
        Err(_) => return Err("snapshot timed out".to_string()),
    };
    std::fs::write(&path, &png).map_err(|error| format!("write {}: {error}", path.display()))?;
    Ok(json!({ "path": path.display().to_string(), "bytes": png.len() }))
}

#[cfg(not(target_os = "macos"))]
async fn snapshot(_app: &AppHandle, _args: &Value) -> Result<Value, String> {
    Err("e2e.snapshot is only implemented on macOS (use CDP on Windows)".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_e2e_namespace_is_claimed() {
        assert!(handles("e2e.eval"));
        assert!(handles("e2e.windows"));
        assert!(!handles("workspace.list"));
        assert!(!handles("e2e"));
    }

    #[test]
    fn the_wrapper_reports_through_socket_response_with_the_request_id() {
        let script = eval_wrapper(42, "return document.title;");
        assert!(script.contains("const __e2eId = 42;"));
        assert!(script.contains("return document.title;"));
        assert!(script.contains("\"socket_response\""));
    }

    #[test]
    fn waits_never_exceed_the_socket_budget() {
        assert_eq!(wait_limit(&json!({}), 10_000), Duration::from_millis(10_000));
        assert_eq!(wait_limit(&json!({ "timeout_ms": 60_000 }), 10_000), MAX_WAIT);
    }
}
