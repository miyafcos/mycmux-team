pub mod ailog;
mod cli_accounts;
mod commands;
mod db;
mod diag;
mod events;
mod pty;
mod remote;
mod session_retention;
mod session_state;
mod socket;
mod status_feed;
pub mod terminal_config;
pub mod usage;
mod util;
pub mod window_registry;

use pty::manager::SessionManager;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

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
    pub session_state_store: session_state::SessionStateStore,
    pub status_feed: status_feed::StatusFeed,
    pub bootstrapped: AtomicBool,
    pub metadata_store: pty::monitor::MetadataStore,
    /// Multi-window (Phase 3b): who owns which workspace, plus each window's
    /// last published workspace list. In-memory only — on restart every
    /// workspace collapses back into main via `data.json` (window layout
    /// persistence is Phase 3d).
    pub window_registry: window_registry::WindowRegistry,
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

        crate::diag_warn!(
            "dual-install",
            "detected per-machine ({}) and per-user ({}) installs",
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
        // Release builds have no console, so the stderr line above goes nowhere.
        // Mirror payload + location into ~/.mycmux/diag.log. Everything below is
        // infallible by construction: a panic inside the hook would abort.
        let location = info.location().map(|location| {
            format!(
                "{}:{}:{}",
                location.file(),
                location.line(),
                location.column()
            )
        });
        let report = diag::format_panic_report(
            &diag::panic_payload_text(info.payload()),
            location.as_deref(),
        );
        diag::log_panic(&report);
    }));

    let _single_instance_guard = match single_instance::acquire() {
        Ok(Some(guard)) => Some(guard),
        Ok(None) => return,
        Err(error) => {
            crate::diag_warn!("mycmux", "{error}");
            return;
        }
    };

    // Strip ephemeral env vars inherited from the parent shell so they do not
    // leak into spawned PTY child processes (would auto-resume sessions).
    for key in [
        "MYCMUX_RESUME",
        "MYCMUX_SESSION_ID",
        "MYCMUX_AGENT_KIND",
        "MYCMUX_RESUME_FORK",
        "MYCMUX_LAUNCH_TARGET",
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

    let session_state_store = session_state::SessionStateStore::new();
    let status_feed = status_feed::StatusFeed::new(session_state_store.clone());
    session_state_store.set_change_listener(status_feed.change_listener());
    let state = AppState {
        session_manager: Arc::new(SessionManager::new()),
        session_state_store,
        status_feed,
        bootstrapped: AtomicBool::new(false),
        metadata_store: metadata_store.clone(),
        window_registry: window_registry::WindowRegistry::new(),
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
        .manage(usage::UsageState::new())
        .manage(cli_accounts::login_watch::LoginRegistry::default())
        .invoke_handler(tauri::generate_handler![
            commands::terminal::create_session,
            commands::terminal::write_to_session,
            commands::terminal::is_session_alive,
            commands::terminal::resize_session,
            commands::terminal::ack_frontend_data,
            commands::terminal::set_frontend_visible,
            commands::terminal::get_session_scrollback,
            commands::terminal::kill_session,
            commands::artifact::preview_artifact_uri_for_session_v2,
            commands::artifact::read_editable_artifact,
            commands::artifact::save_editable_artifact,
            commands::terminal::get_terminal_config,
            commands::terminal::get_pty_metadata_snapshot,
            commands::terminal::get_session_output_snapshot,
            commands::terminal::is_directory,
            commands::terminal::get_launch_cwd,
            commands::online::list_online_savepoints,
            commands::online::list_trashed_online_savepoints,
            commands::online::get_savepoint_storage_settings,
            commands::online::join_savepoint_summary,
            commands::online::join_savepoint_full,
            commands::online::toggle_savepoint_pin,
            commands::online::delete_online_savepoint,
            commands::online::restore_online_savepoint,
            commands::online::purge_online_savepoint,
            commands::online::cleanup_online_savepoints,
            commands::online::transfer::export_savepoint_transfer,
            commands::online::transfer::import_savepoint_transfer,
            commands::online_publish::publish_savepoint,
            commands::online_publish::finalize_savepoint,
            commands::shell::get_default_shell,
            commands::tab_sweep::run_tab_sweep_judge,
            commands::tab_sweep::abort_tab_sweep_judge,
            commands::session_mapping::read_agent_session_mappings,
            commands::crsm::crsm_list_sessions,
            commands::crsm::crsm_create_handoff,
            commands::workspace::load_persistent_data,
            commands::workspace::save_persistent_data,
            commands::pets::list_pets,
            commands::pet_gallery::fetch_pet_gallery,
            commands::pet_gallery::fetch_pet_preview,
            commands::pet_gallery::install_pet_from_gallery,
            commands::pet_gallery::quarantine_pet,
            commands::pet_gallery::restore_pet,
            commands::pet_gallery::list_quarantined_pets,
            commands::fs::resolve_local_path_links,
            commands::fs::reveal_in_explorer,
            commands::fs::reveal_path_in_explorer,
            commands::fs::open_with_default,
            commands::window::claim_leader,
            commands::window::reveal_main_window,
            commands::window::open_child_window,
            commands::window::quit_app,
            commands::window_registry::open_workspace_window,
            commands::window_registry::publish_window_fragment,
            commands::window_registry::take_pending_adoption,
            commands::window_registry::release_workspaces,
            commands::window_registry::get_window_fragments,
            commands::window_registry::get_app_settings,
            commands::usage::get_account_usage,
            commands::ailog::ailog_index_start,
            commands::ailog::ailog_index_cancel,
            commands::ailog::ailog_index_status,
            commands::ailog::ailog_summarize_start,
            commands::ailog::ailog_summarize_cancel,
            commands::ailog::ailog_summarize_status,
            commands::ailog::ailog_overview,
            commands::ailog::ailog_series,
            commands::ailog::ailog_breakdown,
            commands::ailog::ailog_sessions,
            commands::ailog::ailog_session_detail,
            commands::ailog::ailog_models,
            commands::ailog::ailog_efficiency,
            commands::ailog::ailog_get_prices,
            commands::ailog::ailog_set_price,
            commands::cli_accounts::list_cli_accounts,
            commands::cli_accounts::capture_cli_account,
            commands::cli_accounts::switch_cli_account,
            commands::cli_accounts::remove_cli_account,
            commands::cli_accounts::rename_cli_account,
            commands::cli_accounts::begin_cli_login,
            commands::cli_accounts::cancel_cli_login,
            commands::cli_accounts::list_cli_login_sessions,
            cli_accounts::resolve_cli_account_orphan,
            remote::get_remote_info,
            remote::rotate_remote_token,
            remote::get_remote_bind_all,
            remote::set_remote_bind_all,
            status_feed::get_session_status_snapshot,
            socket::socket_response,
        ])
        .setup(|#[allow(unused)] app| {
            use tauri::Manager;

            let app_handle = app.handle().clone();
            let state = app.state::<AppState>();
            state.status_feed.set_app_handle(app_handle.clone());
            if let Err(err) = install_launcher_script() {
                crate::diag_warn!("launcher", "failed to install launcher scripts: {err}");
            }
            warn_if_dual_install(&app_handle);
            if let Ok(app_data) = app_handle.path().app_data_dir() {
                usage::legacy::retire_legacy_usage_oauth(&app_handle, &app_data);
            }
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
                state.session_state_store.clone(),
            );
            session_state::register_frontend_listener(
                &app_handle,
                state.session_state_store.clone(),
            );

            // Token rotation invalidates a stored CLI snapshot the moment the
            // provider hands the live CLI a new refresh token, so the snapshot
            // of whichever account is logged in has to follow the live file.
            if let Ok(accounts_base) = app_handle.path().app_data_dir() {
                match cli_accounts::rescue_rejected_snapshots(&accounts_base) {
                    Ok(restored) if !restored.is_empty() => crate::diag::log(&format!(
                        "[cli_accounts] restored {} previously rejected account snapshot(s)",
                        restored.len()
                    )),
                    Ok(_) => {}
                    Err(error) => crate::diag_warn!(
                        "cli_accounts",
                        "failed to rescue rejected account snapshots at startup: {error}"
                    ),
                }
                // An abandoned isolated login leaves its staging directory
                // behind (the CLI can still hold a handle when we try to clean
                // up), so the next launch is the reliable place to reclaim it.
                cli_accounts::staging::sweep_stale_staging(
                    &accounts_base,
                    std::time::Duration::from_secs(86_400),
                );
                cli_accounts::live_sync::start_live_sync(accounts_base);
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

                // macOS: the window is created decorated with `titleBarStyle: Overlay`
                // + `hiddenTitle` (tauri.macos.conf.json), so the native traffic lights
                // float over the in-app title bar instead of adding a second bar.
                // Keeping decorations on also avoids the tao 0.34.x idle-CPU pathology
                // where is_zoomed() on an undecorated window triggers NSWindow
                // setStyleMask: → full NSThemeFrame relayout (100% main-thread CPU).
                // Do NOT call set_decorations here — re-applying the style mask would
                // clobber the overlay/full-size-content flags set at creation.
                // Force-show the window because the frontend reveal flow does not
                // currently fire on macOS (under investigation separately).
                #[cfg(target_os = "macos")]
                {
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
