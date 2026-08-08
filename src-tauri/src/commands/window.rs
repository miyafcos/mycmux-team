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
