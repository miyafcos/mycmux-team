use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[cfg(any(windows, test))]
pub(crate) fn normalize_windows_profile_name(name: &str) -> String {
    name.to_ascii_lowercase()
}

/// Windows lock names must distinguish the profile's actual data file. Scope
/// tags keep the default file distinct from a user profile named "default".
#[cfg(any(windows, test))]
fn data_mutex_name(profile: Option<&str>, test_pid: Option<u32>) -> String {
    let scope = profile.map(|name| format!("profile-{}", normalize_windows_profile_name(name)))
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
        acquire_named(&mutex_name(), timeout)
    }

    pub(super) fn acquire_named(name: &str, timeout: std::time::Duration) -> Result<DataLockGuard, String> {
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
    use std::path::Path;
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


    fn acquire_at(runtime_dir: &Path) -> Result<DataLockGuard, String> {
        acquire_at_with_timeout(runtime_dir, LOCK_TIMEOUT)
    }

    pub(super) fn acquire_at_with_timeout(runtime_dir: &Path, timeout: Duration) -> Result<DataLockGuard, String> {
        acquire_named_at(runtime_dir, "data.json.lock", timeout)
    }

    pub(super) fn acquire_named_at(runtime_dir: &Path, file_name: &str, timeout: Duration) -> Result<DataLockGuard, String> {
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
            .open(runtime_dir.join(file_name))
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

const LEGACY_AILOG_MIRROR_FULL_TEXT_ROOT: &str =
    "G:\\\u{30de}\u{30a4}\u{30c9}\u{30e9}\u{30a4}\u{30d6}\\pc-backup\\mycmux-ailog";

fn default_ailog_mirror_full_text_root() -> Option<String> {
    None
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
    /// Opt-in destination for compressed full-text transcript copies.
    #[serde(default = "default_ailog_mirror_full_text_root")]
    pub ailog_mirror_full_text_root: Option<String>,
    #[serde(default)]
    pub ailog_mirror_full_text_root_migrated: bool,
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
            ailog_mirror_full_text_root_migrated: true,
            ailog_claude_fallback_root: None,
        }
    }
}

