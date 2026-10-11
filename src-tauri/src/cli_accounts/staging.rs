//! Isolated login: let a CLI log in somewhere that is not the live account.
//!
//! Adding a second account used to mean logging the live one *out* first,
//! because `capture_account` can only read `~/.claude` / `~/.codex`. That is a
//! bad trade: the live snapshot is rewritten by the logout, and a failed login
//! leaves the user with no account at all.
//!
//! Both CLIs accept a config directory override (`CLAUDE_CONFIG_DIR`,
//! `CODEX_HOME`) and neither inherits the live credentials through it, so a
//! throwaway directory is an isolated login surface: the new tokens land in
//! files, or in a config-directory-specific keychain service on macOS. Live
//! credentials are never opened, and capture uses the same store as the CLI.
//!
//! Staging lives under `<app_data>` rather than `%TEMP%` on purpose - codex
//! refuses to create its helper binaries below the temp directory.

use std::{
    fs,
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::{
    atomic::write_atomic,
    claude::{self, ClaudePaths, CredentialStore, CredentialsOnce, CredentialsRead},
    codex::{self, CodexPaths},
    grok::{self, GrokPaths},
    capture_account_with_grok, mutation_guard, registry, snapshot, CliAccountProfile, CliProvider,
    ERR_ACCOUNTS_UNAVAILABLE,
    ERR_LIVE_IDENTITY_MISSING, ERR_LOGIN_IDENTITY_MISMATCH, ERR_LOGIN_STAGING_FAILED,
};

const STAGING_DIR: &str = "cli_login_staging";

/// Keys copied from the live `~/.claude.json` into a fresh staging config.
///
/// The only purpose is to skip the onboarding wizard, so this list is
/// deliberately tiny and carries no identity: `oauthAccount`, `projects`,
/// `history`, `userID` and `machineID` are exactly the keys that must *not*
/// travel, and anything not observed in a real staging config is not invented
/// here either (`hasCompletedOnboarding`, for one, is never written by the CLI).
const SEEDED_CLAUDE_KEYS: &[&str] = &[
    "migrationVersion",
    "opusProMigrationComplete",
    "sonnet1m45MigrationComplete",
    "hasResetAutoModeOptInForDefaultOffer",
    "theme",
    "installMethod",
];

pub fn staging_root(base: &Path) -> PathBuf {
    base.join(STAGING_DIR)
}

/// A private directory for one login attempt. Never reused: a leftover config
/// from an abandoned attempt would make the next capture ambiguous.
pub fn create_staging_dir(base: &Path) -> Result<PathBuf, String> {
    let dir = staging_root(base).join(Uuid::new_v4().simple().to_string());
    fs::create_dir_all(&dir).map_err(|_| ERR_LOGIN_STAGING_FAILED.to_string())?;
    Ok(dir)
}

/// Shared by the login command and subprocess acceptance tests. Codex must
/// write a file even when a CLI release or copied config prefers a keyring.
pub fn login_command(provider: CliProvider) -> (&'static str, Vec<String>, &'static str) {
    match provider {
        CliProvider::Claude => ("claude", Vec::new(), "CLAUDE_CONFIG_DIR"),
        CliProvider::Codex => (
            "codex",
            vec!["login".to_string(), "-c".to_string(),
                "cli_auth_credentials_store=\"file\"".to_string()],
            "CODEX_HOME",
        ),
        CliProvider::Grok => ("grok", vec!["login".to_string()], "GROK_HOME"),
    }
}

/// The exact CLI environment value and its credential store are derived here
/// together. Do not canonicalize it: Claude hashes the supplied string itself.
pub fn claude_staging_config(dir: &Path) -> (String, CredentialStore) {
    let config_dir = dir.display().to_string();
    let store = if cfg!(target_os = "macos") {
        CredentialStore::Keychain {
            service: claude_staging_service(&config_dir),
        }
    } else {
        CredentialStore::File
    };
    (config_dir, store)
}

/// Claude Code 2.1.295: SHA-256(config-dir string), first eight lowercase hex
/// digits. Verified with `/tmp/kc-shim-2319/cfg-abc` -> `18bef226`.
pub(super) fn claude_staging_service(config_dir: &str) -> String {
    let digest = hex::encode(Sha256::digest(config_dir.as_bytes()));
    format!("{}-{}", claude::KEYCHAIN_SERVICE, &digest[..8])
}

/// Mirrors how `claude` picks its config file: `.config.json` wins when it
/// exists, otherwise `.claude.json`. Reading the wrong one would report the
/// login as never having happened.
pub fn claude_staging_paths(dir: &Path) -> ClaudePaths {
    let preferred = dir.join(".config.json");
    ClaudePaths {
        credentials: dir.join(".credentials.json"),
        claude_json: if preferred.is_file() {
            preferred
        } else {
            dir.join(".claude.json")
        },
        store: claude_staging_config(dir).1,
    }
}

/// The OS boundary is injectable for polling, capture and cleanup. Tests can
/// model macOS without credential files or access to a real login keychain.
pub(super) trait StagingCredentials: Sync {
    fn claude_paths(&self, dir: &Path) -> ClaudePaths {
        claude_staging_paths(dir)
    }

    fn read(&self, paths: &ClaudePaths) -> CredentialsRead {
        claude::read_credentials_status(paths)
    }

    fn remove_keychain(&self, service: &str) {
        claude::remove_keychain_credentials(service);
    }
}

pub(super) struct NativeCredentials;
impl StagingCredentials for NativeCredentials {}

pub fn codex_staging_paths(dir: &Path) -> CodexPaths {
    CodexPaths {
        auth: dir.join("auth.json"),
    }
}

pub fn grok_staging_paths(dir: &Path) -> GrokPaths {
    GrokPaths {
        auth: dir.join("auth.json"),
        lock: dir.join("auth.json.lock"),
    }
}

/// Best-effort onboarding skip. A failure here costs the user a few wizard
/// clicks and nothing else, so it never turns into an error: the login itself
/// works on a completely empty staging directory.
pub fn seed_claude_staging(dir: &Path, live: &ClaudePaths) {
    let Ok(text) = fs::read_to_string(&live.claude_json) else {
        return;
    };
    let Ok(Value::Object(live_config)) = serde_json::from_str::<Value>(&text) else {
        return;
    };
    let mut seeded = Map::new();
    for key in SEEDED_CLAUDE_KEYS {
        if let Some(value) = live_config.get(*key) {
            seeded.insert((*key).to_string(), value.clone());
        }
    }
    if seeded.is_empty() {
        return;
    }
    let Ok(bytes) = serde_json::to_vec(&Value::Object(seeded)) else {
        return;
    };
    if let Err(error) = write_atomic(&dir.join(".claude.json"), &bytes) {
        crate::diag_warn!(
            "cli_accounts",
            "failed to seed staging claude config: {error}"
        );
    }
}

/// Register whatever logged in inside `dir`.
///
/// Returns the profile plus whether it replaced an existing registration, which
/// is the difference between "added an account" and "refreshed an account" in
/// the UI.
pub fn capture_staged(
    base: &Path,
    provider: CliProvider,
    dir: &Path,
    label: Option<String>,
    expected_identity: Option<&str>,
) -> Result<(CliAccountProfile, bool), String> {
    capture_staged_with_credentials(
        base, provider, dir, label, expected_identity, &NativeCredentials,
    )
}

pub(super) fn capture_staged_with_credentials(
    base: &Path,
    provider: CliProvider,
    dir: &Path,
    label: Option<String>,
    expected_identity: Option<&str>,
    credentials: &dyn StagingCredentials,
) -> Result<(CliAccountProfile, bool), String> {
    let claude_paths = credentials.claude_paths(dir);
    let reader = |paths: &ClaudePaths| credentials.read(paths);
    let mut credentials_once = CredentialsOnce::with_reader(&claude_paths, &reader);
    let codex_paths = codex_staging_paths(dir);
    let grok_paths = grok_staging_paths(dir);
    let live = match provider {
        CliProvider::Claude => {
            claude::read_live_identity_reusing(&claude_paths, &mut credentials_once)
        }
        CliProvider::Codex => codex::read_live_identity(&codex_paths),
        CliProvider::Grok => grok::read_live_identity(&grok_paths),
    };
    let identity = live
        .identity_key
        .ok_or_else(|| ERR_LIVE_IDENTITY_MISSING.to_string())?;
    if expected_identity.is_some_and(|expected| expected != identity) {
        return Err(ERR_LOGIN_IDENTITY_MISMATCH.to_string());
    }

    let _guard = mutation_guard()?;
    let updated_existing = registry::load(base)
        .map_err(|_| ERR_ACCOUNTS_UNAVAILABLE.to_string())?
        .profiles
        .iter()
        .any(|profile| profile.provider == provider && profile.identity_key == identity);
    let profile = if provider == CliProvider::Claude {
        let (stored, live) = claude::capture_reusing(&claude_paths, &mut credentials_once)?;
        super::save_captured_account(
            base,
            snapshot::StoredSnapshot::Claude(stored),
            live,
            label,
            &super::token_owner::cached_owner,
            super::UnverifiedPolicy::Allow,
        )?
    } else {
        capture_account_with_grok(
            base,
            &claude_paths,
            &codex_paths,
            Some(&grok_paths),
            provider,
            label,
            &super::token_owner::cached_owner,
            // One isolated login writes identity and tokens; a known mismatch still refuses capture.
            super::UnverifiedPolicy::Allow,
        )?
    };
    Ok((profile, updated_existing))
}

/// Best-effort: the CLI may still hold a handle on Windows, and a directory we
/// failed to delete is swept at the next startup anyway.
pub fn cleanup_staging(dir: &Path) {
    cleanup_staging_with_credentials(dir, &NativeCredentials);
}

pub(super) fn cleanup_staging_with_credentials(dir: &Path, credentials: &dyn StagingCredentials) {
    // Only the service derived from this staging path can be removed. Never
    // enumerate keychain items or fall back to the unsuffixed live service.
    if let CredentialStore::Keychain { service } = credentials.claude_paths(dir).store {
        credentials.remove_keychain(&service);
    }
    if let Err(error) = fs::remove_dir_all(dir) {
        if error.kind() != std::io::ErrorKind::NotFound {
            crate::diag_warn!(
                "cli_accounts",
                "failed to remove login staging dir {}: {error}",
                dir.display()
            );
        }
    }
}

/// Kept separate from the directory walk so the age rule can be tested with
/// synthetic timestamps: a directory mtime cannot be backdated portably.
///
/// A directory whose mtime is in the future is never stale - a clock skew must
/// not be an excuse to delete a login that is still in progress.
fn is_stale(modified: SystemTime, now: SystemTime, max_age: Duration) -> bool {
    now.duration_since(modified)
        .map(|age| age > max_age)
        .unwrap_or(false)
}

/// Drop staging directories left behind by crashes or by a CLI that kept a
/// handle open past `cleanup_staging`. Runs at startup.
pub fn sweep_stale_staging(base: &Path, max_age: Duration) {
    sweep_stale_staging_with_credentials(base, max_age, &NativeCredentials);
}

fn sweep_stale_staging_with_credentials(
    base: &Path,
    max_age: Duration,
    credentials: &dyn StagingCredentials,
) {
    let root = staging_root(base);
    let Ok(entries) = fs::read_dir(&root) else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let stale = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .map(|modified| is_stale(modified, now, max_age))
            .unwrap_or(false);
        if stale {
            cleanup_staging_with_credentials(&path, credentials);
        }
    }
}

