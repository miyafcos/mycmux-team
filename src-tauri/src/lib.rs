mod commands;
mod db;
mod events;
mod fs;
mod pty;
mod remote;
mod session_retention;
mod socket;
pub mod terminal_config;
mod usage;

use pty::manager::SessionManager;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, OnceLock};

#[cfg(target_os = "windows")]
mod single_instance {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE};
    use windows::Win32::System::Threading::CreateMutexW;

    pub struct InstanceGuard(HANDLE);

    impl Drop for InstanceGuard {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }

    pub fn acquire() -> Result<Option<InstanceGuard>, String> {
        let name = format!("Local\\miyazaki-{}-single-instance", env!("CARGO_PKG_NAME"));
        let wide_name: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
        let handle = unsafe { CreateMutexW(None, true, PCWSTR(wide_name.as_ptr())) }
            .map_err(|error| format!("Failed to create single-instance mutex: {error}"))?;
        if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
            unsafe {
                let _ = CloseHandle(handle);
            }
            return Ok(None);
        }
        Ok(Some(InstanceGuard(handle)))
    }
}

#[cfg(not(target_os = "windows"))]
mod single_instance {
    pub struct InstanceGuard;

    pub fn acquire() -> Result<Option<InstanceGuard>, String> {
        Ok(Some(InstanceGuard))
    }
}

pub struct AppState {
    pub session_manager: Arc<SessionManager>,
    pub bootstrapped: AtomicBool,
    pub metadata_store: pty::monitor::MetadataStore,
    pub fs_watcher: OnceLock<Arc<fs::FsWatcher>>,
}

fn install_launcher_script() -> Result<(), String> {
    let home = dirs::home_dir().ok_or_else(|| "Failed to resolve home directory".to_string())?;
    let bin_dir = home.join(".mycmux").join("bin");
    std::fs::create_dir_all(&bin_dir)
        .map_err(|e| format!("Failed to create launcher directory: {e}"))?;

    let target = bin_dir.join("launcher.sh");
    let contents = include_str!("launcher.sh").replace("\r\n", "\n");
    let needs_write = std::fs::read_to_string(&target)
        .map(|current| current.replace("\r\n", "\n") != contents)
        .unwrap_or(true);

    if needs_write {
        if !bin_dir.join("launcher.local.sh").exists() {
            eprintln!(
                "mycmux launcher.sh is managed by the app and manual edits will be overwritten. Put customizations in ~/.mycmux/bin/launcher.local.sh instead."
            );
        }
        std::fs::write(&target, contents)
            .map_err(|e| format!("Failed to write launcher script: {e}"))?;
    }

    let target = bin_dir.join("launcher.ps1");
    let contents = include_str!("launcher.ps1").replace("\r\n", "\n");
    let needs_write = std::fs::read_to_string(&target)
        .map(|current| current.replace("\r\n", "\n") != contents)
        .unwrap_or(true);

    if needs_write {
        std::fs::write(&target, contents)
            .map_err(|e| format!("Failed to write PowerShell launcher script: {e}"))?;
    }

    Ok(())
}

