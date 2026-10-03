//! Nonmodal AppKit tear-out: keep WebKit/PTY work running while dragging.
//! No global event injection, activation, new permissions or modal Tao reentry.
use super::{geometry, unix_ms, Approval, MoveState, Reveal, TearoutState, WindowGeometry};
use block2::RcBlock;
use objc2::{class, msg_send, rc::Retained, runtime::AnyObject};
use objc2_foundation::{NSPoint, NSRect, NSString};
use serde::Serialize;
use std::{
    cell::RefCell,
    sync::{atomic::Ordering, Arc},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventSourceKeyState(state: i32, key: u16) -> bool;
}

struct Active {
    id: String,
    timer: Retained<AnyObject>,
    monitor: Retained<AnyObject>,
}
thread_local! {
    static ACTIVE: RefCell<Option<Active>> = const { RefCell::new(None) };
}

/// A zero-delay native timer runs outside Tao's handler mutex. In particular,
/// frame/order changes may deliver AppKit delegates back into Tao.
pub(super) fn defer(action: impl FnOnce() + 'static) {
    let slot = RefCell::new(Some(action));
    let block = RcBlock::new(move |_: *mut AnyObject| {
        if let Some(action) = slot.borrow_mut().take() {
            action();
        }
    });
    unsafe {
        let _: Retained<AnyObject> = msg_send![class!(NSTimer),
            scheduledTimerWithTimeInterval: 0.0f64, repeats: false, block: &*block];
    }
}

/// These borrowed objects are used exclusively from native main-loop callbacks.
unsafe fn ns_window(window: &tauri::Window) -> Result<&AnyObject, String> {
    let pointer = window.ns_window().map_err(|error| error.to_string())?;
    unsafe { (pointer as *const AnyObject).as_ref() }.ok_or("tearout_nswindow_missing".into())
}

fn cursor() -> NSPoint {
    unsafe { msg_send![class!(NSEvent), mouseLocation] }
}
fn held() -> bool {
    let buttons: usize = unsafe { msg_send![class!(NSEvent), pressedMouseButtons] };
    buttons & 1 != 0
}

fn origin_under_pointer(point: NSPoint, width: f64, height: f64, x: f64, y: f64) -> NSPoint {
    NSPoint::new(
        point.x - x.clamp(0.0, (width - 40.0).max(0.0)),
        point.y - height + y.clamp(0.0, 30.0),
    )
}

fn css_point(point: NSPoint, bounds: NSRect, flipped: bool) -> (f64, f64) {
    (
        point.x - bounds.origin.x,
        if flipped {
            point.y - bounds.origin.y
        } else {
            bounds.origin.y + bounds.size.height - point.y
        },
    )
}

fn focus_snapshot() -> (bool, usize) {
    unsafe {
        let app: Retained<AnyObject> = msg_send![class!(NSApplication), sharedApplication];
        let active: bool = msg_send![&*app, isActive];
        let key: *mut AnyObject = msg_send![&*app, keyWindow];
        (active, key as usize)
    }
}

fn focus_changed(before: (bool, usize), after: (bool, usize), moving: usize) -> bool {
    after.0 && (!before.0 || before.1 != after.1 && after.1 != moving)
}

/// A label is a reusable slot. GUI checks compare WindowServer identities.
pub(super) fn window_identity(app: &AppHandle, label: &str) -> Result<serde_json::Value, String> {
    let window = app
        .get_window(label)
        .ok_or("tearout_identity_window_missing")?;
    let number: isize = unsafe { msg_send![ns_window(&window)?, windowNumber] };
    Ok(serde_json::json!({ "window_number": number }))
}

