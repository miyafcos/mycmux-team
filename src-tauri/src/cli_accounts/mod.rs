mod atomic;
pub(crate) mod claude;
pub(crate) mod codex;
pub(crate) mod json_splice;
pub(crate) mod live_sync;
mod registry;
mod snapshot;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::{
    path::Path,
    sync::{Mutex, MutexGuard, OnceLock},
};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

pub const ERR_ACCOUNTS_UNAVAILABLE: &str = "cli_account.error.accounts_unavailable";
pub const ERR_LIVE_LOGIN_UNAVAILABLE: &str = "cli_account.error.live_login_unavailable";
pub const ERR_LIVE_IDENTITY_MISSING: &str = "cli_account.error.live_identity_missing";
pub const ERR_PROFILE_NOT_FOUND: &str = "cli_account.error.profile_not_found";
pub const ERR_SNAPSHOT_UNAVAILABLE: &str = "cli_account.error.snapshot_unavailable";
pub const ERR_SNAPSHOT_INVALID: &str = "cli_account.error.snapshot_invalid";
pub const ERR_NEEDS_RELOGIN: &str = "cli_account.error.needs_relogin";
pub const ERR_SNAPSHOT_PROVIDER_MISMATCH: &str = "cli_account.error.snapshot_provider_mismatch";
pub const ERR_BACKUP_FAILED: &str = "cli_account.error.backup_failed";
pub const ERR_RESTORE_FAILED: &str = "cli_account.error.restore_failed";
pub const ERR_REGISTRY_SAVE_FAILED: &str = "cli_account.error.registry_save_failed";
pub const ERR_REMOVE_FAILED: &str = "cli_account.error.remove_failed";
pub const ERR_RENAME_FAILED: &str = "cli_account.error.rename_failed";
pub const ERR_ORPHAN_NOT_FOUND: &str = "cli_account.error.orphan_not_found";
pub const ERR_ORPHAN_INVALID: &str = "cli_account.error.orphan_invalid";
pub const ERR_ORPHAN_IDENTITY_ALREADY_REGISTERED: &str =
    "cli_account.error.orphan_identity_already_registered";
pub const ERR_ORPHAN_MANAGE_FAILED: &str = "cli_account.error.orphan_manage_failed";
pub const ERR_CLAUDE_IDENTITY_UNREADABLE: &str = "cli_account.error.claude_identity_unreadable";
pub const ERR_CLAUDE_IDENTITY_INVALID: &str = "cli_account.error.claude_identity_invalid";
pub const ERR_CODEX_IDENTITY_UNREADABLE: &str = "cli_account.error.codex_identity_unreadable";
pub const ERR_CODEX_IDENTITY_INVALID: &str = "cli_account.error.codex_identity_invalid";
pub const WARN_ACTIVE_SNAPSHOT_REFRESHED: &str = "cli_account.warning.active_snapshot_refreshed";
pub const WARN_UNREGISTERED_LIVE_LOGIN_SAVED: &str =
    "cli_account.warning.unregistered_live_login_saved";
