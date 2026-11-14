use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use crate::ipc_caller::TrustedAppCaller;
use super::{destination_status, save_destination, remove_destination, prepare_submission, deliver,
    DailyCounter, DestinationStatus, FeedbackError, FeedbackMetadata, FeedbackRequest};
use super::destination_store::OsSecretStore;
use super::transport::HttpSlackTransport;

// Serialize settings changes and submissions, including the persisted per-device daily reservation.
static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
fn directory(app: &AppHandle) -> Result<PathBuf, FeedbackError> {
    app.path().app_data_dir().map(crate::test_profile::app_data_dir_from).map_err(|_| FeedbackError::Storage)
}
fn public_error(error: FeedbackError) -> String { error.message().to_string() }
async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, FeedbackError> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|_| public_error(FeedbackError::Storage))?.map_err(public_error)
}
#[tauri::command]
pub async fn feedback_status(_trusted: TrustedAppCaller, app: AppHandle) -> Result<DestinationStatus, String> {
    let _guard = LOCK.lock().await;
    let base = directory(&app).map_err(public_error)?;
    blocking(move || destination_status(&OsSecretStore::new(base))).await
}
#[tauri::command]
pub async fn feedback_save_destination(_trusted: TrustedAppCaller, app: AppHandle, token: String, destination: String)
    -> Result<DestinationStatus, String>
{
    let _guard = LOCK.lock().await;
    let base = directory(&app).map_err(public_error)?;
    blocking(move || save_destination(&OsSecretStore::new(base), &token, &destination)).await
}
#[tauri::command]
pub async fn feedback_remove_destination(_trusted: TrustedAppCaller, app: AppHandle) -> Result<DestinationStatus, String> {
    let _guard = LOCK.lock().await;
    let base = directory(&app).map_err(public_error)?;
    blocking(move || remove_destination(&OsSecretStore::new(base))).await
}
#[tauri::command]
pub async fn feedback_capture_main(_trusted: TrustedAppCaller, app: AppHandle, webview: tauri::Webview) -> Result<String, String> {
    #[cfg(windows)]
    { super::capture_windows::capture(&app, webview.label()).await }
    #[cfg(target_os = "macos")]
    { super::capture_macos::capture(&app, webview.label()).await }
    #[cfg(not(any(windows, target_os = "macos")))]
    { let _ = (app, webview); Err("この OS では撮れません".into()) }
}
#[tauri::command]
pub async fn feedback_send(_trusted: TrustedAppCaller, app: AppHandle, request: FeedbackRequest) -> Result<(), String> {
    let _guard = LOCK.lock().await;
    let base = directory(&app).map_err(public_error)?;
    let version = app.package_info().version.to_string();
    let submission = blocking(move || {
        let now = chrono::Local::now();
        let os = if cfg!(windows) { "Windows" } else if cfg!(target_os = "macos") { "macOS" } else { std::env::consts::OS };
        let metadata = FeedbackMetadata { version,
            os: format!("{os} {}", sysinfo::System::os_version().unwrap_or_default()),
            sent_at: now.format("%Y-%m-%d %H:%M").to_string() };
        prepare_submission(&OsSecretStore::new(base.clone()), &DailyCounter::new(&base),
            &now.format("%Y-%m-%d").to_string(), &request, &metadata)
    }).await?;
    let transport = HttpSlackTransport::new().map_err(public_error)?;
    deliver(&transport, submission).await.map_err(public_error)
}
