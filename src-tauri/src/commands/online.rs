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
        handoff_path: handoff_path.to_string_lossy().into_owned(),
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

fn resolve_join_cwd(cwd: &str, dropbox_root: Option<&str>, home: &Path) -> (PathBuf, bool) {
    let candidate = if let Some(suffix) = cwd.strip_prefix(DROPBOX_TOKEN) {
        dropbox_root
            .map(|root| expand_home_path(root, home).join(suffix.trim_start_matches(['/', '\\'])))
    } else {
        let path = PathBuf::from(cwd);
        path.is_absolute().then_some(path)
    };

    match candidate {
        Some(path) if path.is_dir() => (path, false),
        _ => (home.to_path_buf(), true),
    }
}

fn join_savepoint_summary_from_config(
    bundle_dir: &Path,
    config_path: &Path,
    home: &Path,
) -> Result<JoinSavepointSummary, String> {
    let config = load_config(config_path)?;
    let bundle_dir = absolute_path(bundle_dir.to_path_buf())?;
    let mut manifest: SavepointManifest = read_json(&bundle_dir.join("manifest.json"))?;
    if manifest.schema != SAVEPOINT_SCHEMA {
        return Err(format!("Unsupported savepoint schema: {}", manifest.schema));
    }
    manifest.identity()?;
    manifest.lifecycle = manifest.lifecycle.normalized();
    let handoff_path = bundle_dir.join("handoff.md");
    let handoff_metadata = fs::metadata(&handoff_path).map_err(|error| {
        format!(
            "Savepoint handoff is not ready at {}: {error}",
            handoff_path.display()
        )
    })?;
    if !handoff_metadata.is_file() || handoff_metadata.len() == 0 {
        return Err(format!(
            "Savepoint handoff is not ready at {}",
            handoff_path.display()
        ));
    }
    let (resolved_cwd, cwd_missing) =
        resolve_join_cwd(&manifest.cwd, config.dropbox_root.as_deref(), home);
    Ok(JoinSavepointSummary {
        resolved_cwd: resolved_cwd.to_string_lossy().into_owned(),
        handoff_path: handoff_path.to_string_lossy().into_owned(),
        cwd_missing,
        source_checkpoint_id: manifest.lifecycle.checkpoint_id,
    })
}

fn find_transcript(bundle_dir: &Path) -> Result<PathBuf, String> {
    let transcript_dir = bundle_dir.join("transcript");
    let mut transcripts = fs::read_dir(&transcript_dir)
        .map_err(|error| format!("Failed to scan {}: {error}", transcript_dir.display()))?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_file() && path.extension().is_some_and(|ext| ext == "jsonl"))
        .collect::<Vec<_>>();
    transcripts.sort();
    transcripts
        .into_iter()
        .next()
        .ok_or_else(|| format!("No transcript JSONL found in {}", transcript_dir.display()))
}

pub(crate) fn sanitize_project_dir(cwd: &str) -> String {
    cwd.trim_end_matches(['/', '\\'])
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character
            } else {
                '-'
            }
        })
        .collect()
}

fn import_codex_transcript(
    transcript: &Path,
    sessions_root: &Path,
    expected_session_id: &str,
    resolved_cwd: &str,
) -> Result<String, String> {
    Uuid::parse_str(expected_session_id)
        .map_err(|_| "Codex savepoint session id is invalid".to_string())?;
    let source = fs::File::open(transcript)
        .map_err(|error| format!("Failed to open {}: {error}", transcript.display()))?;
    let mut reader = BufReader::new(source);
    let mut first_line = String::new();
    if reader
        .read_line(&mut first_line)
        .map_err(|error| format!("Failed to read {}: {error}", transcript.display()))?
        == 0
    {
        return Err("Codex savepoint transcript is empty".to_string());
    }
    let mut session_meta: serde_json::Value = serde_json::from_str(first_line.trim_end())
        .map_err(|error| format!("Invalid Codex session metadata: {error}"))?;
    if session_meta.get("type").and_then(serde_json::Value::as_str) != Some("session_meta") {
        return Err("Codex savepoint transcript does not start with session_meta".to_string());
    }
    let payload = session_meta
        .get_mut("payload")
        .and_then(serde_json::Value::as_object_mut)
        .ok_or_else(|| "Codex session_meta payload is invalid".to_string())?;
    let source_id = payload
        .get("id")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "Codex session_meta id is missing".to_string())?;
    let root_session_id = payload
        .get("session_id")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "Codex session_meta root session id is missing".to_string())?;
    if source_id != expected_session_id || root_session_id != expected_session_id {
        return Err("Codex savepoint transcript identity does not match its manifest".to_string());
    }

    let import_id = Uuid::new_v4().to_string();
    payload.insert(
        "id".to_string(),
        serde_json::Value::String(import_id.clone()),
    );
    payload.insert(
        "session_id".to_string(),
        serde_json::Value::String(import_id.clone()),
    );
    payload.insert(
        "cwd".to_string(),
        serde_json::Value::String(resolved_cwd.to_string()),
    );

    let now = Local::now();
    let target_dir = sessions_root
        .join(now.format("%Y").to_string())
        .join(now.format("%m").to_string())
        .join(now.format("%d").to_string());
    fs::create_dir_all(&target_dir)
        .map_err(|error| format!("Failed to create {}: {error}", target_dir.display()))?;
    let target = target_dir.join(format!(
        "rollout-{}-{import_id}.jsonl",
        now.format("%Y-%m-%dT%H-%M-%S")
    ));
    let mut temp = tempfile::NamedTempFile::new_in(&target_dir)
        .map_err(|error| format!("Failed to create Codex transcript import: {error}"))?;
    serde_json::to_writer(temp.as_file_mut(), &session_meta)
        .map_err(|error| format!("Failed to write Codex session metadata: {error}"))?;
    temp.write_all(b"\n")
        .map_err(|error| format!("Failed to write Codex transcript import: {error}"))?;
    std::io::copy(&mut reader, temp.as_file_mut())
        .map_err(|error| format!("Failed to copy Codex transcript: {error}"))?;
    temp.as_file_mut()
        .sync_all()
        .map_err(|error| format!("Failed to flush Codex transcript import: {error}"))?;
    temp.persist(&target)
        .map_err(|error| format!("Failed to install {}: {}", target.display(), error.error))?;
    Ok(import_id)
}

fn join_savepoint_full_from_config(
    bundle_dir: &Path,
    config_path: &Path,
    home: &Path,
    projects_dir: &Path,
) -> Result<JoinSavepointFull, String> {
    let config = load_config(config_path)?;
    let bundle_dir = absolute_path(bundle_dir.to_path_buf())?;
    let mut manifest: SavepointManifest = read_json(&bundle_dir.join("manifest.json"))?;
    if manifest.schema != SAVEPOINT_SCHEMA {
        return Err(format!("Unsupported savepoint schema: {}", manifest.schema));
    }
    let identity = manifest.identity()?;
    manifest.lifecycle = manifest.lifecycle.normalized();
    let (resolved_cwd, cwd_missing) =
        resolve_join_cwd(&manifest.cwd, config.dropbox_root.as_deref(), home);
    let resolved_cwd_string = resolved_cwd.to_string_lossy().into_owned();
    let transcript = find_transcript(&bundle_dir)?;
    let (resume_session_id, command_argv) = match identity.kind {
        SavepointAgentKind::Claude => {
            let project_dir = projects_dir.join(sanitize_project_dir(&resolved_cwd_string));
            fs::create_dir_all(&project_dir)
                .map_err(|error| format!("Failed to create {}: {error}", project_dir.display()))?;
            let resume_session_id = Uuid::new_v4().to_string();
            let target = project_dir.join(format!("{resume_session_id}.jsonl"));
            fs::copy(&transcript, &target).map_err(|error| {
                format!(
                    "Failed to copy {} to {}: {error}",
                    transcript.display(),
                    target.display()
                )
            })?;
            let command_argv = vec![
                "claude".to_string(),
                "--resume".to_string(),
                resume_session_id.clone(),
                "--fork-session".to_string(),
            ];
            (resume_session_id, command_argv)
        }
        SavepointAgentKind::Codex => {
            let resume_session_id = import_codex_transcript(
                &transcript,
                &home.join(".codex").join("sessions"),
                &identity.session_id,
                &resolved_cwd_string,
            )?;
            let command_argv = vec![
                "codex".to_string(),
                "fork".to_string(),
                "--no-alt-screen".to_string(),
                resume_session_id.clone(),
            ];
            (resume_session_id, command_argv)
        }
    };
    Ok(JoinSavepointFull {
        resolved_cwd: resolved_cwd_string,
        cwd_missing,
        resume_session_id: Some(resume_session_id.clone()),
        command_argv,
        agent_kind: identity.kind,
        source_checkpoint_id: manifest.lifecycle.checkpoint_id,
    })
}

