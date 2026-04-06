use std::collections::HashMap;
use tauri::AppHandle;

use crate::db::storage::{self, AppSettings, PersistentData, WorkspaceConfig};

#[tauri::command]
pub fn load_persistent_data(app_handle: AppHandle) -> Result<PersistentData, String> {
    storage::load(&app_handle)
}

#[tauri::command]
pub fn save_workspaces(
    app_handle: AppHandle,
    workspaces: Vec<WorkspaceConfig>,
) -> Result<(), String> {
    let mut data = storage::load(&app_handle).unwrap_or_default();
    data.workspaces = workspaces;
    storage::save(&app_handle, &data)
}

#[tauri::command]
pub fn save_settings(app_handle: AppHandle, settings: AppSettings) -> Result<(), String> {
    let mut data = storage::load(&app_handle).unwrap_or_default();
    data.settings = settings;
    storage::save(&app_handle, &data)
}

/// Write restore manifest so the shell launcher can auto-resume processes.
/// Maps CWD → process name (e.g., "claude", "codex").
#[tauri::command]
pub fn write_restore_manifest(entries: Vec<(String, String)>) -> Result<(), String> {
    let mut path = dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
    path.push(".mycmux");
    std::fs::create_dir_all(&path).map_err(|e| format!("mkdir: {e}"))?;
    path.push("restore.json");

    let map: HashMap<String, String> = entries.into_iter().collect();
    let json = serde_json::to_string_pretty(&map).map_err(|e| format!("json: {e}"))?;
    std::fs::write(&path, json).map_err(|e| format!("write: {e}"))?;
    Ok(())
}