pub const WARN_RESTORED_IDENTITY_MISMATCH: &str = "cli_account.warning.restored_identity_mismatch";
pub const WARN_SWITCH_METADATA_NOT_SAVED: &str = "cli_account.warning.switch_metadata_not_saved";

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum CliProvider {
    Claude,
    Codex,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SnapshotUpdate {
    Applied,
    Conflict,
    NotFound,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct CliAccountProfile {
    pub id: String,
    pub provider: CliProvider,
    pub label: String,
    #[serde(default)]
    pub email: Option<String>,
    pub identity_key: String,
    #[serde(default)]
    pub plan: Option<String>,
    #[serde(default)]
    pub org_name: Option<String>,
    pub captured_at: String,
    #[serde(default)]
    pub last_switched_at: Option<String>,
    #[serde(default)]
    pub needs_relogin: bool,
}

#[derive(Serialize, Clone)]
pub struct CliLiveLogin {
    pub provider: CliProvider,
    pub present: bool,
    pub email: Option<String>,
    pub identity_key: Option<String>,
    pub plan: Option<String>,
    pub org_name: Option<String>,
    pub matched_profile_id: Option<String>,
    pub error: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct CliOrphanSnapshot {
    pub id: String,
    pub provider: Option<CliProvider>,
    pub captured_at: Option<String>,
    pub email: Option<String>,
    pub identity_key: Option<String>,
    pub plan: Option<String>,
    pub org_name: Option<String>,
    pub needs_relogin: bool,
    pub error: Option<String>,
}

#[derive(Serialize)]
pub struct CliAccountsSnapshot {
    pub profiles: Vec<CliAccountProfile>,
    pub live: Vec<CliLiveLogin>,
    pub active: registry::ActivePointers,
    pub orphans: Vec<CliOrphanSnapshot>,
    pub backup_root: String,
    pub generated_at: String,
}

#[derive(Serialize)]
pub struct CliSwitchResult {
    pub profile: CliAccountProfile,
    pub wrote_back_to: Option<String>,
    pub backup_dir: String,
    pub warnings: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CliOrphanAction {
    Register,
    Discard,
}

fn paths_for<'a>(
    provider: CliProvider,
    claude_paths: &'a claude::ClaudePaths,
    codex_paths: &'a codex::CodexPaths,
) -> Vec<&'a Path> {
    match provider {
        CliProvider::Claude => vec![
            claude_paths.credentials.as_path(),
            claude_paths.claude_json.as_path(),
        ],
        CliProvider::Codex => vec![codex_paths.auth.as_path()],
    }
}

fn match_live(mut live: CliLiveLogin, profiles: &[CliAccountProfile]) -> CliLiveLogin {
    if let Some(key) = live.identity_key.as_deref() {
        live.matched_profile_id = profiles
            .iter()
            .find(|profile| profile.provider == live.provider && profile.identity_key == key)
            .map(|profile| profile.id.clone());
    }
    live
}

fn refreshed_profiles(base: &Path, profiles: &[CliAccountProfile]) -> Vec<CliAccountProfile> {
    profiles
        .iter()
        .cloned()
        .map(|mut profile| {
            if profile.provider == CliProvider::Claude {
                profile.needs_relogin = match snapshot::load(base, &profile.id) {
                    Ok(snapshot::StoredSnapshot::Claude(stored))
                        if stored.provider == CliProvider::Claude =>
                    {
                        claude::needs_relogin(&stored.credentials_text)
                    }
                    _ => true,
                };
            }
            profile
        })
        .collect()
}

pub fn list(
    base: &Path,
    claude_paths: &claude::ClaudePaths,
    codex_paths: &codex::CodexPaths,
) -> Result<CliAccountsSnapshot, String> {
    let file = registry::load(base).map_err(|_| ERR_ACCOUNTS_UNAVAILABLE.to_string())?;
    let profiles = refreshed_profiles(base, &file.profiles);
    let live = vec![
        match_live(claude::read_live_identity(claude_paths), &profiles),
        match_live(codex::read_live_identity(codex_paths), &profiles),
    ];
    let orphans = snapshot::list_orphans(base, &file.profiles)
        .map_err(|_| ERR_ACCOUNTS_UNAVAILABLE.to_string())?;
    Ok(CliAccountsSnapshot {
        profiles,
        live,
        active: file.active,
        orphans,
        backup_root: snapshot::backup_root(base).display().to_string(),
        generated_at: Utc::now().to_rfc3339(),
    })
}

pub fn capture_account(
    base: &Path,
    claude_paths: &claude::ClaudePaths,
    codex_paths: &codex::CodexPaths,
    provider: CliProvider,
    label: Option<String>,
) -> Result<CliAccountProfile, String> {
    let (stored, live) = match provider {
        CliProvider::Claude => {
            let (stored, live) = claude::capture(claude_paths)?;
            (snapshot::StoredSnapshot::Claude(stored), live)
        }
        CliProvider::Codex => {
            let (stored, live) = codex::capture(codex_paths)?;
            (snapshot::StoredSnapshot::Codex(stored), live)
        }
    };
    let identity = live
        .identity_key
        .clone()
        .ok_or_else(|| ERR_LIVE_IDENTITY_MISSING.to_string())?;
    let mut file = registry::load(base).map_err(|_| ERR_ACCOUNTS_UNAVAILABLE.to_string())?;
    let existing = file
        .profiles
        .iter()
        .find(|profile| profile.provider == provider && profile.identity_key == identity)
        .cloned();
    let id = existing
        .as_ref()
        .map(|profile| profile.id.clone())
        .unwrap_or_else(|| {
            format!(
                "{}-{}",
                match provider {
                    CliProvider::Claude => "claude",
                    CliProvider::Codex => "codex",
                },
                &Uuid::new_v4().simple().to_string()[..8]
            )
        });
    let profile = CliAccountProfile {
        id: id.clone(),
        provider,
        label: label
            .or_else(|| existing.as_ref().map(|profile| profile.label.clone()))
            .unwrap_or_else(|| {
                live.email
                    .clone()
                    .unwrap_or_else(|| identity.chars().take(8).collect())
            }),
        email: live.email,
        identity_key: identity,
        plan: live.plan,
        org_name: live.org_name,
        captured_at: Utc::now().to_rfc3339(),
        last_switched_at: existing.and_then(|profile| profile.last_switched_at),
        needs_relogin: match &stored {
            snapshot::StoredSnapshot::Claude(stored) => {
                claude::needs_relogin(&stored.credentials_text)
            }
            snapshot::StoredSnapshot::Codex(_) => false,
        },
    };
    snapshot::save(base, &id, &stored).map_err(|_| ERR_REGISTRY_SAVE_FAILED.to_string())?;
    registry::upsert_by_identity_key(&mut file, profile.clone());
    registry::save(base, &file).map_err(|_| ERR_REGISTRY_SAVE_FAILED.to_string())?;
    Ok(profile)
}

pub fn switch_account(
    base: &Path,
    claude_paths: &claude::ClaudePaths,
    codex_paths: &codex::CodexPaths,
    provider: CliProvider,
    profile_id: &str,
) -> Result<CliSwitchResult, String> {
    let mut file = registry::load(base).map_err(|_| ERR_ACCOUNTS_UNAVAILABLE.to_string())?;
    let target = file
        .profiles
        .iter()
        .find(|profile| profile.id == profile_id && profile.provider == provider)
        .cloned()
        .ok_or_else(|| ERR_PROFILE_NOT_FOUND.to_string())?;
    let live = match provider {
        CliProvider::Claude => claude::read_live_identity(claude_paths),
        CliProvider::Codex => codex::read_live_identity(codex_paths),
    };
    let mut warnings = Vec::new();
    let mut wrote_back_to = None;
    if live.present {
        let (current, identity) = match provider {
            CliProvider::Claude => {
                let (stored, _) = claude::capture(claude_paths)?;
                (
                    snapshot::StoredSnapshot::Claude(stored),
                    live.identity_key.clone(),
                )
            }
            CliProvider::Codex => {
                let (stored, _) = codex::capture(codex_paths)?;
                (
                    snapshot::StoredSnapshot::Codex(stored),
                    live.identity_key.clone(),
                )
            }
        };
        if let Some(identity) = identity {
            if let Some(profile) = file
                .profiles
                .iter()
                .find(|profile| profile.provider == provider && profile.identity_key == identity)
            {
                snapshot::save(base, &profile.id, &current)
                    .map_err(|_| ERR_REGISTRY_SAVE_FAILED.to_string())?;
                wrote_back_to = Some(profile.id.clone());
                if profile.id == target.id {
                    warnings.push(WARN_ACTIVE_SNAPSHOT_REFRESHED.to_string());
                }
            } else {
                snapshot::save_orphan(base, provider, &current)
                    .map_err(|_| ERR_REGISTRY_SAVE_FAILED.to_string())?;
                warnings.push(WARN_UNREGISTERED_LIVE_LOGIN_SAVED.to_string());
            }
        }
    }

    let stored =
        snapshot::load(base, &target.id).map_err(|_| ERR_SNAPSHOT_UNAVAILABLE.to_string())?;
    match (&stored, provider) {
        (snapshot::StoredSnapshot::Claude(stored), CliProvider::Claude)
            if stored.provider == CliProvider::Claude =>
        {
            serde_json::from_str::<serde_json::Value>(&stored.credentials_text)
                .map_err(|_| ERR_SNAPSHOT_INVALID.to_string())?;
            if claude::needs_relogin(&stored.credentials_text) {
                return Err(ERR_NEEDS_RELOGIN.to_string());
            }
        }
        (snapshot::StoredSnapshot::Codex(stored), CliProvider::Codex)
            if stored.provider == CliProvider::Codex =>
        {
            let value: serde_json::Value = serde_json::from_str(&stored.auth_text)
                .map_err(|_| ERR_SNAPSHOT_INVALID.to_string())?;
            if value.get("tokens").is_none() {
                return Err(ERR_SNAPSHOT_INVALID.to_string());
            }
        }
        _ => return Err(ERR_SNAPSHOT_PROVIDER_MISMATCH.to_string()),
    }

    let backup = snapshot::backup_live_files(base, &paths_for(provider, claude_paths, codex_paths))
        .map_err(|_| ERR_BACKUP_FAILED.to_string())?;
    match stored {
        snapshot::StoredSnapshot::Claude(stored) => claude::restore(claude_paths, &stored)?,
        snapshot::StoredSnapshot::Codex(stored) => codex::restore(codex_paths, &stored)?,
    }
    let verified = match provider {
        CliProvider::Claude => claude::read_live_identity(claude_paths),
        CliProvider::Codex => codex::read_live_identity(codex_paths),
    };
    if verified.identity_key.as_deref() != Some(target.identity_key.as_str()) {
        warnings.push(WARN_RESTORED_IDENTITY_MISMATCH.to_string());
    }
    let now = Utc::now().to_rfc3339();
    if let Some(profile) = file
        .profiles
        .iter_mut()
        .find(|profile| profile.id == target.id)
    {
        profile.last_switched_at = Some(now);
    }
    registry::set_active(&mut file, provider, Some(target.id.clone()));
    if registry::save(base, &file).is_err() {
        warnings.push(WARN_SWITCH_METADATA_NOT_SAVED.to_string());
    }
    let profile = file
        .profiles
        .iter()
        .find(|profile| profile.id == target.id)
        .cloned()
        .unwrap_or(target);
    Ok(CliSwitchResult {
        profile,
        wrote_back_to,
        backup_dir: backup.display().to_string(),
        warnings,
    })
}

fn mutation_lock() -> &'static Mutex<()> {
    static MUTATION_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    MUTATION_LOCK.get_or_init(|| Mutex::new(()))
}

fn mutation_guard() -> Result<MutexGuard<'static, ()>, String> {
    mutation_lock()
        .lock()
        .map_err(|_| ERR_ACCOUNTS_UNAVAILABLE.to_string())
}

