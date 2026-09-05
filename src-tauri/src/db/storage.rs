use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(target_os = "windows")]
mod interprocess_data_lock {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{
        CloseHandle, HANDLE, WAIT_ABANDONED, WAIT_OBJECT_0, WAIT_TIMEOUT,
    };
    use windows::Win32::System::Threading::{CreateMutexW, ReleaseMutex, WaitForSingleObject};

    const LOCK_TIMEOUT_MS: u32 = 30_000;

    pub struct DataLockGuard(HANDLE);

    impl Drop for DataLockGuard {
        fn drop(&mut self) {
            unsafe {
                let _ = ReleaseMutex(self.0);
                let _ = CloseHandle(self.0);
            }
        }
    }

    pub(super) fn mutex_name() -> String {
        #[cfg(test)]
        {
            return format!(
                "Local\\miyazaki-{}-data-json-test-{}",
                env!("CARGO_PKG_NAME"),
                std::process::id()
            );
        }
        #[cfg(not(test))]
        format!("Local\\miyazaki-{}-data-json", env!("CARGO_PKG_NAME"))
    }

    pub fn acquire() -> Result<DataLockGuard, String> {
        let name = mutex_name();
        let wide_name: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
        let handle = unsafe { CreateMutexW(None, false, PCWSTR(wide_name.as_ptr())) }
            .map_err(|error| format!("Failed to create data-file mutex: {error}"))?;
        let wait_result = unsafe { WaitForSingleObject(handle, LOCK_TIMEOUT_MS) };

        if wait_result == WAIT_OBJECT_0 || wait_result == WAIT_ABANDONED {
            return Ok(DataLockGuard(handle));
        }

        unsafe {
            let _ = CloseHandle(handle);
        }

        if wait_result == WAIT_TIMEOUT {
            Err("Timed out waiting for data-file mutex".to_string())
        } else {
            Err(format!(
                "Unexpected data-file mutex wait result: {wait_result:?}"
            ))
        }
    }
}

#[cfg(unix)]
mod interprocess_data_lock {
    use std::fs::{self, File, OpenOptions};
    use std::os::fd::AsRawFd;
    use std::path::{Path, PathBuf};
    use std::thread;
    use std::time::{Duration, Instant};

    const LOCK_TIMEOUT: Duration = Duration::from_secs(30);
    const LOCK_RETRY_INTERVAL: Duration = Duration::from_millis(50);

    pub struct DataLockGuard(File);

    impl Drop for DataLockGuard {
        fn drop(&mut self) {
            unsafe {
                libc::flock(self.0.as_raw_fd(), libc::LOCK_UN);
            }
        }
    }

    fn lock_path(runtime_dir: &Path) -> PathBuf {
        runtime_dir.join("data.json.lock")
    }

    fn acquire_at(runtime_dir: &Path) -> Result<DataLockGuard, String> {
        fs::create_dir_all(runtime_dir)
            .map_err(|error| format!("Failed to create data-file lock directory: {error}"))?;
        // Nothing is ever written into this file — it exists only to carry
        // the flock — so truncation is irrelevant. Say so, rather than leave
        // the behaviour to the default.
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(lock_path(runtime_dir))
            .map_err(|error| format!("Failed to open data-file lock: {error}"))?;
        let started = Instant::now();

        loop {
            let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
            if result == 0 {
                return Ok(DataLockGuard(file));
            }
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::EWOULDBLOCK)
                && error.raw_os_error() != Some(libc::EAGAIN)
            {
                return Err(format!("Failed to acquire data-file lock: {error}"));
            }
            if started.elapsed() >= LOCK_TIMEOUT {
                return Err("Timed out waiting for data-file lock".to_string());
            }
            thread::sleep(LOCK_RETRY_INTERVAL);
        }
    }

    pub fn acquire() -> Result<DataLockGuard, String> {
        let runtime_dir = crate::test_profile::runtime_dir()?;
        acquire_at(&runtime_dir)
    }

    #[cfg(test)]
    pub fn acquire_for_runtime_dir(runtime_dir: &Path) -> Result<DataLockGuard, String> {
        acquire_at(runtime_dir)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SuppressedAgentSessionConfig {
    pub agent_kind: String,
    pub agent_session_id: String,
    #[serde(default)]
    pub claude_session_id: Option<String>,
}

fn skip_turn_marks(value: &Option<Vec<TurnMarkPersistConfig>>) -> bool {
    value.as_ref().map_or(true, |marks| marks.is_empty())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TurnMarkPersistConfig {
    pub label: String,
    pub at: u64,
    pub lines_from_bottom: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaneTabOriginConfig {
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_tab_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaneTabConfig {
    #[serde(default)]
    pub tab_id: Option<String>,
    pub agent_id: String,
    pub label: Option<String>,
    /// Who set `label`: "user" or "ai". Absent means user-set, so a name that
    /// predates auto naming (or was typed by hand) is never overwritten.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label_source: Option<String>,
    #[serde(default)]
    pub r#type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preset_id: Option<String>,
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
    pub suppressed_agent_sessions: Option<Vec<SuppressedAgentSessionConfig>>,
    #[serde(default)]
    pub launch_env: Option<HashMap<String, String>>,
    #[serde(default)]
    pub terminal_snapshot: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "skip_turn_marks")]
    pub turn_marks: Option<Vec<TurnMarkPersistConfig>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lifecycle: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<PaneTabOriginConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub declared_prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub declared_target: Option<String>,
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
    pub suppressed_agent_sessions: Option<Vec<SuppressedAgentSessionConfig>>,
    #[serde(default)]
    pub launch_env: Option<HashMap<String, String>>,
    #[serde(default)]
    pub active_tab_id: Option<String>,
    #[serde(default)]
    pub pinned_tab_id: Option<String>,
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
    #[serde(default)]
    pub pet: Option<String>,
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
    CURRENT_SCHEMA_VERSION
}

pub const CURRENT_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "kind")]
pub enum PersistentStorageError {
    #[serde(rename = "unsupportedSchema")]
    UnsupportedSchema {
        #[serde(rename = "schemaVersion")]
        schema_version: u32,
        message: String,
    },
    #[serde(rename = "invalidPayloadSchema")]
    InvalidPayloadSchema {
        #[serde(rename = "schemaVersion")]
        schema_version: u32,
        message: String,
    },
    #[serde(rename = "unsupportedPlatform")]
    UnsupportedPlatform { message: String },
    #[serde(rename = "storage")]
    Storage { message: String },
}