pub fn reveal(
    app: &AppHandle,
    label: &str,
    offset_x: f64,
    offset_y: f64,
) -> Result<Reveal, String> {
    let window = app
        .get_window(label)
        .ok_or("tearout_prepared_window_missing")?;
    window
        .set_size(tauri::LogicalSize::new(720.0, 520.0))
        .map_err(|e| e.to_string())?;
    window.set_focusable(false).map_err(|e| e.to_string())?;
    unsafe {
        let native = ns_window(&window)?;
        let frame: NSRect = msg_send![native, frame];
        let point = origin_under_pointer(
            cursor(),
            frame.size.width,
            frame.size.height,
            offset_x,
            offset_y,
        );
        let _: () = msg_send![native, setFrameOrigin: point];
        let application: Retained<AnyObject> = msg_send![class!(NSApplication), sharedApplication];
        let before: *mut AnyObject = msg_send![&*application, keyWindow];
        let before_focus = focus_snapshot();
        let shown_at = unix_ms();
        // orderFront does not activate the app or make this window key.
        let _: () = msg_send![native, orderFront: std::ptr::null::<AnyObject>()];
        let visible: bool = msg_send![native, isVisible];
        if !visible {
            return Err("tearout_window_not_visible".into());
        }
        let after: *mut AnyObject = msg_send![&*application, keyWindow];
        let monitor = window.current_monitor().map_err(|e| e.to_string())?;
        Ok(Reveal {
            shown_at,
            visible_at: unix_ms(),
            scale: window.scale_factor().map_err(|e| e.to_string())?,
            monitor: monitor.and_then(|m| m.name().cloned()),
            focus_stolen: before != after || focus_changed(before_focus, focus_snapshot(), 0),
        })
    }
}

/// Ask WindowServer for the first hit. An unrelated app above a receiver blocks
/// docking. Only when that hit is our moving window do we look immediately below.
fn receiver_at(app: &AppHandle, moving: &str, point: NSPoint) -> Option<(String, f64, f64)> {
    unsafe {
        let mut number: isize = msg_send![class!(NSWindow), windowNumberAtPoint: point,
            belowWindowWithWindowNumber: 0isize];
        if let Some(window) = app.get_window(moving) {
            let native = ns_window(&window).ok()?;
            let moving_number: isize = msg_send![native, windowNumber];
            if number == moving_number {
                number = msg_send![class!(NSWindow), windowNumberAtPoint: point,
                    belowWindowWithWindowNumber: moving_number];
            }
        }
        if number == 0 {
            return None;
        }
        for (label, window) in app.windows() {
            if label == moving {
                continue;
            }
            let native = ns_window(&window).ok()?;
            let candidate: isize = msg_send![native, windowNumber];
            let visible: bool = msg_send![native, isVisible];
            let minimized: bool = msg_send![native, isMiniaturized];
            if candidate != number || !visible || minimized {
                continue;
            }
            let view: *mut AnyObject = msg_send![native, contentView];
            let view = view.as_ref()?;
            let local: NSPoint = msg_send![native, convertPointFromScreen: point];
            let local: NSPoint =
                msg_send![view, convertPoint: local, fromView: std::ptr::null::<AnyObject>()];
            let bounds: NSRect = msg_send![view, bounds];
            let flipped: bool = msg_send![view, isFlipped];
            let (x, y) = css_point(local, bounds, flipped);
            return Some((label, x, y));
        }
        None
    }
}

pub fn set_alpha(window: &tauri::Window, alpha: u8) -> Result<bool, String> {
    unsafe {
        let native = ns_window(window)?;
        let desired = alpha as f64 / 255.0;
        let current: f64 = msg_send![native, alphaValue];
        if (current - desired).abs() < 0.0001 {
            return Ok(false);
        }
        let _: () = msg_send![native, setAlphaValue: desired];
        Ok(true)
    }
}

#[derive(Clone, Serialize)]
struct Sample {
    id: String,
    label: String,
    source: String,
    sequence: u64,
    region_count: usize,
    receiver_epoch: u64,
    x: i32,
    y: i32,
    phase: &'static str,
    at: u64,
    escaped: bool,
    receiver: Option<String>,
    client_x: f64,
    client_y: f64,
    approval: Option<Approval>,
    native_started_at: Option<u64>,
    error: Option<&'static str>,
    scale: f64,
    monitor: Option<String>,
    focus_stolen: bool,
    esc_at: Option<u64>,
    original: WindowGeometry,
}

fn original(window: &tauri::Window) -> Result<WindowGeometry, String> {
    let position = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.inner_size().map_err(|e| e.to_string())?;
    Ok(WindowGeometry {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    })
}