fn write_json_atomic(path: &Path, value: &serde_json::Value) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Manifest parent directory not found".to_string())?;
    let json = serde_json::to_string_pretty(value)
        .map_err(|error| format!("Failed to serialize {}: {error}", path.display()))?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("Failed to create temporary manifest: {error}"))?;
    temp.write_all(json.as_bytes())
        .map_err(|error| format!("Failed to write temporary manifest: {error}"))?;
    temp.flush()
        .map_err(|error| format!("Failed to flush temporary manifest: {error}"))?;
    temp.as_file()
        .sync_all()
        .map_err(|error| format!("Failed to sync temporary manifest: {error}"))?;
    temp.persist(path)
        .map(|_| ())
        .map_err(|error| format!("Failed to replace {}: {}", path.display(), error.error))
}

fn lifecycle_from_value(manifest: &serde_json::Value) -> SavepointLifecycle {
    manifest
        .get("lifecycle")
        .and_then(|value| serde_json::from_value::<SavepointLifecycle>(value.clone()).ok())
        .unwrap_or_default()
        .normalized()
}

fn find_closed_head(online_dir: &Path, checkpoint_id: &str) -> Option<PathBuf> {
    let online_root = fs::canonicalize(online_dir).ok()?;
    fs::read_dir(&online_root)
        .ok()?
        .flatten()
        .find_map(|entry| {
            let candidate = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.')
                || name == FINAL_RECORDS_DIR
                || !candidate.is_dir()
                || is_link_or_reparse_point(&candidate)
            {
                return None;
            }
            let head = fs::canonicalize(&candidate).ok()?;
            if head.parent() != Some(online_root.as_path()) {
                return None;
            }
            let manifest = read_json::<serde_json::Value>(&head.join("manifest.json")).ok()?;
            let lifecycle = lifecycle_from_value(&manifest);
            (lifecycle.status == SavepointLifecycleStatus::Closed
                && !lifecycle.final_checkpoint
                && lifecycle.checkpoint_id.as_deref() == Some(checkpoint_id))
            .then_some(head)
        })
}

fn final_shadow_for_bundle(bundle_dir: &Path, manifest: &serde_json::Value) -> Option<PathBuf> {
    let lifecycle = lifecycle_from_value(manifest);
    if !lifecycle.final_checkpoint {
        return None;
    }
    let records_dir = bundle_dir.parent()?;
    if records_dir.file_name()?.to_string_lossy() != FINAL_RECORDS_DIR {
        return None;
    }
    find_closed_head(records_dir.parent()?, lifecycle.checkpoint_id.as_deref()?)
}

fn toggle_savepoint_pin_at(bundle_dir: &Path) -> Result<ToggleSavepointPinResult, String> {
    let bundle_dir = fs::canonicalize(absolute_path(bundle_dir.to_path_buf())?)
        .map_err(|error| format!("Failed to resolve {}: {error}", bundle_dir.display()))?;
    let manifest_path = bundle_dir.join("manifest.json");
    let mut manifest: serde_json::Value = read_json(&manifest_path)?;
    let object = manifest
        .as_object_mut()
        .ok_or_else(|| format!("Invalid manifest object: {}", manifest_path.display()))?;
    let pinned = !object
        .get("pinned")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    object.insert("pinned".to_string(), serde_json::Value::Bool(pinned));
    if let Some(shadow_dir) = final_shadow_for_bundle(&bundle_dir, &manifest) {
        let shadow_manifest_path = shadow_dir.join("manifest.json");
        let mut shadow_manifest: serde_json::Value = read_json(&shadow_manifest_path)?;
        let shadow_object = shadow_manifest.as_object_mut().ok_or_else(|| {
            format!(
                "Invalid manifest object: {}",
                shadow_manifest_path.display()
            )
        })?;
        shadow_object.insert("pinned".to_string(), serde_json::Value::Bool(pinned));
        write_json_atomic(&shadow_manifest_path, &shadow_manifest)?;
    }
    write_json_atomic(&manifest_path, &manifest)?;
    Ok(ToggleSavepointPinResult { pinned })
}

fn read_valid_manifest_for_operation(
    bundle_dir: &Path,
) -> Result<(serde_json::Value, SavepointManifest), String> {
    let manifest_path = bundle_dir.join("manifest.json");
    if !manifest_path.is_file() {
        return Err(format!(
            "Savepoint manifest not found: {}",
            manifest_path.display()
        ));
    }
    let value: serde_json::Value = read_json(&manifest_path)?;
    let manifest = serde_json::from_value::<SavepointManifest>(value.clone()).map_err(|error| {
        format!(
            "Invalid savepoint manifest {}: {error}",
            manifest_path.display()
        )
    })?;
    if manifest.schema != SAVEPOINT_SCHEMA || manifest.identity().is_err() {
        return Err(format!(
            "Invalid savepoint manifest: {}",
            manifest_path.display()
        ));
    }
    Ok((value, manifest))
}

fn validated_final_checkpoint_id(
    manifest: &SavepointManifest,
    original_parent: SavepointTrashParent,
    original_name: &str,
) -> Result<Option<String>, String> {
    let lifecycle = manifest.lifecycle.clone().normalized();
    if !lifecycle.final_checkpoint {
        return Ok(None);
    }
    if original_parent == SavepointTrashParent::Root {
        let received_transfer_id = manifest.transfer.as_ref().and_then(|transfer| {
            Uuid::parse_str(&transfer.id)
                .ok()
                .map(|id| format!("received_{id}"))
        });
        if received_transfer_id.as_deref() == Some(original_name) {
            // Received final checkpoints have no local closed-head shadow and keep
            // their transfer-stable root name so importing the same file is idempotent.
            return Ok(None);
        }
    }
    let checkpoint_id = lifecycle
        .checkpoint_id
        .filter(|value| Uuid::parse_str(value).is_ok())
        .ok_or_else(|| "Final savepoint checkpoint id is invalid".to_string())?;
    if original_parent != SavepointTrashParent::Records || original_name != checkpoint_id {
        return Err("Final savepoint identity does not match its records path".to_string());
    }
    Ok(Some(checkpoint_id))
}

fn matching_closed_head(
    online_root: &Path,
    checkpoint_id: &str,
    identity: &SavepointIdentity,
) -> Result<Option<(PathBuf, serde_json::Value)>, String> {
    let Some(shadow_dir) = find_closed_head(online_root, checkpoint_id) else {
        return Ok(None);
    };
    let (shadow_value, shadow_manifest) = read_valid_manifest_for_operation(&shadow_dir)?;
    if shadow_manifest.identity()? != *identity {
        return Err("Final savepoint shadow belongs to a different session".to_string());
    }
    Ok(Some((shadow_dir, shadow_value)))
}

fn update_final_shadow_trash_marker(
    online_root: &Path,
    manifest: &SavepointManifest,
    original_parent: SavepointTrashParent,
    original_name: &str,
    checkpoint_marker: Option<&str>,
) -> Result<Option<(PathBuf, serde_json::Value)>, String> {
    let Some(checkpoint_id) =
        validated_final_checkpoint_id(manifest, original_parent, original_name)?
    else {
        return Ok(None);
    };
    let identity = manifest.identity()?;
    let Some((shadow_dir, original_shadow)) =
        matching_closed_head(online_root, &checkpoint_id, &identity)?
    else {
        return Ok(None);
    };
    let mut updated_shadow = original_shadow.clone();
    let shadow_object = updated_shadow
        .as_object_mut()
        .ok_or_else(|| format!("Invalid manifest object: {}", shadow_dir.display()))?;
    if let Some(marker) = checkpoint_marker {
        shadow_object.insert(
            TRASHED_FINAL_CHECKPOINT_FIELD.to_string(),
            serde_json::Value::String(marker.to_string()),
        );
    } else {
        shadow_object.remove(TRASHED_FINAL_CHECKPOINT_FIELD);
    }
    write_json_atomic(&shadow_dir.join("manifest.json"), &updated_shadow)?;
    Ok(Some((shadow_dir, original_shadow)))
}

