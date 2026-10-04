//! WKWebView native automation. All AppKit work stays on the main thread;
//! events are delivered only to this view, never posted to the OS event queue.
use std::{cell::RefCell, collections::HashMap, rc::Rc, time::Duration};

use block2::{Block, RcBlock};
use objc2::{
    class, define_class, msg_send,
    rc::Retained,
    runtime::{AnyObject, NSObject, Sel},
    AnyThread, DefinedClass, MainThreadOnly, Message,
};
use objc2_app_kit::{
    NSBitmapImageFileType, NSBitmapImageRep, NSEvent, NSEventModifierFlags, NSEventType, NSImage,
};
use objc2_foundation::{
    MainThreadMarker, NSArray, NSDictionary, NSError, NSObjectProtocol, NSPoint, NSRange, NSRect,
    NSSize, NSString, NSNotFound,
};
use objc2_web_kit::{WKSnapshotConfiguration, WKWebView};
use serde_json::Value;
use tauri::{AppHandle, Manager};
use tokio::sync::oneshot;

use super::{
    png_dimensions, screenshot_path, write_screenshot, NativeBudget, WebPaneClip, WebPaneFile,
    WebPaneScreenshotResult, WebPaneSetFileInputResult, WebPaneTrustedInput,
    WebPaneTrustedInputResult,
};

const GENERATION_CHANGED: &str = "page changed since the target was resolved; snapshot again";
const MAX_UPLOAD_BYTES: u64 = 25 * 1024 * 1024;
static UPLOAD_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn javascript_error_message(operation: &str, detail: &str) -> String {
    let message = detail.strip_prefix("Error: ").unwrap_or(detail);
    match message {
        GENERATION_CHANGED
        | "selector matched no element"
        | "target is disabled"
        | "native file input target is not a file input" => message.to_string(),
        _ => format!("{operation} failed: {detail}"),
    }
}

fn javascript_error(operation: &str, error: &NSError) -> String {
    let info = error.userInfo();
    let detail = info
        .objectForKey(&NSString::from_str("WKJavaScriptExceptionMessage"))
        .map(|value| unsafe {
            let text: Retained<NSString> = msg_send![&*value, description];
            text.to_string()
        })
        .unwrap_or_else(|| error.localizedDescription().to_string());
    javascript_error_message(operation, &detail)
}

fn webview(app: &AppHandle, tab_id: &str) -> Result<tauri::Webview, String> {
    let label = super::super::webpane::webview_label(tab_id)?;
    app.get_webview(&label)
        .ok_or_else(|| "web pane does not exist".to_string())
}

async fn receive<T>(
    rx: oneshot::Receiver<Result<T, String>>,
    timeout: Duration,
    operation: &str,
) -> Result<T, String> {
    tokio::time::timeout(timeout, rx)
        .await
        .map_err(|_| {
            format!(
                "{operation} failed: timed out after {} ms",
                timeout.as_millis()
            )
        })?
        .map_err(|_| format!("{operation} failed: completion handler disconnected"))?
}

/// JSON.stringify avoids coercing heterogeneous Objective-C values. No eval(),
/// debugging port or page IPC is needed, and the native callback obeys the budget.
async fn evaluate(
    app: &AppHandle,
    tab_id: &str,
    expression: String,
    budget: &NativeBudget,
) -> Result<Value, String> {
    let view = webview(app, tab_id)?;
    let timeout = budget.call_timeout()?;
    let (tx, rx) = oneshot::channel();
    crate::mac_webview::with_webview(&view, move |platform| {
        if tx.is_closed() {
            return;
        }
        let sender = Rc::new(RefCell::new(Some(tx)));
        let handler = RcBlock::new(move |value: *mut AnyObject, error: *mut NSError| {
            let result = unsafe {
                if let Some(error) = error.as_ref() {
                    Err(javascript_error("Runtime.evaluate", error))
                } else if value.is_null() {
                    Ok(Value::Null)
                } else {
                    let is_string: bool = msg_send![value, isKindOfClass: class!(NSString)];
                    if is_string {
                        serde_json::from_str((&*(value as *const NSString)).to_string().as_str())
                            .map_err(|error| {
                                format!("Runtime.evaluate returned invalid JSON: {error}")
                            })
                    } else {
                        Err("Runtime.evaluate returned a non-JSON value".to_string())
                    }
                }
            };
            if let Some(tx) = sender.borrow_mut().take() {
                let _ = tx.send(result);
            }
        });
        // SAFETY: with_webview executes on the UI thread and inner is WKWebView.
        let wk = unsafe { &*(platform.inner() as *const WKWebView) };
        let script = NSString::from_str(&format!("JSON.stringify(({expression}) ?? null)"));
        unsafe {
            wk.evaluateJavaScript_completionHandler(&script, Some(&handler));
        }
    })
    .map_err(|error| format!("Runtime.evaluate failed: {error}"))?;
    receive(rx, timeout, "Runtime.evaluate").await
}

fn observed_generation(value: &Value) -> Option<u64> {
    value
        .as_f64()
        .filter(|n| n.is_finite() && *n >= 0.0 && n.fract() == 0.0 && *n <= u32::MAX as f64)
        .map(|n| n as u64)
}

