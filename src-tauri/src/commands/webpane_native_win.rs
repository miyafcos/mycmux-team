use std::cell::RefCell;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tokio::sync::oneshot;
use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
use windows_webview2::core::{BOOL, HRESULT, HSTRING};

use super::webpane::webview_label;
use super::webpane_native::{
    png_dimensions, screenshot_path, write_screenshot, NativeBudget, WebPaneClip, WebPaneFile,
    WebPaneScreenshotResult, WebPaneSetFileInputResult, WebPaneTrustedInput,
    WebPaneTrustedInputResult,
};

const MAX_UPLOAD_BYTES: u64 = 25 * 1024 * 1024;
const UPLOAD_LIMIT_ERROR: &str = "web.upload files exceed the 25 MB limit";
const GENERATION_CHANGED: &str = "page changed since the target was resolved; snapshot again";

fn generation_params() -> Value {
    json!({
        "expression": "window.__mycmux && window.__mycmux.generation",
        "returnByValue": true
    })
}

async fn check_generation<F, Fut>(expected: Option<u64>, evaluate: F) -> Result<(), String>
where
    F: FnOnce(Value) -> Fut,
    Fut: std::future::Future<Output = Result<Value, String>>,
{
    if let Some(expected) = expected {
        let reply = evaluate(generation_params()).await?;
        if reply.get("exceptionDetails").is_some()
            || observed_generation(&reply["result"]["value"]) != Some(expected)
        {
            return Err(GENERATION_CHANGED.to_string());
        }
    }
    Ok(())
}

fn observed_generation(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .filter(|value| *value <= u32::MAX as u64)
        .or_else(|| {
            value
                .as_f64()
                .filter(|value| {
                    value.is_finite()
                        && *value >= 0.0
                        && value.fract() == 0.0
                        && *value <= u32::MAX as f64
                })
                .map(|value| value as u64)
        })
}

fn cdp_error(method: &str, detail: impl std::fmt::Display, hidden: bool) -> String {
    let hint = if hidden {
        "; tab is hidden; open with --background or focus it"
    } else {
        ""
    };
    format!("{method} failed: {detail}{hint}")
}

fn decode_cdp_reply(method: &str, status: i32, reply: &str) -> Result<Value, String> {
    HRESULT(status)
        .ok()
        .map_err(|error| format!("{method} HRESULT 0x{:08X}: {error}", status as u32))?;
    let value: Value = serde_json::from_str(reply)
        .map_err(|error| format!("{method} returned invalid JSON: {error}"))?;
    if let Some(error) = value.get("error") {
        return Err(format!("{method} protocol error: {error}"));
    }
    Ok(value)
}

pub(super) async fn cdp_call(
    app: &AppHandle,
    tab_id: &str,
    method: &str,
    params: Value,
    timeout: Duration,
) -> Result<Value, String> {
    let label = webview_label(tab_id)?;
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| "web pane does not exist".to_string())?;
    let (tx, rx) = oneshot::channel::<Result<(i32, String), String>>();
    let hidden = Arc::new(AtomicBool::new(false));
    let callback_hidden = hidden.clone();
    let method_name = method.to_string();
    let params_json = params.to_string();
    webview
        .with_webview(move |pw| {
            // A queued closure must not start an action after its caller timed out.
            if tx.is_closed() {
                return;
            }
            let controller = pw.controller();
            let mut visible = BOOL::default();
            if unsafe { controller.IsVisible(&mut visible) }.is_ok() {
                callback_hidden.store(!visible.as_bool(), Ordering::Relaxed);
            }
            // This cell and the COM callback stay on the UI thread. No mutex,
            // blocking receive, or message pump is needed there.
            let sender = Rc::new(RefCell::new(Some(tx)));
            let completed_sender = sender.clone();
            let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                move |status, reply| {
                    let status = status.err().map_or(0, |error| error.code().0);
                    if let Some(tx) = completed_sender.borrow_mut().take() {
                        let _ = tx.send(Ok((status, reply)));
                    }
                    Ok(())
                },
            ));
            let started = unsafe {
                controller.CoreWebView2().and_then(|core| {
                    core.CallDevToolsProtocolMethod(
                        &HSTRING::from(method_name),
                        &HSTRING::from(params_json),
                        &handler,
                    )
                })
            };
            if let Err(error) = started {
                if let Some(tx) = sender.borrow_mut().take() {
                    let _ = tx.send(Err(format!(
                        "HRESULT 0x{:08X}: {error}",
                        error.code().0 as u32
                    )));
                }
            }
        })
        .map_err(|error| cdp_error(method, error, hidden.load(Ordering::Relaxed)))?;

    let result = match tokio::time::timeout(timeout, rx).await {
        Err(_) => Err(format!("timed out after {} ms", timeout.as_millis())),
        Ok(Err(_)) => Err("completion handler disconnected".to_string()),
        Ok(Ok(Err(error))) => Err(error),
        Ok(Ok(Ok((status, reply)))) => decode_cdp_reply(method, status, &reply),
    };
    result.map_err(|error| cdp_error(method, error, hidden.load(Ordering::Relaxed)))
}

