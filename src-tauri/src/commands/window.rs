use std::collections::HashSet;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(target_os = "windows")]
use windows::Win32::Foundation::RECT;
#[cfg(target_os = "windows")]
use windows::Win32::UI::WindowsAndMessaging::{
    GetWindowRect, SetForegroundWindow, SetWindowPos, ShowWindow, HWND_TOP, SWP_SHOWWINDOW,
    SW_SHOWNORMAL,
};

use crate::AppState;

/// Whether a window rectangle overlaps any monitor at all.
///
/// A window that overlaps nothing is unreachable: it cannot be clicked, dragged
/// or closed, and on macOS nothing brings it back on its own. That gap is real
/// even though the case that prompted this was not one -- a window found at
/// x=-1920 on 2026-09-10 turned out to be sitting on a second display at that
/// origin, not stranded. What remains true is that the rescue existed only for
/// Windows, so a Mac that loses the display a window is on has no way back.
///
/// Rectangles are half-open: touching edges do not count as overlapping, which
/// is what puts a window flush against the left edge of a monitor on-screen
/// rather than one pixel outside it.
pub(crate) fn rect_overlaps_any_monitor(
    rect: (i32, i32, i32, i32),
    monitors: &[(i32, i32, i32, i32)],
) -> bool {
    let (left, top, right, bottom) = rect;
    monitors.iter().any(|&(m_left, m_top, m_right, m_bottom)| {
        left < m_right && right > m_left && top < m_bottom && bottom > m_top
    })
}

/// Brings the window back onto a display if it is stranded off every monitor.
///
/// Tauri's own geometry rather than Win32: this is the path macOS takes, where
/// the frontend reveal flow does not fire and the Windows-only rescue below
/// never runs. Centring is the recovery — a window overlapping no monitor is by
/// definition somewhere the operator cannot reach. A window on a second display
/// overlaps that display and is left alone.
pub(crate) fn recenter_if_offscreen(window: &tauri::WebviewWindow) {
    let (Ok(position), Ok(size), Ok(monitors)) = (
        window.outer_position(),
        window.outer_size(),
        window.available_monitors(),
    ) else {
        return;
    };
    if monitors.is_empty() {
        return;
    }

    let width = i32::try_from(size.width).unwrap_or(i32::MAX);
    let height = i32::try_from(size.height).unwrap_or(i32::MAX);
    let rect = (
        position.x,
        position.y,
        position.x.saturating_add(width),
        position.y.saturating_add(height),
    );
    let bounds: Vec<(i32, i32, i32, i32)> = monitors
        .iter()
        .map(|monitor| {
            let origin = monitor.position();
            let extent = monitor.size();
            (
                origin.x,
                origin.y,
                origin
                    .x
                    .saturating_add(i32::try_from(extent.width).unwrap_or(i32::MAX)),
                origin
                    .y
                    .saturating_add(i32::try_from(extent.height).unwrap_or(i32::MAX)),
            )
        })
        .collect();

    if !rect_overlaps_any_monitor(rect, &bounds) {
        let _ = window.center();
    }
}

#[cfg(target_os = "windows")]
fn ensure_window_bounds(window: &tauri::WebviewWindow) {
    if let Ok(hwnd) = window.hwnd() {
        let native_hwnd = windows::Win32::Foundation::HWND(hwnd.0);
        let mut rect = RECT::default();
        let actual_rect = unsafe { GetWindowRect(native_hwnd, &mut rect) };

        if actual_rect.is_ok() {
            let width = rect.right - rect.left;
            let height = rect.bottom - rect.top;

            if width < 400 || height < 300 {
                unsafe {
                    let _ = ShowWindow(native_hwnd, SW_SHOWNORMAL);
                    let _ = SetWindowPos(native_hwnd, HWND_TOP, 120, 80, 1400, 900, SWP_SHOWWINDOW);
                    let _ = SetForegroundWindow(native_hwnd);
                }
            }

            if let Ok(monitors) = window.available_monitors() {
                let overlaps_monitor = monitors.iter().any(|monitor| {
                    let position = monitor.position();
                    let size = monitor.size();
                    let monitor_left = position.x;
                    let monitor_top = position.y;
                    let monitor_right =
                        monitor_left.saturating_add(i32::try_from(size.width).unwrap_or(i32::MAX));
                    let monitor_bottom =
                        monitor_top.saturating_add(i32::try_from(size.height).unwrap_or(i32::MAX));

                    rect.left < monitor_right
                        && rect.right > monitor_left
                        && rect.top < monitor_bottom
                        && rect.bottom > monitor_top
                });

                if !monitors.is_empty() && !overlaps_monitor {
                    unsafe {
                        let _ = ShowWindow(native_hwnd, SW_SHOWNORMAL);
                        let _ =
                            SetWindowPos(native_hwnd, HWND_TOP, 120, 80, 1400, 900, SWP_SHOWWINDOW);
                        let _ = SetForegroundWindow(native_hwnd);
                    }
                }
            }
        }
    }
}