async fn check_generation(
    app: &AppHandle,
    tab_id: &str,
    expected: Option<u64>,
    budget: &NativeBudget,
) -> Result<(), String> {
    if let Some(expected) = expected {
        let generation = evaluate(
            app,
            tab_id,
            "window.__mycmux && window.__mycmux.generation".into(),
            budget,
        )
        .await?;
        if observed_generation(&generation) != Some(expected) {
            return Err(GENERATION_CHANGED.to_string());
        }
    }
    Ok(())
}

fn checked_clip(viewport: &Value, clip: Option<WebPaneClip>) -> Result<(WebPaneClip, f64), String> {
    let read = |name: &str| {
        viewport[name]
            .as_f64()
            .filter(|n| n.is_finite() && *n > 0.0)
            .ok_or_else(|| format!("Runtime.evaluate returned invalid viewport {name}"))
    };
    let width = read("w")?;
    let height = read("h")?;
    let dpr = read("dpr")?;
    let clip = clip.unwrap_or(WebPaneClip {
        x: 0.0,
        y: 0.0,
        width,
        height,
    });
    if ![clip.x, clip.y, clip.width, clip.height, dpr]
        .iter()
        .all(|n| n.is_finite())
        || clip.x < 0.0
        || clip.y < 0.0
        || clip.width <= 0.0
        || clip.height <= 0.0
        || !(1.0 / dpr).is_finite()
    {
        return Err("Page.captureScreenshot requires a finite positive clip and DPR".to_string());
    }
    Ok((clip, dpr))
}


/// CGImage is immutable and CoreGraphics documents cross-thread use. Transfer
/// precisely one retained image to the worker; no AppKit view leaves the UI.
struct SnapshotImage(usize);
impl Drop for SnapshotImage {
    fn drop(&mut self) { unsafe { CGImageRelease(self.0 as *const std::ffi::c_void); } }
}
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGImageRetain(image: *const std::ffi::c_void) -> *const std::ffi::c_void;
    fn CGImageRelease(image: *const std::ffi::c_void);
}

fn encode_snapshot(image: SnapshotImage) -> Result<Vec<u8>, String> {
    objc2::rc::autoreleasepool(|_| unsafe {
        let bitmap: Retained<NSBitmapImageRep> = msg_send![NSBitmapImageRep::alloc(),
            initWithCGImage: image.0 as *const std::ffi::c_void];
        bitmap.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new())
            .map(|png| png.to_vec())
            .ok_or_else(|| "Page.captureScreenshot returned no PNG data".to_string())
    })
}

