//! Isolated login: let a CLI log in somewhere that is not the live account.
//!
//! Adding a second account used to mean logging the live one *out* first,
//! because `capture_account` can only read `~/.claude` / `~/.codex`. That is a
//! bad trade: the live snapshot is rewritten by the logout, and a failed login
//! leaves the user with no account at all.
//!
//! Both CLIs accept a config directory override (`CLAUDE_CONFIG_DIR`,
//! `CODEX_HOME`) and neither inherits the live credentials through it, so a
//! throwaway directory is a complete, isolated login surface: the new tokens
//! land there, the live files are never opened, and capture reads the staging
//! directory exactly the way it would read the live one.
//!
//! Staging lives under `<app_data>` rather than `%TEMP%` on purpose - codex
//! refuses to create its helper binaries below the temp directory.

use std::{
    fs,
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

use serde_json::{Map, Value};
use uuid::Uuid;

use super::{
    atomic::write_atomic,
    claude::{self, ClaudePaths},
    codex::{self, CodexPaths},
    grok::{self, GrokPaths},
    capture_account_with_grok, mutation_guard, registry, CliAccountProfile, CliProvider, ERR_ACCOUNTS_UNAVAILABLE,
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
    }
}

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
    let claude_paths = claude_staging_paths(dir);
    let codex_paths = codex_staging_paths(dir);
    let grok_paths = grok_staging_paths(dir);
    let live = match provider {
        CliProvider::Claude => claude::read_live_identity(&claude_paths),
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
    let profile = capture_account_with_grok(
        base,
        &claude_paths,
        &codex_paths,
        Some(&grok_paths),
        provider,
        label,
    )?;
    Ok((profile, updated_existing))
}

/// Best-effort: the CLI may still hold a handle on Windows, and a directory we
/// failed to delete is swept at the next startup anyway.
pub fn cleanup_staging(dir: &Path) {
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
            cleanup_staging(&path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli_accounts::snapshot;
    use tempfile::tempdir;

    const CLAUDE_JSON: &str = include_str!("fixtures/claude_json_sample.json");
    const CREDS: &str = include_str!("fixtures/claude_credentials_sample.json");

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
}
