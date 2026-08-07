use std::{fs, path::PathBuf};

use chrono::Utc;
use serde_json::Value;

use super::{
    atomic::write_atomic,
    json_splice::{extract_top_level_member, replace_top_level_member},
    snapshot::ClaudeSnapshot,
    CliLiveLogin, CliProvider, ERR_CLAUDE_IDENTITY_INVALID, ERR_CLAUDE_IDENTITY_UNREADABLE,
    ERR_LIVE_LOGIN_UNAVAILABLE, ERR_RESTORE_FAILED, ERR_SNAPSHOT_INVALID,
};

#[derive(Clone)]
pub struct ClaudePaths {
    pub credentials: PathBuf,
    pub claude_json: PathBuf,
}

impl ClaudePaths {
    pub fn resolve() -> Result<Self, String> {
        let home = dirs::home_dir().ok_or_else(|| ERR_LIVE_LOGIN_UNAVAILABLE.to_string())?;
        Ok(Self {
            credentials: home.join(".claude").join(".credentials.json"),
            claude_json: home.join(".claude.json"),
        })
    }
}

fn field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

pub fn needs_relogin(text: &str) -> bool {
    serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|value| {
            value
                .get("claudeAiOauth")?
                .get("refreshTokenExpiresAt")?
                .as_i64()
        })
        .map(|expires_at| expires_at <= Utc::now().timestamp_millis())
        .unwrap_or(true)
}

pub fn read_live_identity(paths: &ClaudePaths) -> CliLiveLogin {
    let blank = || CliLiveLogin {
        provider: CliProvider::Claude,
        present: false,
        email: None,
        identity_key: None,
        plan: None,
        org_name: None,
        matched_profile_id: None,
        error: None,
    };
    if !paths.claude_json.is_file() {
        return blank();
    }
    let text = match fs::read_to_string(&paths.claude_json) {
        Ok(value) => value,
        Err(_) => {
            let mut login = blank();
            login.error = Some(ERR_CLAUDE_IDENTITY_UNREADABLE.to_string());
            return login;
        }
    };
    let value: Value = match serde_json::from_str(&text) {
        Ok(value) => value,
        Err(_) => {
            let mut login = blank();
            login.error = Some(ERR_CLAUDE_IDENTITY_INVALID.to_string());
            return login;
        }
    };
    let Some(account) = value.get("oauthAccount") else {
        return blank();
    };
    CliLiveLogin {
        provider: CliProvider::Claude,
        present: true,
        email: field(account, "emailAddress"),
        identity_key: field(account, "accountUuid"),
        plan: fs::read_to_string(&paths.credentials)
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .and_then(|value| field(value.get("claudeAiOauth")?, "subscriptionType")),
        org_name: field(account, "organizationName"),
        matched_profile_id: None,
        error: None,
    }
}

pub fn capture(paths: &ClaudePaths) -> Result<(ClaudeSnapshot, CliLiveLogin), String> {
    let credentials = fs::read_to_string(&paths.credentials)
        .map_err(|_| ERR_LIVE_LOGIN_UNAVAILABLE.to_string())?;
    let claude_json = fs::read_to_string(&paths.claude_json)
        .map_err(|_| ERR_LIVE_LOGIN_UNAVAILABLE.to_string())?;
    let oauth_account_text = extract_top_level_member(&claude_json, "oauthAccount")
        .map_err(|_| ERR_CLAUDE_IDENTITY_INVALID.to_string())?
        .ok_or_else(|| ERR_CLAUDE_IDENTITY_INVALID.to_string())?
        .to_string();
    let live = read_live_identity(paths);
    if let Some(error) = &live.error {
        return Err(error.clone());
    }
    Ok((
        ClaudeSnapshot {
            version: 1,
            provider: CliProvider::Claude,
            captured_at: Utc::now().to_rfc3339(),
            credentials_text: credentials,
            oauth_account_text,
        },
        live,
    ))
}

pub fn restore(paths: &ClaudePaths, snapshot: &ClaudeSnapshot) -> Result<(), String> {
    restore_with_writer(paths, snapshot, write_atomic)
}

fn restore_with_writer<F>(
    paths: &ClaudePaths,
    snapshot: &ClaudeSnapshot,
    mut writer: F,
) -> Result<(), String>
where
    F: FnMut(&std::path::Path, &[u8]) -> Result<(), String>,
{
    serde_json::from_str::<Value>(&snapshot.credentials_text)
        .map_err(|_| ERR_SNAPSHOT_INVALID.to_string())?;
    let live =
        fs::read_to_string(&paths.claude_json).map_err(|_| ERR_RESTORE_FAILED.to_string())?;
    let replaced = replace_top_level_member(&live, "oauthAccount", &snapshot.oauth_account_text)
        .map_err(|_| ERR_RESTORE_FAILED.to_string())?;
    let original_credentials = match fs::read(&paths.credentials) {
        Ok(value) => Some(value),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => return Err(ERR_RESTORE_FAILED.to_string()),
    };
    writer(&paths.credentials, snapshot.credentials_text.as_bytes())
        .map_err(|_| ERR_RESTORE_FAILED.to_string())?;
    if writer(&paths.claude_json, replaced.as_bytes()).is_err() {
        match original_credentials {
            Some(bytes) => {
                let _ = writer(&paths.credentials, &bytes);
            }
            None => {
                let _ = fs::remove_file(&paths.credentials);
            }
        }
        return Err(ERR_RESTORE_FAILED.to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn restore_rolls_back_credentials_when_claude_json_write_fails() {
        let dir = tempdir().unwrap();
        let paths = ClaudePaths {
            credentials: dir.path().join("credentials.json"),
            claude_json: dir.path().join("claude.json"),
        };
        let original_credentials = br#"{"old":true}"#;
        fs::write(&paths.credentials, original_credentials).unwrap();
        fs::write(
            &paths.claude_json,
            r#"{"oauthAccount":{"accountUuid":"old"}}"#,
        )
        .unwrap();
        let snapshot = ClaudeSnapshot {
            version: 1,
            provider: CliProvider::Claude,
            captured_at: "x".into(),
            credentials_text: r#"{"new":true}"#.into(),
            oauth_account_text: r#"{"accountUuid":"new"}"#.into(),
        };
        let mut writes = 0;
        let result = restore_with_writer(&paths, &snapshot, |path, bytes| {
            writes += 1;
            if writes == 2 {
                return Err("injected second write failure".into());
            }
            write_atomic(path, bytes)
        });

        assert_eq!(result, Err(ERR_RESTORE_FAILED.to_string()));
        assert_eq!(fs::read(&paths.credentials).unwrap(), original_credentials);
        assert!(fs::read_to_string(&paths.claude_json)
            .unwrap()
            .contains("\"old\""));
    }
}