pub(super) async fn screenshot(
    app: &AppHandle,
    tab_id: String,
    path: Option<String>,
    clip: Option<WebPaneClip>,
    budget: &NativeBudget,
) -> Result<WebPaneScreenshotResult, String> {
    let home = if path.is_none() {
        dirs::home_dir().ok_or_else(|| "failed to resolve home directory".to_string())?
    } else {
        std::path::PathBuf::new()
    };
    let path = screenshot_path(&home, &tab_id, path.as_deref(), chrono::Utc::now())?;
    let viewport = evaluate(
        app,
        &tab_id,
        "({w:innerWidth,h:innerHeight,dpr:devicePixelRatio})".into(),
        budget,
    )
    .await?;
    let (clip, dpr) = checked_clip(&viewport, clip)?;
    let view = webview(app, &tab_id)?;
    let timeout = budget.call_timeout()?;
    let (tx, rx) = oneshot::channel();
    crate::mac_webview::with_webview(&view, move |platform| {
        if tx.is_closed() {
            return;
        }
        let wk = unsafe { &*(platform.inner() as *const WKWebView) };
        let config = unsafe {
            WKSnapshotConfiguration::new(MainThreadMarker::new().expect("WKWebView on main thread"))
        };
        let bounds = wk.bounds();
        let sx = bounds.size.width / viewport["w"].as_f64().unwrap();
        let sy = bounds.size.height / viewport["h"].as_f64().unwrap();
        unsafe {
            let rect = NSRect::new(
                NSPoint::new(clip.x * sx, clip.y * sy),
                NSSize::new(clip.width * sx, clip.height * sy),
            );
            let _: () = msg_send![&*config,setRect:rect];
            let width: Retained<AnyObject> =
                msg_send![class!(NSNumber),numberWithDouble:clip.width/dpr];
            let _: () = msg_send![&*config,setSnapshotWidth:&*width];
            config.setAfterScreenUpdates(true);
        }
        let sender = Rc::new(RefCell::new(Some(tx)));
        let handler = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
            #[cfg(feature = "e2e")]
            let main_started = std::time::Instant::now();
            let result = if let Some(image) = unsafe { image.as_ref() } {
                let cg: *const std::ffi::c_void = unsafe { msg_send![image,
                    CGImageForProposedRect: std::ptr::null_mut::<NSRect>(),
                    context: Option::<&AnyObject>::None, hints: Option::<&AnyObject>::None] };
                if cg.is_null() {
                    Err("Page.captureScreenshot returned no CGImage".to_string())
                } else {
                    Ok(SnapshotImage(unsafe { CGImageRetain(cg) } as usize))
                }
            } else {
                let reason = unsafe { error.as_ref() }
                    .map(|error| error.localizedDescription().to_string())
                    .unwrap_or_else(|| "no image".into());
                Err(format!("Page.captureScreenshot failed: {reason}"))
            };
            #[cfg(feature = "e2e")]
            eprintln!("[m4] snapshot_main_ms={:.6}", main_started.elapsed().as_secs_f64()*1000.0);
            if let Some(tx) = sender.borrow_mut().take() {
                let _ = tx.send(result);
            }
        });
        unsafe {
            wk.takeSnapshotWithConfiguration_completionHandler(Some(&config), &handler);
        }
    })
    .map_err(|error| format!("Page.captureScreenshot failed: {error}"))?;
    let image = receive(rx, timeout, "Page.captureScreenshot").await?;
    let write_budget = budget.clone();
    tokio::task::spawn_blocking(move || {
        write_budget.call_timeout()?;
        #[cfg(feature = "e2e")]
        let worker_started = std::time::Instant::now();
        let png = encode_snapshot(image)?;
        #[cfg(feature = "e2e")]
        eprintln!("[m4] snapshot_worker_ms={:.6}", worker_started.elapsed().as_secs_f64()*1000.0);
        let (width, height) = png_dimensions(&png)?;
        let dpr = if f64::from(width) == clip.width && f64::from(height) == clip.height {
            dpr
        } else {
            f64::from(width) / clip.width
        };
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

fn finite(values: &[f64]) -> Result<(), String> {
    if values.iter().all(|n| n.is_finite()) {
        Ok(())
    } else {
        Err("trusted input coordinates and deltas must be finite".into())
    }
}

fn modifiers(values: &[String]) -> Result<NSEventModifierFlags, String> {
    values
        .iter()
        .try_fold(NSEventModifierFlags::empty(), |bits, modifier| {
            Ok(bits
                | match modifier.to_ascii_lowercase().as_str() {
                    "alt" => NSEventModifierFlags::Option,
                    "ctrl" | "control" => NSEventModifierFlags::Control,
                    "meta" => NSEventModifierFlags::Command,
                    "shift" => NSEventModifierFlags::Shift,
                    _ => return Err(format!("unsupported trusted input modifier: {modifier}")),
                })
        })
}

/// USB/ANSI macOS virtual key codes, not Windows VK numbers.
fn key_mapping(key: &str, code: Option<&str>) -> Result<(String, u16), String> {
    let (text, default_code) = match key {
        "Enter" => ("\r".into(), 36),
        "Tab" => ("\t".into(), 48),
        "Escape" => ("\u{1b}".into(), 53),
        "Backspace" => ("\u{7f}".into(), 51),
        "Delete" => ("\u{f728}".into(), 117),
        "ArrowLeft" => ("\u{f702}".into(), 123),
        "ArrowUp" => ("\u{f700}".into(), 126),
        "ArrowRight" => ("\u{f703}".into(), 124),
        "ArrowDown" => ("\u{f701}".into(), 125),
        "Home" => ("\u{f729}".into(), 115),
        "End" => ("\u{f72b}".into(), 119),
        "PageUp" => ("\u{f72c}".into(), 116),
        "PageDown" => ("\u{f72d}".into(), 121),
        "Space" | " " => (" ".into(), 49),
        _ => {
            let mut chars = key.chars();
            let ch = chars.next().filter(|ch| !ch.is_control()).ok_or_else(|| {
                "trusted input key must not be empty or a control character".to_string()
            })?;
            if chars.next().is_some() {
                return Err(format!("unsupported trusted input key: {key}"));
            }
            (key.to_string(), physical_key(ch).unwrap_or(0))
        }
    };
    let physical = code
        .and_then(|c| c.strip_prefix("Key").or_else(|| c.strip_prefix("Digit")))
        .and_then(|c| c.chars().next())
        .and_then(physical_key)
        .unwrap_or(default_code);
    Ok((text, physical))
}

fn physical_key(ch: char) -> Option<u16> {
    Some(match ch.to_ascii_lowercase() {
        'a' => 0,
        's' => 1,
        'd' => 2,
        'f' => 3,
        'h' => 4,
        'g' => 5,
        'z' => 6,
        'x' => 7,
        'c' => 8,
        'v' => 9,
        'b' => 11,
        'q' => 12,
        'w' => 13,
        'e' => 14,
        'r' => 15,
        'y' => 16,
        't' => 17,
        '1' => 18,
        '2' => 19,
        '3' => 20,
        '4' => 21,
        '6' => 22,
        '5' => 23,
        '=' | '+' => 24,
        '9' => 25,
        '7' => 26,
        '-' | '_' => 27,
        '8' => 28,
        '0' => 29,
        ']' | '}' => 30,
        'o' => 31,
        'u' => 32,
        '[' | '{' => 33,
        'i' => 34,
        'p' => 35,
        'l' => 37,
        'j' => 38,
        '\'' | '"' => 39,
        'k' => 40,
        ';' | ':' => 41,
        '\\' | '|' => 42,
        ',' | '<' => 43,
        '/' | '?' => 44,
        'n' => 45,
        'm' => 46,
        '.' | '>' => 47,
        '`' | '~' => 50,
        _ => return None,
    })
}

fn validate_input(action: &WebPaneTrustedInput) -> Result<&'static str, String> {
    Ok(match action {
        WebPaneTrustedInput::Click {
            x,
            y,
            button,
            click_count,
            ..
        } => {
            finite(&[*x, *y])?;
            if !matches!(
                button.as_deref().unwrap_or("left"),
                "left" | "right" | "middle"
            ) {
                return Err("trusted click button must be left, right, or middle".into());
            }
            if button.as_deref() == Some("right") {
                return Err("trusted right click is not supported on macOS; native context menus are disabled".into());
            }
            if !(1..=3).contains(&click_count.unwrap_or(1)) {
                return Err("trusted clickCount must be between 1 and 3".into());
            }
            "click"
        }
        WebPaneTrustedInput::Key {
            key,
            code,
            modifiers: mods,
            ..
        } => {
            let mods = mods.as_deref().unwrap_or(&[]);
            // WebKit may resend unhandled Command shortcuts to NSApp, and
            // paste: reads the operator's clipboard even without resending.
            // Reject before dispatch or temporarily changing the responder.
            if mods.iter().any(|modifier| modifier.eq_ignore_ascii_case("meta")) {
                return Err("trusted key with the meta modifier is not supported on macOS; use web-type for text".into());
            }
            key_mapping(key, code.as_deref())?;
            modifiers(mods)?;
            "key"
        }
        WebPaneTrustedInput::InsertText { .. } => "insertText",
        WebPaneTrustedInput::Wheel {
            x,
            y,
            delta_x,
            delta_y,
            ..
        } => {
            finite(&[*x, *y, *delta_x, *delta_y])?;
            "wheel"
        }
    })
}

fn view_point(wk: &WKWebView, x: f64, y: f64) -> NSPoint {
    let bounds = wk.bounds();
    NSPoint::new(
        bounds.origin.x + x,
        if wk.isFlipped() {
            bounds.origin.y + y
        } else {
            bounds.origin.y + bounds.size.height - y
        },
    )
}

fn event_uptime() -> f64 {
    unsafe {
        let info: Retained<AnyObject> = msg_send![class!(NSProcessInfo), processInfo];
        msg_send![&*info, systemUptime]
    }
}

unsafe fn mouse(wk: &WKWebView, x: f64, y: f64, button: &str, count: u32) -> Result<(), String> {
    let window = wk
        .window()
        .ok_or_else(|| "trusted input webview has no window".to_string())?;
    let point = wk.convertPoint_toView(view_point(wk, x, y), None);
    let (down, up) = match button {
        "left" => (NSEventType::LeftMouseDown, NSEventType::LeftMouseUp),
        "right" => (NSEventType::RightMouseDown, NSEventType::RightMouseUp),
        _ => (NSEventType::OtherMouseDown, NSEventType::OtherMouseUp),
    };
    for ty in [NSEventType::MouseMoved, down, up] {
        let event=NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
            ty,point,NSEventModifierFlags::empty(),event_uptime(),window.windowNumber(),None,0,count as isize,if ty==down{1.0}else{0.0})
            .ok_or_else(||"trusted input could not create mouse event".to_string())?;
        match ty {
            NSEventType::MouseMoved => wk.mouseMoved(&event),
            NSEventType::LeftMouseDown => wk.mouseDown(&event),
            NSEventType::LeftMouseUp => wk.mouseUp(&event),
            NSEventType::RightMouseDown => wk.rightMouseDown(&event),
            NSEventType::RightMouseUp => wk.rightMouseUp(&event),
            NSEventType::OtherMouseDown => wk.otherMouseDown(&event),
            _ => wk.otherMouseUp(&event),
        }
    }
    Ok(())
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventCreateScrollWheelEvent2(
        source: *const std::ffi::c_void,
        units: u32,
        count: u32,
        wheel1: i32,
        wheel2: i32,
        wheel3: i32,
    ) -> *mut std::ffi::c_void;
    fn CGEventSetLocation(event: *mut std::ffi::c_void, point: NSPoint);
    fn CGEventSetIntegerValueField(event: *mut std::ffi::c_void, field: u32, value: i64);
}
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRelease(object: *const std::ffi::c_void);
}

