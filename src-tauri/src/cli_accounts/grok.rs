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

/// Outcome of writing a refreshed token pair back to the live `auth.json`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LiveTokenWrite {
    Applied,
    /// The file moved on under us -- the CLI refreshed first, and its tokens are
    /// newer than the ones we set out to write.
    Conflict,
}

pub(crate) fn refresh_token_of(auth_text: &str) -> Option<String> {
    let value: Value = serde_json::from_str(auth_text).ok()?;
    identity_entry(&value)?
        .get("refresh_token")
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// Persist a refreshed token pair into the `auth.json` the grok CLI reads.
///
/// The account snapshot cannot stand in for this file when the profile is the
/// live one: usage fetching reads an active row's tokens straight from
/// `auth.json`, so a rotated refresh token parked in the snapshot would never
/// be read again -- not by mycmux, and not by the CLI, whose next refresh would
/// then present a token the provider has already retired.
///
/// Takes the same lock the account switcher does, and re-reads the file under
/// it: if the refresh token no longer matches the one the caller refreshed
/// from, the CLI got there first and its tokens win.
pub fn update_live_tokens(
    paths: &GrokPaths,
    expected_refresh_token: &str,
    access_token: &str,
    refresh_token: Option<&str>,
) -> Result<LiveTokenWrite, String> {
    wait_for_lock(paths)?;
    let text = fs::read_to_string(&paths.auth).map_err(|_| ERR_GROK_IDENTITY_UNREADABLE.to_string())?;
    if refresh_token_of(&text).as_deref() != Some(expected_refresh_token) {
        return Ok(LiveTokenWrite::Conflict);
    }
    let next = crate::usage::credentials::grok_auth_with(&text, access_token, refresh_token)
        .map_err(|_| ERR_GROK_IDENTITY_INVALID.to_string())?;
    write_atomic(&paths.auth, next.as_bytes()).map_err(|_| ERR_RESTORE_FAILED.to_string())?;
    Ok(LiveTokenWrite::Applied)
}

#[cfg(test)]
mod live_token_tests {
    use super::*;
    use std::io::Write;

    fn auth_text(refresh: &str) -> String {
        format!(
            r#"{{"https://auth.x.ai::abc":{{"key":"old-access","refresh_token":"{refresh}","user_id":"u1"}}}}"#
        )
    }

    fn paths_in(dir: &std::path::Path) -> GrokPaths {
        GrokPaths { auth: dir.join("auth.json"), lock: dir.join("auth.json.lock") }
    }

    fn write(path: &std::path::Path, text: &str) {
        let mut file = fs::File::create(path).expect("create auth.json");
        file.write_all(text.as_bytes()).expect("write auth.json");
    }

    #[test]
    fn reads_the_refresh_token_out_of_an_auth_document() {
        assert_eq!(refresh_token_of(&auth_text("r1")).as_deref(), Some("r1"));
        assert_eq!(refresh_token_of("not json"), None);
        assert_eq!(refresh_token_of("{}"), None);
    }

    #[test]
    fn applies_a_rotated_pair_when_the_file_still_holds_the_expected_token() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = paths_in(dir.path());
        write(&paths.auth, &auth_text("r1"));

        let outcome = update_live_tokens(&paths, "r1", "new-access", Some("r2"))
            .expect("write should succeed");

        assert_eq!(outcome, LiveTokenWrite::Applied);
        let after = fs::read_to_string(&paths.auth).expect("read back");
        assert_eq!(refresh_token_of(&after).as_deref(), Some("r2"));
        assert!(after.contains("new-access"));
    }

    // The CLI refreshed first while we were in flight: its tokens are newer, so
    // ours are dropped rather than written over the top.
    #[test]
    fn leaves_the_file_alone_when_the_cli_rotated_first() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = paths_in(dir.path());
        write(&paths.auth, &auth_text("r9"));

        let outcome = update_live_tokens(&paths, "r1", "new-access", Some("r2"))
            .expect("conflict is not an error");

        assert_eq!(outcome, LiveTokenWrite::Conflict);
        let after = fs::read_to_string(&paths.auth).expect("read back");
        assert_eq!(refresh_token_of(&after).as_deref(), Some("r9"));
        assert!(after.contains("old-access"));
    }
}