fn resolve_active_savepoint(
    online_dir: &Path,
    bundle_dir: &Path,
) -> Result<
    (
        PathBuf,
        PathBuf,
        serde_json::Value,
        SavepointManifest,
        SavepointTrashParent,
    ),
    String,
> {
    let online_root = fs::canonicalize(online_dir)
        .map_err(|error| format!("Failed to resolve {}: {error}", online_dir.display()))?;
    if is_link_or_reparse_point(bundle_dir) {
        return Err("Savepoint links cannot be moved to the trash".to_string());
    }
    let bundle_dir = fs::canonicalize(bundle_dir)
        .map_err(|error| format!("Failed to resolve {}: {error}", bundle_dir.display()))?;
    let name = bundle_dir
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .ok_or_else(|| "Savepoint bundle name is missing".to_string())?;
    if name == FINAL_RECORDS_DIR || name == TRASH_DIR || !is_safe_path_component(&name) {
        return Err("Savepoint containers cannot be moved to the trash".to_string());
    }
    let original_parent = if bundle_dir.parent() == Some(online_root.as_path()) {
        SavepointTrashParent::Root
    } else if bundle_dir.parent().is_some_and(|parent| {
        parent
            .file_name()
            .is_some_and(|value| value.to_string_lossy() == FINAL_RECORDS_DIR)
            && parent.parent() == Some(online_root.as_path())
    }) {
        SavepointTrashParent::Records
    } else {
        return Err(format!(
            "Savepoint bundle must be inside {}",
            online_root.display()
        ));
    };
    let (manifest_value, manifest) = read_valid_manifest_for_operation(&bundle_dir)?;
    Ok((
        online_root,
        bundle_dir,
        manifest_value,
        manifest,
        original_parent,
    ))
}

fn ensure_trash_root(online_root: &Path) -> Result<PathBuf, String> {
    let trash_dir = online_root.join(TRASH_DIR);
    if !trash_dir.exists() {
        fs::create_dir(&trash_dir)
            .map_err(|error| format!("Failed to create {}: {error}", trash_dir.display()))?;
    }
    if !trash_dir.is_dir() || is_link_or_reparse_point(&trash_dir) {
        return Err(format!(
            "Invalid savepoint trash directory: {}",
            trash_dir.display()
        ));
    }
    let trash_root = fs::canonicalize(&trash_dir)
        .map_err(|error| format!("Failed to resolve {}: {error}", trash_dir.display()))?;
    if trash_root.parent() != Some(online_root) {
        return Err(format!(
            "Invalid savepoint trash directory: {}",
            trash_dir.display()
        ));
    }
    Ok(trash_root)
}

fn trash_online_savepoint_at(
    online_dir: &Path,
    bundle_dir: &Path,
    deleted_at: &str,
    reason: SavepointTrashReason,
) -> Result<PathBuf, String> {
    let (online_root, bundle_dir, original_manifest, manifest, original_parent) =
        resolve_active_savepoint(online_dir, bundle_dir)?;
    let original_name = bundle_dir
        .file_name()
        .expect("validated savepoint name")
        .to_string_lossy()
        .into_owned();
    let trash_root = ensure_trash_root(&online_root)?;
    let trash_id = Uuid::new_v4().to_string();
    let target = trash_root.join(&trash_id);
    let trash = SavepointTrash {
        id: trash_id,
        deleted_at: deleted_at.to_string(),
        reason,
        original_parent,
        original_name: original_name.clone(),
    };
    let final_checkpoint_id =
        validated_final_checkpoint_id(&manifest, original_parent, &original_name)?;
    let shadow_rollback = update_final_shadow_trash_marker(
        &online_root,
        &manifest,
        original_parent,
        &original_name,
        final_checkpoint_id.as_deref(),
    )?;
    let mut updated_manifest = original_manifest.clone();
    updated_manifest
        .as_object_mut()
        .ok_or_else(|| format!("Invalid manifest object: {}", bundle_dir.display()))?
        .insert(
            "trash".to_string(),
            serde_json::to_value(trash)
                .map_err(|error| format!("Failed to serialize trash metadata: {error}"))?,
        );
    if let Err(error) = write_json_atomic(&bundle_dir.join("manifest.json"), &updated_manifest) {
        if let Some((shadow_dir, original_shadow)) = shadow_rollback.as_ref() {
            let _ = write_json_atomic(&shadow_dir.join("manifest.json"), original_shadow);
        }
        return Err(error);
    }
    if let Err(error) = fs::rename(&bundle_dir, &target) {
        let _ = write_json_atomic(&bundle_dir.join("manifest.json"), &original_manifest);
        if let Some((shadow_dir, original_shadow)) = shadow_rollback.as_ref() {
            let _ = write_json_atomic(&shadow_dir.join("manifest.json"), original_shadow);
        }
        return Err(format!(
            "Failed to move {} to {}: {error}",
            bundle_dir.display(),
            target.display()
        ));
    }
    Ok(target)
}

fn resolve_trashed_savepoint(
    online_dir: &Path,
    bundle_dir: &Path,
    expected_trash_id: &str,
) -> Result<
    (
        PathBuf,
        PathBuf,
        serde_json::Value,
        SavepointManifest,
        SavepointTrash,
    ),
    String,
> {
    let online_root = fs::canonicalize(online_dir)
        .map_err(|error| format!("Failed to resolve {}: {error}", online_dir.display()))?;
    if Uuid::parse_str(expected_trash_id).is_err() || is_link_or_reparse_point(bundle_dir) {
        return Err("Invalid savepoint trash item".to_string());
    }
    let trash_dir = online_root.join(TRASH_DIR);
    if !trash_dir.is_dir() || is_link_or_reparse_point(&trash_dir) {
        return Err("Savepoint trash directory was not found".to_string());
    }
    let trash_root = fs::canonicalize(&trash_dir)
        .map_err(|error| format!("Failed to resolve {}: {error}", trash_dir.display()))?;
    if trash_root.parent() != Some(online_root.as_path()) {
        return Err(format!(
            "Invalid savepoint trash directory: {}",
            trash_dir.display()
        ));
    }
    let bundle_dir = fs::canonicalize(bundle_dir)
        .map_err(|error| format!("Failed to resolve {}: {error}", bundle_dir.display()))?;
    if bundle_dir.parent() != Some(trash_root.as_path())
        || bundle_dir
            .file_name()
            .is_none_or(|value| value.to_string_lossy() != expected_trash_id)
    {
        return Err("Savepoint trash item does not match the requested id".to_string());
    }
    let (manifest_value, manifest) = read_valid_manifest_for_operation(&bundle_dir)?;
    let trash = manifest
        .trash
        .clone()
        .filter(|trash| {
            trash.id == expected_trash_id && is_safe_path_component(&trash.original_name)
        })
        .ok_or_else(|| "Savepoint trash metadata does not match the requested id".to_string())?;
    Ok((online_root, bundle_dir, manifest_value, manifest, trash))
}

fn restore_online_savepoint_at(
    online_dir: &Path,
    bundle_dir: &Path,
    trash_id: &str,
) -> Result<PathBuf, String> {
    let (online_root, bundle_dir, original_manifest, manifest, trash) =
        resolve_trashed_savepoint(online_dir, bundle_dir, trash_id)?;
    let target_parent = match trash.original_parent {
        SavepointTrashParent::Root => online_root.clone(),
        SavepointTrashParent::Records => {
            let records_dir = online_root.join(FINAL_RECORDS_DIR);
            if !records_dir.exists() {
                fs::create_dir(&records_dir).map_err(|error| {
                    format!("Failed to create {}: {error}", records_dir.display())
                })?;
            }
            if !records_dir.is_dir() || is_link_or_reparse_point(&records_dir) {
                return Err(format!(
                    "Invalid final-records directory: {}",
                    records_dir.display()
                ));
            }
            let records_root = fs::canonicalize(&records_dir)
                .map_err(|error| format!("Failed to resolve {}: {error}", records_dir.display()))?;
            if records_root.parent() != Some(online_root.as_path()) {
                return Err(format!(
                    "Invalid final-records directory: {}",
                    records_dir.display()
                ));
            }
            records_root
        }
    };
    let target = target_parent.join(&trash.original_name);
    if target.exists() {
        return Err(format!(
            "A savepoint already exists at the restore destination: {}",
            target.display()
        ));
    }
    let shadow_rollback = update_final_shadow_trash_marker(
        &online_root,
        &manifest,
        trash.original_parent,
        &trash.original_name,
        None,
    )?;
    let mut restored_manifest = original_manifest;
    let restored_object = restored_manifest
        .as_object_mut()
        .ok_or_else(|| format!("Invalid manifest object: {}", bundle_dir.display()))?;
    restored_object.remove("trash");
    restored_object.insert(
        "expires_at".to_string(),
        serde_json::Value::String(
            (Utc::now() + chrono::Duration::hours(RESTORED_EXPIRE_HOURS)).to_rfc3339(),
        ),
    );
    if let Err(error) = fs::rename(&bundle_dir, &target) {
        if let Some((shadow_dir, original_shadow)) = shadow_rollback.as_ref() {
            let _ = write_json_atomic(&shadow_dir.join("manifest.json"), original_shadow);
        }
        return Err(format!(
            "Failed to restore {} to {}: {error}",
            bundle_dir.display(),
            target.display()
        ));
    }
    if let Err(error) = write_json_atomic(&target.join("manifest.json"), &restored_manifest) {
        let _ = fs::rename(&target, &bundle_dir);
        if let Some((shadow_dir, original_shadow)) = shadow_rollback.as_ref() {
            let _ = write_json_atomic(&shadow_dir.join("manifest.json"), original_shadow);
        }
        return Err(error);
    }
    Ok(target)
}