unsafe fn dispatch(wk: &WKWebView, action: &WebPaneTrustedInput) -> Result<(), String> {
    let window = wk
        .window()
        .ok_or_else(|| "trusted input webview has no window".to_string())?;
    match action {
        WebPaneTrustedInput::Click {
            x,
            y,
            button,
            click_count,
            ..
        } => mouse(
            wk,
            *x,
            *y,
            button.as_deref().unwrap_or("left"),
            click_count.unwrap_or(1),
        )?,
        WebPaneTrustedInput::InsertText { text, .. } => {
            let text = NSString::from_str(text);
            let _: () = msg_send![wk,insertText:&*text,replacementRange:NSRange::new(NSNotFound as usize,0)];
        }
        WebPaneTrustedInput::Key {
            key,
            code,
            text,
            modifiers: mods,
            ..
        } => {
            let (base, code) = key_mapping(key, code.as_deref())?;
            let flags = modifiers(mods.as_deref().unwrap_or(&[]))?;
            let chars = NSString::from_str(text.as_deref().unwrap_or(&base));
            let plain = NSString::from_str(&base);
            if flags.intersection(NSEventModifierFlags::Control | NSEventModifierFlags::Command
                | NSEventModifierFlags::Option).is_empty()
                && (key.chars().count() == 1 || key == "Space") {
                // Printable text must bypass the operator's selected IME.
                let _: () = msg_send![wk,insertText:&*chars,replacementRange:NSRange::new(NSNotFound as usize,0)];
                return Ok(());
            }
            for ty in [NSEventType::KeyDown, NSEventType::KeyUp] {
                let event=NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(
                    ty,NSPoint::new(0.0,0.0),flags,event_uptime(),window.windowNumber(),None,&chars,&plain,false,code)
                    .ok_or_else(||"trusted input could not create key event".to_string())?;
                if ty == NSEventType::KeyDown {
                    wk.keyDown(&event);
                } else {
                    wk.keyUp(&event);
                }
            }
        }
        WebPaneTrustedInput::Wheel {
            x,
            y,
            delta_x,
            delta_y,
            ..
        } => {
            // A CGEvent is only an in-memory backing for NSEvent. It is never
            // posted, and therefore needs no Accessibility permission.
            let point = wk.convertPoint_toView(view_point(wk, *x, *y), None);
            // eventWithCGEvent has no associated window. Use the same flipped
            // window coordinates as WebKit's EventSenderProxy: AppKit then
            // exposes locationInWindow in this view's target window, rather
            // than offsetting the native wheel by the window's screen origin.
            let screens: Retained<NSArray<AnyObject>> = msg_send![class!(NSScreen), screens];
            let primary_height = screens
                .firstObject()
                .map(|screen| {
                    let frame: NSRect = msg_send![&*screen, frame];
                    frame.size.height
                })
                .unwrap_or(0.0);
            let dx = (-*delta_x).round() as i32;
            let dy = (-*delta_y).round() as i32;
            for (phase, dx, dy) in [
                (1, dx.signum(), dy.signum()),
                (2, dx - dx.signum(), dy - dy.signum()),
                (4, 0, 0),
            ] {
                let cg = CGEventCreateScrollWheelEvent2(std::ptr::null(), 0, 2, dy, dx, 0);
                if cg.is_null() {
                    return Err("trusted input could not create wheel event".into());
                }
                CGEventSetLocation(cg, NSPoint::new(point.x, primary_height - point.y));
                // Public CGEventField constants: continuous pixel scrolling,
                // scroll phase and momentum phase. Delivery stays view-local.
                CGEventSetIntegerValueField(cg, 88, 1);
                CGEventSetIntegerValueField(cg, 99, phase);
                CGEventSetIntegerValueField(cg, 123, 0);
                let event: Option<Retained<NSEvent>> =
                    msg_send![class!(NSEvent),eventWithCGEvent:cg];
                CFRelease(cg);
                let event = event
                    .ok_or_else(|| "trusted input could not create wheel event".to_string())?;
                wk.scrollWheel(&event);
            }
        }
    }
    Ok(())
}