#[cfg(test)]
pub(super) mod test_support {
    use super::*;
    use std::{collections::HashMap, sync::Mutex};

    /// Keep the existing file-backed regression cases independent of the host
    /// OS. No test adapter may invoke the real macOS keychain.
    pub struct FileCredentials;

    impl StagingCredentials for FileCredentials {
        fn claude_paths(&self, dir: &Path) -> ClaudePaths {
            let mut paths = claude_staging_paths(dir);
            paths.store = CredentialStore::File;
            paths
        }

        fn remove_keychain(&self, _service: &str) {
            panic!("a file-backed test must never remove keychain credentials");
        }
    }

    #[derive(Default)]
    pub struct FakeKeychain {
        entries: Mutex<HashMap<String, String>>,
        reads: Mutex<Vec<String>>,
        removed: Mutex<Vec<String>>,
    }

    impl FakeKeychain {
        pub fn service(dir: &Path) -> String {
            claude_staging_service(&claude_staging_config(dir).0)
        }

        pub fn insert(&self, service: &str, text: &str) {
            self.entries
                .lock()
                .unwrap()
                .insert(service.to_string(), text.to_string());
        }

        pub fn contains(&self, service: &str) -> bool {
            self.entries.lock().unwrap().contains_key(service)
        }

        pub fn reads(&self) -> Vec<String> {
            self.reads.lock().unwrap().clone()
        }

