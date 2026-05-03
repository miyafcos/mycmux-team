use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

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
    #[serde(default)]
    pub agent_kind: Option<String>,
    #[serde(default)]
    pub agent_session_id: Option<String>,
    #[serde(default)]
    pub launch_env: Option<HashMap<String, String>>,
    #[serde(default)]
    pub terminal_snapshot: Option<Vec<String>>,
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
    pub agent_kind: Option<String>,
    #[serde(default)]
    pub agent_session_id: Option<String>,
    #[serde(default)]
    pub launch_env: Option<HashMap<String, String>>,
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

fn default_schema_version() -> u32 {
    1
}

fn default_font_family() -> String {
    "'JetBrainsMono Nerd Font Mono', 'JetBrains Mono', 'Geist Mono', 'SF Mono', 'BIZ UDGothic', 'MS Gothic', monospace".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    pub font_size: u16,
    #[serde(default = "default_font_family")]
    pub font_family: String,
    pub theme_id: String,
    #[serde(default)]
    pub keybindings: HashMap<String, String>,
    /// When true, persistence is triggered by Zustand subscribers + debounce
    /// instead of a fixed interval. Rollback switch for Phase A.
    #[serde(default = "default_true")]
    pub dirty_save_mode: bool,
    /// When true, inject a shell-specific OSC 7 hook so CWD updates flow
    /// instantly from bash/fish (zsh/pwsh fall back to sysinfo). Rollback
    /// switch for Phase B.
    #[serde(default = "default_true")]
    pub osc7_tracking_enabled: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            font_size: 14,
            font_family: default_font_family(),
            theme_id: "yoru-cafe".to_string(),
            keybindings: HashMap::new(),
            dirty_save_mode: true,
            osc7_tracking_enabled: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistentData {
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
    pub workspaces: Vec<WorkspaceConfig>,
    pub settings: AppSettings,
    #[serde(default)]
    pub active_workspace_id: Option<String>,
    #[serde(default)]
    pub active_pane_id: Option<String>,
    #[serde(default)]
    pub active_tab_id: Option<String>,
}

impl Default for PersistentData {
    fn default() -> Self {
        Self {
            schema_version: 1,
            workspaces: Vec::new(),
            settings: AppSettings::default(),
            active_workspace_id: None,
            active_pane_id: None,
            active_tab_id: None,
        }
    }
}

fn save_lock() -> &'static Mutex<()> {
    static SAVE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    SAVE_LOCK.get_or_init(|| Mutex::new(()))
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

fn backup_path_for(path: &Path, reason: &str) -> PathBuf {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("data.json");

    path.with_file_name(format!(
        "{file_name}.{reason}-{timestamp}-{}.bak",
        std::process::id()
    ))
}

fn quarantine_data_file(path: &Path, reason: &str) -> Result<PathBuf, String> {
    let backup_path = backup_path_for(path, reason);
    fs::rename(path, &backup_path).map_err(|error| {
        format!(
            "Failed to quarantine {} to {}: {error}",
            path.display(),
            backup_path.display()
        )
    })?;
    Ok(backup_path)
}

fn load_from_path(path: &Path) -> Result<PersistentData, String> {
    if !path.exists() {
        return Ok(PersistentData::default());
    }

    let mut contents = String::new();
    File::open(path)
        .map_err(|error| format!("Failed to open {}: {error}", path.display()))?
        .read_to_string(&mut contents)
        .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;

    if contents.trim().is_empty() {
        let _backup_path = quarantine_data_file(path, "empty")?;
        return Ok(PersistentData::default());
    }

    match serde_json::from_str::<PersistentData>(&contents) {
        Ok(data) => Ok(data),
        Err(_error) => {
            let _backup_path = quarantine_data_file(path, "corrupt")?;
            Ok(PersistentData::default())
        }
    }
}

fn write_json_file(path: &Path, json: &str) -> Result<(), String> {
    let mut file = File::create(path)
        .map_err(|error| format!("Failed to create {}: {error}", path.display()))?;
    file.write_all(json.as_bytes())
        .map_err(|error| format!("Failed to write {}: {error}", path.display()))?;
    file.sync_all()
        .map_err(|error| format!("Failed to flush {}: {error}", path.display()))
}

fn replace_data_file(path: &Path, tmp_path: &Path) -> Result<(), String> {
    if !path.exists() {
        return fs::rename(tmp_path, path).map_err(|error| {
            format!(
                "Failed to move {} to {}: {error}",
                tmp_path.display(),
                path.display()
            )
        });
    }

    let backup_path = backup_path_for(path, "pre-replace");
    fs::rename(path, &backup_path).map_err(|error| {
        format!(
            "Failed to backup {} to {}: {error}",
            path.display(),
            backup_path.display()
        )
    })?;

    match fs::rename(tmp_path, path) {
        Ok(()) => {
            let _ = fs::remove_file(&backup_path);
            Ok(())
        }
        Err(error) => {
            let _ = fs::rename(&backup_path, path);
            Err(format!(
                "Failed to replace {} with {}: {error}",
                path.display(),
                tmp_path.display()
            ))
        }
    }
}

fn save_to_path(path: &Path, data: &PersistentData) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
    }

    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("data.json");
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let tmp_path = path.with_file_name(format!(
        "{file_name}.tmp-{}-{timestamp}",
        std::process::id()
    ));
    let json = serde_json::to_string_pretty(data)
        .map_err(|error| format!("Failed to serialize data: {error}"))?;

    write_json_file(&tmp_path, &json)?;
    replace_data_file(path, &tmp_path).inspect_err(|_| {
        let _ = fs::remove_file(&tmp_path);
    })
}

