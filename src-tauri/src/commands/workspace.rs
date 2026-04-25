use tauri::AppHandle;

use crate::db::storage::{self, AppSettings, PersistentData, WorkspaceConfig};

#[tauri::command]
pub fn load_persistent_data(app_handle: AppHandle) -> Result<PersistentData, String> {
    storage::load(&app_handle)
}

#[tauri::command]
pub fn save_persistent_data(
    app_handle: AppHandle,
    mut data: PersistentData,
) -> Result<(), String> {
    data.schema_version = 1;
    storage::save(&app_handle, &data)
}

#[tauri::command]
pub fn save_workspaces(
    app_handle: AppHandle,
    workspaces: Vec<WorkspaceConfig>,
    active_workspace_id: Option<String>,
    active_pane_id: Option<String>,
) -> Result<(), String> {
    storage::update(&app_handle, |data| {
        data.schema_version = 1;
        data.workspaces = workspaces;
        data.active_workspace_id = active_workspace_id;
        data.active_pane_id = active_pane_id;
        data.active_tab_id = None;
    })
}

#[tauri::command]
pub fn save_settings(app_handle: AppHandle, settings: AppSettings) -> Result<(), String> {
    storage::update(&app_handle, |data| {
        data.schema_version = 1;
        data.settings = settings;
    })
}

