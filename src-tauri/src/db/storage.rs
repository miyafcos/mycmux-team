use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Windows lock names must distinguish the profile's actual data file. Scope
/// tags keep the default file distinct from a user profile named "default".
#[cfg(any(windows, test))]
fn data_mutex_name(profile: Option<&str>, test_pid: Option<u32>) -> String {
    let scope = profile.map(|name| format!("profile-{}", name.to_ascii_lowercase()))
        .unwrap_or_else(|| "default".to_string());
    match test_pid {
        Some(pid) => format!("Local\\miyazaki-{}-data-json-test-{scope}-{pid}", env!("CARGO_PKG_NAME")),
        None => format!("Local\\miyazaki-{}-data-json-scope-{scope}", env!("CARGO_PKG_NAME")),
    }
}

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
        super::data_mutex_name(crate::test_profile::name(), if cfg!(test) { Some(std::process::id()) } else { None })
    }

    pub fn acquire() -> Result<DataLockGuard, String> {
        acquire_with_timeout(std::time::Duration::from_millis(LOCK_TIMEOUT_MS.into()))
    }

    pub fn acquire_with_timeout(timeout: std::time::Duration) -> Result<DataLockGuard, String> {
        let name = mutex_name();
        let wide_name: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
        let handle = unsafe { CreateMutexW(None, false, PCWSTR(wide_name.as_ptr())) }
            .map_err(|error| format!("Failed to create data-file mutex: {error}"))?;
        let wait_result = unsafe { WaitForSingleObject(handle, timeout.as_millis().min(u128::from(LOCK_TIMEOUT_MS)) as u32) };

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
        acquire_at_with_timeout(runtime_dir, LOCK_TIMEOUT)
    }

    pub(super) fn acquire_at_with_timeout(runtime_dir: &Path, timeout: Duration) -> Result<DataLockGuard, String> {
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
            if started.elapsed() >= timeout {
                return Err("Timed out waiting for data-file lock".to_string());
            }
            thread::sleep(LOCK_RETRY_INTERVAL.min(timeout.saturating_sub(started.elapsed())));
        }
    }

    pub fn acquire() -> Result<DataLockGuard, String> {
        acquire_with_timeout(LOCK_TIMEOUT)
    }

    pub fn acquire_with_timeout(timeout: Duration) -> Result<DataLockGuard, String> {
        acquire_at_with_timeout(&crate::test_profile::runtime_dir()?, timeout)
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

// Only auxiliary delegation fields are tolerant; required layout fields remain strict.
fn optional_delegation_id<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<String>, D::Error> {
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(value.as_str().map(str::to_owned))
}

fn optional_delegation_timestamp<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<i64>, D::Error> {
    let value = serde_json::Value::deserialize(deserializer)?;
    // JavaScript safe integer range keeps Rust/TS persistence lossless.
    Ok(value.as_i64().filter(|at| (0..=9_007_199_254_740_991).contains(at)))
}

fn scrub_launch_secrets(env: Option<HashMap<String, String>>) -> Option<HashMap<String, String>> {
    env.map(|mut env| {
        env.retain(|key, _| !["CLAUDE_CODE_OAUTH_TOKEN", "MYCMUX_LAUNCH_ACCOUNT",
            "CODEX_HOME", "GROK_HOME", "CODEX_SQLITE_HOME", "GROK_AUTH_PATH", "GROK_LEADER_SOCKET",
            "MYCMUX_ACCOUNT_HOME_KIND", "MYCMUX_CLI_LOGIN_ID"].iter().any(|name| key.eq_ignore_ascii_case(name)));
        env
    })
}

fn serialize_launch_env<S: serde::Serializer>(env: &Option<HashMap<String, String>>, serializer: S) -> Result<S::Ok, S::Error> {
    scrub_launch_secrets(env.clone()).serialize(serializer)
}

fn deserialize_launch_env<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<HashMap<String, String>>, D::Error> {
    Option::<HashMap<String, String>>::deserialize(deserializer).map(scrub_launch_secrets)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaneTabConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_account_id: Option<String>,
    #[serde(default)]
    pub tab_id: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    pub agent_id: String,
    pub label: Option<String>,
    /// Who set `label`: "user", "ai", or a scripted "launch". Unknown/absent
    /// provenance is handled conservatively by the naming frontend.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label_source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name_source: Option<String>,
    #[serde(default)]
    pub r#type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preset_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub html_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview_path: Option<String>,
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
    #[serde(default, serialize_with = "serialize_launch_env", deserialize_with = "deserialize_launch_env")]
    pub launch_env: Option<HashMap<String, String>>,
    #[serde(default)]
    pub terminal_snapshot: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "skip_turn_marks")]
    pub turn_marks: Option<Vec<TurnMarkPersistConfig>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lifecycle: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<PaneTabOriginConfig>,
    #[serde(default, deserialize_with = "optional_delegation_id", skip_serializing_if = "Option::is_none")]
    pub delegated_by_tab_id: Option<String>,
    #[serde(default, deserialize_with = "optional_delegation_id", skip_serializing_if = "Option::is_none")]
    pub delegated_by_agent_session_id: Option<String>,
    #[serde(default, deserialize_with = "optional_delegation_timestamp", skip_serializing_if = "Option::is_none")]
    pub delegated_at: Option<i64>,
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
    #[serde(default, serialize_with = "serialize_launch_env", deserialize_with = "deserialize_launch_env")]
    pub launch_env: Option<HashMap<String, String>>,
    #[serde(default)]
    pub active_tab_id: Option<String>,
    #[serde(default)]
    pub pinned_tab_id: Option<String>,
    #[serde(default)]
    pub tabs: Option<Vec<PaneTabConfig>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetachedPaneOriginConfig {
    pub workspace_id: String,
    pub pane_id: String,
    pub tab_id: String,
    pub index: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub column: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub row: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub column_size: Option<usize>,
}

/// Where a detached workspace's window sat, in logical pixels.
///
/// Written by the save path from the live window rather than by the frontend:
/// only Rust can read another window's frame, and the window that owns the
/// workspace is the one that knows where it is. Read at startup to open the
/// window again where the user left it (2026-09-17).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WindowFrameConfig {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Optional window ownership added without changing schema 1. Older readers
/// ignore it and can still open every workspace in their main window.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WindowGroupConfig {
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decorated: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_tearout: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub maximized: Option<bool>,
    // New frames use the inner size accepted by Tauri's window builder. The
    // legacy window_frame remains an outer frame for downgrade compatibility.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frame: Option<WindowFrameConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_workspace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_pane_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_tab_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_group: Option<WindowGroupConfig>,
    #[serde(default)]
    pub detached: Option<bool>,
    #[serde(default)]
    pub detached_from: Option<DetachedPaneOriginConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_frame: Option<WindowFrameConfig>,
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name_source: Option<String>,
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
    // Which dividers the user dragged. Added 2026-09-16 without a schema bump:
    // data.json files written before it simply have no pins, which reads as
    // "nothing was ever dragged" on the frontend.
    #[serde(default)]
    pub column_divider_pins: Option<Vec<bool>>,
    #[serde(default)]
    pub row_divider_pins_per_col: Option<Vec<Vec<bool>>>,
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
    "none".to_string()
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
    #[serde(default)]
    pub auto_workspace_naming_enabled: Option<bool>,
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
    #[serde(default = "default_pet_display_mode")]
    pub pet_display_mode: String,
    #[serde(default = "default_pet_new_ws_mode")]
    pub pet_new_ws_mode: String,
    #[serde(default)]
    pub pet_disabled: Vec<String>,
    #[serde(default)]
    pub pet_fixed_id: Option<String>,
    /// Frontend-owned, versioned random cycle. Unknown bags remain repairable.
    #[serde(default)]
    pub pet_random_bag: Option<serde_json::Value>,
    /// Yen per US dollar used by the AI log money display. Unit prices stay
    /// in USD; the renderer multiplies at format time.
    #[serde(default = "default_ailog_usd_jpy_rate")]
    pub ailog_usd_jpy_rate: f64,
    /// Optional durable full-text transcript mirror. An explicit null disables
    /// Tier 2 while the metadata-only local mirror continues.
    #[serde(default = "default_ailog_mirror_full_text_root")]
    pub ailog_mirror_full_text_root: Option<String>,
    /// Read-only fallback for missing Claude project transcripts. Empty disables it.
    #[serde(default)]
    pub ailog_claude_fallback_root: Option<String>,
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
            auto_workspace_naming_enabled: None,
            reply_draft_suggestions_enabled: None,
            dirty_save_mode: true,
            osc7_tracking_enabled: true,
            pet_display_mode: default_pet_display_mode(),
            pet_new_ws_mode: default_pet_new_ws_mode(),
            pet_disabled: Vec::new(),
            pet_fixed_id: None,
            pet_random_bag: None,
            ailog_usd_jpy_rate: default_ailog_usd_jpy_rate(),
            ailog_mirror_full_text_root: default_ailog_mirror_full_text_root(),
            ailog_claude_fallback_root: None,
        }
    }
}

