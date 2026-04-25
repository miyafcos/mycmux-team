mod commands;
mod db;
mod events;
mod pty;
mod remote;
mod socket;
pub mod terminal_config;

use pty::manager::SessionManager;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

pub struct AppState {
    pub session_manager: Arc<SessionManager>,
    pub bootstrapped: AtomicBool,
    pub metadata_store: pty::monitor::MetadataStore,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let metadata_store = pty::monitor::new_metadata_store();

    let state = AppState {
        session_manager: Arc::new(SessionManager::new()),
        bootstrapped: AtomicBool::new(false),
        metadata_store: metadata_store.clone(),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(state)
        .manage(socket::SocketState {
            pending_requests: Arc::new(dashmap::DashMap::new()),
            next_id: std::sync::atomic::AtomicUsize::new(1),
        })
        .invoke_handler(tauri::generate_handler![
            commands::terminal::create_session,
            commands::terminal::write_to_session,
            commands::terminal::resize_session,
            commands::terminal::kill_session,
            commands::terminal::get_terminal_config,
            commands::terminal::get_all_cwds,
            commands::terminal::is_directory,
            commands::terminal::get_launch_cwd,
            commands::terminal::get_default_shell,
            commands::terminal::get_claude_session_id,
            commands::terminal::read_pane_session_mappings,
            commands::workspace::load_persistent_data,
            commands::workspace::save_persistent_data,
            commands::workspace::save_workspaces,
            commands::workspace::save_settings,
            commands::window::claim_leader,
            commands::window::get_window_count,
            commands::window::reveal_main_window,
            commands::window::quit_app,
            socket::socket_response,
        ])
        .setup(|#[allow(unused)] app| {
            use tauri::Manager;

            let app_handle = app.handle().clone();
            let state = app.state::<AppState>();
            #[cfg(target_os = "windows")]
            crate::pty::windows_console::start_startup_flash_suppression(std::process::id());
            let ms = state.metadata_store.clone();
            pty::monitor::start_monitor(
                app_handle.clone(),
                state.session_manager.clone(),
                ms.clone(),
            );

            socket::start_socket_listener(app_handle.clone());
            remote::start_remote_server(
                app_handle.clone(),
                state.session_manager.clone(),
                ms,
            );

            // Kill all PTY sessions when the main window closes
            let mgr = state.session_manager.clone();
            if let Some(main_window) = app.get_webview_window("main") {
                if let Some(icon) = app.default_window_icon().cloned() {
                    let _ = main_window.set_icon(icon);
                }

                main_window.on_window_event(move |event| {
                    if let tauri::WindowEvent::Destroyed = event {
                        mgr.kill_all();
                    }
                });
            }

            #[cfg(debug_assertions)]
            {
                if let Some(webview) = app.get_webview_window("main") {
                    webview.open_devtools();
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