#[tauri::command]
pub fn claim_leader(window: tauri::WebviewWindow, state: State<'_, AppState>) -> bool {
    state.window_registry.claim_leader(window.label())
}

#[tauri::command(async)]
pub fn release_leader(window: tauri::WebviewWindow) {
    release_window_role(window.app_handle(), window.label());
}

pub fn release_window_role(app: &AppHandle, label: &str) {
    if let Some(state) = app.try_state::<AppState>() {
        if state.window_registry.release_leader(label) {
            let _ = app.emit(crate::window_registry::WINDOW_REGISTRY_CHANGED_EVENT,
                state.window_registry.revision());
        }
    }
}

#[tauri::command]
pub fn reveal_main_window(app: AppHandle) -> Result<(), String> {
    let app_handle = app.clone();
    app.run_on_main_thread(move || {
        if let Some(window) = app_handle.get_webview_window("main") {
            let _ = window.show();
            #[cfg(target_os = "windows")]
            ensure_window_bounds(&window);
            recenter_if_offscreen(&window);
        }
    })
    .map_err(|e| e.to_string())
}

/// Label prefix for every non-main window. It has to stay in sync with the
/// capability glob in `capabilities/default.json` (`"mycmux-w*"`): a window
/// whose label falls outside that glob gets zero permissions, so every
/// `invoke` from it fails silently-ish (see the child boot probe in App.tsx).
pub const CHILD_WINDOW_LABEL_PREFIX: &str = "mycmux-w";

const CHILD_WINDOW_DEFAULT_WIDTH: f64 = 1200.0;
const CHILD_WINDOW_DEFAULT_HEIGHT: f64 = 800.0;
const CHILD_WINDOW_MIN_WIDTH: f64 = 600.0;
const CHILD_WINDOW_MIN_HEIGHT: f64 = 400.0;

/// Deterministic, reused child-window labels: `mycmux-w1`, `mycmux-w2`, … and
/// always the *lowest free* index. Reuse (rather than a monotonic counter)
/// keeps `WindowConfig.id` stable across restarts once Phase 3d persists window
/// layout, and keeps the label set small enough to reason about.
///
/// Pure so it can be unit-tested without a Tauri app handle.
pub fn next_child_window_label(existing: &[String]) -> String {
    let used: HashSet<u32> = existing
        .iter()
        .filter_map(|label| child_window_index(label))
        .collect();

    let mut candidate = 1u32;
    while used.contains(&candidate) {
        candidate += 1;
    }
    format!("{CHILD_WINDOW_LABEL_PREFIX}{candidate}")
}

/// `mycmux-w7` → `Some(7)`; anything else (including `main`, `mycmux-w`,
/// `mycmux-w0`, `mycmux-w07`, `mycmux-w1x`) → `None`. Only canonical decimal
/// indices count as taken, so a hand-crafted label can never wedge the
/// allocator.
fn child_window_index(label: &str) -> Option<u32> {
    let rest = label.strip_prefix(CHILD_WINDOW_LABEL_PREFIX)?;
    if rest.is_empty() || rest.starts_with('0') || !rest.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    rest.parse::<u32>().ok().filter(|index| *index >= 1)
}

