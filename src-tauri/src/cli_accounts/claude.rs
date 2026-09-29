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

/// Where Claude Code keeps the credentials for a given config directory.
///
/// On macOS the live install does not use a file at all: the credentials sit in
/// the login keychain under the service `Claude Code-credentials`, and
/// `~/.claude/.credentials.json` never exists. Reading it as a file therefore
/// always failed there — `capture` returned ERR_LIVE_LOGIN_UNAVAILABLE, so
/// registering a Claude account from the accounts panel could not work at all,
/// while Codex and Grok, which do use files, registered fine. Confirmed on the
/// Mac on 2026-09-10: no credentials file, keychain item present.
///
/// A staging directory is different. `CLAUDE_CONFIG_DIR` pointed somewhere else
/// starts unauthenticated (measured: `Not logged in` even with the keychain
/// item in place), and the CLI writes into that directory, so staging stays on
/// files on every platform.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum CredentialStore {
    File,
    Keychain,
}

/// The keychain service Claude Code stores its credentials under.
const KEYCHAIN_SERVICE: &str = "Claude Code-credentials";

/// `security` exits with errSecItemNotFound when the login keychain holds no
/// item for the service. That is the logged-out state, not a malfunction:
/// measured on the Mac with `security find-generic-password -s 'Claude
/// Code-credentials'; echo $?`.
#[cfg(target_os = "macos")]
const KEYCHAIN_ITEM_NOT_FOUND: i32 = 44;

/// What the credential store answered.
///
/// The two failures are worth keeping apart. "Logged out" is a resting state —
/// retrying cannot change it, and the live-sync watcher used to report it as a
/// failed tick every 20 seconds. "Unavailable" is a store we could not consult
/// (spawn failed, keychain locked, permission denied) and may answer next time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CredentialsRead {
    Found(String),
    LoggedOut,
    Unavailable,
}

/// Reads the live credentials at most once.
///
/// On macOS every read spawns `security`, and one live-sync tick did it three
/// times for the same answer: the plan lookup in `read_live_identity`, the
/// capture itself, and the identity read inside that capture. Passing this
/// holder down the tick collapses them into one read, and keeps the answer
/// consistent while the tick runs — the identity and the bytes we file away
/// can no longer come from two different reads of a rotating store.
///
/// Scope is one tick on purpose. A longer-lived cache would hand a switch or a
/// restore the credentials of the account it just replaced.
pub struct CredentialsOnce<'a> {
    paths: &'a ClaudePaths,
    value: Option<CredentialsRead>,
}

impl<'a> CredentialsOnce<'a> {
    pub fn new(paths: &'a ClaudePaths) -> Self {
        Self { paths, value: None }
    }

    fn read(&mut self) -> &CredentialsRead {
        let paths = self.paths;
        self.value
            .get_or_insert_with(|| read_credentials_status(paths))
    }

    /// The credentials text, or `None` for both failures.
    pub fn text(&mut self) -> Option<&str> {
        match self.read() {
            CredentialsRead::Found(text) => Some(text.as_str()),
            _ => None,
        }
    }

    /// True when the store answered "there is nothing here" rather than
    /// "I could not look".
    pub fn logged_out(&mut self) -> bool {
        matches!(self.read(), CredentialsRead::LoggedOut)
    }
}

#[derive(Clone)]
pub struct ClaudePaths {
    pub credentials: PathBuf,
    pub claude_json: PathBuf,
    pub store: CredentialStore,
}

impl ClaudePaths {
    pub fn resolve() -> Result<Self, String> {
        let home = dirs::home_dir().ok_or_else(|| ERR_LIVE_LOGIN_UNAVAILABLE.to_string())?;
        Ok(Self {
            credentials: home.join(".claude").join(".credentials.json"),
            claude_json: home.join(".claude.json"),
            store: if cfg!(target_os = "macos") {
                CredentialStore::Keychain
            } else {
                CredentialStore::File
            },
        })
    }
}

/// Reads the credentials JSON, whichever store this install uses.
pub fn read_credentials(paths: &ClaudePaths) -> Option<String> {
    match read_credentials_status(paths) {
        CredentialsRead::Found(text) => Some(text),
        CredentialsRead::LoggedOut | CredentialsRead::Unavailable => None,
    }
}

/// Same read, keeping "nothing stored" apart from "could not look".
pub fn read_credentials_status(paths: &ClaudePaths) -> CredentialsRead {
    match paths.store {
        CredentialStore::File => match fs::read_to_string(&paths.credentials) {
            Ok(text) => CredentialsRead::Found(text),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                CredentialsRead::LoggedOut
            }
            Err(_) => CredentialsRead::Unavailable,
        },
        CredentialStore::Keychain => read_keychain_credentials(),
    }
}

