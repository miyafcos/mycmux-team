use super::geometry::{self, ReceiverCandidate, Rect};
use super::performance::{claim_follower_tick, follower_should_stop, FollowerConditions};
use super::{unix_ms, Approval, MoveMode, MoveState, Reveal, TearoutState, WindowGeometry};
use super::release::{ReleaseFrame, ReleaseMethod, ReleasePoint};
use serde::Serialize;
use std::time::{Duration, Instant};
use std::{
    cell::{Cell, RefCell},
    collections::{HashMap, HashSet},
    sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex, OnceLock},
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
            GetTopWindow, GetWindow, GetWindowLongPtrW, GetWindowRect, IsIconic, IsWindow, IsWindowVisible,
            PostMessageW, SetLayeredWindowAttributes, SetWindowLongPtrW, SetWindowsHookExW,
            ShowWindow, UnhookWindowsHookEx, GWL_EXSTYLE, GW_HWNDNEXT, HHOOK, LWA_ALPHA,
            GetWindowPlacement, SetWindowPlacement, SetWindowPos, SW_MAXIMIZE, SW_SHOWNORMAL,
            SWP_NOACTIVATE, SWP_NOZORDER, WINDOWPLACEMENT, WINDOWPLACEMENT_FLAGS, GetClientRect, IsZoomed,
            WPF_RESTORETOMAXIMIZED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, HCBT_ACTIVATE, WH_CBT, WH_KEYBOARD, WM_CANCELMODE, WM_ENTERSIZEMOVE, WM_EXITSIZEMOVE,
            WM_KEYDOWN, WM_NCDESTROY, WS_EX_LAYERED, WH_MOUSE, MOUSEHOOKSTRUCT, WM_LBUTTONUP, WM_NCLBUTTONUP,
        },
    },
};

pub fn cursor() -> Result<POINT, String> {
    let mut p = POINT::default();
    if let Err(error) = unsafe { GetCursorPos(&mut p) } {
        // Explicit test-profile input for a non-input hidden desktop. Never
        // synthesize a cursor in the live application or move the real pointer.
        if crate::test_profile::is_active() {
            if let Ok(root) = crate::test_profile::runtime_dir() {
                if let Ok(bytes) = std::fs::read(root.join("tearout-test-cursor.json")) {
                    if let Ok(point) = serde_json::from_slice::<[i32; 2]>(&bytes) {
                        return Ok(POINT { x: point[0], y: point[1] });
                    }
                }
            }
        }
        return Err(error.to_string());
    }
    Ok(p)
}

pub fn left_button_down() -> bool {
    unsafe { GetAsyncKeyState(VK_LBUTTON.0 as i32) as u16 & 0x8000 != 0 }
}