impl PersistentStorageError {
    pub fn unsupported_schema(schema_version: u32) -> Self {
        Self::UnsupportedSchema {
            schema_version,
            message: unsupported_schema_error(schema_version),
        }
    }

    fn invalid_payload_schema(schema_version: u32) -> Self {
        Self::InvalidPayloadSchema {
            schema_version,
            message: format!(
                "data.json payload schema version {schema_version} does not match current schema {CURRENT_SCHEMA_VERSION}"
            ),
        }
    }

    // The wire kind is part of the contract `ipc.ts` decodes, and
    // test_data_json_schema_guard_contract.py pins the cfg that keeps this
    // constructor reachable off Windows. Nothing calls it there today -- the
    // platform seal that used to is gone -- so clippy would flag it as dead;
    // the allow says that is deliberate rather than an oversight, and keeps the
    // variant constructible if a non-Windows path ever needs to refuse a write
    // again.
    #[cfg_attr(not(test), allow(dead_code))]
    #[cfg(any(test, not(windows)))]
    fn unsupported_platform(message: impl Into<String>) -> Self {
        Self::UnsupportedPlatform {
            message: message.into(),
        }
    }

    fn storage(message: impl Into<String>) -> Self {
        Self::Storage {
            message: message.into(),
        }
    }

    pub fn kind(&self) -> &'static str {
        match self {
            Self::UnsupportedSchema { .. } => "unsupportedSchema",
            Self::InvalidPayloadSchema { .. } => "invalidPayloadSchema",
            Self::UnsupportedPlatform { .. } => "unsupportedPlatform",
            Self::Storage { .. } => "storage",
        }
    }

    pub fn schema_version(&self) -> Option<u32> {
        match self {
            Self::UnsupportedSchema { schema_version, .. }
            | Self::InvalidPayloadSchema { schema_version, .. } => Some(*schema_version),
            Self::UnsupportedPlatform { .. }
            | Self::Storage { .. } => None,
        }
    }

    fn message(&self) -> &str {
        match self {
            Self::UnsupportedSchema { message, .. }
            | Self::InvalidPayloadSchema { message, .. }
            | Self::UnsupportedPlatform { message }
            | Self::Storage { message } => message,
        }
    }
}

impl std::fmt::Display for PersistentStorageError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.message())
    }
}

impl std::error::Error for PersistentStorageError {}

impl From<String> for PersistentStorageError {
    fn from(message: String) -> Self {
        Self::storage(message)
    }
}

impl From<PersistentStorageError> for String {
    fn from(error: PersistentStorageError) -> Self {
        error.to_string()
    }
}

// Zero means persistence has not seen an unsupported schema. Other values are
// the schema version plus one, which lets schema version zero remain valid.
static QUARANTINED_SCHEMA_VERSION: AtomicU64 = AtomicU64::new(0);

fn latch_unsupported_schema(schema_version: u32) {
    let encoded = u64::from(schema_version) + 1;
    let _ =
        QUARANTINED_SCHEMA_VERSION.compare_exchange(0, encoded, Ordering::SeqCst, Ordering::SeqCst);
}

fn quarantined_schema_version() -> Option<u32> {
    QUARANTINED_SCHEMA_VERSION
        .load(Ordering::SeqCst)
        .checked_sub(1)
        .and_then(|value| u32::try_from(value).ok())
}

#[cfg(test)]
pub(crate) fn reset_quarantined_schema_for_test() {
    QUARANTINED_SCHEMA_VERSION.store(0, Ordering::SeqCst);
}

#[cfg(test)]
pub(crate) fn persistence_test_lock() -> std::sync::MutexGuard<'static, ()> {
    static TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    TEST_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .expect("persistence test lock poisoned")
}

fn unsupported_schema_error(schema_version: u32) -> String {
    format!("data.json schema version {schema_version} is not supported by this mycmux build")
}

fn default_theme_tweaks() -> serde_json::Value {
    serde_json::json!({
        "enabled": false,
        "colors": {}
    })
}

fn default_font_family() -> String {
    "'JetBrainsMono Nerd Font Mono', 'JetBrains Mono', 'Geist Mono', 'SF Mono', 'BIZ UDGothic', 'MS Gothic', monospace".to_string()
}

fn default_line_height() -> f32 {
    1.35
}

fn default_ui_density() -> String {
    "standard".to_string()
}

fn default_sidebar_width() -> u32 {
    280
}

fn default_ai_provider() -> String {
    crate::ai::AiConfig::default()
        .provider
        .as_storage()
        .to_string()
}
fn default_ai_model() -> String {
    crate::ai::AiConfig::default().model
}

fn default_ui_font_scale() -> f32 {
    1.0
}

fn default_pet_display_mode() -> String {
    "ws".to_string()
}

fn default_pet_new_ws_mode() -> String {
    "random".to_string()
}

pub const DEFAULT_AILOG_USD_JPY_RATE: f64 = 150.0;

fn default_ailog_usd_jpy_rate() -> f64 {
    DEFAULT_AILOG_USD_JPY_RATE
}

fn default_ailog_mirror_full_text_root() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        Some(
            "G:\\\u{30de}\u{30a4}\u{30c9}\u{30e9}\u{30a4}\u{30d6}\\pc-backup\\mycmux-ailog"
                .to_string(),
        )
    }
    #[cfg(not(target_os = "windows"))]
    {
        None
    }
}

