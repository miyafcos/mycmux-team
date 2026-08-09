//! Keeps the snapshot of the *live* CLI login in step with token rotation.
//!
//! Both CLIs rewrite their credential file whenever they refresh an access
//! token, and Claude rotates the refresh token when it does. A snapshot taken
//! before such a rotation is dead the moment the provider invalidates the old
//! token: switching back to that profile restores credentials the server no
//! longer accepts (the CLI lands on "Please run /login"), and usage fetches
//! 401 with no recovery except a manual re-login.
//!
//! Capturing only at switch time is therefore not enough — every rotation that
//! happens while a profile is active silently rots its snapshot. This watcher
//! re-captures whenever the live file changes, so the active profile's stored
//! copy is never more than one poll behind.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    thread,
    time::{Duration, SystemTime},
};

use super::{claude, codex, registry, snapshot, CliAccountProfile, CliProvider};

/// Rotation is driven by token lifetime (hours), not by user actions, so a
/// coarse poll is enough. Short enough that a switch right after a rotation
/// still finds a fresh snapshot; long enough to stay invisible in CPU terms.
const POLL_INTERVAL: Duration = Duration::from_secs(20);

/// What a single provider's tick did — returned so tests can assert without
/// reading the log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncOutcome {
    /// Credential files untouched since the previous tick.
    Unchanged,
    /// No live login present (logged out, or the file is not readable yet).
    NoLiveLogin,
    /// Live login belongs to no registered profile. Deliberately *not* stored:
    /// creating profiles is a user-initiated action ("register current login").
    Unregistered,
    /// Snapshot rewritten for this profile id.
    Resynced(String),
    /// Capture or save failed; the stamp is left untouched so the next tick retries.
    Failed(String),
}

/// mtime bookkeeping per watched file. Kept outside the sync function so the
/// caller owns it across ticks and tests can drive several ticks in a row.
#[derive(Default)]
pub struct FileStamps {
    stamps: HashMap<PathBuf, SystemTime>,
}

impl FileStamps {
    pub fn new() -> Self {
        Self::default()
    }

    /// True when any of `paths` differs from the recorded stamp. A missing file
    /// counts as a change exactly once (its entry is removed), so a logout
    /// followed by a login is never collapsed into "unchanged".
    pub fn changed(&mut self, paths: &[&Path]) -> bool {
        let mut changed = false;
        for path in paths {
            let current = std::fs::metadata(path).and_then(|meta| meta.modified()).ok();
            match current {
                Some(stamp) => {
                    if self.stamps.insert((*path).to_path_buf(), stamp) != Some(stamp) {
                        changed = true;
                    }
                }
                None => {
                    if self.stamps.remove(*path).is_some() {
                        changed = true;
                    }
                }
            }
        }
        changed
    }

    /// Drop the recorded stamps for `paths` so the next tick re-examines them.
    /// Used after a failed capture: the file did change, but we did not manage
    /// to store it, and silently swallowing that would lose the rotation.
    pub fn forget(&mut self, paths: &[&Path]) {
        for path in paths {
            self.stamps.remove(*path);
        }
    }
}

/// The profile a live identity belongs to, or `None` when it is unregistered.
///
/// Pure so the matching rule (same provider *and* same identity key) is
/// testable without touching the filesystem.
pub fn resync_target(
    provider: CliProvider,
    identity_key: Option<&str>,
    profiles: &[CliAccountProfile],
) -> Option<String> {
    let identity = identity_key?;
    profiles
        .iter()
        .find(|profile| profile.provider == provider && profile.identity_key == identity)
        .map(|profile| profile.id.clone())
}

fn claude_watched(paths: &claude::ClaudePaths) -> Vec<&Path> {
    vec![paths.credentials.as_path(), paths.claude_json.as_path()]
}

fn codex_watched(paths: &codex::CodexPaths) -> Vec<&Path> {
    vec![paths.auth.as_path()]
}

/// One provider's tick: re-capture when the live files moved and the login
/// belongs to a registered profile.
pub fn sync_provider(
    base: &Path,
    provider: CliProvider,
    claude_paths: &claude::ClaudePaths,
    codex_paths: &codex::CodexPaths,
    stamps: &mut FileStamps,
) -> SyncOutcome {
    let watched = match provider {
        CliProvider::Claude => claude_watched(claude_paths),
        CliProvider::Codex => codex_watched(codex_paths),
    };
    if !stamps.changed(&watched) {
        return SyncOutcome::Unchanged;
    }

    let live = match provider {
        CliProvider::Claude => claude::read_live_identity(claude_paths),
        CliProvider::Codex => codex::read_live_identity(codex_paths),
    };
    if !live.present {
        return SyncOutcome::NoLiveLogin;
    }

    let mut file = match registry::load(base) {
        Ok(file) => file,
        Err(error) => {
            stamps.forget(&watched);
            return SyncOutcome::Failed(error);
        }
    };
    let Some(profile_id) = resync_target(provider, live.identity_key.as_deref(), &file.profiles)
    else {
        return SyncOutcome::Unregistered;
    };

    let stored = match provider {
        CliProvider::Claude => claude::capture(claude_paths).map(|(stored, _)| {
            snapshot::StoredSnapshot::Claude(stored)
        }),
        CliProvider::Codex => {
            codex::capture(codex_paths).map(|(stored, _)| snapshot::StoredSnapshot::Codex(stored))
        }
    };
    let stored = match stored {
        Ok(stored) => stored,
        Err(error) => {
            stamps.forget(&watched);
            return SyncOutcome::Failed(error);
        }
    };
    match snapshot::save(base, &profile_id, &stored) {
        Ok(_) => {
            let cleared = file
                .profiles
                .iter_mut()
                .find(|profile| profile.id == profile_id)
                .is_some_and(|profile| profile.refresh_rejected_at.take().is_some());
            if !cleared {
                return SyncOutcome::Resynced(profile_id);
            }
            match registry::save(base, &file) {
                Ok(_) => SyncOutcome::Resynced(profile_id),
                Err(error) => {
                    stamps.forget(&watched);
                    SyncOutcome::Failed(error)
                }
            }
        }
        Err(error) => {
            stamps.forget(&watched);
            SyncOutcome::Failed(error)
        }
    }
}