pub fn reveal(
    app: &AppHandle,
    label: &str,
    offset_x: f64,
    offset_y: f64,
    logical_width: f64,
    logical_height: f64,
) -> Result<Reveal, String> {
    app.state::<TearoutState>().stop_follower(label);
    let window = app.get_window(label).ok_or("Prepared window disappeared")?;
    let point = cursor()?;
    let monitor = app
        .monitor_from_point(point.x as f64, point.y as f64)
        .map_err(|e| e.to_string())?;
    let monitor_scale = monitor.as_ref().map(|m| m.scale_factor()).unwrap_or(1.0);
    let work = monitor_area(point, monitor_scale).map(|m| m.work).unwrap_or(Rect { width: 800.0 * monitor_scale, height: 600.0 * monitor_scale, ..Rect::default() });
    let (width, height) = geometry::initial_logical_size(logical_width, logical_height, work, monitor_scale);
    let origin = geometry::origin_under_cursor((point.x, point.y), width, geometry::GrabOffset { x: offset_x, y: offset_y }, monitor_scale);
    window
        .set_position(tauri::PhysicalPosition::new(origin.0, origin.1))
        .map_err(|e| e.to_string())?;
    // A boundary cursor may select a different DPI from the HWND. Let tao
    // convert the logical extent using the window's actual assigned DPI.
    window
        .set_size(tauri::LogicalSize::new(width, height))
        .map_err(|e| e.to_string())?;
    let foreground = unsafe { GetForegroundWindow() };
    let shown_at = unix_ms();
    quiet_show(&window, false)?;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let handle = HWND(window.hwnd().map_err(|e| e.to_string())?.0);
    let follower = window.inner_size().map_err(|e| e.to_string()).and_then(|size| {
        let logical_width = size.width as f64 / scale.max(0.01);
        start_follower(app, label, handle.0 as usize, logical_width, geometry::GrabOffset { x: offset_x, y: offset_y })
    });
    if let Err(error) = follower { eprintln!("[tearout] cursor follower unavailable: {error}"); }
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

/// An early refusal, failed queue post, or dropped command stops only the
/// reveal it saw at request time. It never waits for the polling thread.
pub(super) struct FollowerStartGuard(Option<Arc<AtomicBool>>);
impl FollowerStartGuard {
    pub(super) fn new(app: &AppHandle, label: &str) -> Self {
        Self(app.state::<TearoutState>().followers.lock().unwrap_or_else(|e| e.into_inner()).get(label).cloned())
    }
}
impl Drop for FollowerStartGuard {
    fn drop(&mut self) {
        if let Some(stop) = &self.0 { stop.store(true, Ordering::Release); }
    }
}

fn follower_conditions(app: &AppHandle, label: &str, handle: usize, stop: &AtomicBool, started: Instant) -> FollowerConditions {
    FollowerConditions {
        stopped: stop.load(Ordering::Acquire), elapsed_ms: started.elapsed().as_millis() as u64,
        left_held: left_button_down(), escape_held: unsafe { GetAsyncKeyState(VK_ESCAPE.0 as i32) < 0 },
        valid_window: unsafe { IsWindow(HWND(handle as *mut _)) }.as_bool(),
        registered_window: app.get_window(label).is_some(),
    }
}

/// UI thread only. Read the OS-assigned window DPI for both placement callers.
fn window_scale(handle: usize) -> Result<f64, String> {
    let dpi = unsafe { GetDpiForWindow(HWND(handle as *mut _)) };
    if dpi == 0 { return Err("tearout_window_scale_unavailable".into()); }
    Ok(dpi as f64 / 96.0)
}

/// UI thread only. Stop following if a second placement flips scale again.
fn follow_cursor(window: &tauri::Window, handle: usize, width: f64, offset: geometry::GrabOffset) -> Result<bool, String> {
    let point = cursor()?;
    let placement = geometry::settle_from_window_scale((point.x, point.y), width, offset,
        || window_scale(handle).map_err(|_| "tearout_follow_window_gone".to_owned()), |origin| {
            window.set_position(tauri::PhysicalPosition::new(origin.0, origin.1)).map_err(|e| e.to_string())
        })?;
    Ok(placement.settled)
}

fn start_follower(app: &AppHandle, label: &str, handle: usize, width: f64, offset: geometry::GrabOffset) -> Result<(), String> {
    let stop = Arc::new(AtomicBool::new(false));
    app.state::<TearoutState>().replace_follower(label, stop.clone());
    let worker_app = app.clone();
    let worker_label = label.to_owned();
    let worker_stop = stop.clone();
    let started = Instant::now();
    let spawned = std::thread::Builder::new().name("tearout-follow".into()).spawn(move || {
        let pending = Arc::new(AtomicBool::new(false));
        loop {
            if follower_should_stop(follower_conditions(&worker_app, &worker_label, handle, &worker_stop, started)) { break; }
            if claim_follower_tick(&worker_stop, &pending) {
                let tick_app = worker_app.clone();
                let tick_label = worker_label.clone();
                let tick_stop = worker_stop.clone();
                let tick_pending = pending.clone();
                if worker_app.run_on_main_thread(move || {
                    if follower_should_stop(follower_conditions(&tick_app, &tick_label, handle, &tick_stop, started)) {
                        tick_stop.store(true, Ordering::Release);
                    } else if let Some(window) = tick_app.get_window(&tick_label) {
                        if !tick_stop.load(Ordering::Acquire) && !matches!(follow_cursor(&window, handle, width, offset), Ok(true)) {
                            tick_stop.store(true, Ordering::Release);
                        }
                    } else {
                        tick_stop.store(true, Ordering::Release);
                    }
                    tick_pending.store(false, Ordering::Release);
                }).is_err() {
                    worker_stop.store(true, Ordering::Release);
                    pending.store(false, Ordering::Release);
                    break;
                }
            }
            std::thread::sleep(Duration::from_millis(8));
        }
        worker_app.state::<TearoutState>().finish_follower(&worker_label, &worker_stop);
    });
    if let Err(error) = spawned {
        app.state::<TearoutState>().finish_follower(label, &stop);
        return Err(error.to_string());
    }
    Ok(())
}


thread_local! {
    static QUIET_SHOW_TARGET: Cell<usize> = const { Cell::new(0) };
}

unsafe extern "system" fn quiet_activation(code: i32, target: WPARAM, data: LPARAM) -> LRESULT {
    if code == HCBT_ACTIVATE as i32 && QUIET_SHOW_TARGET.with(|quiet| quiet.get() == target.0) {
        return LRESULT(1);
    }
    unsafe { CallNextHookEx(None, code, target, data) }
}

/// Scoped to this UI thread and this hidden window's first synchronous show.
/// Explicit ShowWindow activation is vetoed without persisting tao's
/// MARKER_DONT_FOCUS or changing attributes during a later native move.
struct QuietShowActivation {
    hook: HHOOK,
    previous: usize,
}

impl QuietShowActivation {
    fn new(handle: HWND) -> Result<Self, String> {
        let hook = unsafe { SetWindowsHookExW(WH_CBT, Some(quiet_activation), None, GetCurrentThreadId()) }
            .map_err(|e| e.to_string())?;
        let previous = QUIET_SHOW_TARGET.with(|quiet| quiet.replace(handle.0 as usize));
        Ok(Self { hook, previous })
    }
}

impl Drop for QuietShowActivation {
    fn drop(&mut self) {
        QUIET_SHOW_TARGET.with(|quiet| quiet.set(self.previous));
        let _ = unsafe { UnhookWindowsHookEx(self.hook) };
    }
}

/// No tao flag change after the hidden window's first quiet reveal.
pub(super) fn quiet_show(window: &tauri::Window, maximized: bool) -> Result<(), String> {
    let handle = HWND(window.hwnd().map_err(|e| e.to_string())?.0);
    if !unsafe { IsWindowVisible(handle) }.as_bool() {
        let _activation = QuietShowActivation::new(handle)?;
        let style = unsafe { GetWindowLongPtrW(handle, GWL_EXSTYLE) };
        unsafe { SetWindowLongPtrW(handle, GWL_EXSTYLE, style | WS_EX_NOACTIVATE.0 as isize) };
        if maximized {
            let _ = unsafe { ShowWindow(handle, SW_MAXIMIZE) };
        }
        let shown = window.show().map_err(|e| e.to_string());
        // Tao normally rewrites the style during show. Also clear explicitly
        // if WM_SHOWWINDOW already made its cached visibility flag current.
        let style = unsafe { GetWindowLongPtrW(handle, GWL_EXSTYLE) };
        unsafe { SetWindowLongPtrW(handle, GWL_EXSTYLE, style & !(WS_EX_NOACTIVATE.0 as isize)) };
        shown?;
    }
    if !unsafe { IsWindowVisible(handle) }.as_bool() {
        return Err("Window did not become visible".into());
    }
    Ok(())
}

fn monitor_area(point: POINT, scale: f64) -> Option<geometry::MonitorArea> {
    let monitor = unsafe { MonitorFromPoint(point, MONITOR_DEFAULTTONEAREST) };
    let mut info = MONITORINFOEXW::default();
    info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
    if !unsafe { GetMonitorInfoW(monitor, &mut info.monitorInfo) }.as_bool() { return None; }
    let rect = |r: RECT| Rect { x: r.left as f64, y: r.top as f64,
        width: (r.right - r.left) as f64, height: (r.bottom - r.top) as f64 };
    Some(geometry::MonitorArea { bounds: rect(info.monitorInfo.rcMonitor), work: rect(info.monitorInfo.rcWork), scale })
}

fn monitor_areas(app: &AppHandle) -> Vec<geometry::MonitorArea> {
    app.available_monitors().unwrap_or_default().into_iter().filter_map(|monitor| {
        let p = monitor.position();
        let size = monitor.size();
        monitor_area(POINT { x: p.x + size.width as i32 / 2, y: p.y + size.height as i32 / 2 }, monitor.scale_factor())
    }).collect()
}

fn placement(window: &tauri::Window) -> Result<WINDOWPLACEMENT, String> {
    let handle = HWND(window.hwnd().map_err(|e| e.to_string())?.0);
    let mut value = WINDOWPLACEMENT { length: std::mem::size_of::<WINDOWPLACEMENT>() as u32, ..Default::default() };
    unsafe { GetWindowPlacement(handle, &mut value) }.map_err(|e| e.to_string())?;
    Ok(value)
}

fn geometry(window: &tauri::Window) -> Result<WindowGeometry, String> {
    let position = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.inner_size().map_err(|e| e.to_string())?;
    let p = placement(window)?;
    Ok(WindowGeometry { x: position.x, y: position.y, width: size.width, height: size.height,
        placement: Some(super::SavedPlacement { flags: p.flags.0, show_cmd: p.showCmd,
            min_position: [p.ptMinPosition.x, p.ptMinPosition.y], max_position: [p.ptMaxPosition.x, p.ptMaxPosition.y],
            normal: [p.rcNormalPosition.left, p.rcNormalPosition.top, p.rcNormalPosition.right, p.rcNormalPosition.bottom] }) })
}

pub(super) fn restore_geometry(window: &tauri::Window, original: WindowGeometry) -> Result<(), String> {
    // The OS move loop may already have restored Esc, including an arranged
    // (snapped) state. Do not issue another show-state command in that case.
    if geometry(window)? == original { return Ok(()); }
    let handle = HWND(window.hwnd().map_err(|e| e.to_string())?.0);
    if let Some(p) = original.placement {
        let native = WINDOWPLACEMENT { length: std::mem::size_of::<WINDOWPLACEMENT>() as u32,
            flags: WINDOWPLACEMENT_FLAGS(p.flags), showCmd: p.show_cmd,
            ptMinPosition: POINT { x: p.min_position[0], y: p.min_position[1] },
            ptMaxPosition: POINT { x: p.max_position[0], y: p.max_position[1] },
            rcNormalPosition: RECT { left: p.normal[0], top: p.normal[1], right: p.normal[2], bottom: p.normal[3] } };
        // Esc intentionally restores the exact OS placement; no tao geometry
        // setter may clear the cached MAXIMIZED flag or rewrite layered style.
        unsafe { SetWindowPlacement(handle, &native) }.map_err(|e| e.to_string())
    } else {
        let mut rect = RECT { right: original.width as i32, bottom: original.height as i32, ..Default::default() };
        adjust_normal_rect(handle, &mut rect)?;
        unsafe { SetWindowPos(handle, None, original.x, original.y, rect.right - rect.left,
            rect.bottom - rect.top, SWP_NOZORDER | SWP_NOACTIVATE) }.map_err(|e| e.to_string())
    }
}

static NORMAL_INSETS: OnceLock<Mutex<HashMap<usize, (i32, i32)>>> = OnceLock::new();

fn read_normal_insets(handle: HWND) -> Result<(i32, i32), String> {
    let mut outer = RECT::default();
    let mut client = RECT::default();
    unsafe { GetWindowRect(handle, &mut outer) }.map_err(|e| e.to_string())?;
    unsafe { GetClientRect(handle, &mut client) }.map_err(|e| e.to_string())?;
    Ok(((outer.right - outer.left) - (client.right - client.left),
        (outer.bottom - outer.top) - (client.bottom - client.top)))
}

/// Keep actual normal-frame insets across OS maximize, resize and DPI changes.
/// The event handler reads geometry only; it never changes a window attribute.
pub(super) fn watch_normal_insets(window: &tauri::Window) -> Result<(), String> {
    let handle = window.hwnd().map_err(|e| e.to_string())?.0 as usize;
    let cache = NORMAL_INSETS.get_or_init(|| Mutex::new(HashMap::new()));
    {
        let mut cache = cache.lock().map_err(|e| e.to_string())?;
        if cache.contains_key(&handle) { return Ok(()); }
        cache.insert(handle, read_normal_insets(HWND(handle as *mut _))?);
    }
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            if let Ok(mut cache) = cache.lock() { cache.remove(&handle); }
        } else if matches!(event, tauri::WindowEvent::Resized(_) | tauri::WindowEvent::ScaleFactorChanged { .. }) {
            let hwnd = HWND(handle as *mut _);
            if !unsafe { IsZoomed(hwnd) }.as_bool() && !unsafe { IsIconic(hwnd) }.as_bool() {
                if let (Ok(insets), Ok(mut cache)) = (read_normal_insets(hwnd), cache.lock()) { cache.insert(handle, insets); }
            }
        }
    });
    Ok(())
}