/// Invalid stored rates (non-finite or not strictly positive) fall back to
/// the default rather than breaking the money display.
pub fn sanitize_ailog_usd_jpy_rate(rate: f64) -> f64 {
    if rate.is_finite() && rate > 0.0 {
        rate
    } else {
        DEFAULT_AILOG_USD_JPY_RATE
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    pub font_size: u16,
    #[serde(default = "default_line_height")]
    pub line_height: f32,
    #[serde(default = "default_font_family")]
    pub font_family: String,
    pub theme_id: String,
    #[serde(default = "default_theme_tweaks")]
    pub theme_tweaks: serde_json::Value,
    /// UI chrome density ("compact" | "standard" | "relaxed"). Validated on
    /// the frontend (normalizeUiDensity); stored as an opaque string here.
    #[serde(default = "default_ui_density")]
    pub ui_density: String,
    #[serde(default = "default_sidebar_width")]
    pub sidebar_width: u32,
    #[serde(default = "default_ui_font_scale")]
    pub ui_font_scale: f32,
    #[serde(default)]
    pub keybindings: HashMap<String, String>,
    #[serde(default = "default_ai_provider")]
    pub ai_provider: String,
    #[serde(default = "default_ai_model")]
    pub ai_model: String,
    #[serde(default = "default_true")]
    pub ai_enabled: bool,
    /// `None` means this build has not migrated or explicitly saved the
    /// setting yet. The frontend supplies the effective UI default.
    #[serde(default)]
    pub auto_pane_naming_enabled: Option<bool>,
    /// `None` is distinct from the explicit opt-out `Some(false)`.
    #[serde(default)]
    pub reply_draft_suggestions_enabled: Option<bool>,
    /// When true, persistence is triggered by Zustand subscribers + debounce
    /// instead of a fixed interval. Rollback switch for Phase A.
    #[serde(default = "default_true")]
    pub dirty_save_mode: bool,
    /// When true, inject a shell-specific OSC 7 hook so CWD updates flow
    /// instantly from bash/fish (zsh/pwsh fall back to sysinfo). Rollback
    /// switch for Phase B.
    #[serde(default = "default_true")]
    pub osc7_tracking_enabled: bool,
    /// When true, the remote terminal server binds `0.0.0.0` (reachable from
    /// the LAN/Tailscale). When false (the default), it binds `127.0.0.1`
    /// only. Read once at startup; a change takes effect on next app launch.
    #[serde(default)]
    pub remote_bind_all: bool,
    #[serde(default = "default_true")]
    pub remote_enabled: bool,
    #[serde(default = "default_pet_display_mode")]
    pub pet_display_mode: String,
    #[serde(default = "default_pet_new_ws_mode")]
    pub pet_new_ws_mode: String,
    #[serde(default)]
    pub pet_disabled: Vec<String>,
    #[serde(default)]
    pub pet_fixed_id: Option<String>,
    /// Yen per US dollar used by the AI log money display. Unit prices stay
    /// in USD; the renderer multiplies at format time.
    #[serde(default = "default_ailog_usd_jpy_rate")]
    pub ailog_usd_jpy_rate: f64,
    /// Optional durable full-text transcript mirror. An explicit null disables
    /// Tier 2 while the metadata-only local mirror continues.
    #[serde(default = "default_ailog_mirror_full_text_root")]
    pub ailog_mirror_full_text_root: Option<String>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            font_size: 14,
            line_height: default_line_height(),
            font_family: default_font_family(),
            theme_id: "yoru-cafe".to_string(),
            theme_tweaks: default_theme_tweaks(),
            ui_density: default_ui_density(),
            sidebar_width: default_sidebar_width(),
            ui_font_scale: default_ui_font_scale(),
            keybindings: HashMap::new(),
            ai_provider: default_ai_provider(),
            ai_model: default_ai_model(),
            ai_enabled: true,
            auto_pane_naming_enabled: None,
            reply_draft_suggestions_enabled: None,
            dirty_save_mode: true,
            osc7_tracking_enabled: true,
            remote_bind_all: false,
            remote_enabled: false,
            pet_display_mode: default_pet_display_mode(),
            pet_new_ws_mode: default_pet_new_ws_mode(),
            pet_disabled: Vec::new(),
            pet_fixed_id: None,
            ailog_usd_jpy_rate: default_ailog_usd_jpy_rate(),
            ailog_mirror_full_text_root: default_ailog_mirror_full_text_root(),
        }
    }
}

// NOTE: no `deny_unknown_fields` here on purpose. Retired keys (e.g. the
// former `pinned_roots`, dropped with the file-explorer sidebar) can still be
// present in an existing data.json; serde must ignore them rather than fail
// the whole load.
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
            schema_version: CURRENT_SCHEMA_VERSION,
            workspaces: Vec::new(),
            settings: AppSettings::default(),
            active_workspace_id: None,
            active_pane_id: None,
            active_tab_id: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistentDataEnvelope {
    pub schema_version: u32,
    pub data: Option<PersistentData>,
    pub supported: bool,
}

impl PersistentDataEnvelope {
    fn supported(data: PersistentData) -> Self {
        Self {
            schema_version: data.schema_version,
            data: Some(data),
            supported: true,
        }
    }

    fn unsupported(schema_version: u32) -> Self {
        Self {
            schema_version,
            data: None,
            supported: false,
        }
    }
}

fn save_lock() -> &'static Mutex<()> {
    static SAVE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    SAVE_LOCK.get_or_init(|| Mutex::new(()))
}

fn data_path(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let default_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {e}"))?;
    let dir = crate::test_profile::app_data_dir_from(default_dir);
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create app data dir: {e}"))?;
    Ok(dir.join("data.json"))
}

pub(crate) trait PersistentDataTarget {
    fn persistent_data_path(&self) -> Result<PathBuf, String>;
}

impl PersistentDataTarget for tauri::AppHandle {
    fn persistent_data_path(&self) -> Result<PathBuf, String> {
        data_path(self)
    }
}

#[cfg(test)]
impl PersistentDataTarget for Path {
    fn persistent_data_path(&self) -> Result<PathBuf, String> {
        Ok(self.to_path_buf())
    }
}

pub(crate) fn scrollback_dir(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    let path = data_path(app_handle)?;
    let parent = path
        .parent()
        .ok_or_else(|| format!("data path has no parent: {}", path.display()))?;
    Ok(parent.join("scrollback"))
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

fn is_pre_replace_backup(path: &Path, candidate: &Path) -> bool {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("data.json");
    let Some(candidate_name) = candidate.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    candidate_name.starts_with(&format!("{file_name}.pre-replace-"))
        && candidate_name.ends_with(".bak")
}

fn pre_replace_backups(path: &Path) -> Vec<PathBuf> {
    let Some(parent) = path.parent() else {
        return Vec::new();
    };
    let Ok(entries) = fs::read_dir(parent) else {
        return Vec::new();
    };
    let mut backups = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|candidate| is_pre_replace_backup(path, candidate))
        .collect::<Vec<_>>();
    backups.sort_by(|left, right| {
        let left_modified = left
            .metadata()
            .and_then(|metadata| metadata.modified())
            .ok();
        let right_modified = right
            .metadata()
            .and_then(|metadata| metadata.modified())
            .ok();
        right_modified
            .cmp(&left_modified)
            .then_with(|| right.file_name().cmp(&left.file_name()))
    });
    backups
}