fn purge_online_savepoint_at(
    online_dir: &Path,
    bundle_dir: &Path,
    trash_id: &str,
) -> Result<(), String> {
    let (online_root, bundle_dir, _manifest_value, manifest, trash) =
        resolve_trashed_savepoint(online_dir, bundle_dir, trash_id)?;
    if let Some(checkpoint_id) =
        validated_final_checkpoint_id(&manifest, trash.original_parent, &trash.original_name)?
    {
        let active_final_path = online_root.join(FINAL_RECORDS_DIR).join(&checkpoint_id);
        match fs::symlink_metadata(&active_final_path) {
            Ok(_) => {
                return Err(format!(
                    "A live final savepoint still exists at {}",
                    active_final_path.display()
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "Failed to verify {}: {error}",
                    active_final_path.display()
                ));
            }
        }
        let identity = manifest.identity()?;
        if let Some((shadow_dir, shadow_manifest)) =
            matching_closed_head(&online_root, &checkpoint_id, &identity)?
        {
            if shadow_manifest
                .get(TRASHED_FINAL_CHECKPOINT_FIELD)
                .and_then(|value| value.as_str())
                != Some(checkpoint_id.as_str())
            {
                return Err("Final savepoint shadow is not marked for this trash entry".to_string());
            }
            fs::remove_dir_all(&shadow_dir)
                .map_err(|error| format!("Failed to delete {}: {error}", shadow_dir.display()))?;
        }
    }
    fs::remove_dir_all(&bundle_dir)
        .map_err(|error| format!("Failed to delete {}: {error}", bundle_dir.display()))
}

fn parse_iso_datetime(value: &str) -> Option<DateTime<Utc>> {
    if let Ok(parsed) = DateTime::parse_from_rfc3339(value) {
        return Some(parsed.with_timezone(&Utc));
    }
    NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S%.f")
        .ok()
        .and_then(|parsed| Local.from_local_datetime(&parsed).single())
        .map(|parsed| parsed.with_timezone(&Utc))
}