fn adjust_normal_rect(handle: HWND, rect: &mut RECT) -> Result<(), String> {
    let cache = NORMAL_INSETS.get_or_init(|| Mutex::new(HashMap::new()));
    let insets = if !unsafe { IsZoomed(handle) }.as_bool() && !unsafe { IsIconic(handle) }.as_bool() {
        let insets = read_normal_insets(handle)?;
        cache.lock().map_err(|e| e.to_string())?.insert(handle.0 as usize, insets);
        insets
    } else {
        *cache.lock().map_err(|e| e.to_string())?.get(&(handle.0 as usize)).ok_or("tearout_normal_insets_missing")?
    };
    rect.right += insets.0;
    rect.bottom += insets.1;
    Ok(())
}

pub(super) fn saved_normal_frame(window: &tauri::Window) -> Result<(crate::db::storage::WindowFrameConfig,
    crate::db::storage::WindowFrameConfig, bool), String> {
    let p = placement(window)?;
    let handle = HWND(window.hwnd().map_err(|e| e.to_string())?.0);
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let rect = p.rcNormalPosition;
    let area = monitor_area(POINT { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 }, scale);
    // WINDOWPLACEMENT uses work-area coordinates for a top-level non-tool window.
    let offset = if unsafe { GetWindowLongPtrW(handle, GWL_EXSTYLE) } & WS_EX_TOOLWINDOW.0 as isize == 0 {
        area.map(|a| (a.work.x - a.bounds.x, a.work.y - a.bounds.y)).unwrap_or_default()
    } else { (0.0, 0.0) };
    let mut border = RECT::default();
    adjust_normal_rect(handle, &mut border)?;
    let outer = crate::db::storage::WindowFrameConfig {
        x: (rect.left as f64 + offset.0) / scale, y: (rect.top as f64 + offset.1) / scale,
        width: (rect.right - rect.left) as f64 / scale, height: (rect.bottom - rect.top) as f64 / scale };
    let inner = crate::db::storage::WindowFrameConfig { width: (outer.width - (border.right - border.left) as f64 / scale).max(1.0),
        height: (outer.height - (border.bottom - border.top) as f64 / scale).max(1.0), ..outer.clone() };
    let maximized = unsafe { IsZoomed(handle) }.as_bool() || unsafe { IsIconic(handle) }.as_bool() && p.flags.0 & WPF_RESTORETOMAXIMIZED.0 != 0;
    Ok((inner, outer, maximized))
}