/// Start the watcher. Failures are logged and the loop keeps going: a broken
/// tick must never take the app down, and the next rotation gets another try.
pub fn start_live_sync(base: PathBuf) {
    thread::spawn(move || {
        let mut stamps = FileStamps::new();
        loop {
            thread::sleep(POLL_INTERVAL);
            let (claude_paths, codex_paths) =
                match (claude::ClaudePaths::resolve(), codex::CodexPaths::resolve()) {
                    (Ok(claude_paths), Ok(codex_paths)) => (claude_paths, codex_paths),
                    _ => continue,
                };
            // A switch is mid-flight: its own capture already covers this
            // rotation, and interleaving would race the restore. Skip rather
            // than block — the next tick picks up whatever it left behind.
            let Some(_guard) = super::try_mutation_guard() else {
                continue;
            };
            for provider in [CliProvider::Claude, CliProvider::Codex] {
                match sync_provider(&base, provider, &claude_paths, &codex_paths, &mut stamps) {
                    SyncOutcome::Failed(error) => {
                        crate::diag_warn!(
                            "cli-accounts",
                            "live snapshot sync failed ({provider:?}): {error}"
                        );
                    }
                    // Success is the common case and would thrash the 1MB log.
                    SyncOutcome::Resynced(_)
                    | SyncOutcome::Unchanged
                    | SyncOutcome::NoLiveLogin
                    | SyncOutcome::Unregistered => {}
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    const CLAUDE_JSON: &str = include_str!("fixtures/claude_json_sample.json");
    const CREDS: &str = include_str!("fixtures/claude_credentials_sample.json");

    fn profile(id: &str, provider: CliProvider, identity: &str) -> CliAccountProfile {
        CliAccountProfile {
            id: id.to_string(),
            provider,
            label: id.to_string(),
            email: None,
            identity_key: identity.to_string(),
            plan: None,
            org_name: None,
            captured_at: String::new(),
            last_switched_at: None,
            needs_relogin: false,
            refresh_rejected_at: None,
        }
    }

    #[test]
    fn resync_target_matches_provider_and_identity() {
        let profiles = vec![
            profile("claude-1", CliProvider::Claude, "acct-a"),
            profile("codex-1", CliProvider::Codex, "acct-a"),
        ];
        assert_eq!(
            resync_target(CliProvider::Claude, Some("acct-a"), &profiles),
            Some("claude-1".to_string())
        );
        assert_eq!(
            resync_target(CliProvider::Codex, Some("acct-a"), &profiles),
            Some("codex-1".to_string())
        );
        assert_eq!(resync_target(CliProvider::Claude, Some("acct-b"), &profiles), None);
        assert_eq!(resync_target(CliProvider::Claude, None, &profiles), None);
    }

    #[test]
    fn stamps_report_first_sight_then_stability() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("creds.json");
        fs::write(&path, b"{}").unwrap();
        let mut stamps = FileStamps::new();
        assert!(stamps.changed(&[path.as_path()]), "first sight is a change");
        assert!(!stamps.changed(&[path.as_path()]), "untouched file is stable");
    }

    #[test]
    fn stamps_report_removal_once() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("creds.json");
        fs::write(&path, b"{}").unwrap();
        let mut stamps = FileStamps::new();
        assert!(stamps.changed(&[path.as_path()]));
        fs::remove_file(&path).unwrap();
        assert!(stamps.changed(&[path.as_path()]), "removal is a change");
        assert!(!stamps.changed(&[path.as_path()]), "still-missing is stable");
    }

    #[test]
    fn forget_forces_reexamination() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("creds.json");
        fs::write(&path, b"{}").unwrap();
        let mut stamps = FileStamps::new();
        assert!(stamps.changed(&[path.as_path()]));
        stamps.forget(&[path.as_path()]);
        assert!(stamps.changed(&[path.as_path()]), "forgotten stamp is seen again");
    }

    #[test]
    fn resync_clears_refresh_rejection_after_capturing_live_tokens() {
        let dir = tempdir().unwrap();
        let claude_paths = claude::ClaudePaths {
            credentials: dir.path().join("credentials.json"),
            claude_json: dir.path().join("claude.json"),
        };
        let codex_paths = codex::CodexPaths {
            auth: dir.path().join("auth.json"),
        };
        fs::write(&claude_paths.credentials, CREDS).unwrap();
        fs::write(&claude_paths.claude_json, CLAUDE_JSON).unwrap();
        let mut file = registry::CliAccountsFile::default();
        let mut registered = profile("claude-1", CliProvider::Claude, "claude-account-a");
        registered.refresh_rejected_at = Some("2026-08-09T00:00:00Z".into());
        file.profiles.push(registered);
        registry::save(dir.path(), &file).unwrap();

        let mut stamps = FileStamps::new();
        assert_eq!(
            sync_provider(
                dir.path(),
                CliProvider::Claude,
                &claude_paths,
                &codex_paths,
                &mut stamps,
            ),
            SyncOutcome::Resynced("claude-1".into())
        );
        assert!(registry::load(dir.path()).unwrap().profiles[0]
            .refresh_rejected_at
            .is_none());
    }
}