struct FocusRestore {
    window: Retained<AnyObject>,
    previous: Option<Retained<AnyObject>>,
    view: Retained<WKWebView>,
}

fn restore_focus(slot: &RefCell<Option<FocusRestore>>) {
    let Some(saved) = slot.borrow_mut().take() else { return; };
    unsafe {
        let current: Option<Retained<AnyObject>> = msg_send![&*saved.window, firstResponder];
        // Do not override a newer manual focus change while awaiting WebKit.
        let ours = current.as_ref().is_some_and(|current| {
            let is_view: bool = msg_send![&**current, isKindOfClass: class!(NSView)];
            is_view && msg_send![&**current, isDescendantOf: &*saved.view]
        });
        if ours { let _: bool = msg_send![&*saved.window, makeFirstResponder: saved.previous.as_deref()]; }
    }
}

pub(super) async fn input_trusted(
    app: &AppHandle,
    tab_id: String,
    action: WebPaneTrustedInput,
    budget: &NativeBudget,
) -> Result<WebPaneTrustedInputResult, String> {
    check_generation(app, &tab_id, action.expected_generation(), budget).await?;
    let kind = validate_input(&action)?;
    let view = webview(app, &tab_id)?;
    let timeout = budget.call_timeout()?;
    let (tx, rx) = oneshot::channel();
    crate::mac_webview::with_webview(&view, move |platform| {
        if tx.is_closed() { return; }
        let wk = unsafe { &*(platform.inner() as *const WKWebView) };
        let Some(window) = wk.window() else {
            let _ = tx.send(Err("trusted input webview has no window".into()));
            return;
        };
        let previous: Option<Retained<AnyObject>> = unsafe { msg_send![&*window, firstResponder] };
        let restore = Rc::new(RefCell::new(Some(FocusRestore {
            window: unsafe { Retained::cast_unchecked(window) }, previous, view: wk.retain(),
        })));
        if matches!(action, WebPaneTrustedInput::Key { .. } | WebPaneTrustedInput::InsertText { .. }) {
            let _: bool = unsafe { msg_send![&*restore.borrow().as_ref().unwrap().window, makeFirstResponder: wk] };
        }
        if let Err(error) = unsafe { dispatch(wk, &action) } {
            restore_focus(&restore);
            let _ = tx.send(Err(error));
            return;
        }
        // Restore even if the page hangs or the future is cancelled. The
        // successful path waits for a WebKit IPC roundtrip after the input.
        let fallback = restore.clone();
        let timer = RcBlock::new(move |_: *mut AnyObject| restore_focus(&fallback));
        unsafe {
            let _: Retained<AnyObject> = msg_send![class!(NSTimer),
                scheduledTimerWithTimeInterval: 0.25f64, repeats: false, block: &*timer];
        }
        let sender = RefCell::new(Some(tx));
        let finish = RcBlock::new(move |_: *mut AnyObject, error: *mut NSError| {
            restore_focus(&restore);
            let result = unsafe { error.as_ref() }
                .map_or(Ok(()), |error| Err(javascript_error("trusted input fence", error)));
            // A WebKit completion handler is one-shot, but the Rust Block is Fn.
            if let Some(tx) = sender.borrow_mut().take() { let _ = tx.send(result); }
        });
        unsafe { wk.evaluateJavaScript_completionHandler(&NSString::from_str("void 0"), Some(&finish)); }
    })
    .map_err(|error| format!("trusted input failed: {error}"))?;
    receive(rx, timeout, "trusted input").await?;
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
                return Err("native file input paths must be absolute".into());
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
                .filter(|n| *n <= MAX_UPLOAD_BYTES)
                .ok_or_else(|| "web.upload files exceed the 25 MB limit".to_string())?;
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

fn validate_selection(count: usize, multiple: bool, directories: bool) -> Result<(), String> {
    if directories {
        return Err("native file input directory selection is not supported on macOS".into());
    }
    if count > 1 && !multiple {
        return Err("native file input does not allow multiple selection".into());
    }
    Ok(())
}

struct UploadIvars {
    original: Option<Retained<AnyObject>>,
    urls: Retained<NSArray<AnyObject>>,
    sender: RefCell<Option<oneshot::Sender<Result<(), String>>>>,
    budget: NativeBudget,
    cancelled: std::cell::Cell<bool>,
    completed: std::cell::Cell<bool>,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind=MainThreadOnly]
    #[ivars=UploadIvars]
    struct UploadDelegate;
    unsafe impl NSObjectProtocol for UploadDelegate {
        #[unsafe(method(respondsToSelector:))]
        fn responds(&self,selector:Sel)->bool {
            unsafe { let own:bool=msg_send![super(self),respondsToSelector:selector];
                own || self.ivars().original.as_ref().is_some_and(|original|msg_send![&**original,respondsToSelector:selector]) }
        }
    }
    impl UploadDelegate {
        #[unsafe(method(forwardingTargetForSelector:))]
        fn forward(&self,_selector:Sel)->*mut AnyObject {
            self.ivars().original.as_ref().map_or(std::ptr::null_mut(),|original|Retained::as_ptr(original).cast_mut())
        }

        #[unsafe(method(webView:runOpenPanelWithParameters:initiatedByFrame:completionHandler:))]
        fn open_panel(&self,_view:&AnyObject,parameters:&AnyObject,_frame:&AnyObject,
            handler:&Block<dyn Fn(*const NSArray<AnyObject>)>) {
            self.ivars().completed.set(true);
            let sender=self.ivars().sender.borrow_mut().take();
            let result=if !self.ivars().cancelled.get() && sender.as_ref().is_some_and(|tx|!tx.is_closed()) {
                self.ivars().budget.call_timeout().and_then(|_| {
                    let multiple: bool = unsafe { msg_send![parameters, allowsMultipleSelection] };
                    let directories: bool = unsafe { msg_send![parameters, allowsDirectories] };
                    validate_selection(self.ivars().urls.count(), multiple, directories)
                })
            }else{Err("native file input request was cancelled".into())};
            if result.is_ok(){handler.call((Retained::as_ptr(&self.ivars().urls),));}
            else{handler.call((std::ptr::null(),));}
            if let Some(tx)=sender {let _=tx.send(result.map(|_|()));}
        }
    }
);

