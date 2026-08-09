use std::collections::HashSet;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};

#[cfg(target_os = "windows")]
use windows::Win32::Foundation::RECT;
#[cfg(target_os = "windows")]
use windows::Win32::UI::WindowsAndMessaging::{
    GetWindowRect, SetForegroundWindow, SetWindowPos, ShowWindow, HWND_TOP, SWP_SHOWWINDOW,
    SW_SHOWNORMAL,
};

use crate::AppState;

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
pub fn claim_leader(state: State<'_, AppState>) -> bool {
    state
        .bootstrapped
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
}

#[tauri::command]
pub fn reveal_main_window(app: AppHandle) -> Result<(), String> {
    let app_handle = app.clone();
    app.run_on_main_thread(move || {
        if let Some(window) = app_handle.get_webview_window("main") {
            let _ = window.show();
            #[cfg(target_os = "windows")]
            ensure_window_bounds(&window);
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
    app.run_on_main_thread(move || {
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

                // Merge-back safety net (Phase 3b). The clean close path
                // releases the window's workspaces itself, so this normally
                // finds nothing. It exists for the paths that never run JS:
                // a crashed webview, an OS-forced close, the taskbar's
                // "close window". Whatever is still assigned to the label
                // goes back to main, sessions and all.
                let reclaim_handle = app_handle.clone();
                let reclaim_label = build_label.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::Destroyed = event {
                        crate::commands::window_registry::reclaim_destroyed_window(
                            &reclaim_handle,
                            &reclaim_label,
                        );
                    }
                });
            }
            Err(err) => {
                crate::diag_warn!("window", "failed to open child window {build_label}: {err}");
            }
        }
    })
    .map_err(|e| e.to_string())
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

#[tauri::command]
pub fn quit_app(
    app: AppHandle,
    state: State<'_, AppState>,
    remote_sessions: State<'_, Arc<crate::remote::session::RemoteSessionManager>>,
) -> Result<(), String> {
    state.session_manager.kill_all();
    remote_sessions.kill_all();
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
}