fn cleanup_old_pre_replace_backups(path: &Path, keep: Option<&Path>) {
    for backup in pre_replace_backups(path) {
        if keep.is_some_and(|keep_path| backup == keep_path) {
            continue;
        }
        if let Err(error) = fs::remove_file(&backup) {
            crate::diag_warn!(
                "storage",
                "failed to remove old data backup {}: {error}",
                backup.display()
            );
        }
    }
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

fn read_data_file(path: &Path) -> Result<String, String> {
    let mut contents = String::new();
    File::open(path)
        .map_err(|error| format!("Failed to open {}: {error}", path.display()))?
        .read_to_string(&mut contents)
        .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
    Ok(contents
        .strip_prefix('\u{feff}')
        .unwrap_or(&contents)
        .to_string())
}

fn schema_version_from_contents(path: &Path, contents: &str) -> Result<u32, String> {
    let value = serde_json::from_str::<serde_json::Value>(contents)
        .map_err(|error| format!("Failed to parse {}: {error}", path.display()))?;
    let Some(schema_version) = value.get("schema_version") else {
        return Ok(CURRENT_SCHEMA_VERSION);
    };
    let version = schema_version.as_u64().ok_or_else(|| {
        format!(
            "Failed to parse {}: schema_version must be an unsigned integer",
            path.display()
        )
    })?;
    u32::try_from(version).map_err(|_| {
        format!(
            "Failed to parse {}: schema_version is out of range",
            path.display()
        )
    })
}

#[cfg(test)]
fn schema_version_from_path(path: &Path) -> Result<Option<u32>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let contents = read_data_file(path)?;
    if contents.trim().is_empty() {
        return Ok(None);
    }
    schema_version_from_contents(path, &contents).map(Some)
}

#[cfg(test)]
fn ensure_existing_schema_supported(path: &Path) -> Result<(), PersistentStorageError> {
    if let Some(schema_version) =
        schema_version_from_path(path).map_err(PersistentStorageError::from)?
    {
        if schema_version != CURRENT_SCHEMA_VERSION {
            return Err(PersistentStorageError::unsupported_schema(schema_version));
        }
    }
    Ok(())
}

fn sync_file(path: &Path) -> Result<(), String> {
    fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .map_err(|error| format!("Failed to open {} for sync: {error}", path.display()))?
        .sync_all()
        .map_err(|error| format!("Failed to flush {}: {error}", path.display()))
}

fn copy_file_and_sync(source: &Path, target: &Path) -> Result<(), String> {
    fs::copy(source, target).map_err(|error| {
        format!(
            "Failed to copy {} to {}: {error}",
            source.display(),
            target.display()
        )
    })?;
    sync_file(target)
}

fn recover_from_pre_replace_backup(
    path: &Path,
    reason: &str,
) -> Result<Option<PersistentDataEnvelope>, String> {
    for backup_path in pre_replace_backups(path) {
        let Ok(contents) = read_data_file(&backup_path) else {
            continue;
        };
        let Ok(schema_version) = schema_version_from_contents(&backup_path, &contents) else {
            continue;
        };
        let envelope = if schema_version == CURRENT_SCHEMA_VERSION {
            let Ok(data) = serde_json::from_str::<PersistentData>(&contents) else {
                continue;
            };
            PersistentDataEnvelope::supported(data)
        } else {
            PersistentDataEnvelope::unsupported(schema_version)
        };
        if path.exists() {
            let _backup_path = quarantine_data_file(path, reason)?;
        }
        copy_file_and_sync(&backup_path, path)?;
        crate::diag_warn!(
            "storage",
            "recovered {} from {} after {}",
            path.display(),
            backup_path.display(),
            reason
        );
        return Ok(Some(envelope));
    }
    Ok(None)
}

fn load_envelope_from_path(path: &Path) -> Result<PersistentDataEnvelope, String> {
    if !path.exists() {
        if let Some(envelope) = recover_from_pre_replace_backup(path, "missing")? {
            return Ok(envelope);
        }
        return Ok(PersistentDataEnvelope::supported(PersistentData::default()));
    }

    let contents = read_data_file(path)?;

    if contents.trim().is_empty() {
        if let Some(envelope) = recover_from_pre_replace_backup(path, "empty")? {
            return Ok(envelope);
        }
        let _backup_path = quarantine_data_file(path, "empty")?;
        return Ok(PersistentDataEnvelope::supported(PersistentData::default()));
    }

    // Probe the schema before deserializing the current struct. A future
    // schema may be valid JSON while intentionally changing required fields;
    // it must never fall into the corrupt-file recovery path.
    match schema_version_from_contents(path, &contents) {
        Ok(schema_version) if schema_version != CURRENT_SCHEMA_VERSION => {
            return Ok(PersistentDataEnvelope::unsupported(schema_version));
        }
        Ok(_) => {}
        Err(_) => {
            if let Some(envelope) = recover_from_pre_replace_backup(path, "corrupt")? {
                return Ok(envelope);
            }
            let _backup_path = quarantine_data_file(path, "corrupt")?;
            return Ok(PersistentDataEnvelope::supported(PersistentData::default()));
        }
    }

    match serde_json::from_str::<PersistentData>(&contents) {
        Ok(data) => Ok(PersistentDataEnvelope::supported(data)),
        Err(_error) => {
            if let Some(envelope) = recover_from_pre_replace_backup(path, "corrupt")? {
                return Ok(envelope);
            }
            let _backup_path = quarantine_data_file(path, "corrupt")?;
            Ok(PersistentDataEnvelope::supported(PersistentData::default()))
        }
    }
}