fn start_probe(
    app: &AppHandle,
    shared: &Arc<MoveState>,
    id: String,
    label: String,
    recorder: bool,
) {
    if !shared.metrics.probe.load(Ordering::Acquire)
        || shared.metrics.probe_started.swap(true, Ordering::AcqRel)
    {
        return;
    }
    let app = app.clone();
    let shared = shared.clone();
    std::thread::spawn(move || {
        let started = Instant::now();
        while !shared.closed.load(Ordering::Acquire) && started.elapsed().as_secs() < 300 {
            // At most one marker may wait in the UI queue. Never build a backlog.
            if !shared.metrics.probe_pending.swap(true, Ordering::AcqRel) {
                let queued = Instant::now();
                let marker = shared.clone();
                if app
                    .run_on_main_thread(move || {
                        marker.metrics.wait(queued.elapsed().as_secs_f64() * 1000.0);
                        marker.metrics.probe_pending.store(false, Ordering::Release);
                    })
                    .is_err()
                {
                    shared.metrics.probe_pending.store(false, Ordering::Release);
                }
            } else {
                shared.metrics.probe_skipped.fetch_add(1, Ordering::Relaxed);
            }
            std::thread::sleep(Duration::from_millis(4));
        }
        let deadline = Instant::now();
        while shared.metrics.probe_pending.load(Ordering::Acquire)
            && deadline.elapsed().as_secs() < 1
        {
            std::thread::sleep(Duration::from_millis(4));
        }
        if recorder {
            super::log::native_summary(id, label, shared.metrics.summary());
        }
    });
}

/// A test profile can opt into the expensive main-thread probe for real drags.
/// Ordinary recording keeps the probe off; no settings/env/safety contract changes.
fn configure_metrics(shared: &MoveState) {
    if !crate::test_profile::is_active() {
        return;
    }
    let Ok(root) = crate::test_profile::runtime_dir() else {
        return;
    };
    let Ok(bytes) = std::fs::read(root.join("tearout-diagnostics.json")) else {
        return;
    };
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return;
    };
    shared.metrics.probe.store(
        value["main_thread_probe"].as_bool().unwrap_or(false),
        Ordering::Release,
    );
    shared.metrics.legacy.store(
        value["legacy_samples"].as_bool().unwrap_or(false),
        Ordering::Release,
    );
    shared.metrics.enabled.store(
        value["recorder"].as_bool().unwrap_or(true),
        Ordering::Release,
    );
}

fn mark_escape(shared: &MoveState) {
    shared.escaped.store(true, Ordering::Release);
    let _ = shared
        .escaped_at
        .compare_exchange(0, unix_ms(), Ordering::AcqRel, Ordering::Acquire);
}

fn emit_sample(app: &AppHandle, sample: &Sample, previous: Option<&str>, lifecycle: bool) -> usize {
    let mut count = 0;
    for label in geometry::sample_recipients(
        &sample.source,
        &sample.label,
        previous,
        sample.receiver.as_deref(),
        lifecycle,
    ) {
        if app.get_window(label).is_some()
            && app
                .emit_to(label, "mycmux://tearout-native", sample)
                .is_ok()
        {
            count += 1;
        }
    }
    count
}

