use super::geometry::{self, ReceiverCandidate, Rect};
use super::{unix_ms, Approval, MoveState, Reveal, TearoutState, WindowGeometry};
use serde::Serialize;
use std::time::{Duration, Instant};
use std::{
    cell::RefCell,
    collections::{HashMap, HashSet},
    sync::{atomic::Ordering, Arc},
};
use tauri::{AppHandle, Emitter, Manager};
use windows::Win32::{
    Foundation::{COLORREF, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM},
    Graphics::Gdi::{
        ClientToScreen, GetMonitorInfoW, MonitorFromPoint, MONITORINFOEXW, MONITOR_DEFAULTTONEAREST,
    },
    System::Threading::GetCurrentThreadId,
    UI::HiDpi::GetDpiForWindow,
    UI::{
        Input::KeyboardAndMouse::{GetAsyncKeyState, VK_ESCAPE, VK_LBUTTON},
        Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
        WindowsAndMessaging::{
            CallNextHookEx, GetCursorPos, GetForegroundWindow, GetLayeredWindowAttributes,
            GetTopWindow, GetWindow, GetWindowLongPtrW, GetWindowRect, IsIconic, IsWindowVisible,
            PostMessageW, SetLayeredWindowAttributes, SetWindowLongPtrW, SetWindowsHookExW,
            ShowWindow, UnhookWindowsHookEx, GWL_EXSTYLE, GW_HWNDNEXT, HHOOK, LWA_ALPHA,
            SW_SHOWNOACTIVATE, WH_KEYBOARD, WM_CANCELMODE, WM_ENTERSIZEMOVE, WM_EXITSIZEMOVE,
            WM_KEYDOWN, WM_NCDESTROY, WS_EX_LAYERED,
        },
    },
};

pub fn cursor() -> Result<POINT, String> {
    let mut p = POINT::default();
    unsafe { GetCursorPos(&mut p) }.map_err(|e| e.to_string())?;
    Ok(p)
}

pub fn reveal(
    app: &AppHandle,
    label: &str,
    offset_x: f64,
    offset_y: f64,
) -> Result<Reveal, String> {
    let window = app.get_window(label).ok_or("Prepared window disappeared")?;
    let point = cursor()?;
    let monitor = app
        .monitor_from_point(point.x as f64, point.y as f64)
        .map_err(|e| e.to_string())?;
    let scale = monitor.as_ref().map(|m| m.scale_factor()).unwrap_or(1.0);
    window
        .set_position(tauri::PhysicalPosition::new(
            point.x - (offset_x.clamp(0.0, 680.0) * scale).round() as i32,
            point.y - (offset_y.clamp(0.0, 30.0) * scale).round() as i32,
        ))
        .map_err(|e| e.to_string())?;
    window
        .set_size(tauri::LogicalSize::new(720.0, 520.0))
        .map_err(|e| e.to_string())?;
    window.set_focusable(false).map_err(|e| e.to_string())?;
    let foreground = unsafe { GetForegroundWindow() };
    let shown_at = unix_ms();
    window.show().map_err(|e| e.to_string())?;
    let handle = HWND(window.hwnd().map_err(|e| e.to_string())?.0);
    // ShowWindow returns previous visibility, not success; verify it below.
    let _ = unsafe { ShowWindow(handle, SW_SHOWNOACTIVATE) };
    if !unsafe { IsWindowVisible(handle) }.as_bool() {
        return Err("Window did not become visible".into());
    }
    Ok(Reveal {
        shown_at,
        visible_at: unix_ms(),
        scale,
        monitor: monitor.and_then(|m| m.name().cloned()),
        focus_stolen: geometry::focus_stolen(
            foreground.0 as usize,
            unsafe { GetForegroundWindow() }.0 as usize,
            handle.0 as usize,
            &mycmux_handles(app),
            false,
        ),
    })
}