impl AppSettings {
    /// Returns whether a pending migration cleared the old destination.
    fn migrate_ailog_mirror_full_text_root(&mut self) -> Option<bool> {
        if self.ailog_mirror_full_text_root_migrated {
            return None;
        }
        self.ailog_mirror_full_text_root_migrated = true;
        let cleared = self.ailog_mirror_full_text_root.as_deref() == Some(LEGACY_AILOG_MIRROR_FULL_TEXT_ROOT);
        if cleared {
            self.ailog_mirror_full_text_root = None;
        }
        Some(cleared)
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

pub(crate) const APP_LAYOUT_DIR_PREFIX: &str = "com.miyazaki.mycmux";

pub(crate) struct LayoutActivityGuard {
    _lock: interprocess_data_lock::DataLockGuard,
}

pub(crate) fn lock_layout_activity(root: &Path, timeout: Duration) -> Result<LayoutActivityGuard, String> {
    #[cfg(windows)]
    let lock = {
        use sha2::{Digest, Sha256};
        let normalized = root.to_string_lossy().replace('\\', "/").to_lowercase();
        let name = format!("Local\\mycmux-layout-activity-{:x}", Sha256::digest(normalized.as_bytes()));
        interprocess_data_lock::acquire_named(&name, timeout)?
    };
    #[cfg(unix)]
    let lock = interprocess_data_lock::acquire_named_at(root, ".mycmux-layout-activity.lock", timeout)?;
    Ok(LayoutActivityGuard { _lock: lock })
}

/// The startup sweep can inspect all app variants and profiles under the same
/// parent. Their data.json and scrollback commits take that same scope lock.
pub(crate) fn lock_layout_directory(dir: &Path, timeout: Duration) -> Result<Option<LayoutActivityGuard>, String> {
    let app = dir.parent().filter(|parent| parent.file_name().is_some_and(|name| name == "profiles"))
        .and_then(Path::parent).unwrap_or(dir);
    let shared = app.file_name().and_then(|name| name.to_str())
        .filter(|name| name.starts_with(APP_LAYOUT_DIR_PREFIX)).and_then(|_| app.parent());
    shared.map(|root| lock_layout_activity(root, timeout)).transpose()
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
        .ok_or_else(|| "data path has no parent".to_string())?;
    Ok(parent.join("scrollback"))
}

// Compare save times on a steady clock during one run. A restarted app can
// still encounter future-dated backups, which the generation gate handles.
fn layout_write_time() -> SystemTime {
    static ORIGIN: std::sync::OnceLock<(SystemTime, Instant)> = std::sync::OnceLock::new();
    let (wall, anchor) = ORIGIN.get_or_init(|| (SystemTime::now(), Instant::now()));
    *wall + anchor.elapsed()
}

fn timestamp_nanos(now: SystemTime) -> u128 {
    now.duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default()
}

fn backup_path_for(path: &Path, reason: &str) -> PathBuf {
    let mut timestamp = timestamp_nanos(layout_write_time());
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("data.json");

    let pid = std::process::id();
    loop {
        let candidate = path.with_file_name(format!("{file_name}.{reason}-{timestamp}-{pid}.bak"));
        if !candidate.exists() {
            return candidate;
        }
        timestamp += 1;
    }
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

fn backup_entries(dir: &Path) -> std::io::Result<Vec<fs::DirEntry>> {
    match fs::read_dir(dir) {
        Ok(entries) => entries.collect(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(error),
    }
}

fn pre_replace_backup_list(path: &Path) -> std::io::Result<Vec<PathBuf>> {
    let Some(parent) = path.parent() else {
        return Ok(Vec::new());
    };
    let mut backups = Vec::new();
    for entry in backup_entries(parent)? {
        let candidate = entry.path();
        if pre_replace_backup_stamp(path, &candidate).is_some() && entry.file_type()?.is_file() {
            backups.push(candidate);
        }
    }
    backups.sort_by_key(|backup| std::cmp::Reverse((pre_replace_stamp(path, backup), backup.clone())));
    Ok(backups)
}

fn pre_replace_backups(path: &Path) -> Vec<PathBuf> {
    pre_replace_backup_list(path).unwrap_or_default()
}

fn cleanup_old_pre_replace_backups(path: &Path, keep: &Path, archive_available: bool) {
    const MAX_DEFERRED_SHRINK_BACKUPS: usize = 20;
    let mut backups: Vec<_> = pre_replace_backups(path)
        .into_iter()
        .filter(|backup| backup != keep)
        .map(|backup| (deferred_shrink_backup_timestamp(path, &backup), backup))
        .collect();
    backups.sort_unstable_by_key(|(stamp, backup)| {
        std::cmp::Reverse((stamp.is_some(), pre_replace_stamp(path, backup), backup.clone()))
    });
    // The just-written copy is protected even if the system clock moved back.
    let mut deferred_count = usize::from(deferred_shrink_backup_timestamp(path, keep).is_some());
    for (deferred_timestamp, backup) in backups {
        if let Some(timestamp) = deferred_timestamp {
            // A fresh generation can contain a smaller layout, so archive the
            // original bytes before releasing protection for this copy.
            let archived = archive_available
                && archive_layout_from(&backup, path, BackupKind::Shrink, timestamp)
                    .inspect_err(|_| {
                        crate::diag_warn!("persist", "could not archive the protected pre-replace backup");
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
                "failed to remove old pre-replace backup: {:?}",
                error.kind()
            );
        }
    }
}

fn layout_file_name(path: &Path) -> &str {
    path.file_name().and_then(|name| name.to_str()).unwrap_or("data.json")
}

fn quarantine_data_file(path: &Path, reason: &str) -> Result<PathBuf, String> {
    let backup_path = backup_path_for(path, reason);
    fs::rename(path, &backup_path).map_err(|error| {
        format!(
            "Failed to quarantine {} to {}: {error}",
            layout_file_name(path),
            layout_file_name(&backup_path)
        )
    })?;
    Ok(backup_path)
}

#[cfg(test)]
fn read_data_file(path: &Path) -> std::io::Result<String> {
    let mut contents = fs::read_to_string(path)?;
    if contents.starts_with('\u{feff}') {
        contents.drain(..'\u{feff}'.len_utf8());
    }
    Ok(contents)
}

fn schema_version_from_contents(path: &Path, contents: &str) -> Result<u32, String> {
    let value = serde_json::from_str::<serde_json::Value>(contents)
        .map_err(|error| format!("Failed to parse {}: {error}", layout_file_name(path)))?;
    let Some(schema_version) = value.get("schema_version") else {
        return Ok(CURRENT_SCHEMA_VERSION);
    };
    let version = schema_version.as_u64().ok_or_else(|| {
        format!(
            "Failed to parse {}: schema_version must be an unsigned integer",
            layout_file_name(path)
        )
    })?;
    u32::try_from(version).map_err(|_| {
        format!(
            "Failed to parse {}: schema_version is out of range",
            layout_file_name(path)
        )
    })
}

#[cfg(test)]
fn schema_version_from_path(path: &Path) -> Result<Option<u32>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let contents = read_data_file(path)
        .map_err(|error| format!("Failed to read {}: {error}", layout_file_name(path)))?;
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
    static BLOCK_LAYOUT_ARCHIVE_FOR: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
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
        .temp_prefix(".mycmux-layout-copy-")
        .write_with(target, |file| {
            #[cfg(test)]
            if FAIL_NEXT_LAYOUT_COPY.with(|failure| failure.replace(false)) {
                return fail_layout_copy_partway(source, file);
            }
            let mut source_file = File::open(source)
                .map_err(|error| format!("Failed to open {}: {error}", layout_file_name(source)))?;
            std::io::copy(&mut source_file, file)
                .map_err(|error| format!("Failed to copy {}: {error}", layout_file_name(source)))?;
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

#[derive(Clone, Copy, Default, Ord, PartialOrd, Eq, PartialEq)]
struct BackupStamp {
    order: u128,
    timestamp: u128,
}

struct LayoutBackup {
    path: PathBuf,
    timestamp: u128,
    order: u128,
    kind: BackupKind,
}

fn next_backup_order(path: &Path) -> Result<u128, String> {
    let generations = layout_backup_list(path)
        .map_err(|error| format!("cannot determine layout backup order: {:?}", error.kind()))?;
    let pre_replace = pre_replace_backup_list(path)
        .map_err(|error| format!("cannot determine pre-replace backup order: {:?}", error.kind()))?;
    generations.into_iter().map(|backup| backup.order)
        .chain(pre_replace.iter().map(|backup| pre_replace_stamp(path, backup).order))
        .max().unwrap_or_default().checked_add(1)
        .ok_or_else(|| "layout backup order is exhausted".into())
}

fn archive_layout(path: &Path, kind: BackupKind, now: SystemTime) -> Result<PathBuf, String> {
    archive_layout_from(path, path, kind, timestamp_nanos(now))
}

fn archive_layout_from(
    source: &Path, path: &Path, kind: BackupKind, mut timestamp: u128,
) -> Result<PathBuf, String> {
    #[cfg(test)]
    if BLOCK_LAYOUT_ARCHIVE_FOR.with(|blocked| blocked.borrow().as_deref() == Some(path)) {
        return Err("injected archive publication failure".into());
    }
    let directory = path.with_file_name("data-backups");
    let kind = kind.prefix();
    let pid = std::process::id();
    let order = if source == path { next_backup_order(path)? } else { pre_replace_stamp(path, source).order };
    let mut target = directory.join(format!("{kind}-{timestamp}-{pid}-{order}.json"));
    while target.exists() {
        timestamp += 1;
        target = directory.join(format!("{kind}-{timestamp}-{pid}-{order}.json"));
    }
    copy_layout_file(source, &target)?;
    Ok(target)
}

fn parse_backup_stamp(name: &str) -> Option<BackupStamp> {
    let mut parts = name.split('-');
    let timestamp = parts.next()?.parse().ok()?;
    parts.next()?.parse::<u32>().ok()?;
    let order = parts.next().map(str::parse).transpose().ok()?.unwrap_or_default();
    if parts.next().is_some() {
        return None;
    }
    Some(BackupStamp { order, timestamp })
}

fn parse_backup_timestamp(name: &str) -> Option<u128> {
    parse_backup_stamp(name).map(|stamp| stamp.timestamp)
}

fn pre_replace_stamp(path: &Path, backup: &Path) -> BackupStamp {
    pre_replace_backup_stamp(path, backup)
        .map(|stamp| stamp.strip_prefix("shrink-").unwrap_or(stamp))
        .and_then(parse_backup_stamp)
        .unwrap_or_else(|| BackupStamp {
            order: 0,
            timestamp: backup.metadata().and_then(|metadata| metadata.modified()).ok()
                .map(timestamp_nanos).unwrap_or_default(),
        })
}

fn layout_backup_list(path: &Path) -> std::io::Result<Vec<LayoutBackup>> {
    let directory = path.with_file_name("data-backups");
    let mut backups = Vec::new();
    for entry in backup_entries(&directory)? {
        let name = entry.file_name();
        let Some((prefix, name)) = name.to_str().and_then(|name| name.strip_suffix(".json"))
            .and_then(|name| name.split_once('-')) else { continue; };
        let kind = match prefix {
            "data" => BackupKind::Generation,
            "shrink" => BackupKind::Shrink,
            _ => continue,
        };
        let Some(BackupStamp { timestamp, order }) = parse_backup_stamp(name) else { continue; };
        if entry.file_type()?.is_file() {
            backups.push(LayoutBackup { path: entry.path(), timestamp, order, kind });
        }
    }
    backups.sort_unstable_by(|a, b| {
        (b.order, b.timestamp, &b.path).cmp(&(a.order, a.timestamp, &a.path))
    });
    Ok(backups)
}

fn layout_backups(path: &Path) -> Vec<LayoutBackup> {
    layout_backup_list(path).unwrap_or_default()
}

const MIN_RECENT_GENERATIONS: usize = 20;
const BACKUP_HOUR_NS: u128 = 3_600_000_000_000;
const BACKUP_DAY_NS: u128 = 24 * BACKUP_HOUR_NS;

#[derive(Default, Deserialize, Serialize)]
struct BackupClock {
    previous_save: u128,
    protected_through: u128,
    protect_legacy: bool,
}

impl BackupClock {
    fn load(path: &Path) -> Self {
        let read = match fs::read(path.with_file_name("layout-backup-clock.json")) {
            Ok(read) => read,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Self::default(),
            Err(_) => return Self::untrusted(),
        };
        serde_json::from_slice(&read).unwrap_or_else(|_| Self::untrusted())
    }

    fn untrusted() -> Self {
        Self { previous_save: 0, protected_through: u128::MAX, protect_legacy: true }
    }

    fn before_save(path: &Path) -> Self {
        let mut clock = Self::load(path);
        if clock.previous_save == 0 && !clock.protect_legacy {
            clock.previous_save = layout_backups(path).iter().map(|backup| backup.timestamp)
                .chain(pre_replace_backups(path).iter().map(|backup| pre_replace_stamp(path, backup).timestamp))
                .max().unwrap_or_default();
        }
        clock
    }

    fn observe_save(mut self, path: &Path, now: SystemTime, prior_order: u128) -> Self {
        let stamp = timestamp_nanos(now);
        if self.previous_save != 0 && (stamp < self.previous_save
            || stamp - self.previous_save > BACKUP_DAY_NS)
        {
            self.protected_through = self.protected_through.max(prior_order);
            self.protect_legacy = true;
        }
        self.previous_save = stamp;
        let bytes = serde_json::to_vec(&self).expect("backup clock contains only numbers and flags");
        let written = crate::util::atomic_write::AtomicWrite::new("backup clock", "Failed to install backup clock")
            .write_bytes(&path.with_file_name("layout-backup-clock.json"), &bytes);
        if written.is_err() {
            crate::diag_warn!("storage", "backup clock could not be recorded; preserving backups by age");
            return Self::untrusted();
        }
        self
    }

    fn protects_age(&self, order: u128) -> bool {
        if order == 0 { self.protect_legacy } else { order <= self.protected_through }
    }
}

fn prune_layout_backups_with_clock(path: &Path, now: SystemTime, clock: &BackupClock) {
    let now = timestamp_nanos(now);
    let mut generations = 0;
    let mut shrinks = 0;
    let mut hours = HashSet::new();
    let mut days = HashSet::new();
    let backups = layout_backups(path);
    let future_date_present = backups.iter().any(|backup| backup.timestamp > now);
    for backup in backups {
        let Some(age) = now.checked_sub(backup.timestamp) else { continue; };
        let keep = match backup.kind {
            BackupKind::Shrink => {
                shrinks += 1;
                shrinks <= 50 && (age <= 30 * BACKUP_DAY_NS || clock.protects_age(backup.order))
            }
            BackupKind::Generation => {
                generations += 1;
                let hourly = age <= 48 * BACKUP_HOUR_NS && hours.insert(backup.timestamp / BACKUP_HOUR_NS);
                let daily = age <= 14 * BACKUP_DAY_NS && days.insert(backup.timestamp / BACKUP_DAY_NS);
                generations <= MIN_RECENT_GENERATIONS || hourly || daily
            }
        };
        if keep { continue; }
        let outcome = if future_date_present {
            crate::util::atomic_write::preserve_in_old(&backup.path).map(|_| ())
        } else {
            fs::remove_file(&backup.path)
        };
        if outcome.is_err() {
            crate::diag_warn!("storage", "could not rotate an old layout backup");
        }
    }
}

#[cfg(test)]
fn prune_layout_backups(path: &Path, now: SystemTime) {
    prune_layout_backups_with_clock(path, now, &BackupClock::load(path));
}

pub(crate) fn scan_recovery_backups(path: &Path) -> std::io::Result<Vec<PathBuf>> {
    let legacy = pre_replace_backup_list(path)?.into_iter()
        .map(|backup| (pre_replace_stamp(path, &backup), backup));
    let mut backups: Vec<_> = layout_backup_list(path)?.into_iter()
        .map(|backup| (BackupStamp { order: backup.order, timestamp: backup.timestamp }, backup.path))
        .chain(legacy)
        .collect();
    backups.sort_unstable_by(|a, b| b.cmp(a));
    Ok(backups.into_iter().map(|(_, backup)| backup).collect())
}

pub(crate) fn parse_layout_bytes(contents: &[u8]) -> Result<PersistentDataEnvelope, String> {
    let text = std::str::from_utf8(contents).map_err(|_| "invalid UTF-8 layout")?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let schema = schema_version_from_contents(Path::new("layout"), text)?;
    if schema != CURRENT_SCHEMA_VERSION {
        return Ok(PersistentDataEnvelope::unsupported(schema));
    }
    serde_json::from_str::<PersistentData>(text).map(PersistentDataEnvelope::supported)
        .map_err(|error| error.to_string())
}

fn recover_from_pre_replace_backup(
    path: &Path,
    reason: &str,
) -> Result<Option<PersistentDataEnvelope>, String> {
    let candidates = scan_recovery_backups(path)
        .map_err(|error| format!("layout recovery deferred: could not list backups ({:?})", error.kind()))?;
    for backup_path in candidates {
        let bytes = fs::read(&backup_path)
            .map_err(|error| format!("layout recovery deferred: could not read a backup ({:?})", error.kind()))?;
        let Ok(envelope) = parse_layout_bytes(&bytes) else { continue; };
        if path.exists() {
            quarantine_data_file(path, reason)?;
        }
        copy_layout_file(&backup_path, path)?;
        crate::diag_warn!("storage", "restored layout from recovery backup ({reason})");
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
    let contents = match fs::read(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return recover_unusable_data(path, "missing");
        }
        Err(error) => return Err(format!("Failed to read layout file: {error}")),
    };
    let text = std::str::from_utf8(&contents).ok();
    if text.is_some_and(|text| text.trim_start_matches('\u{feff}').trim().is_empty()) {
        return recover_unusable_data(path, "empty");
    }
    match parse_layout_bytes(&contents) {
        Ok(envelope) => Ok(envelope),
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
    let prior_order = next_backup_order(path)?.saturating_sub(1);
    let backup_clock = BackupClock::before_save(path);
    let shrink_backup = shrink.and_then(|(before, after)| {
        match archive_layout(path, BackupKind::Shrink, now) {
            Ok(backup) => Some((before, after, backup)),
            Err(_) => {
                crate::diag_warn!("persist", "could not keep the pre-shrink layout backup");
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
        let timestamp = timestamp_nanos(now);
        let order = next_backup_order(path)?;
        let pid = std::process::id();
        let name = path.file_name().and_then(|name| name.to_str()).unwrap_or("data.json");
        let backup_path = path.with_file_name(format!("{name}.{reason}-{timestamp}-{pid}-{order}.bak"));
        copy_layout_file(path, &backup_path)?;
        let save_stamp = timestamp_nanos(now);
        let backups = layout_backups(path);
        let normal_generations = backups.iter()
            .filter(|backup| backup.kind == BackupKind::Generation && backup.timestamp <= save_stamp);
        // With a future-dated backup, overflow is preserved on disk. At the
        // normal retention floor keep rotating the pre-replace copy, but do
        // not generate more optional copies that would only grow that overflow.
        let clock_overflow = backups.iter().any(|backup| backup.timestamp > save_stamp)
            && normal_generations.clone().count() >= MIN_RECENT_GENERATIONS;
        let keep_generation = !clock_overflow && (layout_reduced
            || normal_generations.into_iter().next()
                .is_none_or(|backup| save_stamp - backup.timestamp >= Duration::from_secs(60).as_nanos()));
        if keep_generation {
            match archive_layout(path, BackupKind::Generation, now) {
                Ok(_) => archive_available = true,
                Err(_) => crate::diag_warn!("persist", "could not keep layout backup generation"),
            }
        }
        Some(backup_path)
    } else {
        None
    };

    fs::rename(tmp_path, path).map_err(|error| {
        format!(
            "Failed to replace {} with {}: {error}",
            layout_file_name(path),
            layout_file_name(tmp_path)
        )
    })?;

    if let Some(backup_path) = backup_path.as_deref() {
        cleanup_old_pre_replace_backups(path, backup_path, archive_available);
    }
    let clock = backup_clock.observe_save(path, now, prior_order);
    prune_layout_backups_with_clock(path, now, &clock);
    if let Some((before, after, _)) = shrink_backup {
        crate::diag::log(&format!(
            "[persist] shrink tabs {}->{} workspaces {}->{} kept pre-shrink layout backup",
            before.tabs, after.tabs, before.workspaces, after.workspaces
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
    let json = serde_json::to_string(data).map_err(|error| {
        PersistentStorageError::storage(format!("Failed to serialize data: {error}"))
    })?;
    save_layout_json(path, &json, now, layout_reduced, shrink)
}

fn save_layout_json(
    path: &Path,
    json: &str,
    now: SystemTime,
    layout_reduced: bool,
    shrink: Option<(LayoutCounts, LayoutCounts)>,
) -> Result<(), PersistentStorageError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            PersistentStorageError::storage(format!("Failed to create layout directory: {error}"))
        })?;
    }

    let file_name = layout_file_name(path);
    let timestamp = timestamp_nanos(now);
    let tmp_path = path.with_file_name(format!(
        "{file_name}.tmp-{}-{timestamp}",
        std::process::id()
    ));
    write_json_file(&tmp_path, json).map_err(PersistentStorageError::from)?;
    replace_data_file(path, &tmp_path, now, layout_reduced, shrink)
        .map_err(PersistentStorageError::from)
        .inspect_err(|replace_error| {
            crate::diag_warn!("storage", "failed to save {file_name}: {replace_error}");
            if let Err(error) = fs::remove_file(&tmp_path) {
                crate::diag_warn!(
                    "storage",
                    "failed to remove temporary data file {}: {:?}",
                    layout_file_name(&tmp_path), error.kind()
                );
            }
        })
}

// Only these storage-owned patterns are safe to move. Older generic scratch
// files beside data.json could belong to other AtomicWrite callers.
fn retain_interrupted_writes(path: &Path) {
    let Some(parent) = path.parent() else { return; };
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else { return; };
    let prefix = format!("{name}.tmp-");
    let backups = path.with_file_name("data-backups");
    for directory in [parent, backups.as_path()] {
        if !fs::symlink_metadata(directory).is_ok_and(|metadata| metadata.is_dir()) {
            continue;
        }
        let Ok(entries) = fs::read_dir(directory) else { continue; };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue; };
            let main_temp = directory == parent && name.strip_prefix(&prefix)
                .and_then(|stamp| stamp.split_once('-')).is_some_and(|(pid, nanos)| {
                    pid.parse::<u32>().is_ok() && nanos.parse::<u128>().is_ok()
                });
            let backup_temp = name.strip_prefix(".mycmux-layout-copy-")
                .or_else(|| (directory == backups).then(|| name.strip_prefix(".tmp")).flatten())
                .is_some_and(|random| random.len() == 6 && random.bytes().all(|byte| byte.is_ascii_alphanumeric()));
            if (main_temp || backup_temp) && entry.file_type().is_ok_and(|kind| kind.is_file()) {
                if let Err(error) = crate::util::atomic_write::preserve_in_old(&entry.path()) {
                    crate::diag_warn!("storage", "could not preserve interrupted layout file: {:?}", error.kind());
                }
            }
        }
    }
}

fn persist_ailog_mirror_migration(path: &Path, cleared: bool) -> Result<(), String> {
    // Keep any keys unknown to this build when the only write is a migration.
    let contents = fs::read(path)
        .map_err(|error| format!("Could not re-read data.json for settings migration: {:?}", error.kind()))?;
    let contents = contents.strip_prefix(b"\xef\xbb\xbf").unwrap_or(&contents);
    let mut wire: serde_json::Value =
        serde_json::from_slice(contents).map_err(|error| error.to_string())?;
    let settings = wire.get_mut("settings").and_then(serde_json::Value::as_object_mut)
        .ok_or("data.json settings are missing")?;
    settings.insert("ailog_mirror_full_text_root_migrated".into(), true.into());
    if cleared {
        settings.insert("ailog_mirror_full_text_root".into(), serde_json::Value::Null);
    }
    let json = serde_json::to_string(&wire).map_err(|error| error.to_string())?;
    save_layout_json(path, &json, layout_write_time(), false, None).map_err(String::from)
}

pub(crate) fn load_envelope<T: PersistentDataTarget + ?Sized>(
    target: &T,
) -> Result<PersistentDataEnvelope, String> {
    let _process_guard = interprocess_data_lock::acquire()?;
    let path = target.persistent_data_path()?;
    let _activity = lock_layout_directory(path.parent().unwrap_or(Path::new(".")), Duration::from_secs(30))?;
    if let Some(schema_version) = quarantined_schema_version() {
        return Ok(PersistentDataEnvelope::unsupported(schema_version));
    }
    let mut envelope = load_envelope_from_path(&path)?;
    if !envelope.supported {
        latch_unsupported_schema(envelope.schema_version);
    } else {
        retain_interrupted_writes(&path);
        if let Some(cleared) = envelope.data.as_mut().and_then(|data| data.settings.migrate_ailog_mirror_full_text_root()) {
            // Use the safe in-memory value even if the locked write fails.
            // A later load retries the migration until the marker is durable.
            if let Err(error) = persist_ailog_mirror_migration(&path, cleared) {
                crate::diag_warn!("persist", "could not persist the AI log mirror settings migration: {error}");
            }
        }
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
    let counts = update_if_changed(target, |disk| {
        updater(disk);
        true
    })?;
    report(counts);
    Ok(())
}

pub(crate) fn update_if_changed<T, F>(target: &T, updater: F) -> Result<LayoutCounts, PersistentStorageError>
where
    T: PersistentDataTarget + ?Sized,
    F: FnOnce(&mut PersistentData) -> bool,
{
    ensure_persistence_write_platform_supported()?;
    let _guard = save_lock().lock().map_err(|error| {
        PersistentStorageError::storage(format!("Failed to lock data file: {error}"))
    })?;
    let _process_guard = interprocess_data_lock::acquire().map_err(PersistentStorageError::from)?;
    update_if_changed_while_locked(target, layout_write_time(), None, updater)
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
where T: PersistentDataTarget + ?Sized, F: FnOnce(&mut PersistentData) -> bool,
{
    ensure_persistence_write_platform_supported()?;
    let lock_deadline = deadline.min(Instant::now() + Duration::from_millis(100));
    let _guard = save_lock_until(save_lock(), lock_deadline)?;
    let _process_guard = interprocess_data_lock::acquire_with_timeout(lock_deadline.saturating_duration_since(Instant::now()))
        .map_err(PersistentStorageError::from)?;
    if Instant::now() >= deadline { return Err(PersistentStorageError::storage("Shutdown save budget expired")); }
    update_if_changed_while_locked(target, layout_write_time(), Some(lock_deadline), updater).map(|_| ())
}

#[cfg(test)]
fn update_while_locked<T, F>(target: &T, now: SystemTime, updater: F) -> Result<LayoutCounts, PersistentStorageError>
where
    T: PersistentDataTarget + ?Sized,
    F: FnOnce(&mut PersistentData),
{
    update_if_changed_while_locked(target, now, None, |data| {
        updater(data);
        true
    })
}

fn update_if_changed_while_locked<T, F>(
    target: &T, now: SystemTime, deadline: Option<Instant>, updater: F,
) -> Result<LayoutCounts, PersistentStorageError>
where
    T: PersistentDataTarget + ?Sized,
    F: FnOnce(&mut PersistentData) -> bool,
{
    if let Some(schema_version) = quarantined_schema_version() {
        return Err(PersistentStorageError::unsupported_schema(schema_version));
    }
    let path = target
        .persistent_data_path()
        .map_err(PersistentStorageError::from)?;
    let timeout = deadline.map_or(Duration::from_secs(30), |at| at.saturating_duration_since(Instant::now()));
    let _activity = lock_layout_directory(path.parent().unwrap_or(Path::new(".")), timeout)
        .map_err(PersistentStorageError::from)?;
    if deadline.is_some_and(|at| Instant::now() > at) {
        return Err(PersistentStorageError::storage("Shutdown layout activity lock budget expired"));
    }
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
    let _ = data.settings.migrate_ailog_mirror_full_text_root();
    let before = data.layout_counts();
    if !updater(&mut data) {
        return Ok(before);
    }
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
    fn l3_fix2_23_windows_instance_guard_uses_the_same_profile_scope_as_data_writes() {
        const WINDOWS_MODULE: &str = "#[cfg(target_os = \"windows\")]\nmod single_instance {";
        let lib = include_str!("../lib.rs").replace("\r\n", "\n");
        let windows = lib.split_once(WINDOWS_MODULE).unwrap().1
            .split_once("#[cfg(unix)]").unwrap().0;

        let crlf = lib.replace('\n', "\r\n");
        assert!(crlf.split_once(WINDOWS_MODULE).is_none());
        let normalized = crlf.replace("\r\n", "\n");
        assert_eq!(
            normalized.split_once(WINDOWS_MODULE).unwrap().1.split_once("#[cfg(unix)]").unwrap().0,
            windows,
        );
        assert_eq!(normalize_windows_profile_name("Demo"), normalize_windows_profile_name("demo"));
        assert!(windows.contains("normalize_windows_profile_name(name)"),
            "Demo and demo name the same saved data but take different instance mutexes");
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
        BLOCK_LAYOUT_ARCHIVE_FOR.with(|blocked| blocked.replace(Some(path.clone())));
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

        BLOCK_LAYOUT_ARCHIVE_FOR.with(|blocked| blocked.replace(None));
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
        BLOCK_LAYOUT_ARCHIVE_FOR.with(|blocked| blocked.replace(Some(path.clone())));

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
        BLOCK_LAYOUT_ARCHIVE_FOR.with(|blocked| blocked.replace(None));
    }

    #[test]
    fn partial_shrink_copy_cannot_displace_twenty_valid_backups() {
        let _serial = persistence_test_lock();
        reset_quarantined_schema_for_test();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data.json");
        BLOCK_LAYOUT_ARCHIVE_FOR.with(|blocked| blocked.replace(Some(path.clone())));

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
        let candidates_before = scan_recovery_backups(&path).unwrap();
        FAIL_NEXT_LAYOUT_COPY.with(|failure| failure.set(true));
        let error = update(path.as_path(), |data| data.workspaces = layout_with_tab_counts(&[2]))
            .unwrap_err();
        assert!(error.to_string().contains("injected partial layout copy failure"));
        assert_eq!(fs::read(&path).unwrap(), live);
        let files_after: HashSet<_> = fs::read_dir(dir.path()).unwrap()
            .map(|entry| entry.unwrap().file_name()).collect();
        let candidates_after = scan_recovery_backups(&path).unwrap();

        update(path.as_path(), |data| data.active_workspace_id = Some("workspace-0".into())).unwrap();
        let retained: HashSet<_> = pre_replace_backups(&path).into_iter()
            .filter(|backup| deferred_shrink_backup_timestamp(&path, backup).is_some())
            .map(|backup| fs::read(backup).unwrap()).collect();

        BLOCK_LAYOUT_ARCHIVE_FOR.with(|blocked| blocked.replace(None));
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
    fn l3_77_shutdown_with_nothing_to_fill_does_not_rotate_the_backup() {
        let _serial = persistence_test_lock();
        reset_quarantined_schema_for_test();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data.json");
        let original = PersistentData {
            workspaces: layout_with_tab_counts(&[3]),
            ..Default::default()
        };
        let edited = PersistentData {
            workspaces: layout_with_tab_counts(&[2]),
            ..Default::default()
        };
        save_to_path(&path, &original).unwrap();
        save_to_path(&path, &edited).unwrap();
        let before = pre_replace_backups(&path);
        let bytes = fs::read(&before[0]).unwrap();
        update_for_shutdown(path.as_path(), Instant::now() + Duration::from_secs(1), |_| false).unwrap();
        assert_eq!(pre_replace_backups(&path), before);
        assert_eq!(fs::read(&before[0]).unwrap(), bytes);
    }

    #[test]
    fn l3_96_recovers_identifiable_interrupted_backup_copy_into_old() {
        let _serial = persistence_test_lock();
        reset_quarantined_schema_for_test();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data.json");
        save_to_path(&path, &PersistentData::default()).unwrap();
        let backups = path.with_file_name("data-backups");
        fs::create_dir_all(&backups).unwrap();
        let partial = backups.join(".tmpAbC123");
        fs::write(&partial, b"interrupted").unwrap();
        let unrelated = dir.path().join(".tmpXyz123");
        fs::write(&unrelated, b"other writer").unwrap();

        assert!(load_envelope(path.as_path()).unwrap().supported);
        assert!(!partial.exists());
        assert_eq!(fs::read(backups.join("_old").join(".tmpAbC123")).unwrap(), b"interrupted");
        assert_eq!(fs::read(unrelated).unwrap(), b"other writer");
    }

    #[test]
    fn l3_100_a_future_generation_does_not_suppress_new_generations() {
        let _serial = persistence_test_lock();
        reset_quarantined_schema_for_test();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data.json");
        save_to_path(&path, &PersistentData::default()).unwrap();
        let now = UNIX_EPOCH + Duration::from_secs(100);
        let future = archive_layout(&path, BackupKind::Generation, now + Duration::from_secs(7200)).unwrap();
        for elapsed in [0, 59, 60] {
            update_while_locked(path.as_path(), now + Duration::from_secs(elapsed), |_| {}).unwrap();
        }
        let timestamps: HashSet<_> = layout_backups(&path).into_iter().map(|backup| backup.timestamp).collect();
        assert_eq!(timestamps, [100, 160, 7300].map(|sec| timestamp_nanos(UNIX_EPOCH + Duration::from_secs(sec))).into());
        assert!(future.is_file());
    }

    #[test]
    fn l3_101_moves_the_interrupted_main_write_without_overwriting_earlier_copies() {
        let _serial = persistence_test_lock();
        reset_quarantined_schema_for_test();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data.json");
        save_to_path(&path, &PersistentData::default()).unwrap();
        let previous = fs::read(&path).unwrap();
        let name = "data.json.tmp-4294967295-1000";
        let partial = dir.path().join(name);
        fs::write(&partial, b"partial layout").unwrap();
        let old = dir.path().join("_old");
        fs::create_dir(&old).unwrap();
        fs::write(old.join(name), b"previous interrupted layout").unwrap();

        assert!(load_envelope(path.as_path()).unwrap().supported);
        assert!(!partial.exists());
        assert_eq!(fs::read(&path).unwrap(), previous);
        let files: Vec<_> = fs::read_dir(old).unwrap().map(|entry| fs::read(entry.unwrap().path()).unwrap()).collect();
        assert!(files.contains(&b"partial layout".to_vec()));
        assert!(files.contains(&b"previous interrupted layout".to_vec()));
    }

    #[test]
    fn l3_drop_102_restores_the_latest_numbered_backup_after_shrink() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data.json");
        let time = UNIX_EPOCH + Duration::from_secs(120);
        let large = PersistentData { workspaces: layout_with_tab_counts(&[10]), ..Default::default() };
        fs::write(&path, serde_json::to_vec(&large).unwrap()).unwrap();
        let before = archive_layout(&path, BackupKind::Shrink, time).unwrap();
        let small = PersistentData { workspaces: layout_with_tab_counts(&[2]), ..Default::default() };
        fs::write(&path, serde_json::to_vec(&small).unwrap()).unwrap();
        let after = archive_layout(&path, BackupKind::Generation, time + Duration::from_secs(61)).unwrap();
        fs::rename(&path, dir.path().join("unavailable.json")).unwrap();

        assert_eq!(load_from_path(&path).unwrap().layout_counts().tabs, 2);
        assert!(before.is_file());
        assert_eq!(fs::read(&path).unwrap(), fs::read(&after).unwrap());
    }

    fn review_generation(path: &Path, tabs: usize, conversation: &str, kind: BackupKind, time: SystemTime) -> PathBuf {
        let mut data = PersistentData { workspaces: layout_with_tab_counts(&[tabs]), ..Default::default() };
        data.workspaces[0].name = conversation.to_owned();
        data.workspaces[0].panes[0].tabs.as_mut().unwrap()[0].agent_session_id = Some(conversation.into());
        data.active_tab_id = data.workspaces[0].panes[0].tabs.as_ref().unwrap()[0].tab_id.clone();
        fs::write(path, serde_json::to_vec(&data).unwrap()).unwrap();
        archive_layout(path, kind, time).unwrap()
    }

    #[test]
    fn l3_fix2_11_a_forward_wall_clock_jump_does_not_expire_a_recent_shrink_copy() {
        let _serial = persistence_test_lock();
        reset_quarantined_schema_for_test();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data.json");
        let now = UNIX_EPOCH + Duration::from_secs(1_000_000);
        let data = PersistentData { workspaces: layout_with_tab_counts(&[10]), ..Default::default() };
        fs::write(&path, serde_json::to_vec(&data).unwrap()).unwrap();
        update_while_locked(path.as_path(), now, |data| data.workspaces = layout_with_tab_counts(&[2])).unwrap();
        let shrink = layout_backups(&path).into_iter().find(|b| b.kind == BackupKind::Shrink).unwrap();
        update_while_locked(path.as_path(), now + Duration::from_secs(31 * 86_400), |_| {}).unwrap();
        drop(_serial);

        assert!(shrink.path.is_file(), "the original pre-shrink copy must still be recoverable");
    }

    #[test]
    fn l3_fix2_11_legacy_shrink_copy_stays_available_after_the_first_save_on_a_new_clock() {
        let _serial = persistence_test_lock();
        reset_quarantined_schema_for_test();
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("data.json");
        let directory = temp.path().join("data-backups");
        fs::create_dir(&directory).unwrap();
        let old_time = UNIX_EPOCH + Duration::from_secs(1_000_000);
        let original = PersistentData { workspaces: layout_with_tab_counts(&[10]), ..Default::default() };
        let backup = directory.join(format!("shrink-{}-42.json", timestamp_nanos(old_time)));
        fs::write(&backup, serde_json::to_vec(&original).unwrap()).unwrap();
        let current = PersistentData { workspaces: layout_with_tab_counts(&[2]), ..Default::default() };
        fs::write(&path, serde_json::to_vec(&current).unwrap()).unwrap();

        update_while_locked(path.as_path(), old_time + Duration::from_secs(31 * 86_400), |_| {}).unwrap();
        drop(_serial);
        assert!(backup.is_file());
    }

    #[test]
    fn l3_fix2_12_recovery_orders_committed_generations_through_a_wall_clock_rollback() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data.json");
        let now = UNIX_EPOCH + Duration::from_secs(10_000);
        review_generation(&path, 1, "future-date-old-content", BackupKind::Generation, now + Duration::from_secs(10_000));
        review_generation(&path, 1, "corrected-date-new-content", BackupKind::Generation, now);
        fs::rename(&path, dir.path().join("missing-main.fixture")).unwrap();

        let restored = load_from_path(&path).unwrap();
        let tab = &restored.workspaces[0].panes[0].tabs.as_ref().unwrap()[0];
        assert_eq!(tab.agent_session_id.as_deref(), Some("corrected-date-new-content"));
    }

    #[test]
    fn l3_fix2_21_future_generation_does_not_disable_normal_count_limits() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data.json");
        fs::write(&path, b"{}").unwrap();
        let now = UNIX_EPOCH + Duration::from_secs(1_000_000);
        let future = archive_layout(&path, BackupKind::Generation, now + Duration::from_secs(365 * 86_400)).unwrap();
        for seconds in 0..32 {
            archive_layout(&path, BackupKind::Generation, now + Duration::from_secs(seconds)).unwrap();
        }
        prune_layout_backups(&path, now + Duration::from_secs(60));
        assert!(future.is_file());
        assert_eq!(layout_backups(&path).len(), 21);
    }

    #[tokio::test]
    async fn lane_a_backup_enumeration_save_failure_omits_the_home_path() {
        let _serial = persistence_test_lock();
        reset_quarantined_schema_for_test();
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("fixture-home-name");
        fs::create_dir(&home).unwrap();
        let path = home.join("data.json");
        let data = PersistentData::default();
        let original = serde_json::to_vec(&data).unwrap();
        fs::write(&path, &original).unwrap();
        fs::write(home.join("data-backups"), b"cannot enumerate").unwrap();

        let diagnostics = temp.path().join("diagnostics");
        let result = crate::diag::with_test_dir(diagnostics.clone(), async {
            save_to_path(&path, &data)
        }).await;
        drop(_serial);
        assert!(result.unwrap_err().to_string().contains("cannot determine layout backup order"));
        assert_eq!(fs::read(&path).unwrap(), original);
        let saved = fs::read_to_string(diagnostics.join("diag.log")).unwrap();
        assert!(saved.contains("failed to save data.json: cannot determine layout backup order"));
        assert!(!saved.contains("fixture-home-name"), "the diagnostic named the fixture home directory");
    }

    #[test]
    fn lane_a_mirror_defaults_to_no_root_on_new_and_missing_settings() {
        assert_eq!(AppSettings::default().ailog_mirror_full_text_root, None);
        let mut wire = serde_json::to_value(AppSettings::default()).unwrap();
        wire.as_object_mut().unwrap().remove("ailog_mirror_full_text_root");
        let settings: AppSettings = serde_json::from_value(wire).unwrap();
        assert_eq!(settings.ailog_mirror_full_text_root, None);
    }

    #[test]
    fn lane_a_mirror_clears_only_the_legacy_default_and_persists_the_migration_once() {
        const LEGACY: &str = "G:\\\u{30de}\u{30a4}\u{30c9}\u{30e9}\u{30a4}\u{30d6}\\pc-backup\\mycmux-ailog";
        const MARKER: &str = "ailog_mirror_full_text_root_migrated";
        let _serial = persistence_test_lock();
        reset_quarantined_schema_for_test();
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("data.json");
        let mut wire = serde_json::to_value(PersistentData::default()).unwrap();
        wire["settings"].as_object_mut().unwrap().remove(MARKER);
        wire["settings"]["ailog_mirror_full_text_root"] = serde_json::json!(LEGACY);
        wire["settings"]["fixture_setting_from_a_different_build"] = serde_json::json!({"value": true});
        fs::write(&path, serde_json::to_vec(&wire).unwrap()).unwrap();

        let migrated = load(path.as_path()).unwrap().settings.ailog_mirror_full_text_root;
        let persisted: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        update(path.as_path(), |disk| disk.settings.ailog_mirror_full_text_root = Some(LEGACY.into())).unwrap();
        let restored = load(path.as_path()).unwrap().settings.ailog_mirror_full_text_root;

        let other_path = temp.path().join("other").join("data.json");
        fs::create_dir(other_path.parent().unwrap()).unwrap();
        let different = LEGACY.replacen('G', "g", 1);
        wire["settings"]["ailog_mirror_full_text_root"] = serde_json::json!(&different);
        fs::write(&other_path, serde_json::to_vec(&wire).unwrap()).unwrap();
        let preserved = load(other_path.as_path()).unwrap().settings.ailog_mirror_full_text_root;
        let other_persisted: serde_json::Value = serde_json::from_slice(&fs::read(other_path).unwrap()).unwrap();
        drop(_serial);

        assert_eq!(migrated, None);
        assert_eq!(persisted["settings"][MARKER], true);
        assert!(persisted["settings"]["ailog_mirror_full_text_root"].is_null());
        assert_eq!(persisted["settings"]["fixture_setting_from_a_different_build"]["value"], true);
        assert_eq!(restored.as_deref(), Some(LEGACY));
        assert_eq!(preserved.as_deref(), Some(different.as_str()));
        assert_eq!(other_persisted["settings"][MARKER], true);
    }

    #[test]
    fn l3_fix3_05_a_failed_backup_scan_cannot_start_or_save_an_empty_layout() {
        let _serial = persistence_test_lock();
        reset_quarantined_schema_for_test();
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("data.json");
        let now = UNIX_EPOCH + Duration::from_secs(20_000);
        let backup = review_generation(&path, 1, "recoverable", BackupKind::Generation, now);
        fs::rename(&path, temp.path().join("removed-main.fixture")).unwrap();
        let directory = backup.parent().unwrap();
        let hidden = temp.path().join("unavailable-backups.fixture");
        fs::rename(directory, &hidden).unwrap();
        fs::write(directory, b"cannot enumerate this directory").unwrap();

        assert!(load_from_path(&path).is_err(), "an incomplete scan must not report an empty layout");
        assert!(update_while_locked(path.as_path(), now, |_| {}).is_err());
        assert!(!path.exists());

        fs::rename(directory, temp.path().join("directory-error.fixture")).unwrap();
        fs::rename(hidden, directory).unwrap();
        assert_eq!(load_from_path(&path).unwrap().workspaces[0].name, "recoverable");
    }

    #[cfg(unix)]
    #[test]
    fn l3_fix3_05_an_unreadable_candidate_does_not_create_an_empty_layout() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("data.json");
        let backup = review_generation(&path, 1, "recoverable", BackupKind::Generation, UNIX_EPOCH);
        fs::rename(&path, temp.path().join("removed-main.fixture")).unwrap();
        let original = fs::metadata(&backup).unwrap().permissions();
        fs::set_permissions(&backup, fs::Permissions::from_mode(0)).unwrap();
        let read_error = fs::read(&backup).unwrap_err().kind();
        let initial = load_from_path(&path);
        fs::set_permissions(&backup, original).unwrap();

        assert_eq!(read_error, std::io::ErrorKind::PermissionDenied);
        assert!(initial.is_err());
        assert!(!path.exists());
        assert_eq!(load_from_path(&path).unwrap().workspaces[0].name, "recoverable");
    }

    #[test]
    fn l3_drop_102_recovers_the_latest_generation_with_its_original_rows() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("data.json");
        let backups = temp.path().join("data-backups");
        fs::create_dir(&backups).unwrap();

        let mut older = PersistentData { workspaces: layout_with_tab_counts(&[10]), ..Default::default() };
        let pane = &mut older.workspaces[0].panes[0];
        pane.pane_id = Some("same-pane".into());
        pane.tabs.as_mut().unwrap()[1].agent_session_id = Some("old-conversation".into());
        let shrink = backups.join("shrink-100-1.json");
        fs::write(&shrink, serde_json::to_vec(&older).unwrap()).unwrap();

        let mut newest = older.clone();
        let mut second_row = newest.workspaces[0].clone();
        newest.workspaces[0].panes[0].tabs.as_mut().unwrap().truncate(1);
        let mut next_tab = second_row.panes[0].tabs.as_ref().unwrap()[1].clone();
        next_tab.agent_session_id = Some("new-conversation".into());
        newest.active_workspace_id = Some(second_row.id.clone());
        newest.active_tab_id = next_tab.tab_id.clone();
        second_row.panes[0].tabs = Some(vec![next_tab]);
        newest.workspaces.push(second_row);
        let newest_bytes = serde_json::to_vec(&newest).unwrap();
        fs::write(backups.join("data-200-1.json"), &newest_bytes).unwrap();

        let recovered = load_from_path(&path).unwrap();
        assert_eq!(recovered.layout_counts().tabs, 2);
        assert_eq!(recovered.workspaces.len(), 2);
        let later_tabs = recovered.workspaces[1].panes[0].tabs.as_ref().unwrap();
        assert_eq!(later_tabs[0].tab_id.as_deref(), Some("tab-0-1"));
        assert_eq!(later_tabs[0].agent_session_id.as_deref(), Some("new-conversation"));
        assert_eq!(recovered.active_tab_id, newest.active_tab_id);
        assert!(fs::read(&path).unwrap() == newest_bytes, "restore the chosen generation byte for byte");
        assert!(shrink.is_file());
    }

    #[test]
    fn l3_fix3_09_a_save_cannot_reuse_an_order_from_an_unreadable_generation_directory() {
        let _serial = persistence_test_lock();
        reset_quarantined_schema_for_test();
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("data.json");
        let future = UNIX_EPOCH + Duration::from_secs(40_000);
        let older = review_generation(&path, 1, "old-conversation", BackupKind::Generation, future);
        update_while_locked(path.as_path(), future + Duration::from_secs(61), |layout| {
            layout.workspaces[0].panes[0].tabs.as_mut().unwrap()[0].agent_session_id = Some("new-conversation".into());
        }).unwrap();
        let latest = fs::read(&path).unwrap();
        let directory = older.parent().unwrap();
        let unlisted = temp.path().join("unlisted-backups.fixture");
        fs::rename(directory, &unlisted).unwrap();
        fs::write(directory, b"cannot enumerate this directory").unwrap();

        let rolled_back = future - Duration::from_secs(10_000);
        assert!(update_while_locked(path.as_path(), rolled_back, |layout| layout.workspaces[0].name = "Changed".into()).is_err());
        assert_eq!(fs::read(&path).unwrap(), latest);

        fs::rename(directory, temp.path().join("directory-error.fixture")).unwrap();
        fs::rename(unlisted, directory).unwrap();
        update_while_locked(path.as_path(), rolled_back, |layout| layout.workspaces[0].name = "Changed".into()).unwrap();
        fs::rename(&path, temp.path().join("removed-main.fixture")).unwrap();
        let recovered = load_from_path(&path).unwrap();
        assert_eq!(recovered.workspaces[0].panes[0].tabs.as_ref().unwrap()[0].agent_session_id.as_deref(), Some("new-conversation"));
    }

    #[test]
    fn l3_fix3_11_future_generations_do_not_keep_accumulating_new_overflow_archives() {
        let _serial = persistence_test_lock();
        reset_quarantined_schema_for_test();
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("data.json");
        let now = UNIX_EPOCH + Duration::from_secs(1_000_000);
        let future = review_generation(&path, 1, "future", BackupKind::Generation, now + Duration::from_secs(365 * 86_400));
        for second in 0..32 {
            archive_layout(&path, BackupKind::Generation, now + Duration::from_secs(second)).unwrap();
        }
        prune_layout_backups(&path, now + Duration::from_secs(60));
        let overflow = future.parent().unwrap().join("_old");
        let kept_before = layout_backups(&path).len() + fs::read_dir(&overflow).map_or(0, Iterator::count);
        for seconds in [120, 181] {
            update_while_locked(path.as_path(), now + Duration::from_secs(seconds), |_| {}).unwrap();
        }

        assert!(future.is_file());
        assert!(layout_backups(&path).len() + fs::read_dir(&overflow).map_or(0, Iterator::count) <= kept_before);
    }

    #[tokio::test]
    async fn l3_fix3_12_shrink_diagnostics_do_not_include_the_backup_path() {
        let _serial = persistence_test_lock();
        reset_quarantined_schema_for_test();
        let temp = tempfile::tempdir().unwrap();
        let fixture_owner = "layout-owner@example.test";
        let path = temp.path().join(fixture_owner).join("data.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let data = PersistentData { workspaces: layout_with_tab_counts(&[4]), ..Default::default() };
        fs::write(&path, serde_json::to_vec(&data).unwrap()).unwrap();

        crate::diag::with_test_dir(temp.path().to_owned(), async {
            update_while_locked(path.as_path(), SystemTime::now(), |layout| {
                layout.workspaces = layout_with_tab_counts(&[1]);
            }).unwrap();
        }).await;

        let log = fs::read_to_string(temp.path().join("diag.log")).unwrap();
        assert!(log.contains("shrink tabs 4->1"));
        assert!(!log.contains(fixture_owner));
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