pub(super) fn restore_saved_frame(window: &tauri::Window, x: f64, y: f64, width: f64, height: f64, maximized: bool) -> Result<(), String> {
    let handle = HWND(window.hwnd().map_err(|e| e.to_string())?.0);
    if !unsafe { IsWindowVisible(handle) }.as_bool() {
        // A reused spare is already painted. Its hidden geometry may use tao;
        // displayed native windows must use WINDOWPLACEMENT below instead.
        window.set_position(tauri::LogicalPosition::new(x, y)).map_err(|e| e.to_string())?;
        window.set_size(tauri::LogicalSize::new(width, height)).map_err(|e| e.to_string())?;
        return quiet_show(window, maximized);
    }
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let mut rect = RECT { right: (width * scale).round() as i32, bottom: (height * scale).round() as i32, ..Default::default() };
    adjust_normal_rect(handle, &mut rect)?;
    let origin = POINT { x: (x * scale).round() as i32, y: (y * scale).round() as i32 };
    let area = monitor_area(origin, scale);
    let offset = area.map(|a| (a.work.x - a.bounds.x, a.work.y - a.bounds.y)).unwrap_or_default();
    let left = origin.x - offset.0 as i32;
    let top = origin.y - offset.1 as i32;
    let p = WINDOWPLACEMENT { length: std::mem::size_of::<WINDOWPLACEMENT>() as u32,
        showCmd: if maximized { SW_MAXIMIZE.0 as u32 } else { SW_SHOWNORMAL.0 as u32 },
        rcNormalPosition: RECT { left, top, right: left + rect.right - rect.left, bottom: top + rect.bottom - rect.top },
        ..Default::default() };
    unsafe { SetWindowPlacement(handle, &p) }.map_err(|e| e.to_string())
}