/// A caller-supplied label must stay inside the capability glob, otherwise the
/// new window would come up permission-less.
pub fn is_valid_child_window_label(label: &str) -> bool {
    child_window_index(label).is_some()
}

/// Grace period before Rust force-reveals a child window the frontend never
/// revealed itself. Long enough for a normal boot (frontend shows itself after
/// first paint), short enough that a broken window is not invisible for long.
const CHILD_WINDOW_REVEAL_FALLBACK_MS: u64 = 6000;

fn schedule_child_window_reveal_fallback(app: AppHandle, label: String) {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(
            CHILD_WINDOW_REVEAL_FALLBACK_MS,
        ));
        let Some(window) = app.get_webview_window(&label) else {
            return; // closed in the meantime
        };
        if window.is_visible().unwrap_or(true) {
            return; // frontend revealed it normally
        }
        crate::diag_warn!(
            "window",
            "child window {label} never revealed itself — forcing show (capability issue?)"
        );
        let _ = window.show();
    });
}

/// Keep a torn-out window fully on the monitor it was dropped on. Dropping near
/// the right or bottom edge is the normal way to detach, and without this the
/// window opens half off-screen with its title band out of reach.
///
/// Pure geometry so the clamp itself is unit-tested (`clamp_window_origin`).
pub fn clamp_window_origin(
    monitor: (f64, f64, f64, f64),
    origin: (f64, f64),
    size: (f64, f64),
) -> (f64, f64) {
    let (mx, my, mw, mh) = monitor;
    let max_x = (mx + mw - size.0).max(mx);
    let max_y = (my + mh - size.1).max(my);
    (origin.0.clamp(mx, max_x), origin.1.clamp(my, max_y))
}

fn clamp_to_monitor<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> (f64, f64) {
    // The drop point decides the monitor; falling back to the window's current
    // one keeps a multi-monitor drop on the screen the user dropped it on.
    let monitor = window
        .app_handle()
        .monitor_from_point(x, y)
        .ok()
        .flatten()
        .or_else(|| window.current_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return (x, y);
    };
    let scale = monitor.scale_factor();
    let position = monitor.position().to_logical::<f64>(scale);
    let size = monitor.size().to_logical::<f64>(scale);
    clamp_window_origin(
        (position.x, position.y, size.width, size.height),
        (x, y),
        (width, height),
    )
}

/// Outcome of label allocation: either the label is free and the caller must
/// build the window, or a window already carries it and was revealed instead.
pub enum ResolvedChildWindow {
    New(String),
    Existing(String),
}

/// Resolve the label a new child window should take: the caller's request
/// (validated against the capability glob) or the lowest free index.
pub fn resolve_child_window_label(
    app: &AppHandle,
    label: Option<String>,
) -> Result<ResolvedChildWindow, String> {
    let existing: Vec<String> = app.webview_windows().keys().cloned().collect();
    let label = match label {
        Some(requested) => {
            if !is_valid_child_window_label(&requested) {
                return Err(format!(
                    "invalid child window label {requested:?} (must be {CHILD_WINDOW_LABEL_PREFIX}<n>)"
                ));
            }
            requested
        }
        None => next_child_window_label(&existing),
    };

    if let Some(window) = app.get_webview_window(&label) {
        // Idempotent: asking for a label that is already open just reveals it.
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(ResolvedChildWindow::Existing(label));
    }

    Ok(ResolvedChildWindow::New(label))
}