#[cfg(target_os = "macos")]
fn read_keychain_credentials() -> CredentialsRead {
    let Ok(output) = std::process::Command::new("/usr/bin/security")
        .args(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"])
        .output()
    else {
        return CredentialsRead::Unavailable;
    };
    if !output.status.success() {
        return if output.status.code() == Some(KEYCHAIN_ITEM_NOT_FOUND) {
            CredentialsRead::LoggedOut
        } else {
            CredentialsRead::Unavailable
        };
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        // An item that exists but holds nothing is not a logged-out keychain;
        // report it as a store we could not get an answer out of.
        CredentialsRead::Unavailable
    } else {
        CredentialsRead::Found(text)
    }
}

#[cfg(not(target_os = "macos"))]
fn read_keychain_credentials() -> CredentialsRead {
    // Only macOS has this store; the variant is unreachable elsewhere.
    CredentialsRead::Unavailable
}

/// Writes the credentials JSON back to whichever store this install uses.
fn write_credentials<F>(paths: &ClaudePaths, text: &str, writer: &mut F) -> Result<(), String>
where
    F: FnMut(&std::path::Path, &[u8]) -> Result<(), String>,
{
    match paths.store {
        CredentialStore::File => writer(&paths.credentials, text.as_bytes()),
        CredentialStore::Keychain => write_keychain_credentials(text),
    }
}

#[cfg(target_os = "macos")]
fn write_keychain_credentials(text: &str) -> Result<(), String> {
    use std::io::Write;

    let account = std::env::var("USER").unwrap_or_else(|_| "default".to_string());
    // The credential goes in over stdin, never as an argument. `security -h`
    // says so itself: "Use of the -p or -w options is insecure. Specify -w as
    // the last option to be prompted." An argument would sit in this process's
    // argv, readable by anything running as the same user for as long as the
    // call takes.
    //
    // The prompt reads a line at a time and asks twice to confirm, so the value
    // has to be one line. Re-serialising compact guarantees that without
    // changing what the JSON means — and it is JSON that Claude Code parses
    // back, not a byte-exact blob.
    let one_line = serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|value| serde_json::to_string(&value).ok())
        .ok_or_else(|| ERR_SNAPSHOT_INVALID.to_string())?;

    // -U replaces the existing item rather than failing on a duplicate, which is
    // what switching between two accounts does every time.
    let mut child = std::process::Command::new("/usr/bin/security")
        .args([
            "add-generic-password",
            "-U",
            "-s",
            KEYCHAIN_SERVICE,
            "-a",
            &account,
            "-w",
        ])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|_| ERR_RESTORE_FAILED.to_string())?;
    {
        let stdin = child
            .stdin
            .as_mut()
            .ok_or_else(|| ERR_RESTORE_FAILED.to_string())?;
        for _ in 0..2 {
            stdin
                .write_all(one_line.as_bytes())
                .and_then(|()| stdin.write_all(b"
"))
                .map_err(|_| ERR_RESTORE_FAILED.to_string())?;
        }
    }
    let status = child.wait().map_err(|_| ERR_RESTORE_FAILED.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(ERR_RESTORE_FAILED.to_string())
    }
}

#[cfg(not(target_os = "macos"))]
fn write_keychain_credentials(_text: &str) -> Result<(), String> {
    Err(ERR_RESTORE_FAILED.to_string())
}

/// Removes the credentials, used to undo a half-finished restore.
fn remove_credentials(paths: &ClaudePaths) {
    match paths.store {
        CredentialStore::File => {
            let _ = fs::remove_file(&paths.credentials);
        }
        CredentialStore::Keychain => remove_keychain_credentials(),
    }
}

#[cfg(target_os = "macos")]
fn remove_keychain_credentials() {
    let _ = std::process::Command::new("/usr/bin/security")
        .args(["delete-generic-password", "-s", KEYCHAIN_SERVICE])
        .status();
}

#[cfg(not(target_os = "macos"))]
fn remove_keychain_credentials() {}

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
    read_live_identity_reusing(paths, &mut CredentialsOnce::new(paths))
}

/// `read_live_identity` against credentials already read this tick.
pub fn read_live_identity_reusing(
    paths: &ClaudePaths,
    credentials: &mut CredentialsOnce<'_>,
) -> CliLiveLogin {
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
        plan: credentials
            .text()
            .and_then(|text| serde_json::from_str::<Value>(text).ok())
            .and_then(|value| field(value.get("claudeAiOauth")?, "subscriptionType")),
        org_name: field(account, "organizationName"),
        matched_profile_id: None,
        error: None,
    }
}

pub fn capture(paths: &ClaudePaths) -> Result<(ClaudeSnapshot, CliLiveLogin), String> {
    capture_reusing(paths, &mut CredentialsOnce::new(paths))
}

