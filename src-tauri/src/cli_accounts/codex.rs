use std::{env, fs, path::PathBuf};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::Utc;
use serde_json::Value;

use super::{
    atomic::write_atomic, snapshot::CodexSnapshot, CliLiveLogin, CliProvider,
    ERR_CODEX_IDENTITY_INVALID, ERR_CODEX_IDENTITY_UNREADABLE, ERR_LIVE_LOGIN_UNAVAILABLE,
    ERR_RESTORE_FAILED, ERR_SNAPSHOT_INVALID,
};

#[derive(Clone)]
pub struct CodexPaths {
    pub auth: PathBuf,
}

impl CodexPaths {
    pub fn resolve() -> Result<Self, String> {
        let directory = env::var("CODEX_HOME")
            .ok()
            .map(PathBuf::from)
            .or_else(|| dirs::home_dir().map(|home| home.join(".codex")))
            .ok_or_else(|| ERR_LIVE_LOGIN_UNAVAILABLE.to_string())?;
        Ok(Self {
            auth: directory.join("auth.json"),
        })
    }
}

#[derive(Clone)]
pub struct CodexClaims {
    pub email: Option<String>,
    pub account_id: Option<String>,
    pub plan: Option<String>,
}

pub fn decode_id_token_claims(jwt: &str) -> Result<CodexClaims, String> {
    let parts = jwt.split('.').collect::<Vec<_>>();
    if parts.len() != 3 {
        return Err(ERR_CODEX_IDENTITY_INVALID.to_string());
    }
    let raw = URL_SAFE_NO_PAD
        .decode(parts[1])
        .map_err(|_| ERR_CODEX_IDENTITY_INVALID.to_string())?;
    let value: Value =
        serde_json::from_slice(&raw).map_err(|_| ERR_CODEX_IDENTITY_INVALID.to_string())?;
    let auth = value
        .get("https://api.openai.com/auth")
        .unwrap_or(&Value::Null);
    Ok(CodexClaims {
        email: value
            .get("email")
            .and_then(Value::as_str)
            .map(str::to_string),
        account_id: auth
            .get("chatgpt_account_id")
            .and_then(Value::as_str)
            .map(str::to_string),
        plan: auth
            .get("chatgpt_plan_type")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

pub fn read_live_identity(paths: &CodexPaths) -> CliLiveLogin {
    let blank = || CliLiveLogin {
        provider: CliProvider::Codex,
        present: false,
        email: None,
        identity_key: None,
        plan: None,
        org_name: None,
        matched_profile_id: None,
        error: None,
    };
    if !paths.auth.is_file() {
        return blank();
    }
    let text = match fs::read_to_string(&paths.auth) {
        Ok(value) => value,
        Err(_) => {
            let mut login = blank();
            login.error = Some(ERR_CODEX_IDENTITY_UNREADABLE.to_string());
            return login;
        }
    };
    let value: Value = match serde_json::from_str(&text) {
        Ok(value) => value,
        Err(_) => {
            let mut login = blank();
            login.error = Some(ERR_CODEX_IDENTITY_INVALID.to_string());
            return login;
        }
    };
    let tokens = value.get("tokens").unwrap_or(&Value::Null);
    let claims = tokens
        .get("id_token")
        .and_then(Value::as_str)
        .map(decode_id_token_claims)
        .transpose();
    match claims {
        Err(error) => {
            let mut login = blank();
            login.error = Some(error);
            login
        }
        Ok(claims) => CliLiveLogin {
            provider: CliProvider::Codex,
            present: true,
            email: claims.as_ref().and_then(|claims| claims.email.clone()),
            identity_key: claims
                .as_ref()
                .and_then(|claims| claims.account_id.clone())
                .or_else(|| {
                    tokens
                        .get("account_id")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                }),
            plan: claims.and_then(|claims| claims.plan),
            org_name: None,
            matched_profile_id: None,
            error: None,
        },
    }
}

pub fn capture(paths: &CodexPaths) -> Result<(CodexSnapshot, CliLiveLogin), String> {
    let text =
        fs::read_to_string(&paths.auth).map_err(|_| ERR_LIVE_LOGIN_UNAVAILABLE.to_string())?;
    let live = read_live_identity(paths);
    if let Some(error) = &live.error {
        return Err(error.clone());
    }
    Ok((
        CodexSnapshot {
            version: 1,
            provider: CliProvider::Codex,
            captured_at: Utc::now().to_rfc3339(),
            auth_text: text,
        },
        live,
    ))
}

pub fn restore(paths: &CodexPaths, snapshot: &CodexSnapshot) -> Result<(), String> {
    let value: Value =
        serde_json::from_str(&snapshot.auth_text).map_err(|_| ERR_SNAPSHOT_INVALID.to_string())?;
    if value.get("tokens").is_none() {
        return Err(ERR_SNAPSHOT_INVALID.to_string());
    }
    write_atomic(&paths.auth, snapshot.auth_text.as_bytes())
        .map_err(|_| ERR_RESTORE_FAILED.to_string())
}