/// Non-blocking variant for background work that must never delay a
/// user-initiated switch: `None` means "busy, try again next tick".
fn try_mutation_guard() -> Option<MutexGuard<'static, ()>> {
    mutation_lock().try_lock().ok()
}

/// Replace credential text in a snapshot only when its refresh token still matches.
pub fn update_snapshot_tokens(
    base: &Path,
    profile_id: &str,
    provider: CliProvider,
    expected_refresh_token: &str,
    rewrite: impl FnOnce(&str) -> Result<String, String>,
) -> Result<SnapshotUpdate, String> {
    let _guard = mutation_guard()?;
    let mut stored = match snapshot::load(base, profile_id) {
        Ok(stored) => stored,
        Err(error) => {
            snapshot::validate_snapshot_id(profile_id)?;
            let path = snapshot::snapshot_dir(base).join(format!("{profile_id}.json"));
            if path.is_file() {
                return Err(error);
            }
            return Ok(SnapshotUpdate::NotFound);
        }
    };

    let text = match (&mut stored, provider) {
        (snapshot::StoredSnapshot::Claude(stored), CliProvider::Claude) => {
            let tokens = crate::usage::credentials::claude_tokens(&stored.credentials_text)?;
            if tokens.refresh_token != expected_refresh_token {
                return Ok(SnapshotUpdate::Conflict);
            }
            &mut stored.credentials_text
        }
        (snapshot::StoredSnapshot::Codex(stored), CliProvider::Codex) => {
            let tokens = crate::usage::credentials::codex_tokens(&stored.auth_text)?;
            if tokens.refresh_token.as_deref() != Some(expected_refresh_token) {
                return Ok(SnapshotUpdate::Conflict);
            }
            &mut stored.auth_text
        }
        _ => return Err(ERR_SNAPSHOT_PROVIDER_MISMATCH.to_string()),
    };
    *text = rewrite(text)?;
    snapshot::save(base, profile_id, &stored).map_err(|_| ERR_REGISTRY_SAVE_FAILED.to_string())?;
    Ok(SnapshotUpdate::Applied)
}