#[cfg(test)]
fn load_from_path(path: &Path) -> Result<PersistentData, String> {
    let envelope = load_envelope_from_path(path)?;
    envelope
        .data
        .ok_or_else(|| unsupported_schema_error(envelope.schema_version))
}

/// Write the serialized data file and fsync it.
///
/// Deliberately not the atomic helper: `save_to_path` writes to its own named
/// tmp path so `replace_data_file` can take a pre-replace backup of the live
/// file between the write and the rename.
fn write_json_file(path: &Path, json: &str) -> Result<(), String> {
    crate::util::atomic_write::write_synced(path, json.as_bytes())
}

fn replace_data_file(path: &Path, tmp_path: &Path) -> Result<(), String> {
    let backup_path = if path.exists() {
        let backup_path = backup_path_for(path, "pre-replace");
        copy_file_and_sync(path, &backup_path)?;
        Some(backup_path)
    } else {
        None
    };

    fs::rename(tmp_path, path).map_err(|error| {
        format!(
            "Failed to replace {} with {}: {error}",
            path.display(),
            tmp_path.display()
        )
    })?;

    if let Some(backup_path) = backup_path.as_deref() {
        cleanup_old_pre_replace_backups(path, Some(backup_path));
    }

    Ok(())
}

fn ensure_payload_schema_supported(data: &PersistentData) -> Result<(), PersistentStorageError> {
    if data.schema_version != CURRENT_SCHEMA_VERSION {
        return Err(PersistentStorageError::invalid_payload_schema(
            data.schema_version,
        ));
    }
    Ok(())
}

#[cfg(test)]
fn save_to_path(path: &Path, data: &PersistentData) -> Result<(), PersistentStorageError> {
    ensure_existing_schema_supported(path)?;
    save_preflighted_to_path(path, data)
}

fn save_preflighted_to_path(
    path: &Path,
    data: &PersistentData,
) -> Result<(), PersistentStorageError> {
    ensure_payload_schema_supported(data)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            PersistentStorageError::storage(format!(
                "Failed to create {}: {error}",
                parent.display()
            ))
        })?;
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
    let json = serde_json::to_string(data).map_err(|error| {
        PersistentStorageError::storage(format!("Failed to serialize data: {error}"))
    })?;

    write_json_file(&tmp_path, &json).map_err(PersistentStorageError::from)?;
    replace_data_file(path, &tmp_path)
        .map_err(PersistentStorageError::from)
        .inspect_err(|replace_error| {
            crate::diag_warn!(
                "storage",
                "failed to save {}: {replace_error}",
                path.display()
            );
            if let Err(error) = fs::remove_file(&tmp_path) {
                crate::diag_warn!(
                    "storage",
                    "failed to remove temporary data file {}: {error}",
                    tmp_path.display()
                );
            }
        })
}

pub(crate) fn load_envelope<T: PersistentDataTarget + ?Sized>(
    target: &T,
) -> Result<PersistentDataEnvelope, String> {
    let _process_guard = interprocess_data_lock::acquire()?;
    let path = target.persistent_data_path()?;
    if let Some(schema_version) = quarantined_schema_version() {
        return Ok(PersistentDataEnvelope::unsupported(schema_version));
    }
    let envelope = load_envelope_from_path(&path)?;
    if !envelope.supported {
        latch_unsupported_schema(envelope.schema_version);
    }
    Ok(envelope)
}

pub(crate) fn load<T: PersistentDataTarget + ?Sized>(target: &T) -> Result<PersistentData, String> {
    let envelope = load_envelope(target)?;
    envelope
        .data
        .ok_or_else(|| unsupported_schema_error(envelope.schema_version))
}

fn ensure_persistence_write_platform_supported() -> Result<(), PersistentStorageError> {
    Ok(())
}

pub(crate) fn update<T, F>(target: &T, updater: F) -> Result<(), PersistentStorageError>
where
    T: PersistentDataTarget + ?Sized,
    F: FnOnce(&mut PersistentData),
{
    ensure_persistence_write_platform_supported()?;
    let _guard = save_lock().lock().map_err(|error| {
        PersistentStorageError::storage(format!("Failed to lock data file: {error}"))
    })?;
    let _process_guard = interprocess_data_lock::acquire().map_err(PersistentStorageError::from)?;
    update_while_locked(target, updater)
}

fn update_while_locked<T, F>(target: &T, updater: F) -> Result<(), PersistentStorageError>
where
    T: PersistentDataTarget + ?Sized,
    F: FnOnce(&mut PersistentData),
{
    if let Some(schema_version) = quarantined_schema_version() {
        return Err(PersistentStorageError::unsupported_schema(schema_version));
    }
    let path = target
        .persistent_data_path()
        .map_err(PersistentStorageError::from)?;
    // This locked read is also the writer preflight. Reuse the parsed payload
    // rather than reopening and reparsing the same bytes in save_to_path.
    let envelope = load_envelope_from_path(&path).map_err(PersistentStorageError::from)?;
    if !envelope.supported {
        latch_unsupported_schema(envelope.schema_version);
        return Err(PersistentStorageError::unsupported_schema(
            envelope.schema_version,
        ));
    }
    let mut data = envelope.data.ok_or_else(|| {
        PersistentStorageError::storage("supported data.json load returned no data")
    })?;
    updater(&mut data);
    if let Some(schema_version) = quarantined_schema_version() {
        return Err(PersistentStorageError::unsupported_schema(schema_version));
    }
    save_preflighted_to_path(&path, &data)
}