        pub fn removed(&self) -> Vec<String> {
            self.removed.lock().unwrap().clone()
        }
    }

    impl StagingCredentials for FakeKeychain {
        fn claude_paths(&self, dir: &Path) -> ClaudePaths {
            let mut paths = claude_staging_paths(dir);
            paths.store = CredentialStore::Keychain {
                service: Self::service(dir),
            };
            paths
        }

        fn read(&self, paths: &ClaudePaths) -> CredentialsRead {
            let CredentialStore::Keychain { service } = &paths.store else {
                panic!("the fake keychain must not read a credential file");
            };
            self.reads.lock().unwrap().push(service.clone());
            match self.entries.lock().unwrap().get(service) {
                Some(text) => CredentialsRead::Found(text.clone()),
                None => CredentialsRead::LoggedOut,
            }
        }

        fn remove_keychain(&self, service: &str) {
            self.removed.lock().unwrap().push(service.to_string());
            self.entries.lock().unwrap().remove(service);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli_accounts::snapshot;
    use test_support::{FakeKeychain, FileCredentials};
    use tempfile::tempdir;

    const CLAUDE_JSON: &str = include_str!("fixtures/claude_json_sample.json");
    const CREDS: &str = include_str!("fixtures/claude_credentials_sample.json");

    #[test]
    fn codex_login_explicitly_selects_the_file_store() {
        let (command, args, env_key) = login_command(CliProvider::Codex);
        assert_eq!(command, "codex");
        assert_eq!(args, ["login", "-c", "cli_auth_credentials_store=\"file\""]);
        assert_eq!(env_key, "CODEX_HOME");
    }

    // Run the existing file fixtures without changing their assertions or
    // touching the real keychain when the test host happens to be macOS.
    fn capture_staged(
        base: &Path,
        provider: CliProvider,
        dir: &Path,
        label: Option<String>,
        expected_identity: Option<&str>,
    ) -> Result<(CliAccountProfile, bool), String> {
        capture_staged_with_credentials(
            base, provider, dir, label, expected_identity, &FileCredentials,
        )
    }

    fn sweep_stale_staging(base: &Path, max_age: Duration) {
        sweep_stale_staging_with_credentials(base, max_age, &FileCredentials);
    }

    #[test]
    fn staging_service_matches_the_measured_claude_sha256_suffix() {
        assert_eq!(
            claude_staging_service("/tmp/kc-shim-2319/cfg-abc"),
            "Claude Code-credentials-18bef226"
        );
    }

    #[test]
    fn staging_config_preserves_the_cli_environment_string() {
        let dir = Path::new("/tmp/config with spaces/../cfg-abc");
        let (config_dir, store) = claude_staging_config(dir);
        assert_eq!(config_dir, dir.display().to_string());
        assert_eq!(config_dir, "/tmp/config with spaces/../cfg-abc");
        assert_ne!(
            claude_staging_service(&config_dir),
            claude_staging_service("/tmp/cfg-abc")
        );
        assert_ne!(
            claude_staging_service(&config_dir),
            claude_staging_service(&(config_dir.clone() + "/"))
        );
        assert_eq!(store, claude_staging_paths(dir).store);
    }

    #[test]
    fn stale_sweep_removes_only_services_for_expired_staging_directories() {
        let base = tempdir().unwrap();
        let expired = create_staging_dir(base.path()).unwrap();
        let service = FakeKeychain::service(&expired);
        let keychain = FakeKeychain::default();
        keychain.insert(&service, CREDS);
        for untouched in [
            "Claude Code-credentials",
            "Claude Code",
            "Claude Code-18bef226",
            "Claude Code-credentials-16a22eae",
            "Claude Code-credentials-4f6a1a52",
        ] {
            keychain.insert(untouched, "untouched");
        }

        sweep_stale_staging_with_credentials(base.path(), Duration::from_secs(3600), &keychain);
        assert!(expired.is_dir());
        assert!(keychain.contains(&service));
        assert!(keychain.removed().is_empty());

        sweep_stale_staging_with_credentials(base.path(), Duration::ZERO, &keychain);
        assert!(!expired.exists());
        assert!(!keychain.contains(&service));
        assert_eq!(keychain.removed(), vec![service]);
        assert!(keychain.reads().is_empty(), "cleanup must not read credential contents");
        for untouched in [
            "Claude Code-credentials",
            "Claude Code",
            "Claude Code-18bef226",
            "Claude Code-credentials-16a22eae",
            "Claude Code-credentials-4f6a1a52",
        ] {
            assert!(keychain.contains(untouched));
        }
    }

    /// A staging directory that looks like a finished `claude` login.
    fn staged_claude(dir: &Path, claude_json: &str) {
        fs::create_dir_all(dir).unwrap();
        fs::write(dir.join(".claude.json"), claude_json).unwrap();
        fs::write(dir.join(".credentials.json"), CREDS).unwrap();
    }

    #[test]
    fn capture_staged_registers_a_profile_without_touching_live_files() {
        let base = tempdir().unwrap();
        let staging = create_staging_dir(base.path()).unwrap();
        staged_claude(&staging, CLAUDE_JSON);

        let (profile, updated_existing) =
            capture_staged(base.path(), CliProvider::Claude, &staging, None, None).unwrap();

        assert!(!updated_existing);
        assert_eq!(profile.identity_key, "claude-account-a");
        assert_eq!(profile.email.as_deref(), Some("a@example.test"));
        assert!(snapshot::load(base.path(), &profile.id).is_ok());
        assert_eq!(
            registry::load(base.path()).unwrap().profiles[0].id,
            profile.id
        );
    }

    #[test]
    fn capture_staged_reports_updated_existing_for_a_known_identity() {
        let base = tempdir().unwrap();
        let staging = create_staging_dir(base.path()).unwrap();
        staged_claude(&staging, CLAUDE_JSON);

        let (first, first_updated) =
            capture_staged(base.path(), CliProvider::Claude, &staging, None, None).unwrap();
        let (second, second_updated) =
            capture_staged(base.path(), CliProvider::Claude, &staging, None, None).unwrap();

        assert!(!first_updated);
        assert!(second_updated);
        assert_eq!(first.id, second.id);
        assert_eq!(registry::load(base.path()).unwrap().profiles.len(), 1);
    }

    #[test]
    fn capture_staged_rejects_an_unexpected_identity() {
        let base = tempdir().unwrap();
        let staging = create_staging_dir(base.path()).unwrap();
        staged_claude(&staging, CLAUDE_JSON);

        assert_eq!(
            capture_staged(
                base.path(),
                CliProvider::Claude,
                &staging,
                None,
                Some("claude-account-b"),
            )
            .err(),
            Some(ERR_LOGIN_IDENTITY_MISMATCH.to_string())
        );
        assert!(registry::load(base.path()).unwrap().profiles.is_empty());
        assert!(capture_staged(
            base.path(),
            CliProvider::Claude,
            &staging,
            None,
            Some("claude-account-a"),
        )
        .is_ok());
    }

    #[test]
    fn claude_staging_prefers_config_json_when_present() {
        let dir = tempdir().unwrap();
        assert_eq!(
            claude_staging_paths(dir.path()).claude_json,
            dir.path().join(".claude.json")
        );

        fs::write(dir.path().join(".config.json"), "{}").unwrap();
        assert_eq!(
            claude_staging_paths(dir.path()).claude_json,
            dir.path().join(".config.json")
        );
        assert_eq!(
            claude_staging_paths(dir.path()).credentials,
            dir.path().join(".credentials.json")
        );
    }

    #[test]
    fn capture_staged_reads_the_config_json_variant() {
        let base = tempdir().unwrap();
        let staging = create_staging_dir(base.path()).unwrap();
        fs::write(staging.join(".credentials.json"), CREDS).unwrap();
        fs::write(
            staging.join(".config.json"),
            CLAUDE_JSON.replace("claude-account-a", "claude-account-c"),
        )
        .unwrap();
        // A stale `.claude.json` must lose to `.config.json`, the same way the
        // CLI resolves it.
        fs::write(staging.join(".claude.json"), CLAUDE_JSON).unwrap();

        let (profile, _) =
            capture_staged(base.path(), CliProvider::Claude, &staging, None, None).unwrap();
        assert_eq!(profile.identity_key, "claude-account-c");
    }

    #[test]
    fn seed_copies_only_onboarding_keys() {
        let live_dir = tempdir().unwrap();
        let staging = tempdir().unwrap();
        let live = ClaudePaths {
            store: super::claude::CredentialStore::File,
            credentials: live_dir.path().join(".credentials.json"),
            claude_json: live_dir.path().join(".claude.json"),
        };
        fs::write(
            &live.claude_json,
            r#"{"migrationVersion":3,"theme":"dark","installMethod":"native",
                "userID":"live-user","machineID":"live-machine",
                "oauthAccount":{"accountUuid":"claude-account-a"},
                "projects":{"C:\\work":{"allowedTools":[]}},
                "history":[{"display":"secret"}]}"#,
        )
        .unwrap();

        seed_claude_staging(staging.path(), &live);

        let seeded = fs::read_to_string(staging.path().join(".claude.json")).unwrap();
        let value: Value = serde_json::from_str(&seeded).unwrap();
        assert_eq!(value.get("migrationVersion"), Some(&Value::from(3)));
        assert_eq!(value.get("theme"), Some(&Value::from("dark")));
        for forbidden in ["oauthAccount", "projects", "history", "userID", "machineID"] {
            assert!(
                value.get(forbidden).is_none(),
                "{forbidden} must not be copied into staging"
            );
        }
        assert!(!seeded.contains("secret"));
        // Never invented: the CLI does not write this key into a fresh config.
        assert!(value.get("hasCompletedOnboarding").is_none());
    }