/// Post the actual window construction to the main thread (tao forbids
/// building windows off it on Windows/macOS). Fire-and-forget by design: like
/// `reveal_main_window`, blocking on the result from a sync command would
/// deadlock the very event loop that has to run the closure.
///
/// The hop through a worker thread is what makes that posting real. Both
/// callers are sync commands (the allowlist in
/// `tests/test_command_sync_contract.py` names them), so they already run on
/// the main thread, and wry's `run_on_main_thread` executes inline when it is
/// called from there. Building a webview inline means creating it inside the WebView2
/// IPC callback: `build()` then waits for the controller while the message
/// loop it needs is still inside our call stack, so the app freezes with an
/// empty, invisible window on screen (reproduced twice on a test machine,
/// 2026-09-11). Handing the closure to a thread makes `run_on_main_thread`
/// post a user event that the event loop runs after the command returns.
///
/// Shared by `open_child_window` (Phase 3a dev hook) and
/// `open_workspace_window` (Phase 3b tear-out) so both windows get identical
/// chrome, the reveal fallback and the merge-back-on-destroy hook.
pub fn spawn_child_window(
    app: &AppHandle,
    label: String,
    x: Option<f64>,
    y: Option<f64>,
    width: Option<f64>,
    height: Option<f64>,
) -> Result<(), String> {
    let app_handle = app.clone();
    let build_label = label;
    let post_handle = app.clone();
    std::thread::spawn(move || {
        let _ = post_handle.run_on_main_thread(move || {
            let mut builder = tauri::WebviewWindowBuilder::new(
                &app_handle,
                &build_label,
                tauri::WebviewUrl::default(),
            )
            .title("mycmux")
            // Same undecorated chrome as the main window (tauri.conf.json) — the
            // in-app TitleBar draws the controls.
            .decorations(false)
            .resizable(true)
            // Revealed by the frontend after first paint (App.tsx), mirroring the
            // main window's hidden-until-ready startup.
            .visible(false)
            .min_inner_size(CHILD_WINDOW_MIN_WIDTH, CHILD_WINDOW_MIN_HEIGHT)
            .inner_size(
                width.unwrap_or(CHILD_WINDOW_DEFAULT_WIDTH),
                height.unwrap_or(CHILD_WINDOW_DEFAULT_HEIGHT),
            );

            if let (Some(x), Some(y)) = (x, y) {
                builder = builder.position(x, y);
            }

            match builder.build() {
                Ok(window) => {
                    // Restate size and position in explicit logical units now that
                    // the window knows which monitor (and scale factor) it is on.
                    // The builder applies them before that is settled, which on a
                    // 150% display produced a window of the wrong size in the wrong
                    // place: 720x520 asked, 585x696 measured (2026-09-12).
                    let size = (
                        width.unwrap_or(CHILD_WINDOW_DEFAULT_WIDTH),
                        height.unwrap_or(CHILD_WINDOW_DEFAULT_HEIGHT),
                    );
                    let _ = window.set_size(tauri::LogicalSize::new(size.0, size.1));
                    if let (Some(x), Some(y)) = (x, y) {
                        let (x, y) = clamp_to_monitor(&window, x, y, size.0, size.1);
                        let _ = window.set_position(tauri::LogicalPosition::new(x, y));
                    }
                    // Per-window taskbar button needs its own icon (mirrors lib.rs
                    // doing this for "main").
                    if let Some(icon) = app_handle.default_window_icon().cloned() {
                        let _ = window.set_icon(icon);
                    }
                    // Safety net for the failure mode the JS boot probe exists to
                    // report: if the capability glob ever stops covering this
                    // label, the frontend cannot show its own window either (that
                    // is an IPC call too), and the hard error UI would render into
                    // a window nobody can see. Reveal it from Rust if the frontend
                    // has not done so itself.
                    schedule_child_window_reveal_fallback(app_handle.clone(), build_label.clone());


                }
                Err(err) => {
                    crate::diag_warn!("window", "failed to open child window {build_label}: {err}");
                }
            }
        });
    });
    Ok(())
}

/// Phase 3a: open an additional app window. It boots the same frontend bundle;
/// every main-window-only singleton (persistence, socket handling, quit path,
/// updater) is gated behind `isMainWindow()` on the JS side.
///
/// Sync + `run_on_main_thread` mirrors `reveal_main_window`: the command body
/// itself only allocates a label (cheap, no blocking work — see
/// `tests/test_command_sync_contract.py`), and the actual window construction
/// is posted to the main thread.
#[tauri::command]
pub fn open_child_window(
    app: AppHandle,
    label: Option<String>,
    x: Option<f64>,
    y: Option<f64>,
    width: Option<f64>,
    height: Option<f64>,
) -> Result<String, String> {
    match resolve_child_window_label(&app, label)? {
        ResolvedChildWindow::Existing(label) => Ok(label),
        ResolvedChildWindow::New(label) => {
            spawn_child_window(&app, label.clone(), x, y, width, height)?;
            Ok(label)
        }
    }
}