pub fn list_resolved(base: &Path) -> Result<CliAccountsSnapshot, String> {
    let claude_paths = claude::ClaudePaths::resolve()?;
    let codex_paths = codex::CodexPaths::resolve()?;
    list(base, &claude_paths, &codex_paths)
}

pub fn capture_resolved(
    base: &Path,
    provider: CliProvider,
    label: Option<String>,
) -> Result<CliAccountProfile, String> {
    let _guard = mutation_guard()?;
    let claude_paths = claude::ClaudePaths::resolve()?;
    let codex_paths = codex::CodexPaths::resolve()?;
    capture_account(base, &claude_paths, &codex_paths, provider, label)
}

pub fn switch_resolved(
    base: &Path,
    provider: CliProvider,
    profile_id: &str,
) -> Result<CliSwitchResult, String> {
    let _guard = mutation_guard()?;
    let claude_paths = claude::ClaudePaths::resolve()?;
    let codex_paths = codex::CodexPaths::resolve()?;
    switch_account(base, &claude_paths, &codex_paths, provider, profile_id)
}

pub fn remove_resolved(base: &Path, profile_id: &str) -> Result<(), String> {
    let _guard = mutation_guard()?;
    snapshot::validate_snapshot_id(profile_id).map_err(|_| ERR_REMOVE_FAILED.to_string())?;
    let mut file = registry::load(base).map_err(|_| ERR_ACCOUNTS_UNAVAILABLE.to_string())?;
    if !registry::remove_profile(&mut file, profile_id) {
        return Err(ERR_PROFILE_NOT_FOUND.to_string());
    }
    registry::save(base, &file).map_err(|_| ERR_REMOVE_FAILED.to_string())?;
    snapshot::remove(base, profile_id).map_err(|_| ERR_REMOVE_FAILED.to_string())?;
    Ok(())
}