    #[test]
    fn seed_is_silent_when_there_is_nothing_to_copy() {
        let live_dir = tempdir().unwrap();
        let staging = tempdir().unwrap();
        let live = ClaudePaths {
            store: super::claude::CredentialStore::File,
            credentials: live_dir.path().join(".credentials.json"),
            claude_json: live_dir.path().join(".claude.json"),
        };

        seed_claude_staging(staging.path(), &live);
        assert!(!staging.path().join(".claude.json").exists());

        fs::write(&live.claude_json, r#"{"oauthAccount":{"accountUuid":"a"}}"#).unwrap();
        seed_claude_staging(staging.path(), &live);
        assert!(!staging.path().join(".claude.json").exists());
    }

    #[test]
    fn staleness_is_decided_by_age_not_by_existence() {
        let now = SystemTime::now();
        let max_age = Duration::from_secs(3600);
        assert!(is_stale(now - Duration::from_secs(7200), now, max_age));
        assert!(!is_stale(now - Duration::from_secs(60), now, max_age));
        assert!(!is_stale(now, now, max_age));
        assert!(
            !is_stale(now + Duration::from_secs(7200), now, max_age),
            "a clock skew must not delete a login in progress"
        );
    }

    #[test]
    fn sweep_removes_expired_directories_and_keeps_recent_ones() {
        let base = tempdir().unwrap();
        let kept = create_staging_dir(base.path()).unwrap();
        fs::write(kept.join(".credentials.json"), CREDS).unwrap();

        sweep_stale_staging(base.path(), Duration::from_secs(3600));
        assert!(
            kept.is_dir(),
            "a directory created moments ago is not stale"
        );

        // Everything on disk is older than a zero-length grace period.
        sweep_stale_staging(base.path(), Duration::ZERO);
        assert!(!kept.exists());
        assert!(staging_root(base.path()).is_dir());
    }

    #[test]
    fn sweep_ignores_files_and_a_missing_root() {
        let base = tempdir().unwrap();
        sweep_stale_staging(base.path(), Duration::from_secs(1));
        assert!(!staging_root(base.path()).exists());

        let root = staging_root(base.path());
        fs::create_dir_all(&root).unwrap();
        let stray = root.join("not-a-directory");
        fs::write(&stray, "x").unwrap();
        sweep_stale_staging(base.path(), Duration::ZERO);
        assert!(stray.is_file());
    }
    #[test]
    fn staged_unverified_login_is_allowed_but_known_foreign_owner_is_refused() {
        for foreign in [false, true] {
            let base = tempdir().unwrap();
            let dir = create_staging_dir(base.path()).unwrap();
            let token = if foreign { "staged-known-foreign-unique" } else { "staged-unverified-unique" };
            staged_claude(&dir, CLAUDE_JSON);
            fs::write(dir.join(".credentials.json"), CREDS.replace("synthetic-access", token)).unwrap();
            if foreign {
                super::super::token_owner::remember_owner(token, &super::super::token_owner::TokenOwner {
                    account_uuid: "another-account".into(), email: None, organization_uuid: None,
                });
            }
            let result = capture_staged(base.path(), CliProvider::Claude, &dir, None, None);
            if foreign {
                assert_eq!(result.err().as_deref(), Some(super::super::ERR_LIVE_TOKEN_FOREIGN));
                assert!(registry::load(base.path()).unwrap().profiles.is_empty());
                assert!(!snapshot::snapshot_dir(base.path()).exists());
            } else {
                assert!(result.is_ok());
            }
        }
    }

}
