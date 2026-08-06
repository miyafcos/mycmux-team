use crate::pty::path_norm::strip_extended_length_prefix;
use chrono::{DateTime, Local, NaiveDateTime, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};
use uuid::Uuid;

pub(crate) mod transfer;

pub(crate) const DROPBOX_TOKEN: &str = "{DROPBOX}";
pub(crate) const SAVEPOINT_SCHEMA: u32 = 1;
pub(crate) const FINAL_RECORDS_DIR: &str = "_records";
pub(crate) const TRASH_DIR: &str = "_trash";
pub(crate) const TRASHED_FINAL_CHECKPOINT_FIELD: &str = "trashed_final_checkpoint";
const STORAGE_MARKER_FILE: &str = ".mycmux-savepoints.json";
const STORAGE_MARKER_KIND: &str = "mycmux-savepoint-storage";
const STALE_TMP_SECONDS: u64 = 24 * 60 * 60;
const RESTORED_EXPIRE_HOURS: i64 = 48;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SavepointAgentKind {
    Claude,
    Codex,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SavepointIdentity {
    pub(crate) kind: SavepointAgentKind,
    pub(crate) session_id: String,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SavepointLifecycleStatus {
    Active,
    #[default]
    Interrupted,
    Closed,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
pub(crate) struct SavepointLifecycle {
    #[serde(default)]
    pub(crate) status: SavepointLifecycleStatus,
    #[serde(default)]
    pub(crate) checkpoint_id: Option<String>,
    #[serde(default)]
    pub(crate) parent_checkpoint_id: Option<String>,
    #[serde(default)]
    pub(crate) final_checkpoint: bool,
    #[serde(default)]
    pub(crate) closed_at: Option<String>,
    #[serde(default)]
    pub(crate) closed_reason: Option<String>,
}

impl SavepointLifecycle {
    pub(crate) fn normalized(mut self) -> Self {
        self.checkpoint_id = self
            .checkpoint_id
            .as_deref()
            .and_then(|value| Uuid::parse_str(value).ok())
            .map(|value| value.to_string());
        self.parent_checkpoint_id = self
            .parent_checkpoint_id
            .as_deref()
            .and_then(|value| Uuid::parse_str(value).ok())
            .map(|value| value.to_string());
        self
    }
}

fn deserialize_lifecycle_or_default<'de, D>(deserializer: D) -> Result<SavepointLifecycle, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(serde_json::from_value::<SavepointLifecycle>(value)
        .unwrap_or_default()
        .normalized())
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SavepointRecordKind {
    Current,
    Final,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum SavepointTrashReason {
    Manual,
    Expired,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum SavepointTrashParent {
    Root,
    Records,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
struct SavepointTrash {
    id: String,
    deleted_at: String,
    reason: SavepointTrashReason,
    original_parent: SavepointTrashParent,
    original_name: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
struct SavepointTransferOrigin {
    id: String,
    received_at: String,
    #[serde(default)]
    sha256: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
pub(crate) struct SavepointConfig {
    #[serde(default)]
    pub(crate) local_dir: Option<String>,
    #[serde(default)]
    pub(crate) online_dir: Option<String>,
    #[serde(default)]
    pub(crate) dropbox_root: Option<String>,
    #[serde(default)]
    pub(crate) author: Option<String>,
    #[serde(default)]
    pub(crate) machine: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SavepointManifest {
    schema: u32,
    author: String,
    machine: String,
    created_at: String,
    updated_at: String,
    expires_at: String,
    #[serde(default)]
    pinned: bool,
    #[serde(default)]
    trash: Option<SavepointTrash>,
    summary_line: String,
    cwd: String,
    #[serde(default)]
    agent_kind: Option<SavepointAgentKind>,
    #[serde(default)]
    agent_session_id: Option<String>,
    #[serde(default)]
    claude_session_id: Option<String>,
    #[serde(default)]
    files_written: Vec<String>,
    #[serde(default)]
    warnings: Vec<String>,
    #[serde(default)]
    transfer: Option<SavepointTransferOrigin>,
    #[serde(default, deserialize_with = "deserialize_lifecycle_or_default")]
    lifecycle: SavepointLifecycle,
}

impl SavepointManifest {
    fn identity(&self) -> Result<SavepointIdentity, String> {
        let generic_id = self
            .agent_session_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let legacy_id = self
            .claude_session_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        match (self.agent_kind, generic_id, legacy_id) {
            (None, None, Some(session_id)) => Ok(SavepointIdentity {
                kind: SavepointAgentKind::Claude,
                session_id: session_id.to_string(),
            }),
            (Some(SavepointAgentKind::Claude), Some(session_id), Some(legacy))
                if session_id == legacy =>
            {
                Ok(SavepointIdentity {
                    kind: SavepointAgentKind::Claude,
                    session_id: session_id.to_string(),
                })
            }
            (Some(SavepointAgentKind::Codex), Some(session_id), None) => Ok(SavepointIdentity {
                kind: SavepointAgentKind::Codex,
                session_id: session_id.to_string(),
            }),
            _ => Err("Savepoint agent identity is invalid".to_string()),
        }
    }
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct OnlineSavepointEntry {
    bundle_dir: String,
    author: String,
    machine: String,
    summary_line: String,
    cwd: String,
    created_at: String,
    updated_at: String,
    expires_at: String,
    pinned: bool,
    trash_id: Option<String>,
    deleted_at: Option<String>,
    trash_reason: Option<SavepointTrashReason>,
    received: bool,
    transfer_id: Option<String>,
    warnings_count: usize,
    agent_kind: SavepointAgentKind,
    agent_session_id: String,
    claude_session_id: Option<String>,
    files_written_count: usize,
    handoff_path: String,
    record_kind: SavepointRecordKind,
    lifecycle_status: SavepointLifecycleStatus,
    checkpoint_id: Option<String>,
    parent_checkpoint_id: Option<String>,
    closed_at: Option<String>,
    closed_reason: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct JoinSavepointSummary {
    resolved_cwd: String,
    handoff_path: String,
    cwd_missing: bool,
    source_checkpoint_id: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct JoinSavepointFull {
    resolved_cwd: String,
    cwd_missing: bool,
    resume_session_id: Option<String>,
    command_argv: Vec<String>,
    agent_kind: SavepointAgentKind,
    source_checkpoint_id: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct ToggleSavepointPinResult {
    pinned: bool,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct CleanupOnlineSavepointsResult {
    online_dir: String,
    machine: String,
    deleted_count: usize,
    expired_count: usize,
    stale_count: usize,
    kept_count: usize,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct SavepointStorageSettings {
    directory: Option<String>,
    directory_exists: bool,
    legacy_directory: Option<String>,
}

pub(crate) fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, String> {
    let contents = fs::read_to_string(path)
        .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
    serde_json::from_str(&contents)
        .map_err(|error| format!("Failed to parse {}: {error}", path.display()))
}

pub(crate) fn is_link_or_reparse_point(path: &Path) -> bool {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return false;
    };
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        let attributes = metadata.file_attributes();
        let read_link_succeeded =
            attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 && fs::read_link(path).is_ok();
        is_redirecting_windows_reparse_point(attributes, read_link_succeeded)
    }
    #[cfg(not(windows))]
    {
        false
    }
}

#[cfg(windows)]
fn is_redirecting_windows_reparse_point(file_attributes: u32, read_link_succeeded: bool) -> bool {
    // Dropbox Smart Sync folders have the reparse attribute but are not path
    // aliases. std::fs::read_link resolves symlinks and junctions and rejects
    // Cloud Files placeholders, which lets normal synced folders pass through.
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    file_attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 && read_link_succeeded
}

pub(crate) fn expand_home_path(raw: &str, home: &Path) -> PathBuf {
    if raw == "~" {
        return home.to_path_buf();
    }
    if let Some(suffix) = raw.strip_prefix("~/").or_else(|| raw.strip_prefix("~\\")) {
        return home.join(suffix);
    }
    PathBuf::from(raw)
}

pub(crate) fn absolute_path(path: PathBuf) -> Result<PathBuf, String> {
    if path.is_absolute() {
        return Ok(path);
    }
    std::env::current_dir()
        .map(|cwd| cwd.join(path))
        .map_err(|error| format!("Failed to resolve current directory: {error}"))
}

pub(crate) fn load_config(config_path: &Path) -> Result<SavepointConfig, String> {
    if config_path.exists() {
        read_json(config_path)
    } else {
        Ok(SavepointConfig::default())
    }
}

fn existing_directory_inside_mycmux_home(path: &Path, home: &Path) -> Option<PathBuf> {
    let root = fs::canonicalize(home.join(".mycmux")).ok()?;
    let candidate = fs::canonicalize(path).ok()?;
    (candidate.is_dir() && candidate.starts_with(&root)).then_some(candidate)
}

pub(crate) fn local_savepoint_dir(
    config: &SavepointConfig,
    home: &Path,
) -> Result<PathBuf, String> {
    if let Some(local_dir) = config
        .local_dir
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let local_dir = expand_home_path(local_dir, home);
        if local_dir.is_absolute() && !is_link_or_reparse_point(&local_dir) {
            return Ok(local_dir);
        }
    }

    if let Some(legacy_dir) = config
        .online_dir
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if let Ok(legacy_dir) = absolute_path(expand_home_path(legacy_dir, home)) {
            if let Some(legacy_dir) = existing_directory_inside_mycmux_home(&legacy_dir, home) {
                return Ok(legacy_dir);
            }
        }
    }

    Ok(home.join(".mycmux").join("savepoints"))
}

pub(crate) fn local_savepoint_dir_from_config(
    config_path: &Path,
    home: &Path,
) -> Result<PathBuf, String> {
    let config = load_config(config_path)?;
    local_savepoint_dir(&config, home)
}

fn path_for_display(path: &Path) -> String {
    let value = path.to_string_lossy();
    #[cfg(windows)]
    {
        if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{rest}");
        }
        value.strip_prefix(r"\\?\").unwrap_or(&value).to_string()
    }
    #[cfg(not(windows))]
    {
        value.into_owned()
    }
}

fn is_hex_nonce(value: &str, allowed_lengths: &[usize]) -> bool {
    allowed_lengths.contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn is_generated_publish_artifact_name(name: &str) -> bool {
    if let Some(rest) = name.strip_prefix('.') {
        if let Some((target, nonce)) = rest.rsplit_once(".tmp-") {
            return !target.is_empty() && is_hex_nonce(nonce, &[8, 32]);
        }
    }

    let Some((target, suffix)) = name.rsplit_once(".old-") else {
        return false;
    };
    let mut parts = suffix.split('-');
    let process_id = parts.next().unwrap_or_default();
    let nonce = parts.next().unwrap_or_default();
    !target.is_empty()
        && !process_id.is_empty()
        && process_id.bytes().all(|byte| byte.is_ascii_digit())
        && is_hex_nonce(nonce, &[8])
        && parts.next().is_none()
}

fn has_valid_savepoint_manifest(directory: &Path) -> bool {
    read_json::<SavepointManifest>(&directory.join("manifest.json"))
        .is_ok_and(|manifest| manifest.schema == SAVEPOINT_SCHEMA && manifest.identity().is_ok())
}

fn is_safe_path_component(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && Path::new(value).components().count() == 1
        && matches!(
            Path::new(value).components().next(),
            Some(std::path::Component::Normal(_))
        )
        && Path::new(value)
            .file_name()
            .is_some_and(|name| name.to_string_lossy() == value)
}

fn write_storage_marker(directory: &Path) -> Result<(), String> {
    write_json_atomic(
        &directory.join(STORAGE_MARKER_FILE),
        &serde_json::json!({
            "kind": STORAGE_MARKER_KIND,
            "schema": SAVEPOINT_SCHEMA,
        }),
    )
}

fn get_savepoint_storage_settings_from_config(
    config_path: &Path,
    home: &Path,
) -> Result<SavepointStorageSettings, String> {
    let config = load_config(config_path)?;
    let directory = local_savepoint_dir(&config, home)?;
    let directory_exists = directory.is_dir();
    let display_directory = if directory_exists {
        fs::canonicalize(&directory)
            .map(|path| path_for_display(&path))
            .unwrap_or_else(|_| path_for_display(&directory))
    } else {
        path_for_display(&directory)
    };
    let legacy_directory = config
        .online_dir
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            let expanded = expand_home_path(value, home);
            absolute_path(expanded.clone()).unwrap_or(expanded)
        })
        .filter(|legacy| legacy != &directory)
        .map(|legacy| path_for_display(&legacy));

    Ok(SavepointStorageSettings {
        directory: Some(display_directory),
        directory_exists,
        legacy_directory,
    })
}

fn online_savepoint_entry(
    bundle_dir: PathBuf,
    mut manifest: SavepointManifest,
    include_trash: bool,
) -> Result<OnlineSavepointEntry, String> {
    let identity = manifest.identity()?;
    manifest.lifecycle = manifest.lifecycle.normalized();
    let handoff_path = bundle_dir.join("handoff.md");
    let record_kind = if manifest.lifecycle.final_checkpoint {
        SavepointRecordKind::Final
    } else {
        SavepointRecordKind::Current
    };
    let trash = include_trash.then(|| manifest.trash.clone()).flatten();
    let transfer_id = manifest.transfer.as_ref().map(|value| value.id.clone());
    Ok(OnlineSavepointEntry {
        bundle_dir: bundle_dir.to_string_lossy().into_owned(),
        author: manifest.author,
        machine: manifest.machine,
        summary_line: manifest.summary_line,
        cwd: manifest.cwd,
        created_at: manifest.created_at,
        updated_at: manifest.updated_at,
        expires_at: manifest.expires_at,
        pinned: manifest.pinned,
        trash_id: trash.as_ref().map(|value| value.id.clone()),
        deleted_at: trash.as_ref().map(|value| value.deleted_at.clone()),
        trash_reason: trash.as_ref().map(|value| value.reason),
        received: transfer_id.is_some(),
        transfer_id,
        warnings_count: manifest.warnings.len(),
        agent_kind: identity.kind,
        agent_session_id: identity.session_id.clone(),
        claude_session_id: (identity.kind == SavepointAgentKind::Claude)
            .then_some(identity.session_id),
        files_written_count: manifest.files_written.len(),
        handoff_path: strip_extended_length_prefix(&handoff_path.to_string_lossy()),
        record_kind,
        lifecycle_status: manifest.lifecycle.status,
        checkpoint_id: manifest.lifecycle.checkpoint_id,
        parent_checkpoint_id: manifest.lifecycle.parent_checkpoint_id,
        closed_at: manifest.lifecycle.closed_at,
        closed_reason: manifest.lifecycle.closed_reason,
    })
}

fn list_online_savepoints_from_config(
    config_path: &Path,
    home: &Path,
) -> Result<Vec<OnlineSavepointEntry>, String> {
    let online_dir = local_savepoint_dir_from_config(config_path, home)?;
    if !online_dir.is_dir() {
        return Ok(Vec::new());
    }

    let mut entries = Vec::new();
    let online_root = fs::canonicalize(&online_dir)
        .map_err(|error| format!("Failed to resolve {}: {error}", online_dir.display()))?;
    let mut scan_roots = vec![online_root.clone()];
    let final_records_dir = online_root.join(FINAL_RECORDS_DIR);
    if final_records_dir.is_dir() && !is_link_or_reparse_point(&final_records_dir) {
        if let Ok(final_records_root) = fs::canonicalize(&final_records_dir) {
            if final_records_root.parent() == Some(online_root.as_path()) {
                scan_roots.push(final_records_root);
            }
        }
    }
    for scan_root in scan_roots {
        let directories = fs::read_dir(&scan_root)
            .map_err(|error| format!("Failed to scan {}: {error}", scan_root.display()))?;
        for directory in directories.flatten() {
            let candidate = directory.path();
            let name = directory.file_name().to_string_lossy().into_owned();
            if name.starts_with('.')
                || name == FINAL_RECORDS_DIR
                || name == TRASH_DIR
                || !candidate.is_dir()
            {
                continue;
            }
            if is_link_or_reparse_point(&candidate) {
                continue;
            }
            let Ok(bundle_dir) = fs::canonicalize(&candidate) else {
                continue;
            };
            if bundle_dir.parent() != Some(scan_root.as_path()) {
                continue;
            }
            let manifest_path = bundle_dir.join("manifest.json");
            let Ok(manifest) = read_json::<SavepointManifest>(&manifest_path) else {
                continue;
            };
            if manifest.schema != SAVEPOINT_SCHEMA {
                continue;
            }
            if let Ok(entry) = online_savepoint_entry(bundle_dir, manifest, false) {
                entries.push(entry);
            }
        }
    }
    let final_checkpoint_ids = entries
        .iter()
        .filter(|entry| entry.record_kind == SavepointRecordKind::Final)
        .filter_map(|entry| entry.checkpoint_id.clone())
        .collect::<std::collections::HashSet<_>>();
    entries.retain(|entry| {
        entry.record_kind != SavepointRecordKind::Current
            || (entry.lifecycle_status != SavepointLifecycleStatus::Closed
                && !entry
                    .checkpoint_id
                    .as_ref()
                    .is_some_and(|id| final_checkpoint_ids.contains(id)))
    });
    Ok(entries)
}

fn list_trashed_online_savepoints_from_config(
    config_path: &Path,
    home: &Path,
) -> Result<Vec<OnlineSavepointEntry>, String> {
    let online_dir = local_savepoint_dir_from_config(config_path, home)?;
    if !online_dir.is_dir() {
        return Ok(Vec::new());
    }
    let online_root = fs::canonicalize(&online_dir)
        .map_err(|error| format!("Failed to resolve {}: {error}", online_dir.display()))?;
    let trash_dir = online_root.join(TRASH_DIR);
    if !trash_dir.is_dir() || is_link_or_reparse_point(&trash_dir) {
        return Ok(Vec::new());
    }
    let trash_root = fs::canonicalize(&trash_dir)
        .map_err(|error| format!("Failed to resolve {}: {error}", trash_dir.display()))?;
    if trash_root.parent() != Some(online_root.as_path()) {
        return Ok(Vec::new());
    }

    let mut entries = Vec::new();
    let directories = fs::read_dir(&trash_root)
        .map_err(|error| format!("Failed to scan {}: {error}", trash_root.display()))?;
    for directory in directories.flatten() {
        let candidate = directory.path();
        let name = directory.file_name().to_string_lossy().into_owned();
        if !candidate.is_dir() || is_link_or_reparse_point(&candidate) {
            continue;
        }
        let Ok(bundle_dir) = fs::canonicalize(&candidate) else {
            continue;
        };
        if bundle_dir.parent() != Some(trash_root.as_path()) {
            continue;
        }
        let Ok(manifest) = read_json::<SavepointManifest>(&bundle_dir.join("manifest.json")) else {
            continue;
        };
        if manifest.schema != SAVEPOINT_SCHEMA
            || manifest.identity().is_err()
            || !manifest.trash.as_ref().is_some_and(|trash| {
                trash.id == name && is_safe_path_component(&trash.original_name)
            })
        {
            continue;
        }
        if let Ok(entry) = online_savepoint_entry(bundle_dir, manifest, true) {
            entries.push(entry);
        }
    }
    Ok(entries)
}

include!("online/join.rs");

include!("online/lifecycle.rs");

#[tauri::command(async)]
pub fn list_online_savepoints() -> Result<Vec<OnlineSavepointEntry>, String> {
    let home = dirs::home_dir().ok_or_else(|| "Failed to resolve home directory".to_string())?;
    list_online_savepoints_from_config(&home.join(".mycmux").join("savepoint.json"), &home)
}

#[tauri::command(async)]
pub fn list_trashed_online_savepoints() -> Result<Vec<OnlineSavepointEntry>, String> {
    let home = dirs::home_dir().ok_or_else(|| "Failed to resolve home directory".to_string())?;
    list_trashed_online_savepoints_from_config(&home.join(".mycmux").join("savepoint.json"), &home)
}

#[tauri::command(async)]
pub fn get_savepoint_storage_settings() -> Result<SavepointStorageSettings, String> {
    let home = dirs::home_dir().ok_or_else(|| "Failed to resolve home directory".to_string())?;
    get_savepoint_storage_settings_from_config(&home.join(".mycmux").join("savepoint.json"), &home)
}

#[tauri::command(async)]
pub fn join_savepoint_summary(bundle_dir: String) -> Result<JoinSavepointSummary, String> {
    let home = dirs::home_dir().ok_or_else(|| "Failed to resolve home directory".to_string())?;
    join_savepoint_summary_from_config(
        Path::new(&bundle_dir),
        &home.join(".mycmux").join("savepoint.json"),
        &home,
    )
}

#[tauri::command(async)]
pub fn join_savepoint_full(bundle_dir: String) -> Result<JoinSavepointFull, String> {
    let home = dirs::home_dir().ok_or_else(|| "Failed to resolve home directory".to_string())?;
    join_savepoint_full_from_config(
        Path::new(&bundle_dir),
        &home.join(".mycmux").join("savepoint.json"),
        &home,
        &home.join(".claude").join("projects"),
    )
}

#[tauri::command(async)]
pub fn toggle_savepoint_pin(bundle_dir: String) -> Result<ToggleSavepointPinResult, String> {
    let _publish_guard = super::online_publish::PUBLISH_LOCK
        .lock()
        .map_err(|_| "Savepoint publisher lock is unavailable".to_string())?;
    let home = dirs::home_dir().ok_or_else(|| "Failed to resolve home directory".to_string())?;
    let config = load_config(&home.join(".mycmux").join("savepoint.json"))?;
    let local_dir = local_savepoint_dir(&config, &home)?;
    let (_, bundle_dir, _, _, _) = resolve_active_savepoint(&local_dir, Path::new(&bundle_dir))?;
    toggle_savepoint_pin_at(&bundle_dir)
}

#[tauri::command(async)]
pub fn delete_online_savepoint(bundle_dir: String) -> Result<(), String> {
    let _publish_guard = super::online_publish::PUBLISH_LOCK
        .lock()
        .map_err(|_| "Savepoint publisher lock is unavailable".to_string())?;
    let home = dirs::home_dir().ok_or_else(|| "Failed to resolve home directory".to_string())?;
    let config = load_config(&home.join(".mycmux").join("savepoint.json"))?;
    let online_dir = local_savepoint_dir(&config, &home)?;
    trash_online_savepoint_at(
        &online_dir,
        Path::new(&bundle_dir),
        &Utc::now().to_rfc3339(),
        SavepointTrashReason::Manual,
    )
    .map(|_| ())
}

#[tauri::command(async)]
pub fn restore_online_savepoint(bundle_dir: String, trash_id: String) -> Result<(), String> {
    let _publish_guard = super::online_publish::PUBLISH_LOCK
        .lock()
        .map_err(|_| "Savepoint publisher lock is unavailable".to_string())?;
    let home = dirs::home_dir().ok_or_else(|| "Failed to resolve home directory".to_string())?;
    let config = load_config(&home.join(".mycmux").join("savepoint.json"))?;
    let online_dir = local_savepoint_dir(&config, &home)?;
    restore_online_savepoint_at(&online_dir, Path::new(&bundle_dir), &trash_id).map(|_| ())
}

#[tauri::command(async)]
pub fn purge_online_savepoint(bundle_dir: String, trash_id: String) -> Result<(), String> {
    let _publish_guard = super::online_publish::PUBLISH_LOCK
        .lock()
        .map_err(|_| "Savepoint publisher lock is unavailable".to_string())?;
    let home = dirs::home_dir().ok_or_else(|| "Failed to resolve home directory".to_string())?;
    let config = load_config(&home.join(".mycmux").join("savepoint.json"))?;
    let online_dir = local_savepoint_dir(&config, &home)?;
    purge_online_savepoint_at(&online_dir, Path::new(&bundle_dir), &trash_id)
}

#[tauri::command(async)]
pub fn cleanup_online_savepoints() -> Result<CleanupOnlineSavepointsResult, String> {
    let home = dirs::home_dir().ok_or_else(|| "Failed to resolve home directory".to_string())?;
    cleanup_online_savepoints_from_config(
        &home.join(".mycmux").join("savepoint.json"),
        &home,
        Utc::now(),
        SystemTime::now(),
    )
}

#[cfg(test)]
mod tests;
