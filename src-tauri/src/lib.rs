mod buddy;
mod commands;
mod db;
mod events;
mod fs;
mod pty;
mod remote;
mod socket;
pub mod terminal_config;

use pty::manager::SessionManager;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, OnceLock};

pub struct AppState {
    pub session_manager: Arc<SessionManager>,
    pub bootstrapped: AtomicBool,
    pub metadata_store: pty::monitor::MetadataStore,
    pub fs_watcher: OnceLock<Arc<fs::FsWatcher>>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let metadata_store = pty::monitor::new_metadata_store();

    let state = AppState {
        session_manager: Arc::new(SessionManager::new()),
        bootstrapped: AtomicBool::new(false),
        metadata_store: metadata_store.clone(),
        fs_watcher: OnceLock::new(),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
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
            commands::workspace::save_workspaces,
            commands::workspace::save_settings,
            commands::fs::list_directory,
            commands::fs::walk_tree,
            commands::fs::normalize_path,
            commands::fs::save_pinned_roots,
            commands::fs::watch_root,
            commands::fs::unwatch_root,
            commands::fs::reveal_in_explorer,
            commands::fs::open_with_default,
            commands::fs::create_file,
            commands::fs::create_folder,
            commands::window::claim_leader,
            commands::window::get_window_count,
            commands::window::reveal_main_window,
            socket::socket_response,
            buddy::commands::codex_judge,
            buddy::commands::codex_summarize,
            buddy::commands::load_buddy_settings,
            buddy::commands::load_buddy_environment,
            buddy::commands::load_session_tail,
            buddy::commands::append_buddy_log,
            buddy::commands::append_buddy_chat,
            buddy::commands::load_recent_chat,
            buddy::commands::load_chat_since,
            buddy::commands::load_buddy_profile,
            buddy::commands::save_buddy_profile,
            buddy::commands::set_buddy_enabled,
            buddy::commands::is_buddy_enabled,
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

            // FsWatcher: singleton per app, lives for app lifetime.
            let watcher = Arc::new(fs::FsWatcher::new(app_handle.clone()));
            let _ = state.fs_watcher.set(watcher.clone());

            // Re-watch any pinned roots restored from disk so the explorer
            // reflects external changes as soon as the user opens it.
            if let Ok(data) = db::storage::load(&app_handle) {
                for root in &data.pinned_roots {
                    if let Err(err) = watcher.watch(std::path::PathBuf::from(&root.path)) {
                        eprintln!("[fs_watcher] failed to watch {}: {}", root.path, err);
                    }
                }
            }

            socket::start_socket_listener(app_handle.clone());
            remote::start_remote_server(
                app_handle.clone(),
                state.session_manager.clone(),
                ms,
            );

            buddy::init(&app_handle);

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