fn sample(
    app: &AppHandle,
    id: &str,
    label: &str,
    source: &str,
    shared: &MoveState,
    hit: Option<(String, f64, f64)>,
    done: bool,
    escaped: bool,
    failed: bool,
    original: WindowGeometry,
    focus_stolen: bool,
    scan_ms: Option<f64>,
) -> Result<serde_json::Value, String> {
    let at = unix_ms();
    shared.metrics.poll(scan_ms);
    let sequence = shared.sample_count.fetch_add(1, Ordering::AcqRel);
    let receiver = hit.as_ref().map(|(label, _, _)| label.clone());
    let previous = {
        let mut previous = shared.receiver.lock().map_err(|e| e.to_string())?;
        let old = previous.clone();
        if *previous != receiver {
            *previous = receiver.clone();
            shared.receiver_since.store(at, Ordering::Release);
            shared.receiver_epoch.fetch_add(1, Ordering::AcqRel);
            shared.preview_revision.store(0, Ordering::Release);
            *shared.approval.lock().map_err(|e| e.to_string())? = None;
            shared.alpha.store(255, Ordering::Release);
        }
        old
    };
    let approval = {
        let approval = shared.approval.lock().map_err(|e| e.to_string())?;
        if done {
            shared.closed.store(true, Ordering::Release);
        }
        if done && !escaped && !failed {
            approval.clone()
        } else {
            None
        }
    };
    let desired = if done {
        255
    } else {
        shared.alpha.load(Ordering::Acquire)
    };
    let window = app.get_window(label);
    if shared.applied_alpha.swap(desired, Ordering::AcqRel) != desired {
        if let Some(window) = &window {
            if set_alpha(window, desired)? {
                shared.alpha_calls.fetch_add(1, Ordering::AcqRel);
            }
        }
    }
    // Match Windows display-rate pacing. Receiver edges, Esc and release are
    // sent immediately, and opacity restoration is never behind this gate.
    let allowed = shared.pacing.lock().map_err(|e| e.to_string())?.allow(
        at,
        hit.as_ref().map(|(label, _, _)| label.as_str()),
        hit.as_ref().map(|(_, x, _)| *x).unwrap_or(-1.0),
        hit.as_ref().map(|(_, _, y)| *y).unwrap_or(-1.0),
        sequence == 0 || done,
        approval.is_some(),
        shared.metrics.legacy.load(Ordering::Acquire),
    );
    if !allowed {
        return Ok(serde_json::json!({ "approval": approval,
            "alpha_calls": shared.alpha_calls.load(Ordering::Acquire),
            "payload_bytes": 0, "recipients": 0 }));
    }
    let scale = window
        .as_ref()
        .and_then(|w| w.scale_factor().ok())
        .unwrap_or(1.0);
    let monitor = window
        .as_ref()
        .and_then(|w| w.current_monitor().ok().flatten())
        .and_then(|m| m.name().cloned());
    let started = shared.started_at.load(Ordering::Acquire);
    let point = cursor();
    let notification = Sample {
        id: id.into(),
        label: label.into(),
        source: source.into(),
        sequence,
        region_count: shared.region_count.load(Ordering::Acquire) as usize,
        receiver_epoch: shared.receiver_epoch.load(Ordering::Acquire),
        x: point.x.round() as i32,
        y: point.y.round() as i32,
        phase: if done { "end" } else { "move" },
        at,
        escaped,
        receiver,
        client_x: hit.as_ref().map(|(_, x, _)| *x).unwrap_or(-1.0),
        client_y: hit.as_ref().map(|(_, _, y)| *y).unwrap_or(-1.0),
        approval: approval.clone(),
        native_started_at: (started != 0 && !shared.synthetic.load(Ordering::Acquire))
            .then_some(started),
        error: failed.then_some("tearout_native_move_failed"),
        scale,
        monitor,
        focus_stolen,
        esc_at: match shared.escaped_at.load(Ordering::Acquire) {
            0 => None,
            value => Some(value),
        },
        original,
    };
    let bytes = serde_json::to_vec(&notification)
        .map_err(|e| e.to_string())?
        .len();
    let emit_at = Instant::now();
    let recipients = emit_sample(
        app,
        &notification,
        previous.as_deref(),
        sequence == 0 || done,
    );
    shared
        .metrics
        .emit(emit_at.elapsed().as_secs_f64() * 1000.0, recipients);
    let result = serde_json::json!({ "approval": approval, "alpha_calls": shared.alpha_calls.load(Ordering::Acquire),
        "payload_bytes": bytes, "recipients": recipients,
        "diagnostics": if done { Some(shared.metrics.summary()) } else { None } });
    if done {
        if shared.metrics.enabled.load(Ordering::Acquire)
            && !shared.metrics.probe_started.load(Ordering::Acquire)
        {
            let summary = shared.metrics.summary();
            let log_id = id.to_owned();
            let log_label = label.to_owned();
            std::thread::spawn(move || super::log::native_summary(log_id, log_label, summary));
        }
        app.state::<TearoutState>()
            .moves
            .lock()
            .map_err(|e| e.to_string())?
            .remove(id);
    }
    Ok(result)
}

fn stop(id: &str) {
    let active = ACTIVE.with(|slot| {
        let mut slot = slot.borrow_mut();
        if slot.as_ref().is_some_and(|active| active.id == id) {
            slot.take()
        } else {
            None
        }
    });
    if let Some(active) = active {
        unsafe {
            let _: () = msg_send![&*active.timer, invalidate];
            let _: () = msg_send![class!(NSEvent), removeMonitor: &*active.monitor];
        }
    }
}