pub fn rename_resolved(
    base: &Path,
    profile_id: &str,
    label: String,
) -> Result<CliAccountProfile, String> {
    let _guard = mutation_guard()?;
    let mut file = registry::load(base).map_err(|_| ERR_ACCOUNTS_UNAVAILABLE.to_string())?;
    if !registry::rename_profile(&mut file, profile_id, label) {
        return Err(ERR_PROFILE_NOT_FOUND.to_string());
    }
    let profile = file
        .profiles
        .iter()
        .find(|profile| profile.id == profile_id)
        .cloned()
        .ok_or_else(|| ERR_PROFILE_NOT_FOUND.to_string())?;
    registry::save(base, &file).map_err(|_| ERR_RENAME_FAILED.to_string())?;
    Ok(profile)
}

fn resolve_orphan_inner(
    base: &Path,
    orphan_id: &str,
    action: CliOrphanAction,
    label: Option<String>,
) -> Result<Option<CliAccountProfile>, String> {
    let _guard = mutation_guard()?;
    let mut file = registry::load(base).map_err(|_| ERR_ACCOUNTS_UNAVAILABLE.to_string())?;
    if file.profiles.iter().any(|profile| profile.id == orphan_id) {
        return Err(ERR_ORPHAN_INVALID.to_string());
    }
    match action {
        CliOrphanAction::Discard => {
            snapshot::discard_orphan(base, orphan_id)?;
            Ok(None)
        }
        CliOrphanAction::Register => {
            let stored = snapshot::load_orphan(base, orphan_id)?;
            let metadata = snapshot::metadata_for_orphan(orphan_id, &stored)?;
            let provider = metadata
                .provider
                .ok_or_else(|| ERR_ORPHAN_INVALID.to_string())?;
            let identity_key = metadata
                .identity_key
                .clone()
                .ok_or_else(|| ERR_ORPHAN_INVALID.to_string())?;
            if file
                .profiles
                .iter()
                .any(|profile| profile.provider == provider && profile.identity_key == identity_key)
            {
                return Err(ERR_ORPHAN_IDENTITY_ALREADY_REGISTERED.to_string());
            }
            let profile = CliAccountProfile {
                id: orphan_id.to_string(),
                provider,
                label: label.unwrap_or_else(|| {
                    metadata
                        .email
                        .clone()
                        .unwrap_or_else(|| identity_key.chars().take(8).collect())
                }),
                email: metadata.email,
                identity_key,
                plan: metadata.plan,
                org_name: metadata.org_name,
                captured_at: metadata
                    .captured_at
                    .unwrap_or_else(|| Utc::now().to_rfc3339()),
                last_switched_at: None,
                needs_relogin: metadata.needs_relogin,
            };
            registry::upsert_by_identity_key(&mut file, profile.clone());
            registry::save(base, &file).map_err(|_| ERR_ORPHAN_MANAGE_FAILED.to_string())?;
            Ok(Some(profile))
        }
    }
}

#[tauri::command(async)]
pub async fn resolve_cli_account_orphan(
    app: AppHandle,
    orphan_id: String,
    action: CliOrphanAction,
    label: Option<String>,
) -> Result<Option<CliAccountProfile>, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|_| ERR_ACCOUNTS_UNAVAILABLE.to_string())?;
    resolve_orphan_inner(&base, &orphan_id, action, label)
}

#[cfg(test)]
mod tests;
