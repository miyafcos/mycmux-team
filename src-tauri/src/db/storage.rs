use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaneTabConfig {
    #[serde(default)]
    pub tab_id: Option<String>,
    pub agent_id: String,
    pub label: Option<String>,
    #[serde(default)]
    pub r#type: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub last_process: Option<String>,
    #[serde(default)]
    pub claude_session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaneConfig {
    #[serde(default)]
    pub pane_id: Option<String>,
    pub agent_id: String,
    pub label: Option<String>,
    pub cwd: Option<String>,
    #[serde(default)]
    pub last_process: Option<String>,
    #[serde(default)]
    pub claude_session_id: Option<String>,
    #[serde(default)]
    pub active_tab_id: Option<String>,
    #[serde(default)]
    pub tabs: Option<Vec<PaneTabConfig>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceConfig {
    pub id: String,
    pub name: String,
    pub grid_template_id: String,
    pub panes: Vec<PaneConfig>,
    pub created_at: u64,
    #[serde(default)]
    pub color: Option<String>,
    // Legacy row-first fields (kept for deserialization of old data)
    #[serde(default)]
    pub split_rows: Option<Vec<Vec<usize>>>,
    #[serde(default)]
    pub row_sizes: Option<Vec<f64>>,
    #[serde(default)]
    pub column_sizes: Option<Vec<Vec<f64>>>,
    // New column-first layout fields
    #[serde(default)]
    pub split_columns: Option<Vec<Vec<usize>>>,
    #[serde(default)]
    pub column_widths: Option<Vec<f64>>,
    #[serde(default)]
    pub row_heights_per_col: Option<Vec<Vec<f64>>>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    pub font_size: u16,
    pub theme_id: String,
    #[serde(default)]
    pub keybindings: HashMap<String, String>,
    /// When true, persistence is triggered by Zustand subscribers + debounce
    /// instead of a fixed interval. Rollback switch for Phase A.
    #[serde(default = "default_true")]
    pub dirty_save_mode: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            font_size: 14,
            theme_id: "yoru-cafe".to_string(),
            keybindings: HashMap::new(),
            dirty_save_mode: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistentData {
    pub workspaces: Vec<WorkspaceConfig>,
    pub settings: AppSettings,
    #[serde(default)]
    pub active_workspace_id: Option<String>,
    #[serde(default)]
    pub active_pane_id: Option<String>,
}

impl Default for PersistentData {
    fn default() -> Self {
        Self {
            workspaces: Vec::new(),
            settings: AppSettings::default(),
            active_workspace_id: None,
            active_pane_id: None,
        }
    }
}

fn data_path(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create app data dir: {e}"))?;
    Ok(dir.join("data.json"))
}

pub fn load(app_handle: &tauri::AppHandle) -> Result<PersistentData, String> {
    let path = data_path(app_handle)?;
    if !path.exists() {
        return Ok(PersistentData::default());
    }
    let contents =
        fs::read_to_string(&path).map_err(|e| format!("Failed to read data file: {e}"))?;
    serde_json::from_str(&contents).map_err(|e| format!("Failed to parse data file: {e}"))
}

pub fn save(app_handle: &tauri::AppHandle, data: &PersistentData) -> Result<(), String> {
    let path = data_path(app_handle)?;
    let tmp_path = path.with_extension("json.tmp");
    let json =
        serde_json::to_string_pretty(data).map_err(|e| format!("Failed to serialize data: {e}"))?;
    fs::write(&tmp_path, &json).map_err(|e| format!("Failed to write temp data file: {e}"))?;
    fs::rename(&tmp_path, &path).map_err(|e| format!("Failed to rename data file: {e}"))
}