#[derive(Clone, Copy, Debug)]
struct Viewport {
    width: f64,
    height: f64,
    dpr: f64,
}

fn viewport_from_reply(reply: &Value) -> Result<Viewport, String> {
    if let Some(error) = reply.get("exceptionDetails") {
        return Err(format!("Runtime.evaluate failed: {error}"));
    }
    let read = |name: &str| {
        reply["result"]["value"][name]
            .as_f64()
            .filter(|value| value.is_finite() && *value > 0.0)
            .ok_or_else(|| format!("Runtime.evaluate returned invalid viewport {name}"))
    };
    Ok(Viewport {
        width: read("w")?,
        height: read("h")?,
        dpr: read("dpr")?,
    })
}

fn capture_params(viewport: Viewport, clip: Option<WebPaneClip>) -> Result<Value, String> {
    let clip = clip.unwrap_or(WebPaneClip {
        x: 0.0,
        y: 0.0,
        width: viewport.width,
        height: viewport.height,
    });
    if ![clip.x, clip.y, clip.width, clip.height, viewport.dpr]
        .iter()
        .all(|value| value.is_finite())
        || clip.x < 0.0
        || clip.y < 0.0
        || clip.width <= 0.0
        || clip.height <= 0.0
        || viewport.dpr <= 0.0
        || !(1.0 / viewport.dpr).is_finite()
    {
        return Err("Page.captureScreenshot requires a finite positive clip and DPR".to_string());
    }
    Ok(json!({
        "format": "png", "captureBeyondViewport": false,
        "clip": {"x": clip.x, "y": clip.y, "width": clip.width,
            "height": clip.height, "scale": 1.0 / viewport.dpr}
    }))
}

fn screenshot_dimensions(png: &[u8], params: &Value, dpr: f64) -> Result<(u32, u32, f64), String> {
    let (width, height) = png_dimensions(png)?;
    let css_width = params["clip"]["width"].as_f64().unwrap();
    let css_height = params["clip"]["height"].as_f64().unwrap();
    let actual_dpr = if f64::from(width) == css_width && f64::from(height) == css_height {
        dpr
    } else {
        // PNG dimensions are authoritative; use the horizontal pixel/CSS ratio.
        f64::from(width) / css_width
    };
    Ok((width, height, actual_dpr))
}

pub(super) async fn screenshot(
    app: &AppHandle,
    tab_id: String,
    path: Option<String>,
    clip: Option<WebPaneClip>,
    budget: &NativeBudget,
) -> Result<WebPaneScreenshotResult, String> {
    // An explicit absolute path does not depend on the home directory existing.
    let home = if path.is_none() {
        dirs::home_dir().ok_or_else(|| "failed to resolve home directory".to_string())?
    } else {
        std::path::PathBuf::new()
    };
    let path = screenshot_path(&home, &tab_id, path.as_deref(), chrono::Utc::now())?;
    let reply = cdp_call(
        app,
        &tab_id,
        "Runtime.evaluate",
        json!({
            "expression": "({w:innerWidth,h:innerHeight,dpr:devicePixelRatio})",
            "returnByValue": true
        }),
        budget.call_timeout()?,
    )
    .await?;
    let viewport = viewport_from_reply(&reply)?;
    let params = capture_params(viewport, clip)?;
    let reply = cdp_call(
        app,
        &tab_id,
        "Page.captureScreenshot",
        params.clone(),
        budget.call_timeout()?,
    )
    .await?;
    // Disk I/O and PNG decoding must not block the async deadline timer.
    let write_budget = budget.clone();
    tokio::task::spawn_blocking(move || {
        write_budget.call_timeout()?;
        let data = reply["data"]
            .as_str()
            .ok_or_else(|| "Page.captureScreenshot returned no PNG data".to_string())?;
        let png = base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|error| format!("Page.captureScreenshot returned invalid base64: {error}"))?;
        let (width, height, dpr) = screenshot_dimensions(&png, &params, viewport.dpr)?;
        write_budget.call_timeout()?;
        write_screenshot(&path, &png)?;
        Ok(WebPaneScreenshotResult {
            tab_id,
            path: path.to_string_lossy().into_owned(),
            width,
            height,
            dpr,
        })
    })
    .await
    .map_err(|error| format!("screenshot worker failed: {error}"))?
}

