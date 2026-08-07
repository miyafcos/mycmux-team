use std::{
    fs,
    path::{Component, Path, PathBuf},
};

use chrono::{NaiveDateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use super::{
    atomic::write_atomic, claude, codex, CliAccountProfile, CliOrphanSnapshot, CliProvider,
    ERR_ORPHAN_INVALID, ERR_ORPHAN_MANAGE_FAILED, ERR_ORPHAN_NOT_FOUND, ERR_SNAPSHOT_INVALID,
};

#[derive(Serialize, Deserialize, Clone)]
pub struct ClaudeSnapshot {
    pub version: u32,
    pub provider: CliProvider,
    pub captured_at: String,
    pub credentials_text: String,
    pub oauth_account_text: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct CodexSnapshot {
    pub version: u32,
    pub provider: CliProvider,
    pub captured_at: String,
    pub auth_text: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(untagged)]
pub enum StoredSnapshot {
    Claude(ClaudeSnapshot),
    Codex(CodexSnapshot),
}

pub fn snapshot_dir(base: &Path) -> PathBuf {
    base.join("cli_account_snapshots")
}

pub fn backup_root(base: &Path) -> PathBuf {
    base.join("cli_account_backups")
}

fn safe_snapshot_id(id: &str) -> bool {
    let mut components = Path::new(id).components();
    let single_component =
        matches!(components.next(), Some(Component::Normal(_))) && components.next().is_none();
    single_component
        && id.len() <= 160
        && (id.starts_with("claude-")
            || id.starts_with("codex-")
            || id.starts_with("unregistered-claude-")
            || id.starts_with("unregistered-codex-"))
        && id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "-_.+".contains(character))
}

pub fn validate_snapshot_id(id: &str) -> Result<(), String> {
    safe_snapshot_id(id)
        .then_some(())
        .ok_or_else(|| ERR_SNAPSHOT_INVALID.to_string())
}

fn snapshot_path(base: &Path, id: &str) -> Result<PathBuf, String> {
    validate_snapshot_id(id)?;
    Ok(snapshot_dir(base).join(format!("{id}.json")))
}

pub fn save(base: &Path, id: &str, snapshot: &StoredSnapshot) -> Result<PathBuf, String> {
    let path = snapshot_path(base, id)?;
    let text = serde_json::to_string(snapshot)
        .map_err(|error| format!("Failed to serialize snapshot: {error}"))?;
    write_atomic(&path, text.as_bytes())?;
    Ok(path)
}

pub fn load(base: &Path, id: &str) -> Result<StoredSnapshot, String> {
    let path = snapshot_path(base, id)?;
    serde_json::from_str(
        &fs::read_to_string(path).map_err(|error| format!("Failed to read snapshot: {error}"))?,
    )
    .map_err(|error| format!("Failed to parse snapshot: {error}"))
}

pub fn save_orphan(
    base: &Path,
    provider: CliProvider,
    snapshot: &StoredSnapshot,
) -> Result<PathBuf, String> {
    let stamp = Utc::now().to_rfc3339().replace(':', "-");
    let unique = &Uuid::new_v4().simple().to_string()[..8];
    save(
        base,
        &format!(
            "unregistered-{}-{stamp}-{unique}",
            match provider {
                CliProvider::Claude => "claude",
                CliProvider::Codex => "codex",
            }
        ),
        snapshot,
    )
}

fn safe_orphan_id(id: &str) -> bool {
    safe_snapshot_id(id)
        && (id.starts_with("unregistered-claude-") || id.starts_with("unregistered-codex-"))
}

pub fn load_orphan(base: &Path, id: &str) -> Result<StoredSnapshot, String> {
    if !safe_orphan_id(id) {
        return Err(ERR_ORPHAN_INVALID.to_string());
    }
    load(base, id).map_err(|_| ERR_ORPHAN_NOT_FOUND.to_string())
}

pub fn discard_orphan(base: &Path, id: &str) -> Result<(), String> {
    if !safe_orphan_id(id) {
        return Err(ERR_ORPHAN_INVALID.to_string());
    }
    let path = snapshot_path(base, id).map_err(|_| ERR_ORPHAN_INVALID.to_string())?;
    if !path.is_file() {
        return Err(ERR_ORPHAN_NOT_FOUND.to_string());
    }
    fs::remove_file(path).map_err(|_| ERR_ORPHAN_MANAGE_FAILED.to_string())
}

pub fn remove(base: &Path, id: &str) -> Result<(), String> {
    let path = snapshot_path(base, id)?;
    if path.is_file() {
        fs::remove_file(path).map_err(|_| ERR_ORPHAN_MANAGE_FAILED.to_string())?;
    }
    Ok(())
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

pub fn metadata_for_orphan(
    id: &str,
    snapshot: &StoredSnapshot,
) -> Result<CliOrphanSnapshot, String> {
    match snapshot {
        StoredSnapshot::Claude(stored) => {
            if stored.provider != CliProvider::Claude || !id.starts_with("unregistered-claude-") {
                return Err(ERR_ORPHAN_INVALID.to_string());
            }
            let account: Value = serde_json::from_str(&stored.oauth_account_text)
                .map_err(|_| ERR_ORPHAN_INVALID.to_string())?;
            let credentials: Value = serde_json::from_str(&stored.credentials_text)
                .map_err(|_| ERR_ORPHAN_INVALID.to_string())?;
            let identity_key = string_field(&account, "accountUuid")
                .ok_or_else(|| ERR_ORPHAN_INVALID.to_string())?;
            Ok(CliOrphanSnapshot {
                id: id.to_string(),
                provider: Some(CliProvider::Claude),
                captured_at: Some(stored.captured_at.clone()),
                email: string_field(&account, "emailAddress"),
                identity_key: Some(identity_key),
                plan: credentials
                    .get("claudeAiOauth")
                    .and_then(|oauth| string_field(oauth, "subscriptionType")),
                org_name: string_field(&account, "organizationName"),
                needs_relogin: claude::needs_relogin(&stored.credentials_text),
                error: None,
            })
        }
        StoredSnapshot::Codex(stored) => {
            if stored.provider != CliProvider::Codex || !id.starts_with("unregistered-codex-") {
                return Err(ERR_ORPHAN_INVALID.to_string());
            }
            let value: Value = serde_json::from_str(&stored.auth_text)
                .map_err(|_| ERR_ORPHAN_INVALID.to_string())?;
            let tokens = value.get("tokens").unwrap_or(&Value::Null);
            let claims = tokens
                .get("id_token")
                .and_then(Value::as_str)
                .map(codex::decode_id_token_claims)
                .transpose()
                .map_err(|_| ERR_ORPHAN_INVALID.to_string())?;
            let identity_key = claims
                .as_ref()
                .and_then(|claims| claims.account_id.clone())
                .or_else(|| string_field(tokens, "account_id"))
                .ok_or_else(|| ERR_ORPHAN_INVALID.to_string())?;
            Ok(CliOrphanSnapshot {
                id: id.to_string(),
                provider: Some(CliProvider::Codex),
                captured_at: Some(stored.captured_at.clone()),
                email: claims.as_ref().and_then(|claims| claims.email.clone()),
                identity_key: Some(identity_key),
                plan: claims.and_then(|claims| claims.plan),
                org_name: None,
                needs_relogin: false,
                error: None,
            })
        }
    }
}

pub fn list_orphans(
    base: &Path,
    profiles: &[CliAccountProfile],
) -> Result<Vec<CliOrphanSnapshot>, String> {
    let root = snapshot_dir(base);
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    let mut orphans = Vec::new();
    for entry in fs::read_dir(root)
        .map_err(|error| error.to_string())?
        .flatten()
    {
        let path = entry.path();
        if !path.is_file() || path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|value| value.to_str()) else {
            continue;
        };
        if !safe_orphan_id(id) || profiles.iter().any(|profile| profile.id == id) {
            continue;
        }
        match load_orphan(base, id).and_then(|stored| metadata_for_orphan(id, &stored)) {
            Ok(metadata) => orphans.push(metadata),
            Err(_) => orphans.push(CliOrphanSnapshot {
                id: id.to_string(),
                provider: if id.starts_with("unregistered-claude-") {
                    Some(CliProvider::Claude)
                } else if id.starts_with("unregistered-codex-") {
                    Some(CliProvider::Codex)
                } else {
                    None
                },
                captured_at: None,
                email: None,
                identity_key: None,
                plan: None,
                org_name: None,
                needs_relogin: true,
                error: Some(ERR_ORPHAN_INVALID.to_string()),
            }),
        }
    }
    orphans.sort_by(|left, right| right.captured_at.cmp(&left.captured_at));
    Ok(orphans)
}

fn is_owned_backup_name(name: &str) -> bool {
    let (stamp, suffix) = match name.len() {
        20 => (name, None),
        29 if name.as_bytes().get(20) == Some(&b'-') => (&name[..20], Some(&name[21..])),
        _ => return false,
    };
    NaiveDateTime::parse_from_str(stamp, "%Y%m%dT%H%M%S%.3fZ").is_ok()
        && suffix.map_or(true, |value| {
            value.len() == 8 && value.chars().all(|character| character.is_ascii_hexdigit())
        })
}

pub fn backup_live_files(base: &Path, paths: &[&Path]) -> Result<PathBuf, String> {
    let stamp = Utc::now().format("%Y%m%dT%H%M%S%.3fZ").to_string();
    let unique = &Uuid::new_v4().simple().to_string()[..8];
    let dir = backup_root(base).join(format!("{stamp}-{unique}"));
    fs::create_dir_all(&dir)
        .map_err(|error| format!("Failed to create backup directory: {error}"))?;
    for path in paths {
        if path.is_file() {
            let name = path
                .file_name()
                .ok_or_else(|| "Live file has no name".to_string())?;
            fs::copy(path, dir.join(name))
                .map_err(|error| format!("Failed to copy live file: {error}"))?;
        }
    }
    let root = backup_root(base);
    let mut dirs: Vec<_> = fs::read_dir(&root)
        .map_err(|error| format!("Failed to read backups: {error}"))?
        .flatten()
        .filter(|entry| {
            entry.path().is_dir() && is_owned_backup_name(&entry.file_name().to_string_lossy())
        })
        .collect();
    dirs.sort_by_key(|entry| entry.file_name());
    let excess = dirs.len().saturating_sub(10);
    for entry in dirs.into_iter().take(excess) {
        fs::remove_dir_all(entry.path())
            .map_err(|error| format!("Failed to rotate backup: {error}"))?;
    }
    Ok(dir)
}
