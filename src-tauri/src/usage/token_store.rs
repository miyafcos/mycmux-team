use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::Manager;

const KEYRING_SERVICE: &str = "mycmux-usage-claude";
const ACCOUNTS_FILE_NAME: &str = "usage_accounts.json";
const ACCOUNTS_FILE_VERSION: u32 = 1;
const MAX_SECRET_CHARS: usize = 1200;

#[derive(Serialize, Deserialize)]
pub struct StoredTokens {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at_ms: i64,
    #[serde(default)]
    pub scope: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageAccountMeta {
    pub account_id: String,
    pub label: String,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    pub created_at: String,
    #[serde(default)]
    pub needs_reauth: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageAccountsFile {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    accounts: Vec<UsageAccountMeta>,
}

fn default_true() -> bool {
    true
}

pub fn store_tokens(account_id: &str, tokens: &StoredTokens) -> Result<(), String> {
    let payload = serde_json::to_string(tokens)
        .map_err(|error| format!("Claude usage token serialization failed: {error}"))?;
    if payload.chars().count() > MAX_SECRET_CHARS {
        return Err("Claude usage token payload exceeds the safe storage limit".to_string());
    }

    keyring_entry(account_id)?
        .set_password(&payload)
        .map_err(|error| format!("Claude usage token storage failed: {error}"))
}

pub fn load_tokens(account_id: &str) -> Result<Option<StoredTokens>, String> {
    let payload = match keyring_entry(account_id)?.get_password() {
        Ok(payload) => payload,
        Err(keyring::Error::NoEntry) => return Ok(None),
        Err(error) => return Err(format!("Claude usage token lookup failed: {error}")),
    };
    if payload.chars().count() > MAX_SECRET_CHARS {
        return Err("Claude usage token payload exceeds the safe storage limit".to_string());
    }

    serde_json::from_str(&payload)
        .map(Some)
        .map_err(|error| format!("Claude usage token payload is invalid: {error}"))
}

pub fn delete_tokens(account_id: &str) -> Result<(), String> {
    match keyring_entry(account_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("Claude usage token deletion failed: {error}")),
    }
}

fn keyring_entry(account_id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, account_id)
        .map_err(|error| format!("Claude usage credential entry creation failed: {error}"))
}

pub fn load_accounts(app: &tauri::AppHandle) -> Result<Vec<UsageAccountMeta>, String> {
    let path = accounts_path(app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }

    let content = fs::read_to_string(&path)
        .map_err(|error| format!("Failed to read usage accounts {}: {error}", path.display()))?;
    let file: UsageAccountsFile = serde_json::from_str(&content)
        .map_err(|error| format!("Failed to parse usage accounts {}: {error}", path.display()))?;
    Ok(file.accounts)
}

pub fn save_accounts(app: &tauri::AppHandle, accounts: &[UsageAccountMeta]) -> Result<(), String> {
    let path = accounts_path(app)?;
    let content = serde_json::to_string_pretty(&UsageAccountsFile {
        version: ACCOUNTS_FILE_VERSION,
        accounts: accounts.to_vec(),
    })
    .map_err(|error| format!("Failed to serialize usage accounts: {error}"))?;
    write_atomic(&path, &content)
        .map_err(|error| format!("Failed to write usage accounts {}: {error}", path.display()))
}

pub fn upsert_account(
    app: &tauri::AppHandle,
    meta: UsageAccountMeta,
) -> Result<UsageAccountMeta, String> {
    let mut accounts = load_accounts(app)?;
    upsert_in(&mut accounts, meta.clone());
    save_accounts(app, &accounts)?;
    Ok(meta)
}

pub fn remove_account_meta(app: &tauri::AppHandle, account_id: &str) -> Result<(), String> {
    let mut accounts = load_accounts(app)?;
    accounts.retain(|account| account.account_id != account_id);
    save_accounts(app, &accounts)
}

pub fn set_needs_reauth(
    app: &tauri::AppHandle,
    account_id: &str,
    needs_reauth: bool,
) -> Result<(), String> {
    update_account(app, account_id, |account| {
        account.needs_reauth = needs_reauth;
    })
}