#[derive(Clone, Serialize)]
struct Sample {
    id: String,
    mode: MoveMode,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    native_start_delay_ms: Option<u64>,
    start_alignment: Option<geometry::StartAlignment>,
    error: Option<&'static str>,
    scale: f64,
    monitor: Option<String>,
    focus_stolen: bool,
    esc_at: Option<u64>,
    original: WindowGeometry,
    moved: bool,
    release: Option<ReleasePoint>,
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

// A thread-local mouse observer sees the move loop's original up coordinate;
// it never injects or consumes an event and requires no global input hook.
unsafe extern "system" fn mouse_release(code: i32, message: WPARAM, data: LPARAM) -> LRESULT {
    if code >= 0 && matches!(message.0 as u32, WM_LBUTTONUP | WM_NCLBUTTONUP) {
        let event = unsafe { &*(data.0 as *const MOUSEHOOKSTRUCT) };
        ACTIVE_MOVE.with(|active| {
            if let Some(shared) = active.borrow().as_ref() {
                shared.release.latch(ReleasePoint { x: event.pt.x as f64, y: event.pt.y as f64, at: unix_ms(), method: ReleaseMethod::NativeUp });
            }
        });
    }
    unsafe { CallNextHookEx(None, code, message, data) }
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
            } else if let Ok(point) = cursor() {
                shared.release.latch(ReleasePoint { x: point.x as f64, y: point.y as f64, at: unix_ms(), method: ReleaseMethod::NativeExit });
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
    app.state::<TearoutState>().stop_follower(label);
    if let Some(window) = app.get_window(label) {
        let hwnd = HWND(window.hwnd().map_err(|e| e.to_string())?.0);
        unsafe { PostMessageW(hwnd, WM_CANCELMODE, WPARAM(0), LPARAM(0)) }
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn receiver_at(app: &AppHandle, moving: &str, point: POINT, monitors: &[geometry::MonitorArea]) -> Option<(String, f64, f64)> {
    // An app receiver wins at a work-area edge. With no receiver the OS move
    // loop retains its normal snap behavior; no docking target is fabricated.
    let _ = monitors;
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
    let (x, y) = geometry::receiver_client_point((point.x as f64, point.y as f64), (origin.x as f64, origin.y as f64), scale);
    Some((label, x, y))
}

pub(super) fn receiver_geometry(app: &AppHandle, label: &str) -> Result<serde_json::Value, String> {
    let window = app.get_window(label).ok_or("tearout_receiver_window_missing")?;
    let handle = HWND(window.hwnd().map_err(|e| e.to_string())?.0);
    if !unsafe { IsWindowVisible(handle) }.as_bool() || unsafe { IsIconic(handle) }.as_bool() { return Err("tearout_receiver_unavailable".into()); }
    let mut origin = POINT::default(); let mut client = RECT::default();
    if !unsafe { ClientToScreen(handle, &mut origin) }.as_bool() { return Err("tearout_receiver_geometry_failed".into()); }
    unsafe { GetClientRect(handle, &mut client) }.map_err(|e| e.to_string())?;
    Ok(serde_json::json!({"window":handle.0 as usize,"origin":[origin.x,origin.y],
        "size":[client.right-client.left,client.bottom-client.top],"scale":unsafe { GetDpiForWindow(handle) }.max(96) as f64 / 96.0}))
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
    mode: MoveMode,
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
                let shared = Arc::new(MoveState { mode, ..MoveState::default() });
                shared.requested_at_ms.store(unix_ms(), Ordering::Release);
                *shared.moving_label.lock().unwrap_or_else(|e| e.into_inner()) = Some(label.clone());
                *shared.source_label.lock().unwrap_or_else(|e| e.into_inner()) = Some(source.clone());
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
        shared.require_mode(mode)?;
        if !shared.synthetic.load(Ordering::Acquire) {
            return Err("tearout_synthetic_live_move".into());
        }
        shared
    };
    let target_window = receiver.as_deref().and_then(|label| app.get_window(label)).unwrap_or(window.clone());
    let target_handle = HWND(target_window.hwnd().map_err(|e| e.to_string())?.0);
    let target_scale = unsafe { GetDpiForWindow(target_handle) }.max(96) as f64 / 96.0;
    let mut point = POINT { x: (client_x * target_scale).round() as i32, y: (client_y * target_scale).round() as i32 };
    if !unsafe { ClientToScreen(target_handle, &mut point) }.as_bool() { return Err("tearout_synthetic_coordinate_failed".into()); }
    let point_pair = (point.x as f64, point.y as f64);
    let start = *shared.synthetic_origin.lock().map_err(|e| e.to_string())?.get_or_insert(point_pair);
    if source != label || geometry::moved_for_dock(start, point_pair, target_scale) { shared.moved.store(true, Ordering::Release); }
    let receiver = if shared.mode.allows_dock() && shared.moved.load(Ordering::Acquire) { receiver } else { None };
    let original = {
        let mut original = shared.original.lock().map_err(|e| e.to_string())?;
        *original.get_or_insert(geometry(&window)?)
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
    let mut sample = Sample {
        id: id.clone(),
        mode: shared.mode,
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
        native_start_delay_ms: shared.native_start_delay_ms(),
        start_alignment: None,
        error: None,
        scale: window.scale_factor().map_err(|e| e.to_string())?,
        monitor: None,
        focus_stolen: false,
        esc_at: escaped.then_some(at),
        original,
        moved: shared.moved.load(Ordering::Acquire),
        release: (phase == "end" && !escaped).then_some(ReleasePoint { x: point_pair.0, y: point_pair.1, at, method: ReleaseMethod::Synthetic }),
    };
    if let Some(point) = sample.release {
        shared.closed.store(true, Ordering::Release);
        if let Some(receiver) = &sample.receiver {
            if super::arm_release(app, ReleaseFrame { id: id.clone(), mode: shared.mode, label: sample.label.clone(), source: sample.source.clone(),
                receiver: receiver.clone(), receiver_epoch: sample.receiver_epoch, region_count: sample.region_count,
                client_x, client_y, point, token: String::new() }).is_err() {
                sample.error = Some("tearout_release_escrow_failed"); sample.release = None;
            }
        }
    }
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
        app.state::<TearoutState>().activity();
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
    let original = geometry(&window)?;
    let monitors = monitor_areas(app);
    let initial_scale = window.scale_factor().map_err(|e| e.to_string())?;
    if ACTIVE_MOVE.with(|active| active.borrow().is_some()) {
        return Err("tearout_move_busy".into());
    }
    configure_metrics(&shared);
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
    let mouse_hook = unsafe { SetWindowsHookExW(WH_MOUSE, Some(mouse_release), None, GetCurrentThreadId()) }
        .ok().map(|hook| hook.0 as usize);
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
    let start_anchor = Arc::new(Mutex::new((initial_cursor.x - position.x, initial_cursor.y - position.y)));
    let poll_anchor = start_anchor.clone();
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
            let mut point = cursor().unwrap_or_default();
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
            let release = (done && !escaped && !failed).then(|| polling.release.final_point(ReleasePoint {
                x: point.x as f64, y: point.y as f64, at: unix_ms(), method: ReleaseMethod::PollFallback,
            }));
            if let Some(release) = release { point = POINT { x: release.x.round() as i32, y: release.y.round() as i32 }; }
            let scan_at = Instant::now();
            if entered && (point.x != initial_cursor.x || point.y != initial_cursor.y) {
                polling.dragged.store(true, Ordering::Release);
            }
            if source != label || geometry::moved_for_dock((initial_cursor.x as f64, initial_cursor.y as f64),
                (point.x as f64, point.y as f64), initial_scale) { polling.moved.store(true, Ordering::Release); }
            let hit = if polling.mode.allows_dock() && polling.moved.load(Ordering::Acquire) { receiver_at(&app, &label, point, &monitors) } else { None };
            polling
                .metrics
                .poll(Some(scan_at.elapsed().as_secs_f64() * 1000.0));
            if entered && polling.metrics.enabled.load(Ordering::Relaxed) {
                let mut rect = RECT::default();
                if unsafe { GetWindowRect(HWND(handle as *mut _), &mut rect) }.is_ok() {
                    let anchor = *poll_anchor.lock().unwrap_or_else(|e| e.into_inner());
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
                    for hook in [hook, mouse_hook].into_iter().flatten() {
                        unsafe { let _ = UnhookWindowsHookEx(HHOOK(hook as *mut _)); }
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
            let mut sample = Sample {
                id: id.clone(),
                mode: polling.mode,
                label: label.clone(),
                sequence: polling.sample_count.fetch_add(1, Ordering::AcqRel),
                source: source.clone(),
                region_count: polling.region_count.load(Ordering::Acquire) as usize,
                receiver_epoch: polling.receiver_epoch.load(Ordering::Acquire),
                x: point.x,
                y: point.y,
                phase: if done { "end" } else { "move" },
                at: release.map(|point| point.at).unwrap_or_else(unix_ms),
                escaped,
                receiver,
                client_x: hit.as_ref().map(|(_, x, _)| *x).unwrap_or(-1.0),
                client_y: hit.as_ref().map(|(_, _, y)| *y).unwrap_or(-1.0),
                approval,
                native_started_at: (started != 0).then_some(started),
                native_start_delay_ms: polling.native_start_delay_ms(),
                start_alignment: *polling.start_alignment.lock().unwrap_or_else(|e| e.into_inner()),
                error: failed.then_some("tearout_native_move_failed"),
                scale: unsafe { GetDpiForWindow(HWND(handle as *mut _)) }.max(96) as f64 / 96.0,
                monitor: monitor_name(point),
                focus_stolen,
                esc_at: match polling.escaped_at.load(Ordering::Acquire) {
                    0 => None,
                    at => Some(at),
                },
                original,
                moved: polling.dragged.load(Ordering::Acquire),
                release,
            };
            if let Some(point) = release {
                if let Some(receiver) = &sample.receiver {
                    if super::arm_release(&app, ReleaseFrame { id: id.clone(), mode: polling.mode, label: label.clone(), source: source.clone(),
                        receiver: receiver.clone(), receiver_epoch: sample.receiver_epoch, region_count: sample.region_count,
                        client_x: sample.client_x, client_y: sample.client_y, point, token: String::new() }).is_err() {
                        sample.error = Some("tearout_release_escrow_failed"); sample.release = None;
                    }
                }
            }
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
        app.state::<TearoutState>().activity();
        app.state::<TearoutState>()
            .moves
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&id);
    });
    if was_held {
        if let Some(offset) = shared.grab_offset {
            let alignment = (|| -> Result<geometry::StartAlignment, String> {
                let point = cursor()?;
                let before = window.outer_position().map_err(|e| e.to_string())?;
                let original_scale = window_scale(handle)?;
                let width = window.inner_size().map_err(|e| e.to_string())?.width as f64 / original_scale.max(0.01);
                let placement = geometry::settle_from_window_scale((point.x, point.y), width, offset, || window_scale(handle), |origin| {
                    window.set_position(tauri::PhysicalPosition::new(origin.0, origin.1)).map_err(|e| e.to_string())
                })?;
                // Even an unsettled seam proceeds from the final placed origin.
                let expected = placement.origin;
                let after = window.outer_position().map_err(|e| e.to_string())?;
                *start_anchor.lock().unwrap_or_else(|e| e.into_inner()) = (point.x - after.x, point.y - after.y);
                Ok(geometry::StartAlignment::measure([point.x as f64, point.y as f64], [before.x as f64, before.y as f64],
                    [expected.0 as f64, expected.1 as f64], [after.x as f64, after.y as f64], placement.scale, 1.0))
            })();
            match alignment {
                Ok(alignment) => *shared.start_alignment.lock().unwrap_or_else(|e| e.into_inner()) = Some(alignment),
                Err(error) => { shared.failed.store(true, Ordering::Release); return Err(error); }
            }
        }
        if let Err(error) = window.start_dragging() {
            shared.failed.store(true, Ordering::Release);
            return Err(error.to_string());
        }
    }
    Ok(())
}


#[cfg(test)]
mod escape_tests {
    use super::*;

    #[test]
    fn dropping_follower_start_guard_sets_its_stop_flag() {
        // This tests the guard, not the individual commands that own it.
        let stop = Arc::new(AtomicBool::new(false));
        drop(FollowerStartGuard(Some(stop.clone())));
        assert!(stop.load(Ordering::Acquire));
    }

    #[test]
    fn escape_snapshot_equality_includes_show_state_and_normal_rectangle() {
        let original = WindowGeometry { x: 10, y: 20, width: 640, height: 480,
            placement: Some(super::super::SavedPlacement { flags: 0, show_cmd: 1,
                min_position: [-1, -1], max_position: [-1, -1], normal: [10, 20, 666, 509] }) };
        assert!(original == original);
        let mut current = original;
        current.x += 1;
        assert!(current != original);
        current = original;
        current.placement.as_mut().unwrap().show_cmd = 3;
        assert!(current != original);
        current = original;
        current.placement.as_mut().unwrap().normal[0] += 1;
        assert!(current != original);
    }
}