/// `capture` against credentials already read this tick.
pub fn capture_reusing(
    paths: &ClaudePaths,
    credentials_once: &mut CredentialsOnce<'_>,
) -> Result<(ClaudeSnapshot, CliLiveLogin), String> {
    let credentials = credentials_once
        .text()
        .ok_or_else(|| ERR_LIVE_LOGIN_UNAVAILABLE.to_string())?
        .to_string();
    let claude_json = fs::read_to_string(&paths.claude_json)
        .map_err(|_| ERR_LIVE_LOGIN_UNAVAILABLE.to_string())?;
    let oauth_account_text = extract_top_level_member(&claude_json, "oauthAccount")
        .map_err(|_| ERR_CLAUDE_IDENTITY_INVALID.to_string())?
        .ok_or_else(|| ERR_CLAUDE_IDENTITY_INVALID.to_string())?
        .to_string();
    let live = read_live_identity_reusing(paths, credentials_once);
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
    let original_credentials = read_credentials(paths);
    write_credentials(paths, &snapshot.credentials_text, &mut writer)
        .map_err(|_| ERR_RESTORE_FAILED.to_string())?;
    if writer(&paths.claude_json, replaced.as_bytes()).is_err() {
        match original_credentials {
            Some(text) => {
                let _ = write_credentials(paths, &text, &mut writer);
            }
            None => remove_credentials(paths),
        }
        return Err(ERR_RESTORE_FAILED.to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {

    #[test]
    fn the_live_install_reads_where_this_platform_actually_keeps_credentials() {
        // macOS Claude Code stores them in the login keychain and never writes
        // ~/.claude/.credentials.json. Reading that path as a file is why
        // registering a Claude account could not work there at all: capture
        // insisted on a file that does not exist, and returned
        // ERR_LIVE_LOGIN_UNAVAILABLE every time. Confirmed on the Mac on
        // 2026-09-10 — no credentials file, keychain item present.
        let paths = ClaudePaths::resolve().expect("home dir");
        if cfg!(target_os = "macos") {
            assert_eq!(paths.store, CredentialStore::Keychain);
        } else {
            assert_eq!(paths.store, CredentialStore::File);
        }
    }

    #[test]
    fn a_staging_directory_is_files_on_every_platform() {
        // A CLAUDE_CONFIG_DIR pointed away from home starts unauthenticated —
        // measured as `Not logged in` with the keychain item in place — and the
        // CLI writes into that directory, so the keychain is not involved even
        // on macOS. Getting this backwards would have staging logins read the
        // live account instead of the one being added.
        let dir = tempfile::tempdir().unwrap();
        let paths = crate::cli_accounts::staging::claude_staging_paths(dir.path());
        assert_eq!(paths.store, CredentialStore::File);
    }

    #[test]
    fn reading_a_file_backed_store_returns_what_is_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let credentials = dir.path().join(".credentials.json");
        fs::write(&credentials, r#"{"claudeAiOauth":{"subscriptionType":"max"}}"#).unwrap();
        let paths = ClaudePaths {
            credentials,
            claude_json: dir.path().join(".claude.json"),
            store: CredentialStore::File,
        };
        assert!(read_credentials(&paths).unwrap().contains("max"));
    }

    #[test]
    fn an_absent_store_reads_as_logged_out_rather_than_unreadable() {
        // The live-sync watcher counts "unavailable" ticks as failures and logs
        // every one of them. A CLI that is simply not logged in must not look
        // like a malfunction: on the Mac that filled diag.log with the same
        // line every 20 seconds for as long as the app ran.
        let dir = tempfile::tempdir().unwrap();
        let paths = ClaudePaths {
            credentials: dir.path().join(".credentials.json"),
            claude_json: dir.path().join(".claude.json"),
            store: CredentialStore::File,
        };
        assert_eq!(read_credentials_status(&paths), CredentialsRead::LoggedOut);
        assert!(CredentialsOnce::new(&paths).logged_out());
    }

    #[test]
    fn one_holder_reads_the_store_once() {
        // Each read is a `security` process on macOS. Deleting the file between
        // the two calls is how a test can tell a reused answer from a re-read.
        let dir = tempfile::tempdir().unwrap();
        let credentials = dir.path().join(".credentials.json");
        fs::write(&credentials, r#"{"claudeAiOauth":{"subscriptionType":"max"}}"#).unwrap();
        let paths = ClaudePaths {
            credentials: credentials.clone(),
            claude_json: dir.path().join(".claude.json"),
            store: CredentialStore::File,
        };
        let mut once = CredentialsOnce::new(&paths);
        assert!(once.text().unwrap().contains("max"));
        fs::remove_file(&credentials).unwrap();
        assert!(once.text().unwrap().contains("max"), "the first answer is reused");
        assert!(!once.logged_out());
        // A fresh holder is a fresh read, so nothing is cached across ticks.
        assert!(CredentialsOnce::new(&paths).text().is_none());
    }

    #[test]
    fn reading_a_file_backed_store_with_no_file_returns_nothing() {
        // Not an error: an install that has never logged in looks exactly like
        // this, and capture turns the None into the right message itself.
        let dir = tempfile::tempdir().unwrap();
        let paths = ClaudePaths {
            credentials: dir.path().join(".credentials.json"),
            claude_json: dir.path().join(".claude.json"),
            store: CredentialStore::File,
        };
        assert!(read_credentials(&paths).is_none());
    }
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn restore_rolls_back_credentials_when_claude_json_write_fails() {
        let dir = tempdir().unwrap();
        let paths = ClaudePaths {
            store: CredentialStore::File,
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