pub fn load(app_handle: &tauri::AppHandle) -> Result<PersistentData, String> {
    let path = data_path(app_handle)?;
    load_from_path(&path)
}

pub fn save(app_handle: &tauri::AppHandle, data: &PersistentData) -> Result<(), String> {
    let _guard = save_lock()
        .lock()
        .map_err(|e| format!("Failed to lock data file: {e}"))?;
    save_unlocked(app_handle, data)
}

pub fn update<F>(app_handle: &tauri::AppHandle, updater: F) -> Result<(), String>
where
    F: FnOnce(&mut PersistentData),
{
    let _guard = save_lock()
        .lock()
        .map_err(|e| format!("Failed to lock data file: {e}"))?;
    let mut data = load(app_handle)?;
    updater(&mut data);
    save_unlocked(app_handle, &data)
}

fn save_unlocked(app_handle: &tauri::AppHandle, data: &PersistentData) -> Result<(), String> {
    let path = data_path(app_handle)?;
    save_to_path(&path, data)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn load_from_path_corrupt_json_quarantines_file_and_returns_default() {
        let temp_dir = tempfile::tempdir().unwrap();
        let path = temp_dir.path().join("data.json");
        fs::write(&path, "{not valid json").unwrap();

        let data = load_from_path(&path).unwrap();

        assert!(data.workspaces.is_empty());
        assert!(!path.exists());
        assert!(fs::read_dir(temp_dir.path()).unwrap().any(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains("corrupt")
        }));
    }

    #[test]
    fn load_from_path_empty_file_quarantines_file_and_returns_default() {
        let temp_dir = tempfile::tempdir().unwrap();
        let path = temp_dir.path().join("data.json");
        fs::write(&path, "   ").unwrap();

        let data = load_from_path(&path).unwrap();

        assert!(data.workspaces.is_empty());
        assert!(!path.exists());
        assert!(fs::read_dir(temp_dir.path()).unwrap().any(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains("empty")
        }));
    }

    #[test]
    fn save_to_path_replaces_existing_json() {
        let temp_dir = tempfile::tempdir().unwrap();
        let path = temp_dir.path().join("data.json");
        fs::write(&path, r#"{"active_workspace_id":"old"}"#).unwrap();
        let data = PersistentData {
            active_workspace_id: Some("next".to_string()),
            ..Default::default()
        };

        save_to_path(&path, &data).unwrap();
        let loaded = load_from_path(&path).unwrap();

        assert_eq!(loaded.active_workspace_id.as_deref(), Some("next"));
    }

    #[test]
    fn pane_launch_env_round_trips() {
        let pane: PaneConfig = serde_json::from_str(
            r#"{"agent_id":"shell-starter","label":null,"cwd":null,"launch_env":{"MYCMUX_RESUME":"codex"}}"#,
        )
        .unwrap();

        assert_eq!(
            pane.launch_env
                .as_ref()
                .and_then(|launch_env| launch_env.get("MYCMUX_RESUME"))
                .map(String::as_str),
            Some("codex")
        );
    }
}