fn cleanup_online_savepoints_from_config(
    config_path: &Path,
    home: &Path,
    now: DateTime<Utc>,
    now_system: SystemTime,
) -> Result<CleanupOnlineSavepointsResult, String> {
    let _publish_guard = super::online_publish::PUBLISH_LOCK
        .lock()
        .map_err(|_| "Savepoint publisher lock is unavailable".to_string())?;
    let config = load_config(config_path)?;
    let online_dir = local_savepoint_dir(&config, home)?;
    let machine = config
        .machine
        .filter(|value| !value.is_empty())
        .or_else(sysinfo::System::host_name)
        .unwrap_or_default();
    let mut result = CleanupOnlineSavepointsResult {
        online_dir: online_dir.to_string_lossy().into_owned(),
        machine,
        deleted_count: 0,
        expired_count: 0,
        stale_count: 0,
        kept_count: 0,
    };
    if !online_dir.is_dir() {
        return Ok(result);
    }

    let online_root = fs::canonicalize(&online_dir)
        .map_err(|error| format!("Failed to resolve {}: {error}", online_dir.display()))?;
    let deleted_at = now.to_rfc3339();
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
        let entries = fs::read_dir(&scan_root)
            .map_err(|error| format!("Failed to scan {}: {error}", scan_root.display()))?;
        for entry in entries.flatten() {
            let candidate = entry.path();
            if !candidate.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if scan_root == online_root && (name == FINAL_RECORDS_DIR || name == TRASH_DIR) {
                continue;
            }
            if is_link_or_reparse_point(&candidate) {
                result.kept_count += 1;
                continue;
            }
            let Ok(path) = fs::canonicalize(&candidate) else {
                result.kept_count += 1;
                continue;
            };
            if path.parent() != Some(scan_root.as_path()) {
                result.kept_count += 1;
                continue;
            }
            if path == final_records_dir {
                result.kept_count += 1;
                continue;
            }
            if is_generated_publish_artifact_name(&name) && has_valid_savepoint_manifest(&path) {
                let stale = entry
                    .metadata()
                    .and_then(|metadata| metadata.modified())
                    .ok()
                    .and_then(|modified| now_system.duration_since(modified).ok())
                    .is_some_and(|age| age > Duration::from_secs(STALE_TMP_SECONDS));
                if stale {
                    if fs::remove_dir_all(&path).is_ok() {
                        result.deleted_count += 1;
                        result.stale_count += 1;
                    } else {
                        result.kept_count += 1;
                    }
                } else {
                    result.kept_count += 1;
                }
                continue;
            }

            let Ok(manifest) = read_json::<SavepointManifest>(&path.join("manifest.json")) else {
                result.kept_count += 1;
                continue;
            };
            if manifest.schema != SAVEPOINT_SCHEMA
                || manifest.pinned
                || (manifest.lifecycle.status == SavepointLifecycleStatus::Closed
                    && !manifest.lifecycle.final_checkpoint)
            {
                result.kept_count += 1;
                continue;
            }
            let Some(expires_at) = parse_iso_datetime(&manifest.expires_at) else {
                result.kept_count += 1;
                continue;
            };
            if expires_at < now {
                if trash_online_savepoint_at(
                    &online_root,
                    &path,
                    &deleted_at,
                    SavepointTrashReason::Expired,
                )
                .is_ok()
                {
                    result.deleted_count += 1;
                    result.expired_count += 1;
                } else {
                    result.kept_count += 1;
                }
            } else {
                result.kept_count += 1;
            }
        }
    }
    Ok(result)
}

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
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[cfg(windows)]
    #[test]
    fn reparse_filter_allows_cloud_placeholders_but_rejects_links() {
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;

        assert!(is_redirecting_windows_reparse_point(
            FILE_ATTRIBUTE_REPARSE_POINT,
            true,
        ));
        assert!(!is_redirecting_windows_reparse_point(
            FILE_ATTRIBUTE_REPARSE_POINT,
            false,
        ));
        assert!(!is_redirecting_windows_reparse_point(0, true));
    }

    #[cfg(windows)]
    #[test]
    fn display_path_preserves_unc_roots() {
        assert_eq!(
            path_for_display(Path::new(r"\\?\UNC\server\share\savepoints")),
            r"\\server\share\savepoints"
        );
    }

    #[test]
    fn storage_settings_use_the_local_default_without_a_config() {
        let temp = tempdir().unwrap();
        let settings = get_savepoint_storage_settings_from_config(
            &temp.path().join("missing.json"),
            temp.path(),
        )
        .unwrap();

        assert_eq!(
            settings,
            SavepointStorageSettings {
                directory: Some(path_for_display(
                    &temp.path().join(".mycmux").join("savepoints"),
                )),
                directory_exists: false,
                legacy_directory: None,
            }
        );
    }

    #[test]
    fn legacy_shared_directory_is_displayed_but_not_used_as_the_local_store() {
        let temp = tempdir().unwrap();
        let home = temp.path().join("home");
        let shared = temp.path().join("shared-savepoints");
        fs::create_dir_all(home.join(".mycmux")).unwrap();
        fs::create_dir_all(&shared).unwrap();
        let config_path = home.join(".mycmux").join("savepoint.json");
        fs::write(
            &config_path,
            serde_json::json!({ "online_dir": shared }).to_string(),
        )
        .unwrap();

        let settings = get_savepoint_storage_settings_from_config(&config_path, &home).unwrap();

        assert_eq!(
            settings.directory,
            Some(path_for_display(&home.join(".mycmux").join("savepoints")))
        );
        assert_eq!(
            settings.legacy_directory,
            Some(path_for_display(&shared))
        );
    }

    #[test]
    fn legacy_directory_inside_mycmux_is_reused_without_migration() {
        let temp = tempdir().unwrap();
        let home = temp.path().join("home");
        let existing = home.join(".mycmux").join("online-dev");
        fs::create_dir_all(&existing).unwrap();
        let config = SavepointConfig {
            online_dir: Some(existing.to_string_lossy().into_owned()),
            ..SavepointConfig::default()
        };

        assert_eq!(
            local_savepoint_dir(&config, &home).unwrap(),
            fs::canonicalize(existing).unwrap()
        );
    }

    #[test]
    fn invalid_legacy_directory_falls_back_without_blocking_local_savepoints() {
        let temp = tempdir().unwrap();
        let home = temp.path().join("home");
        fs::create_dir_all(home.join(".mycmux")).unwrap();
        let config = SavepointConfig {
            online_dir: Some("../shared-savepoints".to_string()),
            ..SavepointConfig::default()
        };

        assert_eq!(
            local_savepoint_dir(&config, &home).unwrap(),
            home.join(".mycmux").join("savepoints")
        );
    }

    fn fixture_online_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("src")
            .join("commands")
            .join("fixtures")
            .join("online_savepoint")
    }

    fn copy_fixture_bundle(target: &Path) {
        let source = fixture_online_dir().join("miyazaki_85d1dd8d");
        fs::create_dir_all(target.join("transcript")).unwrap();
        fs::copy(source.join("manifest.json"), target.join("manifest.json")).unwrap();
        fs::copy(source.join("handoff.md"), target.join("handoff.md")).unwrap();
        fs::copy(
            source
                .join("transcript")
                .join("85d1dd8d-0f32-410e-91da-008f1cfb82a3.jsonl"),
            target
                .join("transcript")
                .join("85d1dd8d-0f32-410e-91da-008f1cfb82a3.jsonl"),
        )
        .unwrap();
    }

    fn write_cleanup_bundle(
        online_dir: &Path,
        name: &str,
        machine: &str,
        pinned: bool,
        expires_at: &str,
    ) {
        let bundle = online_dir.join(name);
        fs::create_dir_all(&bundle).unwrap();
        fs::write(
            bundle.join("manifest.json"),
            serde_json::json!({
                "schema": 1,
                "author": "miyazaki",
                "machine": machine,
                "created_at": "2026-07-01T00:00:00Z",
                "updated_at": "2026-07-01T00:00:00Z",
                "pinned": pinned,
                "expires_at": expires_at,
                "summary_line": "cleanup fixture",
                "cwd": "C:/work",
                "claude_session_id": "11111111-2222-4333-8444-555555555555"
            })
            .to_string(),
        )
        .unwrap();
    }

    #[test]
    fn lists_bundle_from_manifest_fixture() {
        let temp = tempdir().unwrap();
        let config_path = temp.path().join("savepoint.json");
        fs::write(
            &config_path,
            serde_json::json!({ "local_dir": fixture_online_dir() }).to_string(),
        )
        .unwrap();

        let entries = list_online_savepoints_from_config(&config_path, temp.path()).unwrap();
        assert_eq!(entries.len(), 1);
        let entry = &entries[0];
        assert_eq!(entry.author, "miyazaki");
        assert_eq!(entry.machine, "home-windows");
        assert_eq!(entry.warnings_count, 2);
        assert_eq!(entry.files_written_count, 2);
        assert_eq!(entry.record_kind, SavepointRecordKind::Current);
        assert_eq!(
            entry.lifecycle_status,
            SavepointLifecycleStatus::Interrupted
        );
        assert!(entry.bundle_dir.ends_with("miyazaki_85d1dd8d"));
        assert!(entry.handoff_path.ends_with("handoff.md"));
    }

    #[test]
    fn lists_generic_codex_manifest_and_keeps_legacy_claude_compatibility() {
        let temp = tempdir().unwrap();
        let online_dir = temp.path().join("online");
        let claude_bundle = online_dir.join("legacy-claude");
        let codex_bundle = online_dir.join("generic-codex");
        copy_fixture_bundle(&claude_bundle);
        copy_fixture_bundle(&codex_bundle);
        let manifest_path = codex_bundle.join("manifest.json");
        let mut codex: serde_json::Value = read_json(&manifest_path).unwrap();
        codex.as_object_mut().unwrap().remove("claude_session_id");
        codex["agent_kind"] = serde_json::Value::String("codex".to_string());
        codex["agent_session_id"] =
            serde_json::Value::String("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee".to_string());
        fs::write(
            &manifest_path,
            serde_json::to_string_pretty(&codex).unwrap(),
        )
        .unwrap();
        let config_path = temp.path().join("savepoint.json");
        fs::write(
            &config_path,
            serde_json::json!({ "local_dir": online_dir }).to_string(),
        )
        .unwrap();

        let entries = list_online_savepoints_from_config(&config_path, temp.path()).unwrap();

        assert_eq!(entries.len(), 2);
        let claude = entries
            .iter()
            .find(|entry| entry.bundle_dir.ends_with("legacy-claude"))
            .unwrap();
        assert_eq!(claude.agent_kind, SavepointAgentKind::Claude);
        assert_eq!(
            claude.claude_session_id.as_deref(),
            Some(claude.agent_session_id.as_str())
        );
        let codex = entries
            .iter()
            .find(|entry| entry.bundle_dir.ends_with("generic-codex"))
            .unwrap();
        assert_eq!(codex.agent_kind, SavepointAgentKind::Codex);
        assert_eq!(
            codex.agent_session_id,
            "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
        );
        assert!(codex.claude_session_id.is_none());
    }

    #[test]
    fn invalid_lifecycle_defaults_without_rejecting_manifest() {
        let temp = tempdir().unwrap();
        let online_dir = temp.path().join("online");
        let bundle = online_dir.join("miyazaki_85d1dd8d");
        copy_fixture_bundle(&bundle);
        let manifest_path = bundle.join("manifest.json");
        let mut manifest: serde_json::Value = read_json(&manifest_path).unwrap();
        manifest["lifecycle"] = serde_json::json!({
            "status": "future-status",
            "checkpoint_id": "11111111-2222-4333-8444-555555555555"
        });
        fs::write(
            &manifest_path,
            serde_json::to_string_pretty(&manifest).unwrap(),
        )
        .unwrap();
        let config_path = temp.path().join("savepoint.json");
        fs::write(
            &config_path,
            serde_json::json!({ "local_dir": online_dir }).to_string(),
        )
        .unwrap();

        let entries = list_online_savepoints_from_config(&config_path, temp.path()).unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(
            entries[0].lifecycle_status,
            SavepointLifecycleStatus::Interrupted
        );
        assert_eq!(entries[0].checkpoint_id, None);
    }

    #[test]
    fn list_prefers_immutable_final_record_over_closed_head() {
        let temp = tempdir().unwrap();
        let online_dir = temp.path().join("online");
        let head = online_dir.join("miyazaki_85d1dd8d");
        let checkpoint_id = "11111111-2222-4333-8444-555555555555";
        copy_fixture_bundle(&head);
        let mut head_manifest: serde_json::Value = read_json(&head.join("manifest.json")).unwrap();
        head_manifest["lifecycle"] = serde_json::json!({
            "status": "closed",
            "checkpoint_id": checkpoint_id,
            "parent_checkpoint_id": null,
            "final_checkpoint": false,
            "closed_at": "2026-07-13T10:00:00+09:00",
            "closed_reason": "manual"
        });
        fs::write(
            head.join("manifest.json"),
            serde_json::to_string_pretty(&head_manifest).unwrap(),
        )
        .unwrap();
        let final_record = online_dir.join(FINAL_RECORDS_DIR).join(checkpoint_id);
        copy_fixture_bundle(&final_record);
        let mut final_manifest: serde_json::Value =
            read_json(&final_record.join("manifest.json")).unwrap();
        final_manifest["lifecycle"] = serde_json::json!({
            "status": "closed",
            "checkpoint_id": checkpoint_id,
            "parent_checkpoint_id": null,
            "final_checkpoint": true,
            "closed_at": "2026-07-13T10:00:00+09:00",
            "closed_reason": "manual"
        });
        fs::write(
            final_record.join("manifest.json"),
            serde_json::to_string_pretty(&final_manifest).unwrap(),
        )
        .unwrap();
        let config_path = temp.path().join("savepoint.json");
        fs::write(
            &config_path,
            serde_json::json!({ "local_dir": online_dir }).to_string(),
        )
        .unwrap();

        let entries = list_online_savepoints_from_config(&config_path, temp.path()).unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].record_kind, SavepointRecordKind::Final);
        assert_eq!(entries[0].checkpoint_id.as_deref(), Some(checkpoint_id));
        assert!(entries[0].bundle_dir.contains(FINAL_RECORDS_DIR));

        fs::remove_dir_all(final_record).unwrap();
        let entries = list_online_savepoints_from_config(&config_path, temp.path()).unwrap();
        assert!(entries.is_empty(), "closed compatibility heads stay hidden");
    }

    #[test]
    fn expands_dropbox_cwd_and_falls_back_to_home() {
        let temp = tempdir().unwrap();
        let home = temp.path().join("home");
        let dropbox = temp.path().join("dropbox");
        let project = dropbox.join("project");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&project).unwrap();

        let (resolved, missing) = resolve_join_cwd("{DROPBOX}/project", dropbox.to_str(), &home);
        assert_eq!(resolved, project);
        assert!(!missing);

        let (resolved, missing) = resolve_join_cwd("{DROPBOX}/missing", dropbox.to_str(), &home);
        assert_eq!(resolved, home);
        assert!(missing);

        let (resolved, missing) = resolve_join_cwd("C:/definitely/missing", None, &home);
        assert_eq!(resolved, home);
        assert!(missing);
    }

    #[test]
    fn summary_join_rejects_a_partially_synced_bundle_without_handoff() {
        let temp = tempdir().unwrap();
        let home = temp.path().join("home");
        let bundle = temp.path().join("online").join("partial-bundle");
        let config_path = temp.path().join("savepoint.json");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&bundle).unwrap();
        fs::copy(
            fixture_online_dir()
                .join("miyazaki_85d1dd8d")
                .join("manifest.json"),
            bundle.join("manifest.json"),
        )
        .unwrap();
        fs::write(
            &config_path,
            serde_json::json!({ "local_dir": bundle.parent().unwrap() }).to_string(),
        )
        .unwrap();

        let error = join_savepoint_summary_from_config(&bundle, &config_path, &home)
            .expect_err("a manifest without handoff.md must stay unavailable");

        assert!(error.contains("Savepoint handoff is not ready"));
    }

    #[test]
    fn full_join_transplants_fixture_with_fresh_uuid() {
        let temp = tempdir().unwrap();
        let home = temp.path().join("home");
        let project = temp.path().join("dropbox").join("project-one");
        let bundle = temp.path().join("online").join("fixture-bundle");
        let projects_dir = temp.path().join("claude-projects");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&project).unwrap();
        copy_fixture_bundle(&bundle);

        let manifest_path = bundle.join("manifest.json");
        let mut manifest: serde_json::Value = read_json(&manifest_path).unwrap();
        manifest["cwd"] = serde_json::Value::String(project.to_string_lossy().into_owned());
        fs::write(
            &manifest_path,
            serde_json::to_string_pretty(&manifest).unwrap(),
        )
        .unwrap();
        let config_path = temp.path().join("savepoint.json");
        fs::write(
            &config_path,
            serde_json::json!({ "local_dir": bundle.parent().unwrap() }).to_string(),
        )
        .unwrap();

        let first =
            join_savepoint_full_from_config(&bundle, &config_path, &home, &projects_dir).unwrap();
        let second =
            join_savepoint_full_from_config(&bundle, &config_path, &home, &projects_dir).unwrap();

        assert_eq!(first.resolved_cwd, project.to_string_lossy());
        assert!(!first.cwd_missing);
        assert_ne!(first.resume_session_id, second.resume_session_id);
        let first_session_id = first.resume_session_id.as_deref().unwrap();
        assert!(Uuid::parse_str(first_session_id).is_ok());
        assert_eq!(first_session_id.as_bytes()[14], b'4');
        assert_eq!(
            first.command_argv,
            vec!["claude", "--resume", first_session_id, "--fork-session"]
        );
        assert_eq!(first.agent_kind, SavepointAgentKind::Claude);
        let transplanted = projects_dir
            .join(sanitize_project_dir(&first.resolved_cwd))
            .join(format!("{first_session_id}.jsonl"));
        assert_eq!(
            fs::read_to_string(transplanted).unwrap(),
            fs::read_to_string(
                bundle
                    .join("transcript")
                    .join("85d1dd8d-0f32-410e-91da-008f1cfb82a3.jsonl")
            )
            .unwrap()
        );
    }

    #[test]
    fn codex_full_join_with_missing_cwd_uses_home_and_imports_a_fresh_session() {
        let temp = tempdir().unwrap();
        let home = temp.path().join("home");
        let project = temp.path().join("missing-project");
        let bundle = temp.path().join("online").join("codex-bundle");
        let transcript_dir = bundle.join("transcript");
        let source_session_id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&transcript_dir).unwrap();
        fs::write(
            bundle.join("manifest.json"),
            serde_json::json!({
                "schema": 1,
                "author": "miyazaki",
                "machine": "home-windows",
                "created_at": "2026-07-14T10:00:00+09:00",
                "updated_at": "2026-07-14T10:00:00+09:00",
                "expires_at": "2026-07-16T10:00:00+09:00",
                "summary_line": "Codex checkpoint",
                "cwd": project,
                "agent_kind": "codex",
                "agent_session_id": source_session_id,
                "files_written": [],
                "warnings": []
            })
            .to_string(),
        )
        .unwrap();
        fs::write(bundle.join("handoff.md"), "# Codex checkpoint\n").unwrap();
        let source_tail = serde_json::json!({
            "type": "event_msg",
            "payload": {"type": "user_message", "message": "continue"}
        })
        .to_string();
        let transcript = transcript_dir.join(format!(
            "rollout-2026-07-14T10-00-00-{source_session_id}.jsonl"
        ));
        fs::write(
            &transcript,
            format!(
                "{}\n{}",
                serde_json::json!({
                    "type": "session_meta",
                    "payload": {
                        "id": source_session_id,
                        "session_id": source_session_id,
                        "cwd": project
                    }
                }),
                source_tail
            ),
        )
        .unwrap();
        let config_path = temp.path().join("savepoint.json");
        fs::write(
            &config_path,
            serde_json::json!({ "local_dir": bundle.parent().unwrap() }).to_string(),
        )
        .unwrap();

        let result = join_savepoint_full_from_config(
            &bundle,
            &config_path,
            &home,
            &temp.path().join("claude-projects"),
        )
        .unwrap();
        let imported_id = result.resume_session_id.as_deref().unwrap();

        assert_eq!(result.agent_kind, SavepointAgentKind::Codex);
        assert!(result.cwd_missing);
        assert_eq!(result.resolved_cwd, home.to_string_lossy());
        assert_ne!(imported_id, source_session_id);
        assert_eq!(
            result.command_argv,
            vec!["codex", "fork", "--no-alt-screen", imported_id]
        );
        let mut imported = Vec::new();
        let mut pending = vec![home.join(".codex").join("sessions")];
        while let Some(directory) = pending.pop() {
            for entry in fs::read_dir(directory).unwrap().flatten() {
                let path = entry.path();
                if path.is_dir() {
                    pending.push(path);
                } else if path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.ends_with(&format!("-{imported_id}.jsonl")))
                {
                    imported.push(path);
                }
            }
        }
        assert_eq!(imported.len(), 1);
        let body = fs::read_to_string(&imported[0]).unwrap();
        let mut lines = body.lines();
        let meta: serde_json::Value = serde_json::from_str(lines.next().unwrap()).unwrap();
        assert_eq!(meta["payload"]["id"], imported_id);
        assert_eq!(meta["payload"]["session_id"], imported_id);
        assert_eq!(meta["payload"]["cwd"], home.to_string_lossy().as_ref());
        assert_eq!(lines.collect::<Vec<_>>().join("\n"), source_tail);
    }

    #[test]
    fn full_join_with_missing_cwd_transplants_into_the_home_fallback() {
        let temp = tempdir().unwrap();
        let home = temp.path().join("home");
        let bundle = temp.path().join("online").join("fixture-bundle");
        let projects_dir = temp.path().join("claude-projects");
        fs::create_dir_all(&home).unwrap();
        copy_fixture_bundle(&bundle);

        let manifest_path = bundle.join("manifest.json");
        let mut manifest: serde_json::Value = read_json(&manifest_path).unwrap();
        manifest["cwd"] = serde_json::Value::String(
            temp.path()
                .join("missing-project")
                .to_string_lossy()
                .into_owned(),
        );
        fs::write(
            &manifest_path,
            serde_json::to_string_pretty(&manifest).unwrap(),
        )
        .unwrap();
        let config_path = temp.path().join("savepoint.json");
        fs::write(
            &config_path,
            serde_json::json!({ "local_dir": bundle.parent().unwrap() }).to_string(),
        )
        .unwrap();

        let result =
            join_savepoint_full_from_config(&bundle, &config_path, &home, &projects_dir).unwrap();

        assert!(result.cwd_missing);
        assert_eq!(result.resolved_cwd, home.to_string_lossy());
        let resume_session_id = result.resume_session_id.as_deref().unwrap();
        assert_eq!(
            result.command_argv,
            vec!["claude", "--resume", resume_session_id, "--fork-session"]
        );
        assert!(projects_dir
            .join(sanitize_project_dir(&home.to_string_lossy()))
            .join(format!("{resume_session_id}.jsonl"))
            .is_file());
    }

    #[test]
    fn pin_toggle_atomically_preserves_manifest_fields() {
        let temp = tempdir().unwrap();
        let bundle = temp.path().join("fixture-bundle");
        copy_fixture_bundle(&bundle);

        let toggled = toggle_savepoint_pin_at(&bundle).unwrap();
        assert!(toggled.pinned);
        let manifest: serde_json::Value = read_json(&bundle.join("manifest.json")).unwrap();
        assert_eq!(
            manifest.get("pinned").and_then(serde_json::Value::as_bool),
            Some(true)
        );
        assert_eq!(
            manifest
                .get("git_branch")
                .and_then(serde_json::Value::as_str),
            Some("master")
        );
        assert!(!fs::read_dir(&bundle)
            .unwrap()
            .flatten()
            .any(|entry| { entry.file_name().to_string_lossy().contains(".tmp-") }));

        let toggled = toggle_savepoint_pin_at(&bundle).unwrap();
        assert!(!toggled.pinned);
    }

    #[test]
    fn trash_move_preserves_bundle_and_lists_it_separately() {
        let temp = tempdir().unwrap();
        let online_dir = temp.path().join("online");
        let bundle = online_dir.join("bundle");
        copy_fixture_bundle(&bundle);
        let config_path = temp.path().join("savepoint.json");
        fs::write(
            &config_path,
            serde_json::json!({ "local_dir": online_dir }).to_string(),
        )
        .unwrap();

        let trashed = trash_online_savepoint_at(
            &online_dir,
            &bundle,
            "2026-07-14T12:00:00Z",
            SavepointTrashReason::Manual,
        )
        .unwrap();

        assert!(!bundle.exists());
        assert!(trashed.join("handoff.md").is_file());
        let active = list_online_savepoints_from_config(&config_path, temp.path()).unwrap();
        let trash = list_trashed_online_savepoints_from_config(&config_path, temp.path()).unwrap();
        assert!(active.is_empty());
        assert_eq!(trash.len(), 1);
        assert_eq!(trash[0].deleted_at.as_deref(), Some("2026-07-14T12:00:00Z"));
        assert_eq!(trash[0].trash_reason, Some(SavepointTrashReason::Manual));
        copy_fixture_bundle(&bundle);
        let active = list_online_savepoints_from_config(&config_path, temp.path()).unwrap();
        let trash = list_trashed_online_savepoints_from_config(&config_path, temp.path()).unwrap();
        assert_eq!(
            active.len(),
            1,
            "a new save can reuse the original head path"
        );
        assert_eq!(trash.len(), 1, "the deleted snapshot stays in the trash");
    }

    #[test]
    fn trash_rejects_bundle_outside_online_dir() {
        let temp = tempdir().unwrap();
        let online_dir = temp.path().join("online");
        let outside = temp.path().join("outside");
        fs::create_dir_all(&online_dir).unwrap();
        copy_fixture_bundle(&outside);

        assert!(trash_online_savepoint_at(
            &online_dir,
            &outside,
            "2026-07-14T12:00:00Z",
            SavepointTrashReason::Manual,
        )
        .is_err());
        assert!(outside.is_dir());
    }

    #[test]
    fn trash_rejects_bundle_without_manifest() {
        let temp = tempdir().unwrap();
        let online_dir = temp.path().join("online");
        let bundle = online_dir.join("bundle");
        fs::create_dir_all(&bundle).unwrap();

        assert!(trash_online_savepoint_at(
            &online_dir,
            &bundle,
            "2026-07-14T12:00:00Z",
            SavepointTrashReason::Manual,
        )
        .is_err());
        assert!(bundle.is_dir());
    }

    #[test]
    fn restore_refuses_to_overwrite_a_new_savepoint() {
        let temp = tempdir().unwrap();
        let online_dir = temp.path().join("online");
        let bundle = online_dir.join("bundle");
        copy_fixture_bundle(&bundle);
        let trashed = trash_online_savepoint_at(
            &online_dir,
            &bundle,
            "2026-07-14T12:00:00Z",
            SavepointTrashReason::Manual,
        )
        .unwrap();
        let manifest: SavepointManifest = read_json(&trashed.join("manifest.json")).unwrap();
        let trash_id = manifest.trash.unwrap().id;
        copy_fixture_bundle(&bundle);

        assert!(restore_online_savepoint_at(&online_dir, &trashed, &trash_id).is_err());
        assert!(bundle.is_dir());
        assert!(trashed.is_dir());
    }

    #[test]
    fn restore_returns_bundle_to_its_original_location() {
        let temp = tempdir().unwrap();
        let online_dir = temp.path().join("online");
        let bundle = online_dir.join("bundle");
        copy_fixture_bundle(&bundle);
        let trashed = trash_online_savepoint_at(
            &online_dir,
            &bundle,
            "2026-07-14T12:00:00Z",
            SavepointTrashReason::Manual,
        )
        .unwrap();
        let manifest: SavepointManifest = read_json(&trashed.join("manifest.json")).unwrap();
        let trash_id = manifest.trash.unwrap().id;

        let restored = restore_online_savepoint_at(&online_dir, &trashed, &trash_id).unwrap();

        assert_eq!(restored, fs::canonicalize(&bundle).unwrap());
        assert!(bundle.is_dir());
        let restored_manifest: serde_json::Value =
            read_json(&bundle.join("manifest.json")).unwrap();
        assert!(restored_manifest.get("trash").is_none());
        assert!(
            parse_iso_datetime(restored_manifest["expires_at"].as_str().unwrap())
                .is_some_and(|expires_at| expires_at > Utc::now())
        );
    }

    #[test]
    fn purge_removes_final_record_and_its_closed_shadow_only_from_trash() {
        let temp = tempdir().unwrap();
        let online_dir = temp.path().join("online");
        let records_dir = online_dir.join(FINAL_RECORDS_DIR);
        let checkpoint_id = "11111111-2222-4333-8444-555555555555";
        let record = records_dir.join(checkpoint_id);
        let head = online_dir.join("author_11111111");
        copy_fixture_bundle(&record);
        copy_fixture_bundle(&head);
        for (path, final_checkpoint) in [(&record, true), (&head, false)] {
            let manifest_path = path.join("manifest.json");
            let mut manifest: serde_json::Value = read_json(&manifest_path).unwrap();
            manifest["lifecycle"] = serde_json::json!({
                "status": "closed",
                "checkpoint_id": checkpoint_id,
                "final_checkpoint": final_checkpoint
            });
            fs::write(
                manifest_path,
                serde_json::to_string_pretty(&manifest).unwrap(),
            )
            .unwrap();
        }

        let toggled = toggle_savepoint_pin_at(&record).unwrap();
        assert!(toggled.pinned);
        let head_manifest: serde_json::Value = read_json(&head.join("manifest.json")).unwrap();
        assert_eq!(head_manifest["pinned"], true);

        let trashed = trash_online_savepoint_at(
            &online_dir,
            &record,
            "2026-07-14T12:00:00Z",
            SavepointTrashReason::Manual,
        )
        .unwrap();
        let trashed_manifest: SavepointManifest =
            read_json(&trashed.join("manifest.json")).unwrap();
        let trash_id = trashed_manifest.trash.unwrap().id;

        assert!(!record.exists());
        assert!(head.exists());
        let head_manifest: serde_json::Value = read_json(&head.join("manifest.json")).unwrap();
        assert_eq!(head_manifest[TRASHED_FINAL_CHECKPOINT_FIELD], checkpoint_id);

        restore_online_savepoint_at(&online_dir, &trashed, &trash_id).unwrap();
        let head_manifest: serde_json::Value = read_json(&head.join("manifest.json")).unwrap();
        assert!(head_manifest.get(TRASHED_FINAL_CHECKPOINT_FIELD).is_none());
        let trashed = trash_online_savepoint_at(
            &online_dir,
            &record,
            "2026-07-14T13:00:00Z",
            SavepointTrashReason::Manual,
        )
        .unwrap();
        let trashed_manifest: SavepointManifest =
            read_json(&trashed.join("manifest.json")).unwrap();
        let trash_id = trashed_manifest.trash.unwrap().id;

        purge_online_savepoint_at(&online_dir, &trashed, &trash_id).unwrap();
        assert!(!trashed.exists());
        assert!(!head.exists());
        assert!(records_dir.is_dir());
        assert!(trash_online_savepoint_at(
            &online_dir,
            &records_dir,
            "2026-07-14T12:00:00Z",
            SavepointTrashReason::Manual,
        )
        .is_err());
    }

    #[test]
    fn purge_refuses_when_a_live_final_reappears() {
        let temp = tempdir().unwrap();
        let online_dir = temp.path().join("online");
        let checkpoint_id = "11111111-2222-4333-8444-555555555555";
        let record = online_dir.join(FINAL_RECORDS_DIR).join(checkpoint_id);
        let head = online_dir.join("author_11111111");
        copy_fixture_bundle(&record);
        copy_fixture_bundle(&head);
        for (path, final_checkpoint) in [(&record, true), (&head, false)] {
            let manifest_path = path.join("manifest.json");
            let mut manifest: serde_json::Value = read_json(&manifest_path).unwrap();
            manifest["lifecycle"] = serde_json::json!({
                "status": "closed",
                "checkpoint_id": checkpoint_id,
                "final_checkpoint": final_checkpoint
            });
            fs::write(
                manifest_path,
                serde_json::to_string_pretty(&manifest).unwrap(),
            )
            .unwrap();
        }
        let trashed = trash_online_savepoint_at(
            &online_dir,
            &record,
            "2026-07-14T12:00:00Z",
            SavepointTrashReason::Manual,
        )
        .unwrap();
        let trashed_manifest: SavepointManifest =
            read_json(&trashed.join("manifest.json")).unwrap();
        let trash_id = trashed_manifest.trash.unwrap().id;

        copy_fixture_bundle(&record);
        let error = purge_online_savepoint_at(&online_dir, &trashed, &trash_id).unwrap_err();

        assert!(error.contains("A live final savepoint still exists"));
        assert!(record.is_dir());
        assert!(head.is_dir());
        assert!(trashed.is_dir());
    }

    #[test]
    fn purge_rejects_a_trashed_final_with_a_fully_spoofed_identity() {
        let temp = tempdir().unwrap();
        let online_dir = temp.path().join("online");
        let records_dir = online_dir.join(FINAL_RECORDS_DIR);
        let original_checkpoint = "11111111-2222-4333-8444-555555555555";
        let victim_checkpoint = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
        let record = records_dir.join(original_checkpoint);
        let victim_head = online_dir.join("author_victim");
        copy_fixture_bundle(&record);
        copy_fixture_bundle(&victim_head);
        for (path, checkpoint_id, final_checkpoint, session_id) in [
            (&record, original_checkpoint, true, "original-session"),
            (&victim_head, victim_checkpoint, false, "victim-session"),
        ] {
            let manifest_path = path.join("manifest.json");
            let mut manifest: serde_json::Value = read_json(&manifest_path).unwrap();
            manifest["claude_session_id"] = serde_json::Value::String(session_id.to_string());
            manifest["lifecycle"] = serde_json::json!({
                "status": "closed",
                "checkpoint_id": checkpoint_id,
                "final_checkpoint": final_checkpoint
            });
            fs::write(
                manifest_path,
                serde_json::to_string_pretty(&manifest).unwrap(),
            )
            .unwrap();
        }
        let trashed = trash_online_savepoint_at(
            &online_dir,
            &record,
            "2026-07-14T12:00:00Z",
            SavepointTrashReason::Manual,
        )
        .unwrap();
        let manifest_path = trashed.join("manifest.json");
        let mut manifest: serde_json::Value = read_json(&manifest_path).unwrap();
        let trash_id = manifest["trash"]["id"].as_str().unwrap().to_string();
        manifest["lifecycle"]["checkpoint_id"] =
            serde_json::Value::String(victim_checkpoint.to_string());
        manifest["claude_session_id"] = serde_json::Value::String("victim-session".to_string());
        manifest["trash"]["original_name"] =
            serde_json::Value::String(victim_checkpoint.to_string());
        fs::write(
            &manifest_path,
            serde_json::to_string_pretty(&manifest).unwrap(),
        )
        .unwrap();

        assert!(purge_online_savepoint_at(&online_dir, &trashed, &trash_id).is_err());
        assert!(victim_head.is_dir());
        assert!(trashed.is_dir());
    }

    #[test]
    fn cleanup_deletes_expired_and_stale_entries_from_the_local_store() {
        let temp = tempdir().unwrap();
        let home = temp.path().join("home");
        let online_dir = temp.path().join("online");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&online_dir).unwrap();
        write_cleanup_bundle(
            &online_dir,
            "expired",
            "machine-a",
            false,
            "2026-07-10T00:00:00Z",
        );
        write_cleanup_bundle(
            &online_dir,
            "pinned",
            "machine-a",
            true,
            "2026-07-10T00:00:00Z",
        );
        write_cleanup_bundle(
            &online_dir,
            "other",
            "machine-b",
            false,
            "2026-07-10T00:00:00Z",
        );
        write_cleanup_bundle(
            &online_dir,
            "future",
            "machine-a",
            false,
            "2026-07-13T00:00:00Z",
        );
        let records_dir = online_dir.join(FINAL_RECORDS_DIR);
        fs::create_dir_all(&records_dir).unwrap();
        write_cleanup_bundle(
            &records_dir,
            "final-expired",
            "machine-a",
            false,
            "2026-07-10T00:00:00Z",
        );
        write_cleanup_bundle(
            &online_dir,
            ".fixture.tmp-deadbeef",
            "machine-a",
            false,
            "2026-07-13T00:00:00Z",
        );
        write_cleanup_bundle(
            &online_dir,
            "fixture.old-1234-deadbeef",
            "machine-a",
            false,
            "2026-07-13T00:00:00Z",
        );
        fs::create_dir(online_dir.join(".git")).unwrap();
        fs::create_dir(online_dir.join("foo.old-copy")).unwrap();
        let config_path = temp.path().join("savepoint.json");
        fs::write(
            &config_path,
            serde_json::json!({
                "local_dir": online_dir,
                "machine": "machine-a"
            })
            .to_string(),
        )
        .unwrap();
        let now = Utc.with_ymd_and_hms(2026, 7, 11, 0, 0, 0).single().unwrap();
        let future_system = SystemTime::now() + Duration::from_secs(STALE_TMP_SECONDS + 1);

        let result =
            cleanup_online_savepoints_from_config(&config_path, &home, now, future_system).unwrap();

        assert_eq!(result.deleted_count, 5);
        assert_eq!(result.expired_count, 3);
        assert_eq!(result.stale_count, 2);
        assert_eq!(result.kept_count, 4);
        assert!(!online_dir.join("expired").exists());
        assert!(!online_dir.join(".fixture.tmp-deadbeef").exists());
        assert!(!online_dir.join("fixture.old-1234-deadbeef").exists());
        assert!(!records_dir.join("final-expired").exists());
        let trashed = fs::read_dir(online_dir.join(TRASH_DIR))
            .unwrap()
            .flatten()
            .filter(|entry| entry.path().is_dir())
            .count();
        assert_eq!(trashed, 3);
        assert!(online_dir.join(".git").is_dir());
        assert!(online_dir.join("foo.old-copy").is_dir());
        assert!(online_dir.join("pinned").is_dir());
        assert!(!online_dir.join("other").exists());
        assert!(online_dir.join("future").is_dir());
    }
}