#[cfg(all(test, unix))]
fn update_for_runtime_dir<T, F>(
    target: &T,
    runtime_dir: &Path,
    updater: F,
) -> Result<(), PersistentStorageError>
where
    T: PersistentDataTarget + ?Sized,
    F: FnOnce(&mut PersistentData),
{
    ensure_persistence_write_platform_supported()?;
    let _guard = save_lock().lock().map_err(|error| {
        PersistentStorageError::storage(format!("Failed to lock data file: {error}"))
    })?;
    let _process_guard = interprocess_data_lock::acquire_for_runtime_dir(runtime_dir)
        .map_err(PersistentStorageError::from)?;
    update_while_locked(target, updater)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsupported_platform_error_has_a_terminal_wire_kind() {
        let error = PersistentStorageError::unsupported_platform(
            "data.json writes require the Windows persistence binding",
        );
        assert_eq!(error.kind(), "unsupportedPlatform");
        assert_eq!(error.schema_version(), None);
        assert_eq!(
            serde_json::to_value(error).unwrap(),
            serde_json::json!({
                "kind": "unsupportedPlatform",
                "message": "data.json writes require the Windows persistence binding",
            })
        );
    }

    #[cfg(windows)]
    #[test]
    fn test_data_mutex_name_is_process_scoped() {
        let name = interprocess_data_lock::mutex_name();
        assert!(name.starts_with(&format!(
            "Local\\miyazaki-{}-data-json-test-",
            env!("CARGO_PKG_NAME")
        )));
        assert!(name.ends_with(&std::process::id().to_string()));
    }

    #[cfg(not(windows))]
    #[test]
    fn update_persists_data_on_non_windows_using_a_temporary_runtime_directory() {
        let runtime_dir = tempfile::tempdir().unwrap();
        let path = runtime_dir.path().join("data.json");

        update_for_runtime_dir(path.as_path(), runtime_dir.path(), |data| {
            data.active_workspace_id = Some("restored-workspace".to_string());
        })
        .unwrap();

        assert_eq!(
            load_from_path(&path)
                .unwrap()
                .active_workspace_id
                .as_deref(),
            Some("restored-workspace")
        );
        assert!(runtime_dir.path().join("data.json").is_file());
    }

    #[cfg(unix)]
    #[test]
    fn data_lock_is_created_in_the_runtime_directory() {
        let runtime_dir = tempfile::tempdir().unwrap();
        let _first = interprocess_data_lock::acquire_for_runtime_dir(runtime_dir.path()).unwrap();
        let lock_path = runtime_dir.path().join("data.json.lock");

        assert!(lock_path.is_file());
    }

    fn sha256_hex(bytes: &[u8]) -> String {
        use sha2::{Digest, Sha256};

        hex::encode(Sha256::digest(bytes))
    }

    #[test]
    fn future_schema_load_returns_unsupported_without_corrupt_quarantine() {
        let temp_dir = tempfile::tempdir().unwrap();
        let path = temp_dir.path().join("data.json");
        let original = include_bytes!("../../../tests/fixtures/data_json_schema_999_canary.json");
        fs::write(&path, original).unwrap();
        let original_hash = sha256_hex(original);

        let envelope = load_envelope_from_path(&path).unwrap();

        assert!(!envelope.supported);
        assert_eq!(envelope.schema_version, 999);
        assert!(envelope.data.is_none());
        let final_bytes = fs::read(&path).unwrap();
        assert_eq!(sha256_hex(&final_bytes), original_hash);
        assert_eq!(final_bytes.as_slice(), original);
        assert_eq!(pre_replace_backups(&path), Vec::<PathBuf>::new());
        assert!(!fs::read_dir(temp_dir.path()).unwrap().any(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains(".tmp-")
        }));
    }

    #[test]
    fn writer_rejects_a_future_schema_payload_before_creating_a_file() {
        let temp_dir = tempfile::tempdir().unwrap();
        let path = temp_dir.path().join("data.json");
        let mut payload = PersistentData::default();
        payload.schema_version = 999;

        let error = save_to_path(&path, &payload).unwrap_err();

        assert_eq!(error.kind(), "invalidPayloadSchema");
        assert_eq!(error.schema_version(), Some(999));
        assert_eq!(
            serde_json::to_value(&error).unwrap()["kind"],
            "invalidPayloadSchema"
        );
        assert!(error.to_string().contains("payload schema version 999"));
        assert!(!path.exists());
    }

    #[test]
    fn unsupported_schema_error_serializes_with_kind_and_version() {
        let error = PersistentStorageError::unsupported_schema(999);

        assert_eq!(
            serde_json::to_value(error).unwrap(),
            serde_json::json!({
                "kind": "unsupportedSchema",
                "schemaVersion": 999,
                "message": "data.json schema version 999 is not supported by this mycmux build",
            }),
        );
    }

    #[test]
    fn app_settings_missing_line_height_uses_default() {
        let settings: AppSettings =
            serde_json::from_str(r#"{"font_size":14,"theme_id":"yoru-cafe"}"#).unwrap();

        assert_eq!(settings.line_height, 1.35);
    }

    #[test]
    fn app_settings_missing_ai_settings_use_defaults() {
        let settings: AppSettings =
            serde_json::from_str(r#"{"font_size":14,"theme_id":"yoru-cafe"}"#).unwrap();
        assert_eq!(
            settings.ai_provider,
            crate::ai::AiConfig::default().provider.as_storage()
        );
        assert_eq!(settings.ai_model, crate::ai::AiConfig::default().model);
        assert!(settings.ai_enabled);
    }

    #[test]
    fn app_settings_missing_ui_density_uses_default() {
        let settings: AppSettings =
            serde_json::from_str(r#"{"font_size":14,"theme_id":"yoru-cafe"}"#).unwrap();

        assert_eq!(settings.ui_density, "standard");
    }

    #[test]
    fn app_settings_missing_sidebar_width_uses_default() {
        let settings: AppSettings =
            serde_json::from_str(r#"{"font_size":14,"theme_id":"yoru-cafe"}"#).unwrap();

        assert_eq!(settings.sidebar_width, 280);
    }

    #[test]
    fn app_settings_missing_ui_font_scale_uses_default() {
        let settings: AppSettings =
            serde_json::from_str(r#"{"font_size":14,"theme_id":"yoru-cafe"}"#).unwrap();

        assert_eq!(settings.ui_font_scale, 1.0);
    }

    #[test]
    fn app_settings_missing_pet_settings_use_defaults() {
        let settings: AppSettings =
            serde_json::from_str(r#"{"font_size":14,"theme_id":"yoru-cafe"}"#).unwrap();

        assert_eq!(settings.pet_display_mode, "ws");
        assert_eq!(settings.pet_new_ws_mode, "random");
        assert!(settings.pet_disabled.is_empty());
        assert!(settings.pet_fixed_id.is_none());
    }

    #[test]
    fn app_settings_missing_ailog_usd_jpy_rate_uses_default() {
        let settings: AppSettings =
            serde_json::from_str(r#"{"font_size":14,"theme_id":"yoru-cafe"}"#).unwrap();

        assert_eq!(settings.ailog_usd_jpy_rate, DEFAULT_AILOG_USD_JPY_RATE);
    }

    #[test]
    fn sanitize_ailog_usd_jpy_rate_rejects_non_positive_and_non_finite() {
        assert_eq!(sanitize_ailog_usd_jpy_rate(155.5), 155.5);
        assert_eq!(
            sanitize_ailog_usd_jpy_rate(0.0),
            DEFAULT_AILOG_USD_JPY_RATE
        );
        assert_eq!(
            sanitize_ailog_usd_jpy_rate(-1.0),
            DEFAULT_AILOG_USD_JPY_RATE
        );
        assert_eq!(
            sanitize_ailog_usd_jpy_rate(f64::NAN),
            DEFAULT_AILOG_USD_JPY_RATE
        );
        assert_eq!(
            sanitize_ailog_usd_jpy_rate(f64::INFINITY),
            DEFAULT_AILOG_USD_JPY_RATE
        );
    }

    #[test]
    fn remote_enabled_defaults_true_only_for_legacy_data() {
        let temp_dir = tempfile::tempdir().unwrap();
        let path = temp_dir.path().join("data.json");

        let new_install = load_from_path(&path).unwrap();
        assert!(!new_install.settings.remote_enabled);

        fs::write(
            &path,
            r#"{"schema_version":1,"workspaces":[],"settings":{"font_size":14,"theme_id":"yoru-cafe"}}"#,
        )
        .unwrap();
        let legacy_install = load_from_path(&path).unwrap();
        assert!(legacy_install.settings.remote_enabled);

        fs::write(
            &path,
            r#"{"schema_version":1,"workspaces":[],"settings":{"font_size":14,"theme_id":"yoru-cafe","remote_enabled":false}}"#,
        )
        .unwrap();
        let explicit_opt_out = load_from_path(&path).unwrap();
        assert!(!explicit_opt_out.settings.remote_enabled);
    }

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
    fn load_from_path_accepts_utf8_bom_without_quarantining_clone_data() {
        let temp_dir = tempfile::tempdir().unwrap();
        let path = temp_dir.path().join("data.json");
        // Windows PowerShell 5.1 clones write UTF-8 with a BOM; build a
        // schema-valid file the normal way, then prepend that BOM.
        let cloned = PersistentData {
            active_workspace_id: Some("cloned".to_string()),
            ..Default::default()
        };
        save_to_path(&path, &cloned).unwrap();
        let json = fs::read(&path).unwrap();
        let mut with_bom = b"\xEF\xBB\xBF".to_vec();
        with_bom.extend_from_slice(&json);
        fs::write(&path, with_bom).unwrap();

        let data = load_from_path(&path).unwrap();

        assert_eq!(data.active_workspace_id.as_deref(), Some("cloned"));
        assert!(path.exists());
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
    fn save_to_path_removes_tmp_file_when_replace_fails() {
        let temp_dir = tempfile::tempdir().unwrap();
        let path = temp_dir.path().join("data.json");
        fs::create_dir(&path).unwrap();
        let data = PersistentData::default();

        let result = save_to_path(&path, &data);

        assert!(result.is_err());
        assert!(!fs::read_dir(temp_dir.path()).unwrap().any(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains(".tmp-")
        }));
    }

    #[test]
    fn replace_data_file_copies_backup_and_keeps_data_json_path() {
        let temp_dir = tempfile::tempdir().unwrap();
        let path = temp_dir.path().join("data.json");
        let tmp_path = temp_dir.path().join("data.json.tmp-test");
        let old = PersistentData {
            active_workspace_id: Some("old".to_string()),
            ..Default::default()
        };
        let next = PersistentData {
            active_workspace_id: Some("next".to_string()),
            ..Default::default()
        };
        let old_json = serde_json::to_string_pretty(&old).unwrap();
        let next_json = serde_json::to_string_pretty(&next).unwrap();
        write_json_file(&path, &old_json).unwrap();
        write_json_file(&tmp_path, &next_json).unwrap();

        replace_data_file(&path, &tmp_path).unwrap();

        assert!(path.exists());
        assert!(!tmp_path.exists());
        assert_eq!(
            load_from_path(&path)
                .unwrap()
                .active_workspace_id
                .as_deref(),
            Some("next")
        );
        let backups = pre_replace_backups(&path);
        assert_eq!(backups.len(), 1);
        assert_eq!(
            load_from_path(&backups[0])
                .unwrap()
                .active_workspace_id
                .as_deref(),
            Some("old")
        );
    }

    #[test]
    fn load_from_path_recovers_from_backup_when_data_json_is_missing() {
        let temp_dir = tempfile::tempdir().unwrap();
        let path = temp_dir.path().join("data.json");
        let old = PersistentData {
            active_workspace_id: Some("old".to_string()),
            ..Default::default()
        };
        let next = PersistentData {
            active_workspace_id: Some("next".to_string()),
            ..Default::default()
        };

        save_to_path(&path, &old).unwrap();
        save_to_path(&path, &next).unwrap();
        fs::remove_file(&path).unwrap();

        let loaded = load_from_path(&path).unwrap();

        assert_eq!(loaded.active_workspace_id.as_deref(), Some("old"));
        assert!(path.exists());
        assert_eq!(
            load_from_path(&path)
                .unwrap()
                .active_workspace_id
                .as_deref(),
            Some("old")
        );
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
        assert!(pane.suppressed_agent_sessions.is_none());
    }

    /// The sidebar's workspace grouping color lives only in data.json — if it
    /// stopped round-tripping here every group would silently reset on restart.
    #[test]
    fn workspace_color_round_trip() {
        // r##"…"## because the hex color puts a `"#` sequence inside the literal.
        let workspace: WorkspaceConfig = serde_json::from_str(
            r##"{"id":"ws-1","name":"Workspace","grid_template_id":"1x1","panes":[],"created_at":1,"color":"#4C8DF6"}"##,
        )
        .unwrap();

        assert_eq!(workspace.color.as_deref(), Some("#4C8DF6"));

        let serialized = serde_json::to_string(&workspace).unwrap();
        let restored: WorkspaceConfig = serde_json::from_str(&serialized).unwrap();
        assert_eq!(restored.color.as_deref(), Some("#4C8DF6"));
    }

    #[test]
    fn workspace_color_defaults_to_none_when_absent() {
        let workspace: WorkspaceConfig = serde_json::from_str(
            r#"{"id":"ws-1","name":"Workspace","grid_template_id":"1x1","panes":[],"created_at":1}"#,
        )
        .unwrap();

        assert!(workspace.color.is_none());

        let serialized = serde_json::to_string(&workspace).unwrap();
        let restored: WorkspaceConfig = serde_json::from_str(&serialized).unwrap();
        assert!(restored.color.is_none());
    }

    #[test]
    fn workspace_pet_defaults_to_none_when_absent_and_round_trips() {
        let mut workspace: WorkspaceConfig = serde_json::from_str(
            r#"{"id":"ws-1","name":"Workspace","grid_template_id":"1x1","panes":[],"created_at":1}"#,
        )
        .unwrap();
        assert!(workspace.pet.is_none());

        workspace.pet = Some("clawd".to_string());
        let serialized = serde_json::to_string(&workspace).unwrap();
        let restored: WorkspaceConfig = serde_json::from_str(&serialized).unwrap();
        assert_eq!(restored.pet.as_deref(), Some("clawd"));
    }

    #[test]
    fn pinned_tab_id_round_trip() {
        let pane: PaneConfig = serde_json::from_str(
            r#"{"agent_id":"shell-starter","label":null,"cwd":null,"active_tab_id":"tab-1","pinned_tab_id":"tab-2"}"#,
        )
        .unwrap();

        assert_eq!(pane.pinned_tab_id.as_deref(), Some("tab-2"));

        let serialized = serde_json::to_string(&pane).unwrap();
        let restored: PaneConfig = serde_json::from_str(&serialized).unwrap();
        assert_eq!(restored.pinned_tab_id.as_deref(), Some("tab-2"));
    }

    #[test]
    fn pinned_tab_id_defaults_to_none_when_absent() {
        let pane: PaneConfig =
            serde_json::from_str(r#"{"agent_id":"shell-starter","label":null,"cwd":null}"#)
                .unwrap();

        assert!(pane.pinned_tab_id.is_none());

        let serialized = serde_json::to_string(&pane).unwrap();
        let restored: PaneConfig = serde_json::from_str(&serialized).unwrap();
        assert!(restored.pinned_tab_id.is_none());
    }

    #[test]
    fn suppressed_agent_sessions_round_trip() {
        let pane: PaneConfig = serde_json::from_str(
            r#"{"agent_id":"shell-starter","label":null,"cwd":null,"suppressed_agent_sessions":[{"agent_kind":"claude","agent_session_id":"parked-session","claude_session_id":"parked-session"}]}"#,
        )
        .unwrap();

        let parked = &pane.suppressed_agent_sessions.as_ref().unwrap()[0];
        assert_eq!(parked.agent_kind, "claude");
        assert_eq!(parked.agent_session_id, "parked-session");
        assert_eq!(parked.claude_session_id.as_deref(), Some("parked-session"));

        let serialized = serde_json::to_string(&pane).unwrap();
        let restored: PaneConfig = serde_json::from_str(&serialized).unwrap();
        assert_eq!(
            restored
                .suppressed_agent_sessions
                .as_ref()
                .and_then(|values| values.first())
                .map(|value| value.agent_session_id.as_str()),
            Some("parked-session")
        );

        let tab: PaneTabConfig = serde_json::from_str(
            r#"{"agent_id":"shell-starter","suppressed_agent_sessions":[{"agent_kind":"codex","agent_session_id":"parked-tab"}]}"#,
        )
        .unwrap();
        let serialized_tab = serde_json::to_string(&tab).unwrap();
        let restored_tab: PaneTabConfig = serde_json::from_str(&serialized_tab).unwrap();
        assert_eq!(
            restored_tab
                .suppressed_agent_sessions
                .as_ref()
                .and_then(|values| values.first())
                .map(|value| value.agent_session_id.as_str()),
            Some("parked-tab")
        );
    }

    #[test]
    fn pane_tab_turn_marks_default_when_absent() {
        let tab: PaneTabConfig = serde_json::from_str(r#"{"agent_id":"shell-starter"}"#).unwrap();
        assert!(tab.turn_marks.is_none());

        let serialized = serde_json::to_string(&tab).unwrap();
        assert!(
            !serialized.contains("turn_marks"),
            "empty turn_marks must stay omitted: {serialized}"
        );
    }

    #[test]
    fn pane_tab_turn_marks_round_trip() {
        let tab: PaneTabConfig = serde_json::from_str(
            r#"{"agent_id":"shell-starter","turn_marks":[{"label":"hello","at":1700000000000,"lines_from_bottom":4}]}"#,
        )
        .unwrap();
        let marks = tab.turn_marks.as_ref().unwrap();
        assert_eq!(marks.len(), 1);
        assert_eq!(marks[0].label, "hello");
        assert_eq!(marks[0].at, 1_700_000_000_000);
        assert_eq!(marks[0].lines_from_bottom, 4_i64);

        let restored: PaneTabConfig = serde_json::from_str(&serde_json::to_string(&tab).unwrap()).unwrap();
        assert_eq!(restored.turn_marks, tab.turn_marks);
    }

    #[test]
    fn web_pane_tab_type_and_preset_round_trip() {
        let tab: PaneTabConfig = serde_json::from_str(
            r#"{"agent_id":"web","label":"ChatGPT","type":"web","preset_id":"chatgpt"}"#,
        )
        .unwrap();
        assert_eq!(tab.r#type.as_deref(), Some("web"));
        assert_eq!(tab.preset_id.as_deref(), Some("chatgpt"));

        let serialized = serde_json::to_string(&tab).unwrap();
        let restored: PaneTabConfig = serde_json::from_str(&serialized).unwrap();
        assert_eq!(restored.r#type.as_deref(), Some("web"));
        assert_eq!(restored.preset_id.as_deref(), Some("chatgpt"));

        let legacy: PaneTabConfig = serde_json::from_str(r#"{"agent_id":"shell-starter"}"#).unwrap();
        assert!(legacy.preset_id.is_none());
    }
}