type CdpEvent = (&'static str, Value);

fn finite_coordinates(values: &[f64]) -> Result<(), String> {
    if values.iter().all(|value| value.is_finite()) {
        Ok(())
    } else {
        Err("trusted input coordinates and deltas must be finite".to_string())
    }
}

fn key_mapping(key: &str) -> Result<(String, String, u32), String> {
    let (key, code, vk) = match key {
        "Enter" => ("Enter", "Enter", 13),
        "Tab" => ("Tab", "Tab", 9),
        "Escape" => ("Escape", "Escape", 27),
        "Backspace" => ("Backspace", "Backspace", 8),
        "Delete" => ("Delete", "Delete", 46),
        "ArrowLeft" => ("ArrowLeft", "ArrowLeft", 37),
        "ArrowUp" => ("ArrowUp", "ArrowUp", 38),
        "ArrowRight" => ("ArrowRight", "ArrowRight", 39),
        "ArrowDown" => ("ArrowDown", "ArrowDown", 40),
        "Home" => ("Home", "Home", 36),
        "End" => ("End", "End", 35),
        "PageUp" => ("PageUp", "PageUp", 33),
        "PageDown" => ("PageDown", "PageDown", 34),
        "Space" | " " => (" ", "Space", 32),
        _ => {
            let mut chars = key.chars();
            let ch = chars.next().filter(|ch| !ch.is_control()).ok_or_else(|| {
                "trusted input key must not be empty or a control character".to_string()
            })?;
            if chars.next().is_some() {
                return Err(format!("unsupported trusted input key: {key}"));
            }
            let upper = ch.to_uppercase().next().unwrap();
            let code = if ch.is_ascii_alphabetic() {
                format!("Key{upper}")
            } else if ch.is_ascii_digit() {
                format!("Digit{ch}")
            } else {
                match ch {
                    ';' | ':' => "Semicolon",
                    '=' | '+' => "Equal",
                    ',' | '<' => "Comma",
                    '-' | '_' => "Minus",
                    '.' | '>' => "Period",
                    '/' | '?' => "Slash",
                    '`' | '~' => "Backquote",
                    '[' | '{' => "BracketLeft",
                    '\\' | '|' => "Backslash",
                    ']' | '}' => "BracketRight",
                    '\'' | '"' => "Quote",
                    _ => "",
                }
                .to_string()
            };
            return Ok((key.to_string(), code, upper as u32));
        }
    };
    Ok((key.to_string(), code.to_string(), vk))
}

fn modifier_bits(modifiers: &[String]) -> Result<u32, String> {
    modifiers.iter().try_fold(0, |bits, modifier| {
        let bit = match modifier.to_ascii_lowercase().as_str() {
            "alt" => 1,
            "ctrl" | "control" => 2,
            "meta" => 4,
            "shift" => 8,
            _ => return Err(format!("unsupported trusted input modifier: {modifier}")),
        };
        Ok(bits | bit)
    })
}

fn input_events(action: &WebPaneTrustedInput) -> Result<(&'static str, Vec<CdpEvent>), String> {
    match action {
        WebPaneTrustedInput::Click {
            x,
            y,
            button,
            click_count,
            ..
        } => {
            finite_coordinates(&[*x, *y])?;
            let button = button.as_deref().unwrap_or("left");
            let buttons = match button {
                "left" => 1,
                "right" => 2,
                "middle" => 4,
                _ => return Err("trusted click button must be left, right, or middle".to_string()),
            };
            let count = click_count.unwrap_or(1);
            if !(1..=3).contains(&count) {
                return Err("trusted clickCount must be between 1 and 3".to_string());
            }
            Ok((
                "click",
                vec![
                    (
                        "Input.dispatchMouseEvent",
                        json!({"type":"mouseMoved", "x":x, "y":y, "button":"none", "buttons":0}),
                    ),
                    (
                        "Input.dispatchMouseEvent",
                        json!({"type":"mousePressed", "x":x, "y":y, "button":button, "buttons":buttons, "clickCount":count}),
                    ),
                    (
                        "Input.dispatchMouseEvent",
                        json!({"type":"mouseReleased", "x":x, "y":y, "button":button, "buttons":0, "clickCount":count}),
                    ),
                ],
            ))
        }
        WebPaneTrustedInput::Key {
            key,
            code,
            text,
            modifiers,
            ..
        } => {
            let (key, default_code, vk) = key_mapping(key)?;
            let modifiers = modifier_bits(modifiers.as_deref().unwrap_or(&[]))?;
            let mut down = json!({"type":"keyDown", "key":key, "code":code.as_deref().unwrap_or(&default_code),
                "windowsVirtualKeyCode":vk, "modifiers":modifiers});
            let mut up = down.clone();
            up["type"] = json!("keyUp");
            if let Some(text) = text {
                down["text"] = json!(text);
            } else if key.chars().count() == 1 && modifiers & (1 | 2 | 4) == 0 {
                down["text"] = json!(key);
            }
            Ok((
                "key",
                vec![
                    ("Input.dispatchKeyEvent", down),
                    ("Input.dispatchKeyEvent", up),
                ],
            ))
        }
        WebPaneTrustedInput::InsertText { text, .. } => Ok((
            "insertText",
            vec![("Input.insertText", json!({"text":text}))],
        )),
        WebPaneTrustedInput::Wheel {
            x,
            y,
            delta_x,
            delta_y,
            ..
        } => {
            finite_coordinates(&[*x, *y, *delta_x, *delta_y])?;
            Ok((
                "wheel",
                vec![(
                    "Input.dispatchMouseEvent",
                    json!({"type":"mouseWheel",
                "x":x, "y":y, "deltaX":delta_x, "deltaY":delta_y}),
                )],
            ))
        }
    }
}

pub(super) async fn input_trusted(
    app: &AppHandle,
    tab_id: String,
    action: WebPaneTrustedInput,
    budget: &NativeBudget,
) -> Result<WebPaneTrustedInputResult, String> {
    check_generation(action.expected_generation(), |params| async {
        cdp_call(
            app,
            &tab_id,
            "Runtime.evaluate",
            params,
            budget.call_timeout()?,
        )
        .await
    })
    .await?;
    let (kind, events) = input_events(&action)?;
    cdp_call(
        app,
        &tab_id,
        "Emulation.setFocusEmulationEnabled",
        json!({"enabled":true}),
        budget.call_timeout()?,
    )
    .await?;
    for (method, params) in events {
        cdp_call(app, &tab_id, method, params, budget.call_timeout()?).await?;
    }
    Ok(WebPaneTrustedInputResult {
        tab_id,
        kind: kind.to_string(),
    })
}

fn input_files(paths: &[String]) -> Result<Vec<WebPaneFile>, String> {
    let mut total = 0u64;
    paths
        .iter()
        .map(|path| {
            let path = std::path::Path::new(path);
            if !path.is_absolute() {
                return Err("native file input paths must be absolute".to_string());
            }
            let metadata = std::fs::metadata(path).map_err(|error| {
                format!("native file input cannot read {}: {error}", path.display())
            })?;
            if !metadata.is_file() {
                return Err(format!(
                    "native file input path is not a file: {}",
                    path.display()
                ));
            }
            total = total
                .checked_add(metadata.len())
                .filter(|total| *total <= MAX_UPLOAD_BYTES)
                .ok_or_else(|| UPLOAD_LIMIT_ERROR.to_string())?;
            Ok(WebPaneFile {
                name: path
                    .file_name()
                    .ok_or_else(|| "native file input path has no file name".to_string())?
                    .to_string_lossy()
                    .into_owned(),
                size: metadata.len(),
            })
        })
        .collect()
}

fn document_node(reply: &Value) -> Result<i64, String> {
    reply["root"]["nodeId"]
        .as_i64()
        .filter(|id| *id > 0)
        .ok_or_else(|| "DOM.getDocument returned no root node".to_string())
}

fn selected_node(reply: &Value) -> Result<i64, String> {
    match reply["nodeId"].as_i64() {
        Some(0) => Err("selector matched no element".to_string()),
        Some(id) if id > 0 => Ok(id),
        _ => Err("DOM.querySelector returned an invalid nodeId".to_string()),
    }
}

pub(super) async fn set_file_input(
    app: &AppHandle,
    tab_id: String,
    selector: String,
    paths: Vec<String>,
    expected_generation: Option<u64>,
    budget: &NativeBudget,
) -> Result<WebPaneSetFileInputResult, String> {
    check_generation(expected_generation, |params| async {
        cdp_call(
            app,
            &tab_id,
            "Runtime.evaluate",
            params,
            budget.call_timeout()?,
        )
        .await
    })
    .await?;
    // Metadata calls on remote paths may block; keep the command timer responsive.
    let (paths, files) =
        tokio::task::spawn_blocking(move || input_files(&paths).map(|files| (paths, files)))
            .await
            .map_err(|error| format!("file input worker failed: {error}"))??;
    let document = cdp_call(
        app,
        &tab_id,
        "DOM.getDocument",
        json!({"depth":0}),
        budget.call_timeout()?,
    )
    .await?;
    let root = document_node(&document)?;
    let selected = cdp_call(
        app,
        &tab_id,
        "DOM.querySelector",
        json!({"nodeId":root, "selector":selector}),
        budget.call_timeout()?,
    )
    .await?;
    let node_id = selected_node(&selected)?;
    cdp_call(
        app,
        &tab_id,
        "DOM.setFileInputFiles",
        json!({"nodeId":node_id, "files":paths}),
        budget.call_timeout()?,
    )
    .await?;
    Ok(WebPaneSetFileInputResult { tab_id, files })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn action(value: Value) -> WebPaneTrustedInput {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn observed_generation_accepts_only_integral_numbers_in_the_u32_domain() {
        for expected in [0, 42, 2147483648, 3910956446, u32::MAX as u64] {
            assert_eq!(observed_generation(&json!(expected)), Some(expected));
            assert_eq!(observed_generation(&json!(expected as f64)), Some(expected));
        }
        for value in [
            json!(1u64 << 32),
            json!(4294967296.0),
            json!(u64::MAX),
            json!(18446744073709551616.0),
            json!(42.5),
            json!(-42.0),
            json!("42"),
            json!(null),
            json!(true),
        ] {
            assert_eq!(observed_generation(&value), None, "{value}");
        }
    }

    #[tokio::test]
    async fn generation_check_accepts_chromium_doubles_but_rejects_two_to_the_thirty_two() {
        for expected in [2147483648, 3910956446, u32::MAX as u64] {
            check_generation(Some(expected), |_| {
                std::future::ready(Ok(
                    json!({"result":{"type":"number", "value":expected as f64}}),
                ))
            })
            .await
            .unwrap();
        }
        for value in [json!(1u64 << 32), json!(4294967296.0)] {
            assert_eq!(
                check_generation(Some(1u64 << 32), |_| std::future::ready(Ok(
                    json!({"result":{"value":value}})
                )))
                .await
                .unwrap_err(),
                GENERATION_CHANGED
            );
        }
    }

    #[tokio::test]
    async fn generation_check_uses_a_read_only_evaluation_and_skips_omitted_expectations() {
        assert_eq!(
            generation_params(),
            json!({
                "expression":"window.__mycmux && window.__mycmux.generation", "returnByValue":true
            })
        );
        let mut queried = false;
        check_generation(None, |_| {
            queried = true;
            std::future::ready(Err("must not be called".to_string()))
        })
        .await
        .unwrap();
        assert!(!queried);
        for expected in [0, 42, u32::MAX as u64] {
            check_generation(Some(expected), |params| {
                assert_eq!(params, generation_params());
                std::future::ready(Ok(json!({"result":{"type":"number", "value":expected}})))
            })
            .await
            .unwrap();
        }
    }

    #[tokio::test]
    async fn generation_mismatch_or_undefined_prevents_following_input() {
        for reply in [
            json!({"result":{"value":43}}),
            json!({"result":{"type":"undefined"}}),
            json!({"result":{"value":null}}),
            json!({"result":{"value":"42"}}),
            json!({"result":{"value":42}, "exceptionDetails":{"text":"failed"}}),
        ] {
            let mut input_sent = false;
            let result = async {
                check_generation(Some(42), |_| std::future::ready(Ok(reply))).await?;
                input_sent = true;
                Ok::<(), String>(())
            }
            .await;
            assert_eq!(
                result.unwrap_err(),
                "page changed since the target was resolved; snapshot again"
            );
            assert!(!input_sent);
        }
        assert_eq!(
            check_generation(Some(42), |_| std::future::ready(Err(
                "Runtime.evaluate failed".into()
            )))
            .await
            .unwrap_err(),
            "Runtime.evaluate failed"
        );
    }

    #[test]
    fn click_count_accepts_only_one_through_three() {
        for count in [1, 2, 3] {
            let (_, events) = input_events(&action(
                json!({"kind":"click", "x":0, "y":0, "clickCount":count}),
            ))
            .unwrap();
            assert_eq!(events[1].1["clickCount"], count);
            assert_eq!(events[2].1["clickCount"], count);
        }
        for count in [0, 4, u32::MAX] {
            assert_eq!(
                input_events(&action(
                    json!({"kind":"click", "x":0, "y":0, "clickCount":count})
                ))
                .unwrap_err(),
                "trusted clickCount must be between 1 and 3"
            );
        }
    }

    #[test]
    fn file_input_enforces_the_combined_twenty_five_mib_boundary() {
        let dir = tempfile::tempdir().unwrap();
        let first = dir.path().join("first.bin");
        let second = dir.path().join("second.bin");
        std::fs::File::create(&first)
            .unwrap()
            .set_len(MAX_UPLOAD_BYTES - 1)
            .unwrap();
        let second_file = std::fs::File::create(&second).unwrap();
        let paths = vec![
            first.to_string_lossy().into_owned(),
            second.to_string_lossy().into_owned(),
        ];
        second_file.set_len(1).unwrap();
        assert_eq!(
            input_files(&paths)
                .unwrap()
                .iter()
                .map(|file| file.size)
                .sum::<u64>(),
            25 * 1024 * 1024
        );
        second_file.set_len(2).unwrap();
        assert_eq!(
            input_files(&paths).unwrap_err(),
            "web.upload files exceed the 25 MB limit"
        );
        second_file.set_len(0).unwrap();
        assert!(input_files(&paths).is_ok());
    }

    #[test]
    fn click_is_an_ordered_move_press_release_sequence() {
        let (kind, events) = input_events(&action(
            json!({"kind":"click", "x":10.5, "y":20.0, "button":"right", "clickCount":2}),
        ))
        .unwrap();
        assert_eq!(kind, "click");
        assert_eq!(
            events,
            vec![
                (
                    "Input.dispatchMouseEvent",
                    json!({"type":"mouseMoved", "x":10.5, "y":20.0, "button":"none", "buttons":0})
                ),
                (
                    "Input.dispatchMouseEvent",
                    json!({"type":"mousePressed", "x":10.5, "y":20.0, "button":"right", "buttons":2, "clickCount":2})
                ),
                (
                    "Input.dispatchMouseEvent",
                    json!({"type":"mouseReleased", "x":10.5, "y":20.0, "button":"right", "buttons":0, "clickCount":2})
                ),
            ]
        );
        for (button, mask) in [(None, 1), (Some("left"), 1), (Some("middle"), 4)] {
            let (_, events) = input_events(&action(
                json!({"kind":"click", "x":0, "y":0, "button":button}),
            ))
            .unwrap();
            assert_eq!(events[1].1["buttons"], mask);
            assert_eq!(events[1].1["clickCount"], 1);
            assert_eq!(events[1].1["button"], button.unwrap_or("left"));
        }
    }

    #[test]
    fn click_rejects_invalid_button_count_and_coordinates() {
        for extra in [
            json!({"button":"back"}),
            json!({"clickCount":0}),
            json!({"clickCount":u32::MAX}),
        ] {
            let mut value = json!({"kind":"click", "x":0, "y":0});
            value
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            assert!(input_events(&action(value)).is_err());
        }
        assert!(input_events(&WebPaneTrustedInput::Click {
            x: f64::NAN,
            y: 0.0,
            button: None,
            click_count: None,
            expected_generation: None
        })
        .is_err());
    }

    #[test]
    fn key_mapping_covers_navigation_space_and_printable_keys() {
        for (key, vk, code) in [
            ("Enter", 13, "Enter"),
            ("Tab", 9, "Tab"),
            ("Escape", 27, "Escape"),
            ("Backspace", 8, "Backspace"),
            ("Delete", 46, "Delete"),
            ("ArrowLeft", 37, "ArrowLeft"),
            ("ArrowUp", 38, "ArrowUp"),
            ("ArrowRight", 39, "ArrowRight"),
            ("ArrowDown", 40, "ArrowDown"),
            ("Home", 36, "Home"),
            ("End", 35, "End"),
            ("PageUp", 33, "PageUp"),
            ("PageDown", 34, "PageDown"),
            ("Space", 32, "Space"),
            (" ", 32, "Space"),
            ("a", 65, "KeyA"),
            ("Z", 90, "KeyZ"),
            ("7", 55, "Digit7"),
            ("/", 47, "Slash"),
            ("\u{3042}", 0x3042, ""),
        ] {
            let (_, events) = input_events(&action(json!({"kind":"key", "key":key}))).unwrap();
            assert_eq!(events.len(), 2);
            assert_eq!(events[0].0, "Input.dispatchKeyEvent");
            assert_eq!(events[0].1["type"], "keyDown");
            assert_eq!(events[1].1["type"], "keyUp");
            assert_eq!(events[0].1["windowsVirtualKeyCode"], vk, "{key}");
            assert_eq!(events[0].1["code"], code, "{key}");
            assert_eq!(events[0].1["modifiers"], 0);
            assert_eq!(events[0].1["key"], if key == "Space" { " " } else { key });
            if key.chars().count() == 1 || key == "Space" {
                assert_eq!(events[0].1["text"], if key == "Space" { " " } else { key });
            } else {
                assert!(events[0].1.get("text").is_none());
            }
            assert!(events[1].1.get("text").is_none());
        }
    }

    #[test]
    fn key_modifiers_and_explicit_text_code_are_preserved() {
        for (modifier, bits) in [("alt", 1), ("ctrl", 2), ("meta", 4), ("shift", 8)] {
            let (_, events) = input_events(&action(
                json!({"kind":"key", "key":"a", "modifiers":[modifier]}),
            ))
            .unwrap();
            assert_eq!(events[0].1["modifiers"], bits);
            assert_eq!(events[1].1["modifiers"], bits);
            assert_eq!(events[0].1.get("text").is_some(), modifier == "shift");
        }
        let (_, events) = input_events(&action(json!({"kind":"key", "key":"Enter", "code":"NumpadEnter", "text":"\r", "modifiers":["Alt","Ctrl","Meta","Shift","ctrl"]}))).unwrap();
        assert_eq!(
            events[0].1,
            json!({"type":"keyDown", "key":"Enter", "code":"NumpadEnter", "text":"\r", "windowsVirtualKeyCode":13, "modifiers":15})
        );
        assert_eq!(
            events[1].1,
            json!({"type":"keyUp", "key":"Enter", "code":"NumpadEnter", "windowsVirtualKeyCode":13, "modifiers":15})
        );
        assert!(input_events(&action(
            json!({"kind":"key", "key":"a", "modifiers":["hyper"]})
        ))
        .is_err());
        for key in ["", "UnknownKey", "\n"] {
            assert!(input_events(&action(json!({"kind":"key", "key":key}))).is_err());
        }
    }

    #[test]
    fn wheel_and_insert_text_use_their_native_cdp_methods() {
        assert_eq!(
            input_events(&action(
                json!({"kind":"wheel", "x":12.0, "y":24.0, "deltaX":-25.0, "deltaY":600.0})
            ))
            .unwrap(),
            (
                "wheel",
                vec![(
                    "Input.dispatchMouseEvent",
                    json!({"type":"mouseWheel", "x":12.0, "y":24.0, "deltaX":-25.0, "deltaY":600.0})
                )]
            )
        );
        assert_eq!(
            input_events(&action(
                json!({"kind":"insertText", "text":"\u{65e5}\u{672c}\u{8a9e}\n\"quoted\""})
            ))
            .unwrap(),
            (
                "insertText",
                vec![(
                    "Input.insertText",
                    json!({"text":"\u{65e5}\u{672c}\u{8a9e}\n\"quoted\""})
                )]
            )
        );
        assert!(input_events(&WebPaneTrustedInput::Wheel {
            x: 0.0,
            y: 0.0,
            delta_x: 0.0,
            delta_y: f64::INFINITY,
            expected_generation: None
        })
        .is_err());
    }

    #[test]
    fn capture_fills_the_viewport_and_scales_to_css_pixels() {
        let viewport = Viewport {
            width: 800.0,
            height: 600.0,
            dpr: 1.5,
        };
        assert_eq!(
            capture_params(viewport, None).unwrap(),
            json!({"format":"png", "captureBeyondViewport":false,
            "clip":{"x":0.0, "y":0.0, "width":800.0, "height":600.0, "scale":1.0/1.5}})
        );
        assert_eq!(
            capture_params(
                viewport,
                Some(WebPaneClip {
                    x: 12.0,
                    y: 24.0,
                    width: 200.0,
                    height: 100.0
                })
            )
            .unwrap(),
            json!({"format":"png", "captureBeyondViewport":false, "clip":{"x":12.0, "y":24.0, "width":200.0, "height":100.0, "scale":1.0/1.5}})
        );
    }

    #[test]
    fn capture_rejects_invalid_viewport_and_clip_values() {
        for value in [
            json!({}),
            json!({"exceptionDetails":{"text":"failed"}}),
            json!({"result":{"value":{"w":0,"h":600,"dpr":1}}}),
        ] {
            assert!(viewport_from_reply(&value).is_err());
        }
        let viewport =
            viewport_from_reply(&json!({"result":{"value":{"w":800,"h":600,"dpr":1.5}}})).unwrap();
        for clip in [
            WebPaneClip {
                x: -1.0,
                y: 0.0,
                width: 10.0,
                height: 10.0,
            },
            WebPaneClip {
                x: 0.0,
                y: 0.0,
                width: 0.0,
                height: 10.0,
            },
            WebPaneClip {
                x: 0.0,
                y: 0.0,
                width: 10.0,
                height: f64::NAN,
            },
        ] {
            assert!(capture_params(viewport, Some(clip)).is_err());
        }
        assert!(capture_params(
            Viewport {
                dpr: 0.0,
                ..viewport
            },
            None
        )
        .is_err());
    }

    #[test]
    fn png_size_mismatch_returns_measured_dimensions_and_ratio() {
        let params = capture_params(
            Viewport {
                width: 800.0,
                height: 600.0,
                dpr: 1.5,
            },
            None,
        )
        .unwrap();
        let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        png.extend(800u32.to_be_bytes());
        png.extend(600u32.to_be_bytes());
        png.extend([8, 6, 0, 0, 0, 0, 0, 0, 0]);
        assert_eq!(
            screenshot_dimensions(&png, &params, 1.5).unwrap(),
            (800, 600, 1.5)
        );
        png[16..20].copy_from_slice(&1200u32.to_be_bytes());
        png[20..24].copy_from_slice(&900u32.to_be_bytes());
        assert_eq!(
            screenshot_dimensions(&png, &params, 2.0).unwrap(),
            (1200, 900, 1.5)
        );
    }

    #[test]
    fn cdp_errors_preserve_method_hresult_json_and_hidden_hint() {
        assert_eq!(
            decode_cdp_reply("DOM.getDocument", 0, "{}").unwrap(),
            json!({})
        );
        let error = decode_cdp_reply("DOM.getDocument", 0x80004005u32 as i32, "{}").unwrap_err();
        assert!(error.contains("DOM.getDocument HRESULT 0x80004005"));
        assert!(decode_cdp_reply("Runtime.evaluate", 0, "not json")
            .unwrap_err()
            .contains("Runtime.evaluate returned invalid JSON"));
        assert!(
            decode_cdp_reply("Input.insertText", 0, r#"{"error":{"code":-1}}"#)
                .unwrap_err()
                .contains("Input.insertText protocol error")
        );
        assert_eq!(cdp_error("Page.captureScreenshot", "timed out", true), "Page.captureScreenshot failed: timed out; tab is hidden; open with --background or focus it");
        assert_eq!(
            cdp_error("Input.insertText", "denied", false),
            "Input.insertText failed: denied"
        );
    }

    #[test]
    fn file_input_checks_real_absolute_files_and_the_upload_limit() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("large file.bin");
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(MAX_UPLOAD_BYTES).unwrap();
        let files = input_files(&[path.to_string_lossy().into_owned()]).unwrap();
        assert_eq!(files[0].name, "large file.bin");
        assert_eq!(files[0].size, MAX_UPLOAD_BYTES);
        file.set_len(MAX_UPLOAD_BYTES + 1).unwrap();
        assert_eq!(
            input_files(&[path.to_string_lossy().into_owned()]).unwrap_err(),
            UPLOAD_LIMIT_ERROR
        );
        assert!(input_files(&[]).unwrap().is_empty());
        assert!(input_files(&["relative.txt".into()])
            .unwrap_err()
            .contains("absolute"));
        assert!(input_files(&[dir.path().to_string_lossy().into_owned()])
            .unwrap_err()
            .contains("not a file"));
        assert!(input_files(&[dir.path().join("missing").to_string_lossy().into_owned()]).is_err());
    }

    #[test]
    fn file_input_node_ids_are_validated_before_setting_files() {
        assert_eq!(document_node(&json!({"root":{"nodeId":1}})).unwrap(), 1);
        assert!(document_node(&json!({"root":{"nodeId":0}})).is_err());
        assert_eq!(selected_node(&json!({"nodeId":12})).unwrap(), 12);
        assert_eq!(
            selected_node(&json!({"nodeId":0})).unwrap_err(),
            "selector matched no element"
        );
        for value in [json!({}), json!({"nodeId":-1}), json!({"nodeId":"12"})] {
            assert!(selected_node(&value).is_err());
        }
    }
}