struct ActiveUpload {
    view: Retained<WKWebView>,
    delegate: Retained<UploadDelegate>,
}
thread_local! {static UPLOADS:RefCell<HashMap<String,ActiveUpload>>=RefCell::new(HashMap::new());}

/// Cancelling a future restores the original delegate as well. A late WebKit
/// callback cannot attach files after the native deadline.
struct UploadGuard {
    app: AppHandle,
    id: String,
}

fn restore_upload(id: &str) {
    UPLOADS.with(|uploads| {
        if let Some(active) = uploads.borrow_mut().remove(id) {
            unsafe {
                let current: *const AnyObject = msg_send![&*active.view, UIDelegate];
                if current == Retained::as_ptr(&active.delegate).cast() {
                    let original = active.delegate.ivars().original.as_deref();
                    let _: () = msg_send![&*active.view,setUIDelegate:original];
                }
            }
        }
    });
}

impl Drop for UploadGuard {
    fn drop(&mut self) {
        let id = self.id.clone();
        let _ = self.app.run_on_main_thread(move || {
            let completed = UPLOADS.with(|uploads| {
                uploads.borrow().get(&id).map(|active| {
                    active.delegate.ivars().cancelled.set(true);
                    active.delegate.ivars().completed.get()
                })
            });
            if completed != Some(false) { restore_upload(&id); return; }
            // Keep a cancelling delegate for delayed WebKit open-panel IPC.
            // A new upload to this same view is rejected during the grace
            // period, so a late old request cannot use the next upload's URLs.
            let block = RcBlock::new(move |_: *mut AnyObject| restore_upload(&id));
            unsafe {
                let _: Retained<AnyObject> = msg_send![class!(NSTimer),
                    scheduledTimerWithTimeInterval: 2.0f64, repeats: false, block: &*block];
            }
        });
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
    check_generation(app, &tab_id, expected_generation, budget).await?;
    let (paths, files) =
        tokio::task::spawn_blocking(move || input_files(&paths).map(|files| (paths, files)))
            .await
            .map_err(|error| format!("file input worker failed: {error}"))??;
    let _lock = UPLOAD_LOCK.lock().await;
    budget.call_timeout()?;
    // Do not replace any manual delegate until the selector and generation are
    // checked. Resolve again before activation; no page-global staging state
    // survives a cancelled or expired request.
    let script = format!(
        r#"(() => {{
      if ({expected} !== null && (!window.__mycmux || window.__mycmux.generation !== {expected}))
        throw new Error({changed});
      const el=document.querySelector({selector});
      if (!el) throw new Error('selector matched no element');
      if (!(el instanceof HTMLInputElement) || el.type !== 'file') throw new Error('native file input target is not a file input');
      if (el.disabled) throw new Error('target is disabled');
      return true;
    }})()"#,
        expected = serde_json::to_string(&expected_generation).unwrap(),
        changed = serde_json::to_string(GENERATION_CHANGED).unwrap(),
        selector = serde_json::to_string(&selector).unwrap()
    );
    evaluate(app, &tab_id, script, budget).await?;
    let view = webview(app, &tab_id)?;
    let timeout = budget.call_timeout()?;
    let (tx, rx) = oneshot::channel();
    let id = uuid::Uuid::new_v4().to_string();
    let _guard = UploadGuard {
        app: app.clone(),
        id: id.clone(),
    };
    let operation_budget = budget.clone();
    crate::mac_webview::with_webview(&view, move |platform| {
        if tx.is_closed(){return;}
        let wk=unsafe {&*(platform.inner() as *const WKWebView)};
        if UPLOADS.with(|uploads| uploads.borrow().values().any(|active| Retained::as_ptr(&active.view) == wk as *const WKWebView)) {
            let _ = tx.send(Err("native file input is waiting for a cancelled request".into()));
            return;
        }
        let mtm=MainThreadMarker::new().expect("WKWebView on main thread");
        let urls:Vec<Retained<AnyObject>>=paths.iter().map(|path| unsafe {
            msg_send![class!(NSURL),fileURLWithPath:&*NSString::from_str(path)]
        }).collect();
        let original:Option<Retained<AnyObject>>=unsafe {msg_send![wk,UIDelegate]};
        let allocated=mtm.alloc::<UploadDelegate>().set_ivars(UploadIvars{original,urls:NSArray::from_retained_slice(&urls),
            sender:RefCell::new(Some(tx)),budget:operation_budget,cancelled:std::cell::Cell::new(false),completed:std::cell::Cell::new(false)});
        let delegate:Retained<UploadDelegate>=unsafe {msg_send![super(allocated),init]};
        unsafe {let _:()=msg_send![wk,setUIDelegate:&*delegate];}
        UPLOADS.with(|uploads| {uploads.borrow_mut().insert(id,ActiveUpload{view:wk.retain(),delegate:delegate.clone()});});
        let script=format!(r#"(() => {{const el=document.querySelector({selector});
          if ({expected} !== null && (!window.__mycmux || window.__mycmux.generation !== {expected})) throw new Error({changed});
          if (!el || !el.isConnected) throw new Error('selector matched no element');
          if (!(el instanceof HTMLInputElement) || el.type !== 'file') throw new Error('native file input target is not a file input');
          if (el.disabled) throw new Error('target is disabled');
          el.click(); return true;}})()"#,selector=serde_json::to_string(&selector).unwrap(),
            expected=serde_json::to_string(&expected_generation).unwrap(),changed=serde_json::to_string(GENERATION_CHANGED).unwrap());
        let handler=RcBlock::new(move |_:*mut AnyObject,error:*mut NSError| {
            if let Some(error)=unsafe {error.as_ref()} {
                if let Some(tx)=delegate.ivars().sender.borrow_mut().take() {
                    let _=tx.send(Err(javascript_error("native file input",error)));
                }
            }
        });
        unsafe {wk.evaluateJavaScript_completionHandler(&NSString::from_str(&script),Some(&handler));}
    }).map_err(|error|format!("native file input failed: {error}"))?;
    receive(rx, timeout, "native file input").await?;
    Ok(WebPaneSetFileInputResult { tab_id, files })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn native_selection_respects_multiple_and_directory_parameters() {
        assert!(validate_selection(1, false, false).is_ok());
        assert!(validate_selection(2, true, false).is_ok());
        assert!(validate_selection(0, false, false).is_ok());
        assert_eq!(validate_selection(2, false, false).unwrap_err(), "native file input does not allow multiple selection");
        assert!(validate_selection(1, true, true).unwrap_err().contains("directory selection"));
    }
    #[test]
    fn trusted_meta_keys_are_rejected_before_dispatch() {
        for mods in [json!(["meta"]), json!(["MeTa"]), json!(["shift", "meta"]), json!(["ctrl", "alt", "meta"])] {
            for key in ["a", "v", "Enter", "Escape"] {
                let action: WebPaneTrustedInput = serde_json::from_value(json!({"kind":"key","key":key,"modifiers":mods})).unwrap();
                assert_eq!(validate_input(&action).unwrap_err(), "trusted key with the meta modifier is not supported on macOS; use web-type for text");
            }
        }
    }
    #[test]
    fn trusted_named_keys_and_non_meta_modifiers_are_preserved() {
        for mods in [json!([]), json!(["shift"]), json!(["ctrl"]), json!(["control"]), json!(["alt"]), json!(["ctrl", "shift", "alt"])] {
            for key in ["a", "Enter", "Tab", "Escape", "ArrowLeft", "Backspace"] {
                let action: WebPaneTrustedInput = serde_json::from_value(json!({"kind":"key","key":key,"modifiers":mods})).unwrap();
                assert_eq!(validate_input(&action).unwrap(), "key");
            }
        }
    }
    #[test]
    fn trusted_right_click_is_rejected_before_dispatch() {
        let action: WebPaneTrustedInput = serde_json::from_value(json!({"kind":"click","x":1,"y":2,"button":"right"})).unwrap();
        assert!(validate_input(&action).unwrap_err().contains("right click is not supported on macOS"));
    }
    #[test]
    fn javascript_semantic_errors_keep_the_windows_message() {
        for detail in [
            GENERATION_CHANGED,
            "selector matched no element",
            "target is disabled",
            "native file input target is not a file input",
        ] {
            assert_eq!(
                javascript_error_message("Runtime.evaluate", &format!("Error: {detail}")),
                detail
            );
        }
        assert_eq!(
            javascript_error_message("Runtime.evaluate", "TypeError: broken"),
            "Runtime.evaluate failed: TypeError: broken"
        );
    }
    #[test]
    fn generations_are_u32_integral_and_errors_are_stable() {
        for n in [0u64, 42, u32::MAX as u64] {
            assert_eq!(observed_generation(&json!(n)), Some(n));
        }
        for n in [
            json!(-1),
            json!(1.5),
            json!(4294967296u64),
            Value::Null,
            json!("42"),
        ] {
            assert_eq!(observed_generation(&n), None);
        }
    }
    #[test]
    fn screenshot_clip_validation_matches_windows() {
        let v = json!({"w":800,"h":600,"dpr":2});
        let (clip, dpr) = checked_clip(&v, None).unwrap();
        assert_eq!((clip.width, clip.height, dpr), (800.0, 600.0, 2.0));
        for (x, y, width, height) in [
            (-1.0, 0.0, 1.0, 1.0),
            (0.0, -1.0, 1.0, 1.0),
            (0.0, 0.0, 0.0, 1.0),
            (0.0, 0.0, 1.0, f64::NAN),
        ] {
            assert_eq!(
                checked_clip(
                    &v,
                    Some(WebPaneClip {
                        x,
                        y,
                        width,
                        height
                    })
                )
                .unwrap_err(),
                "Page.captureScreenshot requires a finite positive clip and DPR"
            );
        }
    }
    #[test]
    fn files_use_real_metadata_and_the_windows_limit() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a file.txt");
        std::fs::write(&path, b"hello").unwrap();
        let files = input_files(&[path.to_string_lossy().into_owned()]).unwrap();
        assert_eq!(
            (&files[0].name, files[0].size),
            (&"a file.txt".to_string(), 5)
        );
        assert_eq!(
            input_files(&["relative.txt".into()]).unwrap_err(),
            "native file input paths must be absolute"
        );
        std::fs::File::create(&path)
            .unwrap()
            .set_len(MAX_UPLOAD_BYTES + 1)
            .unwrap();
        assert_eq!(
            input_files(&[path.to_string_lossy().into_owned()]).unwrap_err(),
            "web.upload files exceed the 25 MB limit"
        );
        assert!(input_files(&[dir.path().to_string_lossy().into_owned()])
            .unwrap_err()
            .contains("path is not a file"));
        assert!(input_files(&[dir.path().join("missing").to_string_lossy().into_owned()]).is_err());
        assert!(input_files(&[]).unwrap().is_empty());
    }
    #[test]
    fn key_mapping_and_validation_have_windows_errors() {
        assert_eq!(key_mapping("Enter", None).unwrap(), ("\r".into(), 36));
        assert_eq!(key_mapping("a", Some("KeyB")).unwrap(), ("a".into(), 11));
        assert_eq!(
            key_mapping("NoSuchKey", None).unwrap_err(),
            "unsupported trusted input key: NoSuchKey"
        );
        assert_eq!(
            key_mapping("", None).unwrap_err(),
            "trusted input key must not be empty or a control character"
        );
        assert_eq!(
            modifiers(&["unknown".into()]).unwrap_err(),
            "unsupported trusted input modifier: unknown"
        );
        assert!(finite(&[f64::INFINITY]).is_err());
    }
}
