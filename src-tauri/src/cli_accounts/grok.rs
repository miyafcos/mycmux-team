use std::{env, fs, path::PathBuf, thread, time::{Duration, Instant}};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::Utc;
use serde_json::Value;

use super::{
    atomic::write_atomic, snapshot::GrokSnapshot, CliLiveLogin, CliProvider,
    ERR_GROK_IDENTITY_INVALID, ERR_GROK_IDENTITY_UNREADABLE, ERR_LIVE_LOGIN_UNAVAILABLE,
    ERR_GROK_AUTH_LOCK_TIMEOUT, ERR_RESTORE_FAILED, ERR_SNAPSHOT_INVALID,
};

const LOCK_WAIT: Duration = Duration::from_secs(5);
const LOCK_POLL: Duration = Duration::from_millis(50);

#[derive(Clone)]
pub struct GrokPaths {
    pub auth: PathBuf,
    pub lock: PathBuf,
}

impl GrokPaths {
    pub fn resolve() -> Result<Self, String> {
        let directory = env::var("GROK_HOME")
            .ok()
            .map(PathBuf::from)
            .or_else(|| dirs::home_dir().map(|home| home.join(".grok")))
            .ok_or_else(|| ERR_LIVE_LOGIN_UNAVAILABLE.to_string())?;
        Ok(Self {
            auth: directory.join("auth.json"),
            lock: directory.join("auth.json.lock"),
        })
    }
}

#[derive(Clone)]
pub struct GrokClaims {
    pub tier: Option<String>,
}

pub fn decode_key_claims(jwt: &str) -> Result<GrokClaims, String> {
    let parts = jwt.split('.').collect::<Vec<_>>();
    if parts.len() != 3 {
        return Err(ERR_GROK_IDENTITY_INVALID.to_string());
    }
    let raw = URL_SAFE_NO_PAD
        .decode(parts[1])
        .map_err(|_| ERR_GROK_IDENTITY_INVALID.to_string())?;
    let value: Value = serde_json::from_slice(&raw)
        .map_err(|_| ERR_GROK_IDENTITY_INVALID.to_string())?;
    Ok(GrokClaims {
        tier: value.get("tier").and_then(Value::as_str).map(str::to_string),
    })
}

fn blank() -> CliLiveLogin {
    CliLiveLogin {
        provider: CliProvider::Grok,
        present: false,
        email: None,
        identity_key: None,
        plan: None,
        org_name: None,
        matched_profile_id: None,
        error: None,
    }
}

fn identity_entry(value: &Value) -> Option<&serde_json::Map<String, Value>> {
    value.as_object()?.values().find_map(Value::as_object)
}

pub(crate) fn live_identity_from_value(value: &Value) -> Result<CliLiveLogin, String> {
    let entry = identity_entry(value).ok_or_else(|| ERR_GROK_IDENTITY_INVALID.to_string())?;
    let claims = entry.get("key").and_then(Value::as_str).map(decode_key_claims).transpose()?;
    Ok(CliLiveLogin {
        provider: CliProvider::Grok,
        present: true,
        email: entry.get("email").and_then(Value::as_str).map(str::to_string),
        identity_key: entry.get("user_id").and_then(Value::as_str).map(str::to_string),
        plan: claims.and_then(|claims| claims.tier),
        org_name: None,
        matched_profile_id: None,
        error: None,
    })
}

pub fn read_live_identity(paths: &GrokPaths) -> CliLiveLogin {
    if !paths.auth.is_file() {
        return blank();
    }
    let text = match fs::read_to_string(&paths.auth) {
        Ok(value) => value,
        Err(_) => {
            let mut login = blank();
            login.error = Some(ERR_GROK_IDENTITY_UNREADABLE.to_string());
            return login;
        }
    };
    let value: Value = match serde_json::from_str(&text) {
        Ok(value) => value,
        Err(_) => {
            let mut login = blank();
            login.error = Some(ERR_GROK_IDENTITY_INVALID.to_string());
            return login;
        }
    };
    match live_identity_from_value(&value) {
        Ok(login) => login,
        Err(error) => {
            let mut login = blank();
            login.error = Some(error);
            login
        }
    }
}

pub fn capture(paths: &GrokPaths) -> Result<(GrokSnapshot, CliLiveLogin), String> {
    let text = fs::read_to_string(&paths.auth)
        .map_err(|_| ERR_LIVE_LOGIN_UNAVAILABLE.to_string())?;
    let live = read_live_identity(paths);
    if let Some(error) = &live.error {
        return Err(error.clone());
    }
    Ok((
        GrokSnapshot {
            version: 1,
            provider: CliProvider::Grok,
            captured_at: Utc::now().to_rfc3339(),
            grok_auth_text: text,
        },
        live,
    ))
}

fn wait_for_lock(paths: &GrokPaths) -> Result<(), String> {
    let started = Instant::now();
    while paths.lock.exists() {
        if started.elapsed() >= LOCK_WAIT {
            return Err(ERR_GROK_AUTH_LOCK_TIMEOUT.to_string());
        }
        thread::sleep(LOCK_POLL);
    }
    Ok(())
}

pub fn restore(paths: &GrokPaths, snapshot: &GrokSnapshot) -> Result<(), String> {
    let value: Value = serde_json::from_str(&snapshot.grok_auth_text)
        .map_err(|_| ERR_SNAPSHOT_INVALID.to_string())?;
    if identity_entry(&value).is_none() {
        return Err(ERR_SNAPSHOT_INVALID.to_string());
    }
    wait_for_lock(paths)?;
    write_atomic(&paths.auth, snapshot.grok_auth_text.as_bytes())
        .map_err(|_| ERR_RESTORE_FAILED.to_string())
}