/// R-2: runtime safety net for the v0.9.1 dual-install incident, where an
/// NSIS build got absorbed into an MSI install and landed per-machine in
/// `%ProgramFiles%`, silently orphaning the running per-user
/// (`%LOCALAPPDATA%`) copy from auto-updates. The feed/build side was fixed
/// separately; this only detects the symptom at startup and warns without
/// blocking launch. Uses only `std::env::var` and the already-vendored
/// `dirs` crate (no new dependency).
fn warn_if_dual_install(app_handle: &tauri::AppHandle) {
    #[cfg(target_os = "windows")]
    {
        use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

        let Ok(program_files) = std::env::var("ProgramFiles") else {
            return;
        };
        let Some(local_app_data) = dirs::data_local_dir() else {
            return;
        };

        let per_machine = std::path::PathBuf::from(program_files)
            .join("mycmux")
            .join("mycmux.exe");
        let per_user = local_app_data.join("mycmux").join("mycmux.exe");

        if !per_machine.is_file() || !per_user.is_file() {
            return;
        }

        eprintln!(
            "[dual-install] detected per-machine ({}) and per-user ({}) installs",
            per_machine.display(),
            per_user.display()
        );

        // Non-blocking: `show` returns immediately and invokes the callback
        // asynchronously once the user dismisses the dialog, so startup is
        // never held up waiting for it.
        app_handle
            .dialog()
            .message(
                "Two installations of mycmux were detected: one per-machine \
                 (in Program Files) and one per-user (in AppData). The \
                 per-machine copy can prevent auto-updates from reaching the \
                 running app. Uninstall the Program Files copy via Windows \
                 Settings > Apps.",
            )
            .title("mycmux: duplicate installation detected")
            .kind(MessageDialogKind::Warning)
            .show(|_| {});
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app_handle;
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    std::panic::set_hook(Box::new(|info| {
        eprintln!("[mycmux][panic] {info}");
    }));

    let _single_instance_guard = match single_instance::acquire() {
        Ok(Some(guard)) => Some(guard),
        Ok(None) => return,
        Err(error) => {
            eprintln!("[mycmux] {error}");
            return;
        }
    };

    // Strip ephemeral env vars inherited from the parent shell so they do not
    // leak into spawned PTY child processes (would auto-resume sessions).
    for key in [
        "MYCMUX_RESUME",
        "MYCMUX_SESSION_ID",
        "MYCMUX_AGENT_KIND",
        "MYCMUX_HANDOFF",
        "MYCMUX_HANDOFF_FROM",
        "MYCMUX_HANDOFF_PROMPT_FILE",
        "MYCMUX_HANDOFF_FROM_SESSION",
        "MYCMUX_PANE_SESSION_ID",
        "MYCMUX_TAB_ID",
        "MYCMUX_HTML_OUT",
        "MYCMUX_MARKDOWN_OUT",
        "MYCMUX_ARTIFACTS_DIR",
        "__CMUX_LAUNCHER_DONE",
    ] {
        std::env::remove_var(key);
    }

    let metadata_store = pty::monitor::new_metadata_store();
    let remote_control = Arc::new(remote::RemoteControl::new());
    let remote_sessions = Arc::new(remote::session::RemoteSessionManager::new());

    let state = AppState {
        session_manager: Arc::new(SessionManager::new()),
        bootstrapped: AtomicBool::new(false),
        metadata_store: metadata_store.clone(),
        fs_watcher: OnceLock::new(),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        & !tauri_plugin_window_state::StateFlags::VISIBLE,
                )
                .build(),
        )
        .manage(state)
        .manage(socket::SocketState {
            pending_requests: Arc::new(dashmap::DashMap::new()),
            next_id: std::sync::atomic::AtomicUsize::new(1),
        })
        .manage(remote_control)
        .manage(remote_sessions)
        .invoke_handler(tauri::generate_handler![
            commands::terminal::create_session,
            commands::terminal::write_to_session,
            commands::terminal::resize_session,
            commands::terminal::ack_frontend_data,
            commands::terminal::set_frontend_visible,
            commands::terminal::get_session_scrollback,
            commands::terminal::kill_session,
            commands::artifact::preview_artifact_for_session,
            commands::artifact::preview_artifact_uri_for_session,
            commands::artifact::preview_artifact_uri_for_session_v2,
            commands::artifact::read_editable_artifact,
            commands::artifact::save_editable_artifact,
            commands::terminal::get_terminal_config,
            commands::terminal::get_pty_metadata_snapshot,
            commands::terminal::is_directory,
            commands::terminal::get_launch_cwd,
            commands::shell::get_default_shell,
            commands::session_mapping::read_agent_session_mappings,
            commands::crsm::crsm_list_sessions,
            commands::crsm::crsm_create_handoff,
            commands::workspace::load_persistent_data,
            commands::workspace::save_persistent_data,
            commands::workspace::save_workspaces,
            commands::workspace::save_settings,
            commands::fs::list_directory,
            commands::fs::walk_tree,
            commands::fs::normalize_path,
            commands::fs::resolve_local_path_links,
            commands::fs::save_pinned_roots,
            commands::fs::watch_root,
            commands::fs::unwatch_root,
            commands::fs::reveal_in_explorer,
            commands::fs::reveal_path_in_explorer,
            commands::fs::open_with_default,
            commands::fs::create_file,
            commands::fs::create_folder,
            commands::window::claim_leader,
            commands::window::get_window_count,
            commands::window::reveal_main_window,
            commands::window::quit_app,
            commands::usage::get_usage_summary,
            remote::get_remote_info,
            remote::rotate_remote_token,
            remote::get_remote_bind_all,
            remote::set_remote_bind_all,
            socket::socket_response,
        ])
        .setup(|#[allow(unused)] app| {
            use tauri::Manager;

            let app_handle = app.handle().clone();
            let state = app.state::<AppState>();
            #[cfg(target_os = "windows")]
            crate::pty::windows_console::start_startup_flash_suppression(std::process::id());
            if let Err(err) = install_launcher_script() {
                eprintln!("[launcher] failed to install launcher scripts: {err}");
            }
            warn_if_dual_install(&app_handle);
            let app_data_parent = app_handle
                .path()
                .app_data_dir()
                .ok()
                .and_then(|path| path.parent().map(std::path::Path::to_path_buf));
            let mycmux_dir = dirs::home_dir().map(|home| home.join(".mycmux"));
            session_retention::run_startup_retention(app_data_parent, mycmux_dir);
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
            let remote_control = app.state::<Arc<remote::RemoteControl>>().inner().clone();
            let remote_sessions = app
                .state::<Arc<remote::session::RemoteSessionManager>>()
                .inner()
                .clone();
            // S-2: read the persisted LAN-bind preference once at startup;
            // changes to this setting take effect on next launch (see
            // remote::set_remote_bind_all).
            let remote_bind_all = db::storage::load(&app_handle)
                .map(|data| data.settings.remote_bind_all)
                .unwrap_or(false);
            remote::start_remote_server(
                app_handle.clone(),
                state.session_manager.clone(),
                ms,
                remote_control,
                remote_sessions.clone(),
                remote_bind_all,
            );

            // Kill all PTY sessions when the main window closes
            let mgr = state.session_manager.clone();
            if let Some(main_window) = app.get_webview_window("main") {
                if let Some(icon) = app.default_window_icon().cloned() {
                    let _ = main_window.set_icon(icon);
                }

                // macOS: tao 0.34.x has an idle-CPU pathology with `decorations: false`
                // where every is_zoomed() call triggers NSWindow setStyleMask: → full
                // NSThemeFrame relayout (sample profiling shows 100% main-thread CPU).
                // Force native decorations on macOS to bypass it; the visual cost is a
                // standard title bar but the perf win is decisive.
                // Also force-show the window because the frontend reveal flow does not
                // currently fire on macOS (under investigation separately).
                #[cfg(target_os = "macos")]
                {
                    let _ = main_window.set_decorations(true);
                    let _ = main_window.show();
                }

                let remote_sessions_for_close = remote_sessions.clone();
                main_window.on_window_event(move |event| {
                    if let tauri::WindowEvent::Destroyed = event {
                        mgr.kill_all();
                        remote_sessions_for_close.kill_all();
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