pub fn set_enabled(app: &tauri::AppHandle, account_id: &str, enabled: bool) -> Result<(), String> {
    update_account(app, account_id, |account| {
        account.enabled = enabled;
    })
}

fn update_account(
    app: &tauri::AppHandle,
    account_id: &str,
    update: impl FnOnce(&mut UsageAccountMeta),
) -> Result<(), String> {
    let mut accounts = load_accounts(app)?;
    let account = accounts
        .iter_mut()
        .find(|account| account.account_id == account_id)
        .ok_or_else(|| format!("Unknown usage account: {account_id}"))?;
    update(account);
    save_accounts(app, &accounts)
}

fn upsert_in(accounts: &mut Vec<UsageAccountMeta>, meta: UsageAccountMeta) {
    if let Some(existing) = accounts
        .iter_mut()
        .find(|account| account.account_id == meta.account_id)
    {
        *existing = meta;
    } else {
        accounts.push(meta);
    }
}

fn accounts_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join(ACCOUNTS_FILE_NAME))
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))
}

fn write_atomic(path: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Failed to create usage accounts directory {}: {error}",
                parent.display()
            )
        })?;
    }

    let file_name = path
        .file_name()
        .ok_or_else(|| format!("Invalid usage accounts path {}", path.display()))?;
    let mut tmp_file_name = file_name.to_os_string();
    tmp_file_name.push(".tmp");
    let tmp_path = path.with_file_name(tmp_file_name);

    let write_result = (|| -> std::io::Result<()> {
        let mut file = fs::File::create(&tmp_path)?;
        file.write_all(content.as_bytes())?;
        file.sync_all()
    })();

    if let Err(error) = write_result {
        let _ = fs::remove_file(&tmp_path);
        return Err(error.to_string());
    }

    if let Err(error) = fs::rename(&tmp_path, path) {
        let _ = fs::remove_file(&tmp_path);
        return Err(error.to_string());
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(account_id: &str, label: &str) -> UsageAccountMeta {
        UsageAccountMeta {
            account_id: account_id.to_string(),
            label: label.to_string(),
            email: None,
            enabled: true,
            created_at: "2026-07-10T00:00:00Z".to_string(),
            needs_reauth: false,
        }
    }

    #[test]
    fn stored_tokens_serde_round_trip() {
        let tokens = StoredTokens {
            access_token: "access".to_string(),
            refresh_token: "refresh".to_string(),
            expires_at_ms: 123_456,
            scope: Some("user:profile".to_string()),
        };

        let json = serde_json::to_string(&tokens).unwrap();
        let restored: StoredTokens = serde_json::from_str(&json).unwrap();

        assert_eq!(restored.access_token, "access");
        assert_eq!(restored.refresh_token, "refresh");
        assert_eq!(restored.expires_at_ms, 123_456);
        assert_eq!(restored.scope.as_deref(), Some("user:profile"));
    }

    #[test]
    fn usage_account_meta_defaults() {
        let json = r#"{
            "account_id":"account-1",
            "label":"Account",
            "created_at":"2026-07-10T00:00:00Z"
        }"#;
        let restored: UsageAccountMeta = serde_json::from_str(json).unwrap();

        assert!(restored.enabled);
        assert!(!restored.needs_reauth);
        assert_eq!(restored.email, None);
    }

    #[test]
    fn upsert_replaces_by_account_id() {
        let mut accounts = vec![meta("account-1", "Old")];
        upsert_in(&mut accounts, meta("account-1", "New"));

        assert_eq!(accounts.len(), 1);
        assert_eq!(accounts[0].label, "New");
    }

    #[test]
    fn usage_accounts_file_round_trip() {
        let file = UsageAccountsFile {
            version: ACCOUNTS_FILE_VERSION,
            accounts: vec![meta("account-1", "Account")],
        };

        let json = serde_json::to_string(&file).unwrap();
        let restored: UsageAccountsFile = serde_json::from_str(&json).unwrap();

        assert_eq!(restored.version, ACCOUNTS_FILE_VERSION);
        assert_eq!(restored.accounts.len(), 1);
        assert_eq!(restored.accounts[0].account_id, "account-1");
    }
}