pub fn cancel(app: &AppHandle, label: &str) -> Result<(), String> {
    // The next native tick observes the shared cancelled bit. No modal loop
    // owns the window, so it can acknowledge Esc while the button is still held.
    let _ = (app, label);
    Ok(())
}

pub fn start(
    app: &AppHandle,
    label: &str,
    source: String,
    id: String,
    shared: Arc<MoveState>,
) -> Result<(), String> {
    if ACTIVE.with(|slot| slot.borrow().is_some()) {
        return Err("tearout_move_busy".into());
    }
    let window = app
        .get_window(label)
        .ok_or("tearout_moving_window_missing")?;
    let original = original(&window)?;
    shared.alpha.store(255, Ordering::Release);
    shared.applied_alpha.store(255, Ordering::Release);
    configure_metrics(&shared);
    start_probe(
        app,
        &shared,
        id.clone(),
        label.to_owned(),
        shared.metrics.enabled.load(Ordering::Acquire),
    );
    shared.started_at.store(unix_ms(), Ordering::Release);
    // App-local synthetic samples drive the real transfer/preview path in e2e;
    // an ordinary no-button release still settles immediately in shipped builds.
    if cfg!(feature = "e2e") && crate::test_profile::is_active() && !held() {
        shared.synthetic.store(true, Ordering::Release);
        return Ok(());
    }
    let before_focus = focus_snapshot();
    let moving_pointer = unsafe { ns_window(&window)? } as *const AnyObject as usize;
    let stolen = std::cell::Cell::new(false);
    let start_point = cursor();
    let start_frame: NSRect = unsafe { msg_send![ns_window(&window)?, frame] };
    let keys = shared.clone();
    let key_block = RcBlock::new(move |event: *mut AnyObject| -> *mut AnyObject {
        if let Some(event_ref) = unsafe { event.as_ref() } {
            let key: u16 = unsafe { msg_send![event_ref, keyCode] };
            if key == 53 {
                mark_escape(&keys);
                return std::ptr::null_mut();
            }
        }
        event
    });
    let monitor: Retained<AnyObject> = unsafe {
        msg_send![class!(NSEvent),
        addLocalMonitorForEventsMatchingMask: 1usize << 10, handler: &*key_block]
    };
    let handle = app.clone();
    let moving = label.to_owned();
    let move_id = id.clone();
    let began = Instant::now();
    let tick = RcBlock::new(move |_: *mut AnyObject| {
        stolen.set(stolen.get() || focus_changed(before_focus, focus_snapshot(), moving_pointer));
        if unsafe { CGEventSourceKeyState(0, 53) } {
            mark_escape(&shared);
        }
        let escaped = shared.escaped.load(Ordering::Acquire)
            || shared.cancelled.load(Ordering::Acquire)
            || began.elapsed().as_secs() >= 300;
        let mut failed = handle.get_window(&moving).is_none();
        let point = cursor();
        if !escaped && !failed && held() {
            if let Some(window) = handle.get_window(&moving) {
                let origin = NSPoint::new(
                    start_frame.origin.x + point.x - start_point.x,
                    start_frame.origin.y + point.y - start_point.y,
                );
                if let Ok(native) = unsafe { ns_window(&window) } {
                    unsafe {
                        let actual: NSRect = msg_send![native, frame];
                        let scale: f64 = msg_send![native, backingScaleFactor];
                        shared.metrics.lag(
                            ((actual.origin.x - origin.x).powi(2)
                                + (actual.origin.y - origin.y).powi(2))
                            .sqrt()
                                * scale,
                        );
                        if actual.origin != origin {
                            let _: () = msg_send![native, setFrameOrigin: origin];
                        }
                    }
                } else {
                    failed = true;
                }
            }
        }
        let done = escaped || failed || !held();
        if escaped {
            mark_escape(&shared);
        }
        let scan_at = Instant::now();
        let hit = receiver_at(&handle, &moving, point);
        let scan_ms = scan_at.elapsed().as_secs_f64() * 1000.0;
        if sample(
            &handle,
            &move_id,
            &moving,
            &source,
            &shared,
            hit,
            done,
            escaped,
            failed,
            original,
            stolen.get(),
            Some(scan_ms),
        )
        .is_err()
        {
            shared.failed.store(true, Ordering::Release);
            let _ = sample(
                &handle,
                &move_id,
                &moving,
                &source,
                &shared,
                None,
                true,
                escaped,
                true,
                original,
                stolen.get(),
                None,
            );
            stop(&move_id);
        } else if done {
            stop(&move_id);
        }
    });
    let timer: Retained<AnyObject> = unsafe {
        msg_send![class!(NSTimer),
        scheduledTimerWithTimeInterval: 0.008f64, repeats: true, block: &*tick]
    };
    unsafe {
        let run_loop: Retained<AnyObject> = msg_send![class!(NSRunLoop), currentRunLoop];
        let mode = NSString::from_str("NSRunLoopCommonModes");
        let _: () = msg_send![&*run_loop, addTimer: &*timer, forMode: &*mode];
    }
    ACTIVE.with(|slot| *slot.borrow_mut() = Some(Active { id, timer, monitor }));
    Ok(())
}

