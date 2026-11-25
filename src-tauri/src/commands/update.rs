use crate::{ipc_caller::TrustedAppCaller, AppState};
use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_updater::UpdaterExt;
use tokio::sync::Mutex;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingRestart {
    version: String,
    current_version: String,
}

// Native ownership spans installation and recording its result. A WebView
// disappearing after this task starts cannot strand a reservation.
static PENDING_RESTART: Mutex<Option<PendingRestart>> = Mutex::const_new(None);

async fn install_update(app: AppHandle, version: String) -> Result<PendingRestart, String> {
    let mut pending = PENDING_RESTART.lock().await;
    if let Some(installed) = pending.as_ref() {
        return Ok(installed.clone());
    }
    let updater = app.updater().map_err(|_| "update_unavailable")?;
    let update = updater.check().await.map_err(|_| "update_check_failed")?
        .filter(|update| update.version.to_string() == version)
        .ok_or("update_version_changed")?;
    update.download_and_install(|_, _| {}, || {}).await.map_err(|_| "update_install_failed")?;
    let installed = PendingRestart { version, current_version: app.package_info().version.to_string() };
    *pending = Some(installed.clone());
    Ok(installed)
}

#[tauri::command]
pub async fn update_restart_pending(
    _trusted: TrustedAppCaller,
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    install_version: Option<String>,
) -> Result<Option<PendingRestart>, String> {
    if crate::test_profile::is_active() {
        return Err("update unavailable in a test profile".into());
    }
    let Some(version) = install_version else {
        return Ok(PENDING_RESTART.lock().await.clone());
    };
    if state.window_registry.leader().as_deref() != Some(window.label()) {
        return Err("update_unavailable".into());
    }
    tauri::async_runtime::spawn(install_update(app, version)).await
        .map_err(|_| "update_install_failed")?.map(Some)
}
