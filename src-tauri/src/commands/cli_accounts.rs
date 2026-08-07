use tauri::{AppHandle, Manager};

use crate::cli_accounts::{self, CliAccountProfile, CliAccountsSnapshot, CliProvider, CliSwitchResult};

fn app_data_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path().app_data_dir().map_err(|e| format!("Failed to resolve application data directory: {e}"))
}

#[tauri::command(async)]
pub async fn list_cli_accounts(app: AppHandle) -> Result<CliAccountsSnapshot, String> {
    cli_accounts::list_resolved(&app_data_dir(&app)?)
}

#[tauri::command(async)]
pub async fn capture_cli_account(app: AppHandle, provider: CliProvider, label: Option<String>) -> Result<CliAccountProfile, String> {
    cli_accounts::capture_resolved(&app_data_dir(&app)?, provider, label)
}

#[tauri::command(async)]
pub async fn switch_cli_account(app: AppHandle, provider: CliProvider, profile_id: String) -> Result<CliSwitchResult, String> {
    let result = cli_accounts::switch_resolved(&app_data_dir(&app)?, provider, &profile_id);
    if let Err(error) = &result {
        crate::usage::log_oauth_failure(&app, "switch_cli_account", error);
    }
    result
}

#[tauri::command(async)]
pub async fn remove_cli_account(app: AppHandle, profile_id: String) -> Result<(), String> {
    cli_accounts::remove_resolved(&app_data_dir(&app)?, &profile_id)
}

#[tauri::command(async)]
pub async fn rename_cli_account(app: AppHandle, profile_id: String, label: String) -> Result<CliAccountProfile, String> {
    cli_accounts::rename_resolved(&app_data_dir(&app)?, &profile_id, label)
}