pub(super) fn synthetic_sample(
    app: &AppHandle,
    id: String,
    label: String,
    source: String,
    region_count: usize,
    receiver: Option<String>,
    client_x: f64,
    client_y: f64,
    phase: &str,
    escaped: bool,
    diagnostics: bool,
    legacy_samples: bool,
    recorder: bool,
) -> Result<serde_json::Value, String> {
    let window = app
        .get_window(&label)
        .ok_or("tearout_synthetic_window_missing")?;
    if receiver
        .as_ref()
        .is_some_and(|receiver| receiver == &label || app.get_window(receiver).is_none())
    {
        return Err("tearout_synthetic_receiver_invalid".into());
    }
    let shared = {
        let state = app.state::<TearoutState>();
        let mut moves = state.moves.lock().map_err(|e| e.to_string())?;
        moves
            .entry(id.clone())
            .or_insert_with(|| {
                let state = Arc::new(MoveState::default());
                state.synthetic.store(true, Ordering::Release);
                state
                    .region_count
                    .store(region_count.max(1) as u64, Ordering::Release);
                state.alpha.store(255, Ordering::Release);
                state.applied_alpha.store(255, Ordering::Release);
                state
            })
            .clone()
    };
    if !shared.synthetic.load(Ordering::Acquire) {
        return Err("tearout_synthetic_live_move".into());
    }
    shared.metrics.probe.store(diagnostics, Ordering::Release);
    shared
        .metrics
        .legacy
        .store(legacy_samples, Ordering::Release);
    shared
        .metrics
        .enabled
        .store(recorder || diagnostics, Ordering::Release);
    start_probe(app, &shared, id.clone(), label.clone(), recorder);
    if escaped {
        mark_escape(&shared);
    }
    sample(
        app,
        &id,
        &label,
        &source,
        &shared,
        receiver.map(|label| (label, client_x, client_y)),
        phase == "end",
        escaped,
        false,
        original(&window)?,
        false,
        None,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tearout_mac_focus_observation_flags_activation_and_unexpected_key_windows() {
        assert!(focus_changed((false, 0), (true, 2), 2));
        assert!(focus_changed((true, 1), (true, 3), 2));
        assert!(!focus_changed((true, 1), (true, 2), 2));
        assert!(!focus_changed((true, 1), (false, 0), 2));
    }
    #[test]
    fn tearout_mac_origin_preserves_the_grip_with_negative_monitor_coordinates() {
        assert_eq!(
            origin_under_pointer(NSPoint::new(-900.0, 700.0), 720.0, 520.0, 20.0, 15.0),
            NSPoint::new(-920.0, 195.0)
        );
        assert_eq!(
            origin_under_pointer(NSPoint::new(10.0, -800.0), 720.0, 520.0, -20.0, 100.0),
            NSPoint::new(10.0, -1290.0)
        );
    }
    #[test]
    fn tearout_mac_receiver_uses_css_points_in_both_view_orientations() {
        let bounds = NSRect::new(
            NSPoint::new(0.0, 0.0),
            objc2_foundation::NSSize::new(720.0, 520.0),
        );
        assert_eq!(
            css_point(NSPoint::new(40.0, 500.0), bounds, false),
            (40.0, 20.0)
        );
        assert_eq!(
            css_point(NSPoint::new(40.0, 20.0), bounds, true),
            (40.0, 20.0)
        );
    }
}