/// Window closure, explicit exit/restart and native loop termination share cleanup.
pub fn handle_app_run_event(app: &AppHandle, event: tauri::RunEvent) {
    let (live_windows, code) = match event {
        tauri::RunEvent::ExitRequested { code, api, .. } => {
            let live_windows = app.webview_windows().len();
            if code.is_none() && live_windows != 0 {
                api.prevent_exit();
                return;
            }
            (live_windows, code)
        }
        // Native termination (including macOS Cmd+Q) may skip ExitRequested.
        // The shared latch also makes Exit after ExitRequested harmless.
        tauri::RunEvent::Exit => (0, Some(0)),
        _ => return,
    };
    let state = app.state::<AppState>();
    if !state.window_registry.begin_shutdown(live_windows, code) { return; }
    if let Some(dir) = state.scrollback_dir.get() {
        if let Err(error) = state.session_manager.flush_all_scrollbacks(dir) {
            crate::diag_warn!("scrollback", "shutdown flush failed: {error}");
        }
    }
    state.session_manager.kill_all();
    state.hook_service.revoke_all();
    if let Some(remote_sessions) = app.try_state::<Arc<crate::remote::session::RemoteSessionManager>>() {
        remote_sessions.kill_all();
    }
}

#[tauri::command]
pub fn quit_app(app: AppHandle) -> Result<(), String> {
    if !app.webview_windows().is_empty() {
        return Err("Cannot quit while a window is still alive".to_string());
    }
    // Cleanup is centralized in the runtime exit hook, including this path.
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn labels(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn a_drop_near_the_edge_still_opens_on_screen() {
        let monitor = (0.0, 0.0, 1707.0, 1067.0);
        let size = (720.0, 520.0);
        // Inside the monitor the drop point is used as-is.
        assert_eq!(clamp_window_origin(monitor, (300.0, 200.0), size), (300.0, 200.0));
        // Past the right/bottom edge the window slides back into view.
        assert_eq!(clamp_window_origin(monitor, (1576.0, 900.0), size), (987.0, 547.0));
        // Negative coordinates land back at the monitor origin.
        assert_eq!(clamp_window_origin(monitor, (-200.0, -50.0), size), (0.0, 0.0));
        // A second monitor to the right keeps its own origin.
        assert_eq!(
            clamp_window_origin((1707.0, 0.0, 1707.0, 1067.0), (3500.0, 10.0), size),
            (2694.0, 10.0),
        );
    }

    #[test]
    fn a_window_larger_than_the_monitor_pins_to_its_origin() {
        let monitor = (0.0, 0.0, 600.0, 400.0);
        assert_eq!(clamp_window_origin(monitor, (200.0, 200.0), (1200.0, 800.0)), (0.0, 0.0));
    }

    #[test]
    fn first_child_window_label_is_w1() {
        assert_eq!(next_child_window_label(&[]), "mycmux-w1");
        assert_eq!(next_child_window_label(&labels(&["main"])), "mycmux-w1");
    }

    #[test]
    fn allocation_walks_up_from_one() {
        assert_eq!(
            next_child_window_label(&labels(&["main", "mycmux-w1"])),
            "mycmux-w2"
        );
        assert_eq!(
            next_child_window_label(&labels(&["main", "mycmux-w1", "mycmux-w2"])),
            "mycmux-w3"
        );
    }

    #[test]
    fn labels_are_reused_at_the_lowest_free_index() {
        // w1 was closed — the next window takes its slot back instead of
        // growing the counter forever.
        assert_eq!(
            next_child_window_label(&labels(&["main", "mycmux-w2", "mycmux-w3"])),
            "mycmux-w1"
        );
        assert_eq!(
            next_child_window_label(&labels(&["main", "mycmux-w1", "mycmux-w3"])),
            "mycmux-w2"
        );
    }

    #[test]
    fn ordering_does_not_matter() {
        assert_eq!(
            next_child_window_label(&labels(&["mycmux-w3", "mycmux-w1", "main", "mycmux-w2"])),
            "mycmux-w4"
        );
    }

    #[test]
    fn malformed_labels_never_wedge_the_allocator() {
        assert_eq!(
            next_child_window_label(&labels(&[
                "mycmux-w",
                "mycmux-w0",
                "mycmux-w01",
                "mycmux-w1x",
                "mycmux-wa",
                "devtools",
            ])),
            "mycmux-w1"
        );
    }

    #[test]
    fn only_canonical_child_labels_are_accepted_from_callers() {
        assert!(is_valid_child_window_label("mycmux-w1"));
        assert!(is_valid_child_window_label("mycmux-w42"));
        assert!(!is_valid_child_window_label("main"));
        assert!(!is_valid_child_window_label("mycmux-w"));
        assert!(!is_valid_child_window_label("mycmux-w0"));
        assert!(!is_valid_child_window_label("mycmux-w01"));
        assert!(!is_valid_child_window_label("mycmux-w1x"));
        assert!(!is_valid_child_window_label("other-w1"));
    }

    #[test]
    fn child_labels_stay_inside_the_capability_glob() {
        // capabilities/default.json: "windows": ["main", "mycmux-w*"]
        for existing in [
            vec![],
            labels(&["mycmux-w1"]),
            labels(&["mycmux-w1", "mycmux-w2"]),
        ] {
            let label = next_child_window_label(&existing);
            assert!(label.starts_with(CHILD_WINDOW_LABEL_PREFIX), "{label}");
            assert!(is_valid_child_window_label(&label), "{label}");
        }
    }
    #[test]
    fn a_window_inside_the_only_monitor_is_left_alone() {
        let monitors = [(0, 0, 1920, 1080)];
        assert!(rect_overlaps_any_monitor((100, 80, 1500, 980), &monitors));
    }

    #[test]
    fn a_window_one_screen_to_the_left_overlaps_nothing() {
        // What unplugging a second display leaves behind: the window keeps the
        // old monitor's origin, which no remaining monitor covers.
        let monitors = [(0, 0, 1920, 1080)];
        assert!(!rect_overlaps_any_monitor((-1920, 0, 0, 1080), &monitors));
    }

    #[test]
    fn the_same_rect_is_reachable_while_that_display_is_still_attached() {
        // The distinction the check has to make, and the one that caught out a
        // reading of the Mac on 2026-09-10: those coordinates look stranded
        // until the second monitor at the same origin is counted.
        let monitors = [(0, 0, 1920, 1080), (-1920, 0, 0, 1080)];
        assert!(rect_overlaps_any_monitor((-1920, 0, 0, 1080), &monitors));
    }

    #[test]
    fn a_window_half_off_an_edge_still_counts_as_reachable() {
        // Partly visible is still draggable, so it must not be recentred: doing
        // so would yank windows the operator deliberately parked at an edge.
        let monitors = [(0, 0, 1920, 1080)];
        assert!(rect_overlaps_any_monitor((-200, 0, 1000, 900), &monitors));
    }

    #[test]
    fn a_window_on_a_second_monitor_is_reachable() {
        let monitors = [(0, 0, 1920, 1080), (1920, 0, 3840, 1080)];
        assert!(rect_overlaps_any_monitor((2000, 100, 3000, 900), &monitors));
    }

    #[test]
    fn touching_edges_do_not_count_as_overlap() {
        // Half-open rectangles: a window whose right edge is the monitor's left
        // edge shows nothing at all.
        let monitors = [(0, 0, 1920, 1080)];
        assert!(!rect_overlaps_any_monitor((-800, 0, 0, 600), &monitors));
    }

    #[test]
    fn no_monitors_means_no_claim_either_way() {
        assert!(!rect_overlaps_any_monitor((0, 0, 100, 100), &[]));
    }
}