// NOTE: no `deny_unknown_fields` here on purpose. Retired keys (the former
// `pinned_roots`, dropped with the file-explorer sidebar; `remote_enabled` and
// `remote_bind_all`, dropped with the built-in phone server in 2026-09) can
// still be present in an existing data.json; serde must ignore them rather
// than fail the whole load.
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct LayoutCounts {
    pub workspaces: usize,
    pub tabs: usize,
}

impl PersistentData {
    pub(crate) fn layout_counts(&self) -> LayoutCounts {
        LayoutCounts {
            workspaces: self.workspaces.len(),
            tabs: self.workspaces.iter().flat_map(|workspace| &workspace.panes)
                .map(|pane| pane.tabs.as_ref().map_or(1, Vec::len))
                .sum(),
        }
    }
}

pub(crate) fn large_tab_drop(before: usize, after: usize) -> bool {
    before >= 4 && after <= (before - 1) / 2
}

impl LayoutCounts {
    fn shrank_to(self, after: Self) -> bool {
        large_tab_drop(self.tabs, after.tabs) || (self.workspaces >= 3 && after.workspaces <= 1)
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

const RUN_IN_PROGRESS: &[u8] = b"running\n";
const COORDINATED_QUIT: &[u8] = b"coordinated-quit\n";

fn write_run_marker(path: &Path, status: &[u8]) -> Result<(), String> {
    crate::util::atomic_write::AtomicWrite::new("run marker", "Failed to install run marker")
        .write_bytes(path, status)
}

fn start_run_marker(path: &Path) -> Result<bool, String> {
    let previous = match fs::read(path) {
        Ok(contents) => contents == RUN_IN_PROGRESS,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(format!("Failed to read run marker: {error}")),
    };
    write_run_marker(path, RUN_IN_PROGRESS)?;
    Ok(previous)
}

pub(crate) fn record_run_start(app: &tauri::AppHandle) {
    match data_path(app).and_then(|data| start_run_marker(&data.with_file_name("persist-run"))) {
        Ok(true) => crate::diag::log("[persist] previous run ended without a coordinated quit"),
        Ok(false) => {}
        Err(error) => crate::diag_warn!("persist", "{error}"),
    }
}

pub(crate) fn record_coordinated_quit(app: &tauri::AppHandle) {
    if let Err(error) = data_path(app)
        .and_then(|data| write_run_marker(&data.with_file_name("persist-run"), COORDINATED_QUIT))
    {
        crate::diag_warn!("persist", "{error}");
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

fn timestamp_nanos(now: SystemTime) -> u128 {
    now.duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default()
}

fn backup_path_for(path: &Path, reason: &str) -> PathBuf {
    let timestamp = timestamp_nanos(SystemTime::now());
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("data.json");

    path.with_file_name(format!(
        "{file_name}.{reason}-{timestamp}-{}.bak",
        std::process::id()
    ))
}

fn pre_replace_backup_stamp<'a>(path: &Path, candidate: &'a Path) -> Option<&'a str> {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("data.json");
    candidate.file_name()?.to_str()?
        .strip_prefix(&format!("{file_name}.pre-replace-"))?
        .strip_suffix(".bak")
}

fn deferred_shrink_backup_timestamp(path: &Path, backup: &Path) -> Option<u128> {
    let stamp = pre_replace_backup_stamp(path, backup)?.strip_prefix("shrink-")?;
    parse_backup_timestamp(stamp)
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
        .filter(|candidate| pre_replace_backup_stamp(path, candidate).is_some())
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

fn cleanup_old_pre_replace_backups(path: &Path, keep: &Path, archive_available: bool) {
    const MAX_DEFERRED_SHRINK_BACKUPS: usize = 20;
    let mut backups: Vec<_> = pre_replace_backups(path)
        .into_iter()
        .filter(|backup| backup != keep)
        .map(|backup| (deferred_shrink_backup_timestamp(path, &backup), backup))
        .collect();
    backups.sort_unstable_by(|left, right| right.cmp(left));
    // The just-written copy is protected even if the system clock moved back.
    let mut deferred_count = usize::from(deferred_shrink_backup_timestamp(path, keep).is_some());
    for (deferred_timestamp, backup) in backups {
        if let Some(timestamp) = deferred_timestamp {
            // A fresh generation can contain a smaller layout, so archive the
            // original bytes before releasing protection for this copy.
            let archived = archive_available
                && archive_layout_from(&backup, path, BackupKind::Shrink, timestamp)
                    .inspect_err(|error| {
                        crate::diag_warn!("persist", "could not archive the protected pre-replace backup: {error}");
                    })
                    .is_ok();
            if !archived && deferred_count < MAX_DEFERRED_SHRINK_BACKUPS {
                deferred_count += 1;
                continue;
            }
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

fn read_data_file(path: &Path) -> std::io::Result<String> {
    let mut contents = fs::read_to_string(path)?;
    if contents.starts_with('\u{feff}') {
        contents.drain(..'\u{feff}'.len_utf8());
    }
    Ok(contents)
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
    let contents = read_data_file(path)
        .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
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

#[cfg(test)]
thread_local! {
    static FAIL_NEXT_LAYOUT_COPY: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

#[cfg(test)]
fn fail_layout_copy_partway(source: &Path, file: &mut File) -> Result<(), String> {
    use std::io::Read;
    let mut prefix = File::open(source).unwrap().take(1);
    assert_eq!(std::io::copy(&mut prefix, file).unwrap(), 1);
    Err("injected partial layout copy failure".into())
}

fn copy_layout_file(source: &Path, target: &Path) -> Result<(), String> {
    crate::util::atomic_write::AtomicWrite::new("layout backup", "Failed to install layout backup")
        .create_parents()
        .write_with(target, |file| {
            #[cfg(test)]
            if FAIL_NEXT_LAYOUT_COPY.with(|failure| failure.replace(false)) {
                return fail_layout_copy_partway(source, file);
            }
            let mut source_file = File::open(source)
                .map_err(|error| format!("Failed to open {}: {error}", source.display()))?;
            std::io::copy(&mut source_file, file)
                .map_err(|error| format!("Failed to copy {}: {error}", source.display()))?;
            Ok(())
        })
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum BackupKind {
    Generation,
    Shrink,
}

impl BackupKind {
    fn prefix(self) -> &'static str {
        match self {
            Self::Generation => "data",
            Self::Shrink => "shrink",
        }
    }
}

struct LayoutBackup {
    path: PathBuf,
    timestamp: u128,
    kind: BackupKind,
}

fn archive_layout(path: &Path, kind: BackupKind, now: SystemTime) -> Result<PathBuf, String> {
    archive_layout_from(path, path, kind, timestamp_nanos(now))
}

fn archive_layout_from(
    source: &Path, path: &Path, kind: BackupKind, mut timestamp: u128,
) -> Result<PathBuf, String> {
    let directory = path.with_file_name("data-backups");
    let kind = kind.prefix();
    let pid = std::process::id();
    let mut target = directory.join(format!("{kind}-{timestamp}-{pid}.json"));
    while target.exists() {
        timestamp += 1;
        target = directory.join(format!("{kind}-{timestamp}-{pid}.json"));
    }
    copy_layout_file(source, &target)?;
    Ok(target)
}

fn parse_backup_timestamp(name: &str) -> Option<u128> {
    let (time, pid) = name.split_once('-')?;
    pid.parse::<u32>().ok()?;
    time.parse().ok()
}

fn layout_backups(path: &Path) -> Vec<LayoutBackup> {
    let directory = path.with_file_name("data-backups");
    let Ok(entries) = fs::read_dir(&directory) else {
        return Vec::new();
    };
    let mut backups: Vec<_> = entries.filter_map(|entry| {
        let entry = entry.ok()?;
        if !entry.file_type().ok()?.is_file() { return None; }
        let file_name = entry.file_name();
        let (prefix, stamp) = file_name.to_str()?.strip_suffix(".json")?.split_once('-')?;
        let kind = match prefix {
            "data" => BackupKind::Generation,
            "shrink" => BackupKind::Shrink,
            _ => return None,
        };
        let timestamp = parse_backup_timestamp(stamp)?;
        Some(LayoutBackup { path: entry.path(), timestamp, kind })
    }).collect();
    backups.sort_unstable_by(|a, b| b.timestamp.cmp(&a.timestamp).then_with(|| b.path.cmp(&a.path)));
    backups
}

fn prune_layout_backups(path: &Path, now: SystemTime) {
    const HOUR: u128 = 3_600_000_000_000;
    const DAY: u128 = 24 * HOUR;
    let now = timestamp_nanos(now);
    let mut generations = 0;
    let mut shrinks = 0;
    let mut hours = HashSet::new();
    let mut days = HashSet::new();
    for backup in layout_backups(path) {
        let age = now.saturating_sub(backup.timestamp);
        let keep = match backup.kind {
            BackupKind::Shrink => {
                let keep = shrinks < 50 && age <= 30 * DAY;
                shrinks += 1;
                keep
            }
            BackupKind::Generation => {
                let latest = generations < 20;
                generations += 1;
                let hourly = age <= 48 * HOUR && hours.insert(backup.timestamp / HOUR);
                let daily = age <= 14 * DAY && days.insert(backup.timestamp / DAY);
                latest || hourly || daily
            }
        };
        if !keep {
            if let Err(error) = fs::remove_file(&backup.path) {
                crate::diag_warn!("storage", "failed to remove old layout backup {}: {error}", backup.path.display());
            }
        }
    }
}

fn recovery_backups(path: &Path) -> Vec<PathBuf> {
    let legacy = pre_replace_backups(path).into_iter().map(|backup| {
        let timestamp = pre_replace_backup_stamp(path, &backup)
            .map(|stamp| stamp.strip_prefix("shrink-").unwrap_or(stamp))
            .and_then(parse_backup_timestamp)
            .or_else(|| backup.metadata().ok()?.modified().ok().map(timestamp_nanos))
            .unwrap_or_default();
        (timestamp, backup)
    });
    let mut backups: Vec<_> = layout_backups(path).into_iter()
        .map(|backup| (backup.timestamp, backup.path))
        .chain(legacy)
        .collect();
    backups.sort_unstable_by(|a, b| b.cmp(a));
    backups.into_iter().map(|(_, backup)| backup).collect()
}

fn recover_from_pre_replace_backup(
    path: &Path,
    reason: &str,
) -> Result<Option<PersistentDataEnvelope>, String> {
    for backup_path in recovery_backups(path) {
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
        copy_layout_file(&backup_path, path)?;
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

fn recover_unusable_data(path: &Path, reason: &str) -> Result<PersistentDataEnvelope, String> {
    if let Some(envelope) = recover_from_pre_replace_backup(path, reason)? {
        return Ok(envelope);
    }
    if reason != "missing" {
        quarantine_data_file(path, reason)?;
    }
    Ok(PersistentDataEnvelope::supported(PersistentData::default()))
}

fn load_envelope_from_path(path: &Path) -> Result<PersistentDataEnvelope, String> {
    let contents = match read_data_file(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return recover_unusable_data(path, "missing");
        }
        Err(error) if error.kind() == std::io::ErrorKind::InvalidData => {
            return recover_unusable_data(path, "corrupt");
        }
        Err(error) => return Err(format!("Failed to read {}: {error}", path.display())),
    };

    if contents.trim().is_empty() {
        return recover_unusable_data(path, "empty");
    }

    // Probe the schema before deserializing the current struct. A future
    // schema may be valid JSON while intentionally changing required fields;
    // it must never fall into the corrupt-file recovery path.
    match schema_version_from_contents(path, &contents) {
        Ok(schema_version) if schema_version != CURRENT_SCHEMA_VERSION => {
            return Ok(PersistentDataEnvelope::unsupported(schema_version));
        }
        Ok(_) => {}
        Err(_) => return recover_unusable_data(path, "corrupt"),
    }

    match serde_json::from_str::<PersistentData>(&contents) {
        Ok(data) => Ok(PersistentDataEnvelope::supported(data)),
        Err(_) => recover_unusable_data(path, "corrupt"),
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

fn replace_data_file(
    path: &Path,
    tmp_path: &Path,
    now: SystemTime,
    layout_reduced: bool,
    shrink: Option<(LayoutCounts, LayoutCounts)>,
) -> Result<(), String> {
    let shrink_backup = shrink.and_then(|(before, after)| {
        match archive_layout(path, BackupKind::Shrink, now) {
            Ok(backup) => Some((before, after, backup)),
            Err(error) => {
                crate::diag_warn!("persist", "could not keep the layout before shrink: {error}");
                None
            }
        }
    });
    let mut archive_available = shrink_backup.is_some();
    let backup_path = if path.exists() {
        let reason = if shrink.is_some() && shrink_backup.is_none() {
            "pre-replace-shrink"
        } else {
            "pre-replace"
        };
        let backup_path = backup_path_for(path, reason);
        copy_layout_file(path, &backup_path)?;
        let keep_generation = layout_reduced
            || layout_backups(path)
                .into_iter()
                .find(|backup| backup.kind == BackupKind::Generation)
                .is_none_or(|backup| {
                    timestamp_nanos(now).saturating_sub(backup.timestamp)
                        >= Duration::from_secs(60).as_nanos()
                });
        if keep_generation {
            match archive_layout(path, BackupKind::Generation, now) {
                Ok(_) => archive_available = true,
                Err(error) => crate::diag_warn!("persist", "could not keep layout backup generation: {error}"),
            }
        }
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
        cleanup_old_pre_replace_backups(path, backup_path, archive_available);
    }
    prune_layout_backups(path, now);
    if let Some((before, after, backup)) = shrink_backup {
        crate::diag::log(&format!(
            "[persist] shrink tabs {}->{} workspaces {}->{} kept {}",
            before.tabs, after.tabs, before.workspaces, after.workspaces, backup.display()
        ));
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
    save_preflighted_to_path(path, data, SystemTime::now(), false, None)
}

fn save_preflighted_to_path(
    path: &Path,
    data: &PersistentData,
    now: SystemTime,
    layout_reduced: bool,
    shrink: Option<(LayoutCounts, LayoutCounts)>,
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
    let timestamp = timestamp_nanos(now);
    let tmp_path = path.with_file_name(format!(
        "{file_name}.tmp-{}-{timestamp}",
        std::process::id()
    ));
    let json = serde_json::to_string(data).map_err(|error| {
        PersistentStorageError::storage(format!("Failed to serialize data: {error}"))
    })?;

    write_json_file(&tmp_path, &json).map_err(PersistentStorageError::from)?;
    replace_data_file(path, &tmp_path, now, layout_reduced, shrink)
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
    update_reporting_layout(target, updater, |_| {})
}

pub(crate) fn update_reporting_layout<T, F>(
    target: &T,
    updater: F,
    report: impl FnOnce(LayoutCounts),
) -> Result<(), PersistentStorageError>
where
    T: PersistentDataTarget + ?Sized,
    F: FnOnce(&mut PersistentData),
{
    ensure_persistence_write_platform_supported()?;
    let _guard = save_lock().lock().map_err(|error| {
        PersistentStorageError::storage(format!("Failed to lock data file: {error}"))
    })?;
    let _process_guard = interprocess_data_lock::acquire().map_err(PersistentStorageError::from)?;
    let counts = update_while_locked(target, SystemTime::now(), updater)?;
    report(counts);
    Ok(())
}

fn save_lock_until(lock: &Mutex<()>, deadline: Instant) -> Result<std::sync::MutexGuard<'_, ()>, PersistentStorageError> {
    loop {
        match lock.try_lock() {
            Ok(guard) => return Ok(guard),
            Err(std::sync::TryLockError::Poisoned(error)) => return Err(PersistentStorageError::storage(format!("Failed to lock data file: {error}"))),
            Err(std::sync::TryLockError::WouldBlock) => {}
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() { return Err(PersistentStorageError::storage("Timed out waiting for shutdown data-file lock")); }
        std::thread::sleep(Duration::from_millis(5).min(remaining));
    }
}

/// Ordinary autosaves keep their 30-second interprocess timeout. Only the
/// last-chance exit writer abandons lock contention after at most 100 ms.
pub(crate) fn update_for_shutdown<T, F>(target: &T, deadline: Instant, updater: F) -> Result<(), PersistentStorageError>
where T: PersistentDataTarget + ?Sized, F: FnOnce(&mut PersistentData),
{
    ensure_persistence_write_platform_supported()?;
    let lock_deadline = deadline.min(Instant::now() + Duration::from_millis(100));
    let _guard = save_lock_until(save_lock(), lock_deadline)?;
    let _process_guard = interprocess_data_lock::acquire_with_timeout(lock_deadline.saturating_duration_since(Instant::now()))
        .map_err(PersistentStorageError::from)?;
    if Instant::now() >= deadline { return Err(PersistentStorageError::storage("Shutdown save budget expired")); }
    update_while_locked(target, SystemTime::now(), updater).map(|_| ())
}

fn update_while_locked<T, F>(target: &T, now: SystemTime, updater: F) -> Result<LayoutCounts, PersistentStorageError>
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
    let before = data.layout_counts();
    updater(&mut data);
    let after = data.layout_counts();
    let layout_reduced = after.tabs < before.tabs || after.workspaces < before.workspaces;
    let shrink = before.shrank_to(after).then_some((before, after));
    if let Some(schema_version) = quarantined_schema_version() {
        return Err(PersistentStorageError::unsupported_schema(schema_version));
    }
    save_preflighted_to_path(&path, &data, now, layout_reduced, shrink)?;
    Ok(after)
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
    update_while_locked(target, SystemTime::now(), updater).map(|_| ())
}

#[cfg(test)]
mod tests {
    #[test]
    fn h7_invalid_auxiliary_delegation_fields_do_not_quarantine_a_valid_layout() {
        use super::*;
        let original: serde_json::Value = serde_json::from_str(include_str!("../../../tests/fixtures/livebrief_autonomy/delegation-layout.json")).unwrap();
        let baseline: PersistentData = serde_json::from_value(original.clone()).unwrap();
        let rows: Vec<serde_json::Value> = serde_json::from_str(include_str!("../../../tests/fixtures/livebrief_autonomy/delegation-invalid-values.json")).unwrap();
        for row in rows {
            let mut input = original.clone();
            let target = &mut input["workspaces"][0]["panes"][0]["tabs"][0];
            if row["name"] == "missing" {
                for field in row["remove"].as_array().unwrap() { target.as_object_mut().unwrap().remove(field.as_str().unwrap()); }
            }
            if let Some(patch) = row["patch"].as_object() {
                for (field, value) in patch { target[field] = value.clone(); }
            }
            let mut expected = serde_json::to_value(&baseline).unwrap();
            for field in row["remove"].as_array().unwrap() {
                expected["workspaces"][0]["panes"][0]["tabs"][0].as_object_mut().unwrap().remove(field.as_str().unwrap());
            }
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("data.json");
            let bytes = serde_json::to_vec(&input).unwrap();
            fs::write(&path, &bytes).unwrap();
            // Actual file loader, no valid backup: one bad fact must not default
            // the layout, quarantine the file, or restore an older whole layout.
            let loaded = load_envelope_from_path(&path).unwrap();
            assert!(loaded.supported);
            assert_eq!(serde_json::to_value(loaded.data.unwrap()).unwrap(), expected, "{}", row["name"]);
            assert_eq!(fs::read(&path).unwrap(), bytes);
            assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
        }
        let mut invalid_required = original;
        invalid_required["workspaces"][0]["panes"][0]["tabs"][0]["agent_id"] = serde_json::json!(7);
        assert!(serde_json::from_value::<PersistentData>(invalid_required).is_err(), "only delegation metadata is tolerant");
    }

    #[test]
    fn profile_mutex_names_are_distinct_and_case_equivalent_windows_paths_share_a_lock() {
        use super::*;
        let names: std::collections::HashSet<_> = [None, Some("default"), Some("one"), Some("two")]
            .into_iter().map(|profile| data_mutex_name(profile, None)).collect();
        assert_eq!(names.len(), 4);
        assert_eq!(data_mutex_name(Some("Test"), None), data_mutex_name(Some("test"), None));
        assert_ne!(data_mutex_name(Some("test"), None), data_mutex_name(Some("test"), Some(123)));
    }

    #[test]
    fn shutdown_save_abandons_an_inprocess_mutex_held_by_another_thread_without_writing() {
        use super::*;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data.json");
        let original = br#"{"schema_version":999,"canary":"unchanged"}"#;
        fs::write(&path, original).unwrap();
        let (held_tx, held_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let owner = std::thread::spawn(move || {
            let _guard = save_lock().lock().unwrap();
            held_tx.send(()).unwrap();
            release_rx.recv_timeout(Duration::from_secs(3)).unwrap();
        });
        held_rx.recv_timeout(Duration::from_secs(3)).unwrap();
        let started = Instant::now();
        let result = update_for_shutdown(path.as_path(), started + Duration::from_millis(60), |_| panic!("must not update"));
        release_tx.send(()).unwrap();
        owner.join().unwrap();
        assert!(result.unwrap_err().to_string().contains("Timed out"));
        assert!(started.elapsed() < Duration::from_millis(500));
        assert_eq!(fs::read(&path).unwrap(), original);
    }

    #[cfg(unix)]
    #[test]
    fn shutdown_interprocess_lock_uses_a_short_timeout_while_normal_acquire_remains_available() {
        use super::*;
        let dir = tempfile::tempdir().unwrap();
        let (held_tx, held_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        std::thread::scope(|scope| {
            let root = dir.path();
            let owner = scope.spawn(move || {
                let _guard = interprocess_data_lock::acquire_for_runtime_dir(root).unwrap();
                held_tx.send(()).unwrap();
                release_rx.recv_timeout(Duration::from_secs(2)).unwrap();
            });
            held_rx.recv_timeout(Duration::from_secs(2)).unwrap();
            let started = Instant::now();
            assert!(interprocess_data_lock::acquire_at_with_timeout(root, Duration::from_millis(35)).is_err());
            assert!(started.elapsed() < Duration::from_millis(500));
            release_tx.send(()).unwrap();
            owner.join().unwrap();
            assert!(interprocess_data_lock::acquire_for_runtime_dir(root).is_ok());
        });
    }
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
    fn app_settings_preserve_saved_pet_display_modes() {
        for mode in ["ws", "both", "none"] {
            let settings: AppSettings = serde_json::from_value(serde_json::json!({
                "font_size": 14, "theme_id": "yoru-cafe", "pet_display_mode": mode
            }))
            .unwrap();
            assert_eq!(settings.pet_display_mode, mode);
        }
    }

    #[test]
    fn app_settings_missing_pet_settings_use_defaults() {
        let settings: AppSettings =
            serde_json::from_str(r#"{"font_size":14,"theme_id":"yoru-cafe"}"#).unwrap();

        assert_eq!(settings.pet_display_mode, "none");
        assert_eq!(AppSettings::default().pet_display_mode, "none");
        assert_eq!(settings.pet_new_ws_mode, "random");
        assert!(settings.pet_disabled.is_empty());
        assert!(settings.pet_fixed_id.is_none());
        assert!(settings.pet_random_bag.is_none());
    }

    #[test]
    fn pet_random_bag_and_legacy_random_mode_round_trip() {
        let value = serde_json::json!({
            "font_size": 14, "theme_id": "yoru-cafe", "pet_new_ws_mode": "random-repeat",
            "pet_random_bag": {"version": 1, "candidates": ["clawd", "external:sample"], "remaining": ["external:sample"]}
        });
        let settings: AppSettings = serde_json::from_value(value.clone()).unwrap();
        let saved = serde_json::to_value(settings).unwrap();
        assert_eq!(saved["pet_new_ws_mode"], value["pet_new_ws_mode"]);
        assert_eq!(saved["pet_random_bag"], value["pet_random_bag"]);
    }

    #[test]
    fn unknown_pet_random_bag_does_not_block_settings_restore() {
        let settings: AppSettings = serde_json::from_value(serde_json::json!({
            "font_size": 14, "theme_id": "yoru-cafe", "pet_random_bag": {"version": 99}
        })).unwrap();
        assert_eq!(settings.pet_random_bag.unwrap()["version"], 99);
        assert_eq!(settings.pet_new_ws_mode, "random");
    }

    #[test]
    fn app_settings_missing_ailog_usd_jpy_rate_uses_default() {
        let settings: AppSettings =
            serde_json::from_str(r#"{"font_size":14,"theme_id":"yoru-cafe"}"#).unwrap();

        assert_eq!(settings.ailog_usd_jpy_rate, DEFAULT_AILOG_USD_JPY_RATE);
        assert_eq!(settings.ailog_claude_fallback_root,None);
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

    /// Every install that ran the built-in phone server still has its two
    /// keys in data.json. They were dropped from `AppSettings` in 2026-09, so
    /// the load must ignore them instead of failing the whole file.
    #[test]
    fn retired_remote_keys_do_not_fail_the_load() {
        let temp_dir = tempfile::tempdir().unwrap();
        let path = temp_dir.path().join("data.json");

        fs::write(
            &path,
            r#"{"schema_version":1,"workspaces":[],"settings":{"font_size":17,"theme_id":"yoru-cafe","remote_enabled":true,"remote_bind_all":true}}"#,
        )
        .unwrap();

        let loaded = load_from_path(&path).unwrap();
        assert_eq!(loaded.settings.font_size, 17);
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
    fn run_marker_distinguishes_a_coordinated_quit_from_an_unfinished_run() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("persist-run");
        assert!(!start_run_marker(&marker).unwrap());
        assert!(start_run_marker(&marker).unwrap());
        write_run_marker(&marker, COORDINATED_QUIT).unwrap();
        assert!(!start_run_marker(&marker).unwrap());
        assert_eq!(fs::read(marker).unwrap(), RUN_IN_PROGRESS);
    }

    fn layout_with_tab_counts(counts: &[usize]) -> Vec<WorkspaceConfig> {
        counts.iter().enumerate().map(|(workspace, count)| {
            let tabs: Vec<_> = (0..*count).map(|tab| serde_json::json!({
                "agent_id": "shell", "tab_id": format!("tab-{workspace}-{tab}"),
            })).collect();
            serde_json::from_value(serde_json::json!({
                "id": format!("workspace-{workspace}"), "name": "Workspace",
                "grid_template_id": "1x1", "created_at": 0,
                "panes": [{"agent_id": "shell", "tabs": tabs}],
            })).unwrap()
        }).collect()
    }

    #[test]
    fn shrink_save_preserves_the_previous_bytes_and_continues_saving() {
        let _serial = persistence_test_lock();
        reset_quarantined_schema_for_test();
        for (before, after, expected_backups) in [
            (&[5][..], &[2][..], 1),
            (&[1, 1, 1][..], &[1][..], 1),
            (&[4][..], &[2][..], 0),
            (&[3][..], &[1][..], 0),
            (&[1, 1, 1][..], &[1, 1][..], 0),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("data.json");
            save_to_path(&path, &PersistentData {
                workspaces: layout_with_tab_counts(before),
                ..Default::default()
            }).unwrap();
            let original = fs::read(&path).unwrap();

            update(path.as_path(), |data| {
                data.workspaces = layout_with_tab_counts(after);
            }).unwrap();

            let current = load_from_path(&path).unwrap();
            let counts: Vec<_> = current.workspaces.iter().map(|workspace| {
                workspace.panes[0].tabs.as_ref().unwrap().len()
            }).collect();
            assert_eq!(counts, after);
            let shrink: Vec<_> = fs::read_dir(dir.path().join("data-backups"))
                .into_iter().flatten().flatten()
                .filter(|entry| entry.file_name().to_string_lossy().starts_with("shrink-"))
                .collect();
            assert_eq!(shrink.len(), expected_backups, "{before:?} -> {after:?}");
            if let Some(backup) = shrink.first() {
                assert_eq!(fs::read(backup.path()).unwrap(), original);
            }
            assert_eq!(pre_replace_backups(&path).len(), 1);
        }
    }

    #[test]
    fn shrink_backup_failure_keeps_the_pre_replace_copy_across_saves() {
        let _serial = persistence_test_lock();
        reset_quarantined_schema_for_test();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data.json");
        let archive_dir = path.with_file_name("data-backups");
        fs::write(&archive_dir, b"archive directory is blocked").unwrap();
        save_to_path(&path, &PersistentData {
            workspaces: layout_with_tab_counts(&[5]),
            ..Default::default()
        }).unwrap();
        let original = fs::read(&path).unwrap();

        update(path.as_path(), |data| data.workspaces = layout_with_tab_counts(&[2])).unwrap();
        assert_eq!(load_from_path(&path).unwrap().layout_counts().tabs, 2);
        assert_eq!(pre_replace_backups(&path).len(), 1);

        update(path.as_path(), |data| data.active_workspace_id = Some("workspace-0".into())).unwrap();
        let current = load_from_path(&path).unwrap();
        assert_eq!(current.active_workspace_id.as_deref(), Some("workspace-0"));
        assert!(pre_replace_backups(&path).iter().any(|backup| {
            fs::read(backup).unwrap() == original
        }), "the next save removed the only copy of the five-tab layout");

        fs::rename(&archive_dir, path.with_file_name("previous-backup-blocker")).unwrap();
        update(path.as_path(), |data| data.active_workspace_id = None).unwrap();
        assert_eq!(pre_replace_backups(&path).len(), 1);
        assert!(layout_backups(&path).iter().any(|backup| {
            backup.kind == BackupKind::Shrink && fs::read(&backup.path).unwrap() == original
        }), "reopening the archive directory must retain the five-tab copy");
    }

    #[test]
    fn failed_shrink_archives_keep_the_twenty_newest_pre_replace_backups() {
        let _serial = persistence_test_lock();
        reset_quarantined_schema_for_test();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data.json");
        fs::write(path.with_file_name("data-backups"), b"archive directory is blocked").unwrap();

        let mut originals = Vec::new();
        for generation in 0..22 {
            update(path.as_path(), |data| {
                data.workspaces = layout_with_tab_counts(&[5]);
                data.workspaces[0].name = format!("Before shrink {generation}");
            }).unwrap();
            originals.push(fs::read(&path).unwrap());
            update(path.as_path(), |data| data.workspaces = layout_with_tab_counts(&[2])).unwrap();
        }
        assert_eq!(load_from_path(&path).unwrap().layout_counts().tabs, 2);

        let retained: HashSet<_> = pre_replace_backups(&path)
            .into_iter()
            .filter(|backup| pre_replace_backup_stamp(&path, backup).unwrap().starts_with("shrink-"))
            .map(|backup| fs::read(backup).unwrap())
            .collect();
        assert_eq!(retained.len(), 20);
        assert_eq!(retained, originals.into_iter().skip(2).collect());
    }

    #[test]
    fn partial_shrink_copy_cannot_displace_twenty_valid_backups() {
        let _serial = persistence_test_lock();
        reset_quarantined_schema_for_test();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data.json");
        let archive_dir = path.with_file_name("data-backups");
        fs::write(&archive_dir, b"archive directory is blocked").unwrap();

        let mut originals = HashSet::new();
        for generation in 0..20 {
            update(path.as_path(), |data| {
                data.workspaces = layout_with_tab_counts(&[5]);
                data.workspaces[0].name = format!("Before shrink {generation}");
            }).unwrap();
            originals.insert(fs::read(&path).unwrap());
            update(path.as_path(), |data| data.workspaces = layout_with_tab_counts(&[2])).unwrap();
        }
        assert_eq!(originals.len(), 20);
        assert_eq!(pre_replace_backups(&path).len(), 20);

        update(path.as_path(), |data| data.workspaces = layout_with_tab_counts(&[5])).unwrap();
        let live = fs::read(&path).unwrap();
        let files_before: HashSet<_> = fs::read_dir(dir.path()).unwrap()
            .map(|entry| entry.unwrap().file_name()).collect();
        let candidates_before = recovery_backups(&path);
        FAIL_NEXT_LAYOUT_COPY.with(|failure| failure.set(true));
        let error = update(path.as_path(), |data| data.workspaces = layout_with_tab_counts(&[2]))
            .unwrap_err();
        assert!(error.to_string().contains("injected partial layout copy failure"));
        assert_eq!(fs::read(&path).unwrap(), live);
        let files_after: HashSet<_> = fs::read_dir(dir.path()).unwrap()
            .map(|entry| entry.unwrap().file_name()).collect();
        let candidates_after = recovery_backups(&path);

        update(path.as_path(), |data| data.active_workspace_id = Some("workspace-0".into())).unwrap();
        let retained: HashSet<_> = pre_replace_backups(&path).into_iter()
            .filter(|backup| deferred_shrink_backup_timestamp(&path, backup).is_some())
            .map(|backup| fs::read(backup).unwrap()).collect();

        fs::rename(&archive_dir, path.with_file_name("previous-backup-blocker")).unwrap();
        update(path.as_path(), |data| data.active_workspace_id = None).unwrap();
        let archived: HashSet<_> = layout_backups(&path).into_iter()
            .filter(|backup| backup.kind == BackupKind::Shrink)
            .map(|backup| fs::read(backup.path).unwrap()).collect();

        assert_eq!(
            (files_after == files_before, candidates_after == candidates_before,
                retained.len(), retained.intersection(&originals).count(),
                archived.len(), archived.intersection(&originals).count()),
            (true, true, 20, 20, 20, 20),
            "a failed copy must leave no file or recovery candidate and all twenty valid backups must survive both saves",
        );
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

        replace_data_file(&path, &tmp_path, SystemTime::now(), false, None).unwrap();

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
    fn generation_backups_wait_sixty_seconds_unless_layout_counts_decrease() {
        let _serial = persistence_test_lock();
        reset_quarantined_schema_for_test();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data.json");
        let data = PersistentData {
            workspaces: layout_with_tab_counts(&[15, 15]),
            ..Default::default()
        };
        save_to_path(&path, &data).unwrap();

        let start = UNIX_EPOCH + Duration::from_secs(120);
        let mut expected = HashMap::new();
        for (seconds, tab_counts, keep_generation) in [
            (0, &[15, 15][..], true),
            (59, &[15, 15][..], false),
            (60, &[15, 15][..], true),
            (61, &[8, 8][..], true),
            (62, &[16][..], true),
            (70, &[16][..], false),
        ] {
            let now = start + Duration::from_secs(seconds);
            let before = fs::read(&path).unwrap();
            update_while_locked(path.as_path(), now, |data| {
                data.workspaces = layout_with_tab_counts(tab_counts);
            })
            .unwrap();
            if keep_generation {
                expected.insert(timestamp_nanos(now), before);
            }

            let actual: HashMap<_, _> = layout_backups(&path)
                .into_iter()
                .map(|backup| {
                    assert!(backup.kind == BackupKind::Generation);
                    (backup.timestamp, fs::read(backup.path).unwrap())
                })
                .collect();
            assert_eq!(actual, expected, "save at +{seconds}s");
            assert_eq!(pre_replace_backups(&path).len(), 1);
        }
    }

    #[test]
    fn repeated_saves_keep_only_the_latest_twenty_and_hourly_and_daily_generations() {
        let _serial = persistence_test_lock();
        reset_quarantined_schema_for_test();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data.json");
        save_to_path(&path, &PersistentData::default()).unwrap();
        let now = UNIX_EPOCH + Duration::from_secs(32 * 86400 + 12 * 3600 + 30 * 60);
        let cases = [
            (14 * 24 * 60 + 1, false), (14 * 24 * 60, true),
            (12 * 24 * 60 + 120, false), (12 * 24 * 60 + 60, true),
            (49 * 60, false), (48 * 60, true), (47 * 60 + 10, false), (47 * 60, true),
        ].into_iter().chain((0..24).rev().map(|minutes| (minutes, minutes < 20)));
        let mut kept = HashMap::new();
        for (index, (minutes, expected_to_keep)) in cases.enumerate() {
            let time = now - Duration::from_secs(minutes * 60);
            if expected_to_keep {
                kept.insert(timestamp_nanos(time), fs::read(&path).unwrap());
            }
            update_while_locked(path.as_path(), time, |data| {
                data.active_workspace_id = Some(index.to_string());
            }).unwrap();
        }

        let actual: HashMap<_, _> = layout_backups(&path).into_iter().map(|backup| {
            assert!(backup.kind == BackupKind::Generation);
            (backup.timestamp, fs::read(backup.path).unwrap())
        }).collect();
        assert_eq!(actual.len(), 24);
        assert_eq!(actual, kept);
        assert_eq!(pre_replace_backups(&path).len(), 1);
    }

    #[test]
    fn shrink_archives_stay_outside_generation_pruning_for_thirty_days() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data.json");
        let now = UNIX_EPOCH + Duration::from_secs(32 * 86400);
        save_to_path(&path, &PersistentData::default()).unwrap();
        let expired = archive_layout(&path, BackupKind::Shrink, now - Duration::from_secs(31 * 86400)).unwrap();
        let kept = archive_layout(&path, BackupKind::Shrink, now - Duration::from_secs(30 * 86400)).unwrap();
        let unrelated = path.with_file_name("data-backups").join("shrink-manual.json");
        fs::write(&unrelated, b"manual").unwrap();

        prune_layout_backups(&path, now);

        assert!(!expired.exists());
        assert!(kept.is_file());
        assert!(unrelated.is_file());
    }

    #[test]
    fn shrink_pruning_keeps_only_the_newest_fifty_archives() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data.json");
        let now = UNIX_EPOCH + Duration::from_secs(32 * 86400);
        save_to_path(&path, &PersistentData::default()).unwrap();
        let archived: Vec<_> = (0..60)
            .rev()
            .map(|seconds| {
                archive_layout(&path, BackupKind::Shrink, now - Duration::from_secs(seconds)).unwrap()
            })
            .collect();

        prune_layout_backups(&path, now);

        let retained: Vec<_> = layout_backups(&path)
            .into_iter()
            .map(|backup| backup.path)
            .collect();
        let expected: Vec<_> = archived.into_iter().rev().take(50).collect();
        assert_eq!(retained, expected);
    }

    #[test]
    fn recovery_uses_the_newest_readable_generation_then_the_legacy_name() {
        for damaged in [None, Some(&b" "[..]), Some(&b"{broken"[..]), Some(&[0xff][..])] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("data.json");
            let time = UNIX_EPOCH + Duration::from_secs(120);
            let write_generation = |name: &str, time| {
                let config = PersistentData { active_workspace_id: Some(name.into()), ..Default::default() };
                fs::write(&path, serde_json::to_vec(&config).unwrap()).unwrap();
                archive_layout(&path, BackupKind::Generation, time).unwrap()
            };
            write_generation("older", time);
            let newest = write_generation("newest", time + Duration::from_secs(1));
            let invalid = write_generation("invalid", time + Duration::from_secs(2));
            fs::write(invalid, b"{partial").unwrap();
            let legacy = path.with_file_name("data.json.pre-replace-110000000000-42.bak");
            let fallback = PersistentData { active_workspace_id: Some("legacy".into()), ..Default::default() };
            fs::write(&legacy, serde_json::to_vec(&fallback).unwrap()).unwrap();
            match damaged {
                None => fs::remove_file(&path).unwrap(),
                Some(bytes) => fs::write(&path, bytes).unwrap(),
            }

            assert_eq!(load_from_path(&path).unwrap().active_workspace_id.as_deref(), Some("newest"));
            assert_eq!(fs::read(&path).unwrap(), fs::read(newest).unwrap());

            let isolated_legacy = dir.path().join("legacy");
            fs::create_dir(&isolated_legacy).unwrap();
            fs::copy(&legacy, isolated_legacy.join(legacy.file_name().unwrap())).unwrap();
            let fallback = load_from_path(&isolated_legacy.join("data.json")).unwrap();
            assert_eq!(fallback.active_workspace_id.as_deref(), Some("legacy"));
        }
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
    fn tab_agent_account_id_roundtrips_and_is_omitted_when_absent() {
        let tab: PaneTabConfig = serde_json::from_str(r#"{"agent_id":"claude-code","agent_account_id":"claude-1a2b3c4d"}"#).unwrap();
        assert_eq!(tab.agent_account_id.as_deref(), Some("claude-1a2b3c4d"));
        let json = serde_json::to_string(&tab).unwrap();
        let restored: PaneTabConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.agent_account_id, tab.agent_account_id);
        let legacy: PaneTabConfig = serde_json::from_str(r#"{"agent_id":"claude-code"}"#).unwrap();
        assert_eq!(legacy.agent_account_id, None);
        assert!(serde_json::to_value(legacy).unwrap().get("agent_account_id").is_none());
    }

    #[test]
    fn tab_and_pane_launch_secrets_are_scrubbed_on_both_read_and_write() {
        let fake = format!("sk-ant-oat01-{}", "a".repeat(32));
        let source = serde_json::json!({"agent_id":"claude-code", "launch_env": {
            "CLAUDE_CODE_OAUTH_TOKEN": fake, "claude_code_oauth_token": fake,
            "Claude_Code_Oauth_Token": fake, "KEEP": "kept"
        }});
        let mut tab: PaneTabConfig = serde_json::from_value(source.clone()).unwrap();
        let mut pane: PaneConfig = serde_json::from_value(source).unwrap();
        for env in [&tab.launch_env, &pane.launch_env] {
            assert_eq!(env.as_ref().unwrap(), &HashMap::from([("KEEP".into(), "kept".into())]));
        }
        // Populate structs directly too: deserialization alone is not the write guard.
        for env in [&mut tab.launch_env, &mut pane.launch_env] {
            for key in ["CLAUDE_CODE_OAUTH_TOKEN", "claude_code_oauth_token", "Claude_Code_Oauth_Token"] {
                env.as_mut().unwrap().insert(key.into(), fake.clone());
            }
        }
        pane.tabs = Some(vec![tab.clone()]);
        for json in [serde_json::to_string(&tab).unwrap(), serde_json::to_string(&pane).unwrap()] {
            assert!(!json.to_ascii_uppercase().contains("CLAUDE_CODE_OAUTH_TOKEN"));
            assert!(!json.contains("sk-ant-"));
            assert!(json.contains("KEEP"));
        }
        assert!(tab.launch_env.as_ref().unwrap().contains_key("CLAUDE_CODE_OAUTH_TOKEN"));
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
    fn legacy_schema_one_workspaces_do_not_require_window_groups() {
        let old = serde_json::json!({"id":"old","name":"Old","grid_template_id":"1x1","panes":[],"created_at":1});
        let workspace: WorkspaceConfig = serde_json::from_value(old).unwrap();
        assert!(workspace.window_group.is_none());
        let wire = serde_json::to_value(workspace).unwrap();
        assert!(wire.get("window_group").is_none());
        assert_eq!(CURRENT_SCHEMA_VERSION, 1);
    }

    #[test]
    fn unknown_ownership_extension_is_ignored_by_a_legacy_workspace_reader() {
        #[derive(Serialize, Deserialize)]
        struct LegacyWorkspace {
            id: String, name: String, grid_template_id: String,
            panes: Vec<PaneConfig>, created_at: u64,
        }
        let input = serde_json::json!({
            "id":"new","name":"New","grid_template_id":"1x1","panes":[{
                "pane_id":"p","agent_id":"shell-starter","label":"shell","tabs":[{
                    "tab_id":"t","agent_id":"shell-starter","type":"terminal","label":"preserved"
                }]
            }],"created_at":1,
            "window_group":{"label":"mycmux-w1","frame":{"x":120.0,"y":140.0,"width":800.0,"height":600.0}}
        });
        let old: LegacyWorkspace = serde_json::from_value(input.clone()).unwrap();
        assert_eq!(old.panes[0].tabs.as_ref().unwrap()[0].tab_id.as_deref(), Some("t"));
        let downgraded: WorkspaceConfig = serde_json::from_value(serde_json::to_value(old).unwrap()).unwrap();
        assert!(downgraded.window_group.is_none());
        assert_eq!(downgraded.id, "new");
        let mut current: WorkspaceConfig = serde_json::from_value(input).unwrap();
        let first = serde_json::to_value(&current).unwrap();
        for _ in 0..6 { current = serde_json::from_value(serde_json::to_value(current).unwrap()).unwrap(); }
        assert_eq!(serde_json::to_value(current).unwrap(), first);
    }

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

    /// Everything saved before 2026-09-16 predates the divider pins, so the
    /// fields have to be optional both ways: absent on the way in, and back out
    /// unchanged once the frontend starts writing them.
    #[test]
    fn workspace_divider_pins_default_to_none_when_absent_and_round_trip() {
        let mut workspace: WorkspaceConfig = serde_json::from_str(
            r#"{"id":"ws-1","name":"Workspace","grid_template_id":"1x1","panes":[],"created_at":1,"column_widths":[0.7,0.3],"row_heights_per_col":[[1.0],[1.0]]}"#,
        )
        .unwrap();
        assert!(workspace.column_divider_pins.is_none());
        assert!(workspace.row_divider_pins_per_col.is_none());

        workspace.column_divider_pins = Some(vec![true]);
        workspace.row_divider_pins_per_col = Some(vec![vec![], vec![]]);
        let serialized = serde_json::to_string(&workspace).unwrap();
        let restored: WorkspaceConfig = serde_json::from_str(&serialized).unwrap();
        assert_eq!(restored.column_divider_pins, Some(vec![true]));
        assert_eq!(
            restored.row_divider_pins_per_col,
            Some(vec![vec![], vec![]])
        );
        assert_eq!(restored.column_widths, Some(vec![0.7, 0.3]));
    }

    /// A pin list that is longer than one axis is still stored verbatim: the
    /// frontend decides what is believable, Rust only carries the value.
    #[test]
    fn workspace_divider_pins_are_stored_verbatim() {
        let workspace: WorkspaceConfig = serde_json::from_str(
            r#"{"id":"ws-1","name":"Workspace","grid_template_id":"1x1","panes":[],"created_at":1,"column_divider_pins":[true,false,true],"row_divider_pins_per_col":[[false,true]]}"#,
        )
        .unwrap();

        assert_eq!(
            workspace.column_divider_pins,
            Some(vec![true, false, true])
        );
        assert_eq!(
            workspace.row_divider_pins_per_col,
            Some(vec![vec![false, true]])
        );
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

    #[test]
    fn display_names_round_trip_without_replacing_control_labels() {
        let legacy: PaneTabConfig = serde_json::from_str(r#"{"agent_id":"shell-starter","label":"toolx-test-1"}"#).unwrap();
        assert!(legacy.display_name.is_none());
        assert!(legacy.display_name_source.is_none());
        let named: PaneTabConfig = serde_json::from_str(r#"{"agent_id":"shell-starter","label":"toolx-test-1","display_name":"検査","display_name_source":"auto"}"#).unwrap();
        let restored: PaneTabConfig = serde_json::from_str(&serde_json::to_string(&named).unwrap()).unwrap();
        assert_eq!(restored.label.as_deref(), Some("toolx-test-1"));
        assert_eq!(restored.display_name.as_deref(), Some("検査"));
        assert_eq!(restored.display_name_source.as_deref(), Some("auto"));
    }

    #[test]
    fn browser_tab_transfer_metadata_round_trips_and_defaults() {
        let json = r#"{"agent_id":"shell-starter","type":"browser","html_path":"C:/preview.html","source_path":"C:/source.pdf","source_kind":"pdf","preview_path":"C:/preview.pdf"}"#;
        let tab: PaneTabConfig = serde_json::from_str(json).unwrap();
        let restored: PaneTabConfig = serde_json::from_str(&serde_json::to_string(&tab).unwrap()).unwrap();
        assert_eq!(restored.r#type.as_deref(), Some("browser"));
        assert_eq!(restored.html_path.as_deref(), Some("C:/preview.html"));
        assert_eq!(restored.source_path.as_deref(), Some("C:/source.pdf"));
        assert_eq!(restored.source_kind.as_deref(), Some("pdf"));
        assert_eq!(restored.preview_path.as_deref(), Some("C:/preview.pdf"));
        let legacy: PaneTabConfig = serde_json::from_str(r#"{"agent_id":"shell-starter"}"#).unwrap();
        assert!(legacy.html_path.is_none());
        assert!(legacy.source_path.is_none());
        assert!(legacy.source_kind.is_none());
        assert!(legacy.preview_path.is_none());
    }
}

#[cfg(test)]
mod maximized_window_compatibility_tests {
    use super::{WindowFrameConfig, WindowGroupConfig};
    use serde::{Deserialize, Serialize};

    // The exact v0.83.0 window group, without the new optional field.
    #[derive(Serialize, Deserialize)]
    struct OldWindowGroup {
        label: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        decorated: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        native_tearout: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        frame: Option<WindowFrameConfig>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        active_workspace_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        active_pane_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        active_tab_id: Option<String>,
    }

    #[test]
    fn old_window_group_defaults_maximized_and_round_trips_without_new_field() {
        let old = r#"{"label":"mycmux-w2","decorated":false,"native_tearout":true,"frame":{"x":10.0,"y":20.0,"width":400.0,"height":300.0},"active_workspace_id":"ws","active_pane_id":"pane","active_tab_id":"tab"}"#;
        let new: WindowGroupConfig = serde_json::from_str(old).unwrap();
        assert_eq!(new.maximized, None);
        let serialized = serde_json::to_string(&new).unwrap();
        assert!(!serialized.contains("maximized"));
        let old_again: OldWindowGroup = serde_json::from_str(&serialized).unwrap();
        assert_eq!(serde_json::to_value(old_again).unwrap(), serde_json::from_str::<serde_json::Value>(old).unwrap());
    }

    #[test]
    fn maximized_group_survives_new_round_trip_and_old_reader_ignores_only_the_flag() {
        let input = r#"{"label":"mycmux-w2","decorated":false,"native_tearout":true,"maximized":true,"frame":{"x":10.0,"y":20.0,"width":400.0,"height":300.0},"active_workspace_id":"ws","active_pane_id":"pane","active_tab_id":"tab"}"#;
        let new: WindowGroupConfig = serde_json::from_str(input).unwrap();
        let serialized = serde_json::to_string(&new).unwrap();
        let new_again: WindowGroupConfig = serde_json::from_str(&serialized).unwrap();
        assert_eq!(new, new_again);
        assert_eq!(new_again.maximized, Some(true));
        let old: OldWindowGroup = serde_json::from_str(&serialized).unwrap();
        let downgraded: WindowGroupConfig = serde_json::from_str(&serde_json::to_string(&old).unwrap()).unwrap();
        let mut expected = new;
        expected.maximized = None;
        assert_eq!(downgraded, expected);
    }
}


#[cfg(test)]
mod account_homes_storage_tests {
    use super::*;
    #[test]
    fn account_homes_storage_scrubs_every_home_alias_on_read_and_write_but_keeps_only_the_account_id() {
        let mut forged=HashMap::from([("KEEP".to_string(),"kept".to_string())]);
        let keys=crate::cli_accounts::account_homes::HOME_ENV_KEYS.iter().copied().chain(["CLAUDE_CODE_OAUTH_TOKEN","MYCMUX_LAUNCH_ACCOUNT"]);
        for key in keys { forged.insert(key.to_string(),"fixture-sensitive".into()); forged.insert(key.to_ascii_lowercase(),"fixture-sensitive".into()); }
        let source=serde_json::json!({"agent_id":"codex","agent_account_id":"codex-fixture","launch_env":forged});
        let mut tab:PaneTabConfig=serde_json::from_value(source.clone()).unwrap();
        let mut pane:PaneConfig=serde_json::from_value(source).unwrap();
        let expected=Some(HashMap::from([("KEEP".into(),"kept".into())]));
        assert_eq!(tab.launch_env,expected); assert_eq!(pane.launch_env,expected);
        assert_eq!(tab.agent_account_id.as_deref(),Some("codex-fixture"));
        tab.launch_env=Some(forged.clone()); pane.launch_env=Some(forged); pane.tabs=Some(vec![tab.clone()]);
        for serialized in [serde_json::to_string(&tab).unwrap(),serde_json::to_string(&pane).unwrap()] {
            assert!(!serialized.contains("fixture-sensitive")); assert!(serialized.contains("codex-fixture"));
            let restored:PaneTabConfig=serde_json::from_str(&serde_json::to_string(&tab).unwrap()).unwrap();
            assert_eq!(restored.launch_env,expected); assert_eq!(restored.agent_account_id,tab.agent_account_id);
        }
        let legacy:PaneTabConfig=serde_json::from_str(r#"{"agent_id":"codex"}"#).unwrap(); assert_eq!(legacy.agent_account_id,None);
    }
}
