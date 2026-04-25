use std::sync::atomic::Ordering;
use tauri::{AppHandle, Manager, State};

#[cfg(target_os = "windows")]
use windows::Win32::Foundation::RECT;
#[cfg(target_os = "windows")]
use windows::Win32::UI::WindowsAndMessaging::{
    GetWindowRect, HWND_TOP, SW_SHOWNORMAL, SWP_SHOWWINDOW, SetForegroundWindow,
    SetWindowPos, ShowWindow,
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
                    let _ = SetWindowPos(
                        native_hwnd,
                        HWND_TOP,
                        120,
                        80,
                        1400,
                        900,
                        SWP_SHOWWINDOW,
                    );
                    let _ = SetForegroundWindow(native_hwnd);
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
pub fn get_window_count(app: AppHandle) -> usize {
    app.webview_windows().len()
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
pub fn quit_app(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    state.session_manager.kill_all();
    app.exit(0);
    Ok(())
}