#[derive(Clone, Serialize)]
struct Sample {
    id: String,
    label: String,
    sequence: u64,
    source: String,
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

fn mycmux_handles(app: &AppHandle) -> Vec<usize> {
    app.windows()
        .values()
        .filter_map(|window| window.hwnd().ok().map(|handle| handle.0 as usize))
        .collect()
}

fn emit_sample(app: &AppHandle, sample: &Sample, previous: Option<&str>, lifecycle: bool) -> usize {
    let labels = geometry::sample_recipients(
        &sample.source,
        &sample.label,
        previous,
        sample.receiver.as_deref(),
        lifecycle,
    );
    let mut count = 0;
    for label in labels {
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

fn monitor_name(point: POINT) -> Option<String> {
    let monitor = unsafe { MonitorFromPoint(point, MONITOR_DEFAULTTONEAREST) };
    let mut info = MONITORINFOEXW::default();
    info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
    if !unsafe { GetMonitorInfoW(monitor, &mut info.monitorInfo) }.as_bool() {
        return None;
    }
    let end = info
        .szDevice
        .iter()
        .position(|c| *c == 0)
        .unwrap_or(info.szDevice.len());
    Some(String::from_utf16_lossy(&info.szDevice[..end]))
}

thread_local! {
    static ACTIVE_MOVE: RefCell<Option<Arc<MoveState>>> = const { RefCell::new(None) };
}
const SUBCLASS_ID: usize = 0x54454152;

unsafe extern "system" fn keyboard(code: i32, key: WPARAM, data: LPARAM) -> LRESULT {
    if code >= 0 && key.0 == VK_ESCAPE.0 as usize && (data.0 as usize & (1usize << 31)) == 0 {
        ACTIVE_MOVE.with(|active| {
            if let Some(shared) = active.borrow().as_ref() {
                mark_escape(shared);
            }
        });
    }
    unsafe { CallNextHookEx(None, code, key, data) }
}

unsafe extern "system" fn observe(
    hwnd: HWND,
    message: u32,
    key: WPARAM,
    data: LPARAM,
    id: usize,
    reference: usize,
) -> LRESULT {
    let shared = unsafe { &*(reference as *const MoveState) };
    match message {
        WM_ENTERSIZEMOVE => {
            shared.started_at.store(unix_ms(), Ordering::Release);
            shared.entered.store(true, Ordering::Release);
        }
        WM_EXITSIZEMOVE => {
            // Esc/CancelMode exits with the mouse still held. Release does not.
            if unsafe { GetAsyncKeyState(VK_LBUTTON.0 as i32) < 0 } {
                mark_escape(shared);
            }
            shared.exited.store(true, Ordering::Release);
        }
        WM_KEYDOWN if key.0 == VK_ESCAPE.0 as usize => {
            mark_escape(shared);
        }
        WM_NCDESTROY => {
            shared.failed.store(true, Ordering::Release);
            shared.exited.store(true, Ordering::Release);
        }
        _ => {}
    }
    let result = unsafe { DefSubclassProc(hwnd, message, key, data) };
    if message == WM_NCDESTROY && !shared.observer_removed.swap(true, Ordering::AcqRel) {
        unsafe {
            // This final destruction callback releases the observer once;
            // removal cannot change the move already marked as failed above.
            let _ = RemoveWindowSubclass(hwnd, Some(observe), id);
        }
        unsafe {
            drop(Arc::from_raw(reference as *const MoveState));
        }
    }
    result
}

pub fn cancel(app: &AppHandle, label: &str) -> Result<(), String> {
    if let Some(window) = app.get_window(label) {
        let hwnd = HWND(window.hwnd().map_err(|e| e.to_string())?.0);
        unsafe { PostMessageW(hwnd, WM_CANCELMODE, WPARAM(0), LPARAM(0)) }
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn receiver_at(app: &AppHandle, moving: &str, point: POINT) -> Option<(String, f64, f64)> {
    let handles: HashMap<usize, String> = app
        .windows()
        .into_iter()
        .filter_map(|(label, window)| window.hwnd().ok().map(|handle| (handle.0 as usize, label)))
        .collect();
    let mut candidates = Vec::new();
    let mut visited = HashSet::new();
    let mut hwnd = unsafe { GetTopWindow(None) }.ok()?;
    while !hwnd.0.is_null() && visited.insert(hwnd.0 as usize) && visited.len() <= 4096 {
        if unsafe { IsWindowVisible(hwnd) }.as_bool() && !unsafe { IsIconic(hwnd) }.as_bool() {
            let mut frame = RECT::default();
            if unsafe { GetWindowRect(hwnd, &mut frame) }.is_ok() {
                let rect = Rect {
                    x: frame.left as f64,
                    y: frame.top as f64,
                    width: (frame.right - frame.left) as f64,
                    height: (frame.bottom - frame.top) as f64,
                };
                candidates.push(ReceiverCandidate {
                    label: handles.get(&(hwnd.0 as usize)).cloned(),
                    rect,
                    visible: true,
                });
                // The first covering window decides; lower Z-order windows cannot receive.
                if handles.get(&(hwnd.0 as usize)).map(String::as_str) != Some(moving)
                    && geometry::contains(rect, point.x as f64, point.y as f64)
                {
                    break;
                }
            }
        }
        match unsafe { GetWindow(hwnd, GW_HWNDNEXT) } {
            Ok(next) => hwnd = next,
            Err(_) => break,
        }
    }
    let label = geometry::frontmost_receiver(point.x as f64, point.y as f64, &candidates, moving)?
        .to_owned();
    let receiver = app.get_window(&label)?;
    let handle = HWND(receiver.hwnd().ok()?.0);
    let mut origin = POINT::default();
    if !unsafe { ClientToScreen(handle, &mut origin) }.as_bool() {
        return None;
    }
    let scale = unsafe { GetDpiForWindow(handle) }.max(96) as f64 / 96.0;
    Some((
        label,
        (point.x - origin.x) as f64 / scale,
        (point.y - origin.y) as f64 / scale,
    ))
}

pub fn set_alpha(window: &tauri::Window, alpha: u8) -> Result<bool, String> {
    let handle = HWND(window.hwnd().map_err(|e| e.to_string())?.0);
    let style = unsafe { GetWindowLongPtrW(handle, GWL_EXSTYLE) };
    if style & WS_EX_LAYERED.0 as isize == 0 {
        if alpha == 255 {
            return Ok(false);
        }
        unsafe { SetWindowLongPtrW(handle, GWL_EXSTYLE, style | WS_EX_LAYERED.0 as isize) };
        if unsafe { GetWindowLongPtrW(handle, GWL_EXSTYLE) } & WS_EX_LAYERED.0 as isize == 0 {
            return Err("tearout_layered_style_failed".into());
        }
    } else {
        let mut current = 255;
        let mut flags = LWA_ALPHA;
        if unsafe { GetLayeredWindowAttributes(handle, None, Some(&mut current), Some(&mut flags)) }
            .is_ok()
            && current == alpha
            && flags == LWA_ALPHA
        {
            return Ok(false);
        }
    }
    unsafe { SetLayeredWindowAttributes(handle, COLORREF(0), alpha, LWA_ALPHA) }
        .map(|_| true)
        .map_err(|e| e.to_string())
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
        .is_some_and(|target| target == &label || app.get_window(target).is_none())
    {
        return Err("tearout_synthetic_receiver_invalid".into());
    }
    let shared = {
        let state = app.state::<TearoutState>();
        let mut moves = state.moves.lock().map_err(|e| e.to_string())?;
        let shared = moves
            .entry(id.clone())
            .or_insert_with(|| {
                let shared = Arc::new(MoveState::default());
                shared.synthetic.store(true, Ordering::Release);
                shared.metrics.probe.store(diagnostics, Ordering::Release);
                shared
                    .metrics
                    .legacy
                    .store(legacy_samples, Ordering::Release);
                shared
                    .metrics
                    .enabled
                    .store(recorder || diagnostics, Ordering::Release);
                shared.alpha.store(255, Ordering::Release);
                shared.applied_alpha.store(255, Ordering::Release);
                shared
                    .region_count
                    .store(region_count.max(1) as u64, Ordering::Release);
                shared
            })
            .clone();
        if !shared.synthetic.load(Ordering::Acquire) {
            return Err("tearout_synthetic_live_move".into());
        }
        shared
    };
    start_probe(app, &shared, id.clone(), label.clone(), recorder);
    let at = unix_ms();
    let sequence = shared.sample_count.fetch_add(1, Ordering::AcqRel);
    shared.metrics.poll(None);
    let first = sequence == 0;
    let previous_receiver;
    {
        let mut previous = shared.receiver.lock().map_err(|e| e.to_string())?;
        previous_receiver = previous.clone();
        if *previous != receiver {
            *previous = receiver.clone();
            shared.receiver_since.store(at, Ordering::Release);
            shared.receiver_epoch.fetch_add(1, Ordering::AcqRel);
            shared.preview_revision.store(0, Ordering::Release);
            *shared.approval.lock().map_err(|e| e.to_string())? = None;
            shared.alpha.store(255, Ordering::Release);
        }
    }
    let desired = if phase == "end" {
        255
    } else {
        shared.alpha.load(Ordering::Acquire)
    };
    if shared.applied_alpha.swap(desired, Ordering::AcqRel) != desired {
        if set_alpha(&window, desired)? {
            shared.alpha_calls.fetch_add(1, Ordering::AcqRel);
        }
    }
    let approval = shared.approval.lock().map_err(|e| e.to_string())?.clone();
    let allowed = shared.pacing.lock().map_err(|e| e.to_string())?.allow(
        at,
        receiver.as_deref(),
        client_x,
        client_y,
        first || phase == "end",
        approval.is_some(),
        legacy_samples,
    );
    if !allowed {
        return Ok(serde_json::json!({ "approval": approval,
            "alpha_calls": shared.alpha_calls.load(Ordering::Acquire), "payload_bytes": 0,
            "recipients": 0 }));
    }
    let position = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.inner_size().map_err(|e| e.to_string())?;
    let sample = Sample {
        id: id.clone(),
        label,
        sequence,
        source,
        region_count: shared.region_count.load(Ordering::Acquire) as usize,
        receiver_epoch: shared.receiver_epoch.load(Ordering::Acquire),
        x: position.x,
        y: position.y,
        phase: if phase == "end" { "end" } else { "move" },
        at,
        escaped,
        receiver,
        client_x,
        client_y,
        approval: if phase == "end" && !escaped {
            approval.clone()
        } else {
            None
        },
        native_started_at: None,
        error: None,
        scale: window.scale_factor().map_err(|e| e.to_string())?,
        monitor: None,
        focus_stolen: false,
        esc_at: escaped.then_some(at),
        original: WindowGeometry {
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
        },
    };
    let bytes = serde_json::to_vec(&sample)
        .map_err(|e| e.to_string())?
        .len();
    let emit_at = Instant::now();
    let recipients = emit_sample(
        app,
        &sample,
        previous_receiver.as_deref(),
        first || phase == "end",
    );
    shared
        .metrics
        .emit(emit_at.elapsed().as_secs_f64() * 1000.0, recipients);
    let result = serde_json::json!({ "approval": approval,
        "alpha_calls": shared.alpha_calls.load(Ordering::Acquire), "payload_bytes": bytes,
        "recipients": recipients, "diagnostics": if phase == "end" { Some(shared.metrics.summary()) } else { None } });
    if phase == "end" {
        shared.closed.store(true, Ordering::Release);
        if recorder && !shared.metrics.probe_started.load(Ordering::Acquire) {
            let summary = shared.metrics.summary();
            let log_id = id.clone();
            let log_label = sample.label.clone();
            std::thread::spawn(move || super::log::native_summary(log_id, log_label, summary));
        }
        app.state::<TearoutState>()
            .moves
            .lock()
            .map_err(|e| e.to_string())?
            .remove(&id);
    }
    Ok(result)
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

pub fn start(
    app: &AppHandle,
    label: &str,
    source: String,
    id: String,
    shared: Arc<MoveState>,
) -> Result<(), String> {
    let window = app.get_window(label).ok_or("Moving window disappeared")?;
    let position = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.inner_size().map_err(|e| e.to_string())?;
    let original = WindowGeometry {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    };
    if ACTIVE_MOVE.with(|active| active.borrow().is_some()) {
        return Err("tearout_move_busy".into());
    }
    configure_metrics(&shared);
    window.set_focusable(false).map_err(|e| e.to_string())?;
    let hwnd = HWND(window.hwnd().map_err(|e| e.to_string())?.0);
    let reference = Arc::into_raw(shared.clone()) as usize;
    if !unsafe { SetWindowSubclass(hwnd, Some(observe), SUBCLASS_ID, reference) }.as_bool() {
        unsafe {
            drop(Arc::from_raw(reference as *const MoveState));
        }
        return Err("tearout_move_observer_failed".into());
    }
    ACTIVE_MOVE.with(|active| *active.borrow_mut() = Some(shared.clone()));
    let hook =
        unsafe { SetWindowsHookExW(WH_KEYBOARD, Some(keyboard), None, GetCurrentThreadId()) }
            .ok()
            .map(|hook| hook.0 as usize);
    shared.alpha.store(255, Ordering::Release);
    let app = app.clone();
    let label = label.to_owned();
    let moving = window.clone();
    let handle = hwnd.0 as usize;
    let mut foreground = unsafe { GetForegroundWindow() }.0 as usize;
    let was_held = unsafe { GetAsyncKeyState(VK_LBUTTON.0 as i32) < 0 };
    start_probe(
        &app,
        &shared,
        id.clone(),
        label.clone(),
        shared.metrics.enabled.load(Ordering::Acquire),
    );
    let polling = shared.clone();
    let initial_cursor = cursor().unwrap_or_default();
    let anchor = (initial_cursor.x - position.x, initial_cursor.y - position.y);
    std::thread::spawn(move || {
        let begin = std::time::Instant::now();
        let mut opacity = 255;
        let mut focus_stolen = false;
        let mut previous_started = None;
        loop {
            if unsafe { GetAsyncKeyState(VK_ESCAPE.0 as i32) < 0 } {
                mark_escape(&polling);
            }
            let held = unsafe { GetAsyncKeyState(VK_LBUTTON.0 as i32) < 0 };
            let point = cursor().unwrap_or_default();
            let entered = polling.entered.load(Ordering::Acquire);
            let exited = polling.exited.load(Ordering::Acquire);
            let failed = polling.failed.load(Ordering::Acquire)
                || (!entered && begin.elapsed().as_millis() > 2000);
            let cancelled =
                polling.cancelled.load(Ordering::Acquire) || begin.elapsed().as_secs() >= 300;
            let escaped = polling.escaped.load(Ordering::Acquire) || cancelled;
            if (escaped || failed) && entered && !exited {
                let _ = cancel(&app, &label);
            }
            // Do not restore/destroy a window while its OS move loop still owns it.
            let done = exited || failed && !entered || !was_held || !entered && !held;
            let scan_at = Instant::now();
            let hit = receiver_at(&app, &label, point);
            polling
                .metrics
                .poll(Some(scan_at.elapsed().as_secs_f64() * 1000.0));
            if entered && polling.metrics.enabled.load(Ordering::Relaxed) {
                let mut rect = RECT::default();
                if unsafe { GetWindowRect(HWND(handle as *mut _), &mut rect) }.is_ok() {
                    polling.metrics.lag(
                        ((point.x - rect.left - anchor.0) as f64)
                            .hypot((point.y - rect.top - anchor.1) as f64),
                    );
                }
            }
            let receiver = hit.as_ref().map(|(label, _, _)| label.clone());
            let previous = polling
                .receiver
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone();
            if receiver != previous {
                *polling.receiver.lock().unwrap_or_else(|e| e.into_inner()) = receiver.clone();
                polling.receiver_since.store(unix_ms(), Ordering::Release);
                polling.receiver_epoch.fetch_add(1, Ordering::AcqRel);
                polling.preview_revision.store(0, Ordering::Release);
                *polling.approval.lock().unwrap_or_else(|e| e.into_inner()) = None;
                polling.alpha.store(255, Ordering::Release);
            }
            let approval = {
                let approval = polling.approval.lock().unwrap_or_else(|e| e.into_inner());
                if done {
                    polling.closed.store(true, Ordering::Release);
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
                polling.alpha.load(Ordering::Acquire)
            };
            if opacity != desired {
                if set_alpha(&moving, desired).is_err() {
                    polling.failed.store(true, Ordering::Release);
                }
                opacity = desired;
            }
            if done {
                let cleanup = polling.clone();
                let _ = app.run_on_main_thread(move || {
                    let hwnd = HWND(handle as *mut _);
                    if !cleanup.observer_removed.load(Ordering::Acquire)
                        && unsafe { RemoveWindowSubclass(hwnd, Some(observe), SUBCLASS_ID) }
                            .as_bool()
                        && !cleanup.observer_removed.swap(true, Ordering::AcqRel)
                    {
                        unsafe {
                            drop(Arc::from_raw(reference as *const MoveState));
                        }
                    }
                    if let Some(hook) = hook {
                        unsafe {
                            let _ = UnhookWindowsHookEx(HHOOK(hook as *mut _));
                        }
                    }
                    ACTIVE_MOVE.with(|active| *active.borrow_mut() = None);
                });
            }
            let started = polling.started_at.load(Ordering::Acquire);
            let next_foreground = unsafe { GetForegroundWindow() }.0 as usize;
            let previous_focus_stolen = focus_stolen;
            if foreground != next_foreground {
                focus_stolen |= geometry::focus_stolen(
                    foreground,
                    next_foreground,
                    handle,
                    &mycmux_handles(&app),
                    true,
                );
                foreground = next_foreground;
            }
            let lifecycle =
                done || previous_started != Some(started) || focus_stolen != previous_focus_stolen;
            previous_started = Some(started);
            let sample = Sample {
                id: id.clone(),
                label: label.clone(),
                sequence: polling.sample_count.fetch_add(1, Ordering::AcqRel),
                source: source.clone(),
                region_count: polling.region_count.load(Ordering::Acquire) as usize,
                receiver_epoch: polling.receiver_epoch.load(Ordering::Acquire),
                x: point.x,
                y: point.y,
                phase: if done { "end" } else { "move" },
                at: unix_ms(),
                escaped,
                receiver,
                client_x: hit.as_ref().map(|(_, x, _)| *x).unwrap_or(-1.0),
                client_y: hit.as_ref().map(|(_, _, y)| *y).unwrap_or(-1.0),
                approval,
                native_started_at: (started != 0).then_some(started),
                error: failed.then_some("tearout_native_move_failed"),
                scale: unsafe { GetDpiForWindow(HWND(handle as *mut _)) }.max(96) as f64 / 96.0,
                monitor: monitor_name(point),
                focus_stolen,
                esc_at: match polling.escaped_at.load(Ordering::Acquire) {
                    0 => None,
                    at => Some(at),
                },
                original,
            };
            let approved = polling
                .approval
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .is_some();
            let allowed = polling
                .pacing
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .allow(
                    sample.at,
                    sample.receiver.as_deref(),
                    sample.client_x,
                    sample.client_y,
                    lifecycle,
                    approved,
                    polling.metrics.legacy.load(Ordering::Acquire),
                );
            if allowed {
                let emit_at = Instant::now();
                let delivered = emit_sample(&app, &sample, previous.as_deref(), lifecycle);
                polling
                    .metrics
                    .emit(emit_at.elapsed().as_secs_f64() * 1000.0, delivered);
            }
            if done {
                if polling.metrics.enabled.load(Ordering::Acquire)
                    && !polling.metrics.probe_started.load(Ordering::Acquire)
                {
                    super::log::native_summary(
                        id.clone(),
                        label.clone(),
                        polling.metrics.summary(),
                    );
                }
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(8));
        }
        app.state::<TearoutState>()
            .moves
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&id);
    });
    if was_held {
        if let Err(error) = window.start_dragging() {
            shared.failed.store(true, Ordering::Release);
            return Err(error.to_string());
        }
    }
    Ok(())
}
